'use strict';

/**
 * autonomous.js — the unattended worker: what actually runs a queued task.
 *
 * `queue.js` stores tasks; this module is the half that turns one into work.
 * It owns three things no interactive turn has to think about:
 *
 * 1. THE OPERATING DIRECTIVE. An interactive turn can end on "let me check…"
 *    or a question, because a human will read it and answer. A queued task
 *    ends there only if nobody ever looks — so every queued turn runs under a
 *    directive that says, in the model's own context: nobody is watching,
 *    decide, act, verify, report; do not hand the work back. The round horizon
 *    is stated too, so the model budgets its exploration instead of meeting
 *    the cap by accident.
 *
 * 2. THE CARRY-OVER DIGEST. The AEGIS API is stateless per request, so a
 *    drain is not literally one long conversation — but treating ten queued
 *    tasks as ten unrelated strangers makes the ninth re-derive what the
 *    second already learned. Each finished task appends a one-line digest
 *    (what it was, what it touched, whether it was verified) to a carry string
 *    that rides in front of the next task's prompt. Bounded and one line per
 *    task: it is a briefing, not a transcript, and it must never grow into the
 *    context it is meant to save.
 *
 * 3. ATTRIBUTED COMMITS. A queue drain can run in a checkout somebody else is
 *    editing. `git add -A && git commit` in that situation commits THEIR
 *    half-finished work under our message — the failure `git-scope.js` was
 *    written for. So a task's `commit` flag commits only paths that this task
 *    changed, and paths that were dirty before and are byte-identical now (a
 *    concurrent agent's in-flight work) are never staged.
 *
 * It does NOT own the model call itself: the caller passes the local engine
 * (`desktop/lib/local/engine.js`), which is the same tool loop the GUI and the
 * CLI chat in. One tool loop, three callers, no drift.
 *
 * THE APPROVAL GATE IS THE CALLER'S JOB. There is nobody to answer an approval
 * card in an unattended run, so the engine must be constructed with the gate
 * off (`getConfirmMode: () => false`). Rather than trust that, the worker
 * watches the turn's event stream: an approval request means a card nobody can
 * click, so it is reported as a failed task instead of a hang.
 */

const queue = require('./queue.js');
const gitScope = require('./git-scope.js');

/** Default tool-round horizon for an unattended turn (matches the engine's). */
const DEFAULT_ROUNDS = 40;

/**
 * The default AEGIS Cloud model for autonomous work: the pooled brain, which
 * is the tier the server fans out to multiple reasoning workers and
 * synthesises. Autonomous tasks are exactly the ones worth that spend, and
 * `nexus-brain` is the canonical id the catalog itself prefers (the other tier
 * spellings are aliases of it — see filterAegisCatalog in engine.js).
 */
const DEFAULT_MODEL = 'nexus-brain';

/** Phrase match for "work autonomously" in a prompt or a queued task. */
const AUTONOMOUS_REQUEST_RE =
  /\bautonomously\b|\bon your own\b|\bwithout asking\b|\bend[- ]to[- ]end\b|\bno (?:more )?questions\b|\bfully autonomous\b|\bqueue it\b/i;

/** True when the user is asking for unattended execution. */
function isAutonomousRequest(text) {
  return AUTONOMOUS_REQUEST_RE.test(String(text || ''));
}

/** The round horizon, honouring AEGIS_AUTONOMOUS_MAX_ROUNDS. */
function maxRounds(env = process.env, stated) {
  const n = Number.parseInt(stated, 10);
  if (Number.isFinite(n) && n > 0) return n;
  const raw = Number.parseInt((env && env.AEGIS_AUTONOMOUS_MAX_ROUNDS) || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ROUNDS;
}

/**
 * Make the horizon real for the engine, then put the environment back.
 *
 * A `maxRounds` field in the chat payload would be dead code: engine.js reads
 * the knob from `process.env` at turn time (engine.js:1024,
 * `AEGIS_AUTONOMOUS_MAX_ROUNDS`). Env, unlike a payload key, is process-wide, so
 * the restore has to wait for a promise to settle (a turn reads the knob many
 * rounds after the call is made) — hence the thenable branch below.
 */
function withRoundHorizon(rounds, env, fn) {
  const key = 'AEGIS_AUTONOMOUS_MAX_ROUNDS';
  // Both objects: the caller's env carries the path/model defaults this worker
  // reads, and `process.env` is where engine.js reads the round cap. A test that
  // passes its own env still gets the knob on that object, and a real drain gets
  // it where the engine actually looks.
  const targets = [];
  for (const t of [env, process.env]) {
    if (t && targets.indexOf(t) === -1) targets.push(t);
  }
  const saved = targets.map((t) => ({
    target: t,
    had: Object.prototype.hasOwnProperty.call(t, key),
    prev: t[key],
  }));
  try {
    for (const t of targets) t[key] = String(rounds);
  } catch {
    /* a frozen/sealed env object is the caller's choice; the payload carries it too */
  }
  const restore = () => {
    for (const s of saved) {
      try {
        if (s.had) s.target[key] = s.prev;
        else delete s.target[key];
      } catch {
        /* nothing to restore on an object we could not write */
      }
    }
  };
  let out;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (out && typeof out.then === 'function') {
    return out.then(
      (value) => {
        restore();
        return value;
      },
      (err) => {
        restore();
        throw err;
      }
    );
  }
  restore();
  return out;
}

/**
 * The model an autonomous task runs on: an explicit pick wins, then the
 * environment (so a systemd timer can pin a cheap tier), then the pooled
 * brain. Never the interactive session's model — a queue survives the session
 * that queued it, so it cannot inherit that session's choice.
 */
function resolveModel({ model, env } = {}) {
  const e = env || process.env;
  const picked = String(model || '').trim();
  if (picked) return picked;
  const fromEnv = String(e.AEGIS_AUTONOMOUS_MODEL || e.AEGIS_MODEL || '').trim();
  return fromEnv || DEFAULT_MODEL;
}

/** Effort rung for an unattended turn: high unless the caller/environment says otherwise. */
function resolveEffort({ effort, env } = {}) {
  const e = env || process.env;
  return String(effort || e.AEGIS_AUTONOMOUS_EFFORT || 'high');
}

/**
 * The operating directive injected as the autonomous turn's prompt preamble.
 * Ported verbatim in spirit from aegiscodex-dev/src/autonomous.js so both
 * clients behave the same; duplicated rather than vendored because the plugin
 * hosts no ESM build of that module.
 */
function autonomousDirective(rounds = DEFAULT_ROUNDS) {
  return [
    '# Autonomous mode',
    `You are running autonomously, not in a conversation: there is no user to answer a question or approve a plan. You have up to ${rounds} tool rounds this turn; use as many as the task needs.`,
    'Work the task end to end:',
    '1. Plan in one line, then start acting in the same turn — never end a turn on a plan.',
    '2. Read only what you need to make the change (no fishing through the repo).',
    '3. Make the change with Write/Edit/Bash, then VERIFY it: re-read the result and run the relevant test/command.',
    '4. If verification fails, fix it and verify again — loop until it passes or you are genuinely blocked.',
    '5. Do not ask for permission, do not hand the work back, do not stop at "let me check…".',
    '6. Finish with a short report: what changed (file paths), the command you ran to verify, its result, and any remaining blocker.',
  ].join('\n');
}

/**
 * The digest line one finished task contributes to the next task's briefing.
 * Deliberately tiny: task text clipped, outcome as a mark, files as basenames.
 */
function digestLine(item, result) {
  const task = String(item.task || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const mark = result && result.ok ? '✓' : '✗';
  const files = (result && Array.isArray(result.files) && result.files.slice(0, 6)) || [];
  const where = files.length ? ` — touched: ${files.join(', ')}${result.files.length > files.length ? ', …' : ''}` : '';
  const why = !result || result.ok ? '' : ` — ${String((result && result.error) || 'failed').slice(0, 120)}`;
  return `- #${item.id} ${mark} ${task}${where}${why}`;
}

/** Keep only the last `keep` digest lines, so the briefing cannot grow forever. */
function appendDigest(carry, line, { keep = 6 } = {}) {
  const lines = String(carry || '')
    .split('\n')
    .filter(Boolean)
    .concat(line);
  return lines.slice(-keep).join('\n');
}

/**
 * The prompt a queued task actually sends: the directive, the briefing from
 * earlier tasks in the same drain (when there is one), then the task itself.
 */
function taskPrompt(item, { carry = '', rounds = DEFAULT_ROUNDS } = {}) {
  const parts = [autonomousDirective(rounds)];
  if (carry) {
    parts.push(
      '# Earlier tasks in this run\n' +
        'Work already done by this queue — do not redo it, build on it:\n' +
        carry
    );
  }
  parts.push('# Task\n' + String(item.task || '').trim());
  return parts.join('\n\n');
}

/** The assistant's visible text out of an OpenAI-shaped engine result. */
function assistantText(res) {
  if (!res || typeof res !== 'object') return '';
  const choice = Array.isArray(res.choices) ? res.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : res.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  return '';
}

/** A readable one-liner for whatever a failed turn threw. */
function errorText(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return String(err.message || err.error || err);
}

/**
 * Build the worker.
 *
 * @param {object} opts
 * @param {object} opts.engine  The local engine (createLocalEngine()). MUST be
 *   constructed with the approval gate off — see the module header.
 * @param {object} [opts.env]   Environment for paths/model defaults (tests pass a temp one).
 * @param {function} [opts.log] `(event) => void` progress sink; also forwarded
 *   the turn's own `{delta}` / `{tool}` frames.
 * @param {object} [opts.git]   Injectable git-scope (tests).
 * @param {function} [opts.now] Clock.
 */
function createQueueWorker({ engine, env = process.env, log = () => {}, git = gitScope, now = Date.now } = {}) {
  if (!engine || typeof engine.chat !== 'function') {
    throw new Error('autonomous: a local engine with chat() is required');
  }
  const emit = (event) => {
    try {
      log(event);
    } catch {
      /* a progress sink that throws (a closed stdout, a destroyed window) must
         never take the task down with it — the work is the point, not the log */
    }
  };

  /**
   * Run ONE queued task. Never throws: a failed task is data (so the drain can
   * decide whether to continue), not an exception that aborts the queue.
   */
  async function runTask(item, { carry = '', commit } = {}) {
    const cwd = item.cwd || process.cwd();
    const model = resolveModel({ model: item.model, env });
    const effort = resolveEffort({ effort: item.effort, env });
    const rounds = maxRounds(env, item.maxRounds);
    // Approval requests have no one to answer them here; see the header.
    let approvalAsked = null;
    let doneRounds = 0;
    const onDelta = (chunk) => {
      if (!chunk || typeof chunk !== 'object') return;
      if (chunk.approval) {
        approvalAsked = chunk.approval;
        return;
      }
      if (chunk.tool) {
        if (chunk.tool.phase === 'done') doneRounds += 1;
        emit({ type: 'tool', taskId: item.id, tool: chunk.tool });
        return;
      }
      if (typeof chunk.delta === 'string') emit({ type: 'delta', taskId: item.id, text: chunk.delta });
      else if (typeof chunk.reasoning === 'string') emit({ type: 'reasoning', taskId: item.id, text: chunk.reasoning });
    };

    // Snapshot BEFORE the turn: without it there is no way to tell our edits
    // from a concurrent agent's, and scopedCommit refuses to sweep rather than
    // guess.
    const wantCommit = commit === undefined ? Boolean(item.commit) : Boolean(commit);
    const before = wantCommit ? safe(() => git.gitStatusSnapshot(cwd), null) : null;

    emit({ type: 'start', taskId: item.id, model, cwd, rounds });
    const started = now();
    let result;
    try {
      const res = await withRoundHorizon(rounds, env, () =>
        engine.chat(
          {
            class: 'aegis',
            model,
            prompt: taskPrompt(item, { carry, rounds }),
            // The pooled brain ("work autonomously" in the GUI): the server fans
            // the round out to several reasoning workers and synthesises. A
            // `singlePass` task opts out — the retry/write-up passes in the
            // engine send `brain: false` for exactly this reason.
            autonomous: !item.singlePass,
            effort,
            workers: item.workers || undefined,
            // The turn's working directory rides on `env`: engine.js reads the
            // tool loop's cwd from envFor(payload), so a top-level `cwd` field
            // is a directory the engine would ignore and every tool would run
            // in the host's own process.cwd() instead of the task's.
            env: { cwd },
            maxRounds: rounds,
            sessionId: sessionIdFor(item.id),
            stream: true,
          },
          onDelta
        )
      );
      const output = assistantText(res);
      result = {
        ok: true,
        output,
        usage: (res && res.usage) || null,
        stoppedOnRounds: Boolean(res && res.stoppedOnRounds),
        rounds: doneRounds || undefined,
      };
      if (approvalAsked) {
        // A gate that is up in an unattended run is a bug in the caller, and
        // it is better seen than hung on: the tool round cannot proceed past it,
        // and a card nobody can click is a task that never finishes.
        result.ok = false;
        result.error =
          `tool approval was requested for "${approvalAsked.tool || approvalAsked.name || 'a tool'}" ` +
          'with no one to answer it — construct the queue engine with approvals disabled ' +
          '(getConfirmMode: () => false)';
      }
    } catch (e) {
      result = { ok: false, error: errorText(e) };
    }
    result.ms = Math.max(0, now() - started);

    if (wantCommit) {
      result.commit = safe(
        () =>
          git.scopedCommit(cwd, {
            message: commitMessage(item),
            before,
          }),
        { ok: false, error: 'git-scope unavailable' }
      );
      result.files = committedPaths(result.commit, before, cwd, git);
    }

    emit({ type: 'finish', taskId: item.id, ok: result.ok, result });
    return result;
  }

  /** `git-scope` is filesystem/git work: a throw there must not lose the task's outcome. */
  function safe(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  /** The paths this task changed (everything dirty now that wasn't foreign). */
  function committedPaths(commit, before, cwd, git) {
    if (!commit || commit.skipped || commit.error) return [];
    const foreign = new Set((commit.foreign || []).map((p) => String(p)));
    const after = safe(() => git.gitStatusSnapshot(cwd), null);
    if (!after) return [];
    return [...after.keys()].filter((p) => !foreign.has(p));
  }

  /**
   * Drain pending tasks, one at a time, until the queue is empty (or `max` is
   * reached). Rebases on the file between tasks, so a task added mid-drain —
   * by another window, another host, or a `reconcile` — is picked up in the
   * same run instead of waiting for the next one.
   */
  async function proceed({ commit, max = 0, stopOnError = false, carry = '' } = {}) {
    const lock = queue.acquireLock(env);
    if (!lock.ok) {
      emit({ type: 'locked', holder: lock.holder });
      return { ok: false, locked: true, holder: lock.holder, ran: [], carry };
    }
    const ran = [];
    try {
      for (;;) {
        if (max > 0 && ran.length >= max) break;
        // Re-read the FILE every iteration, never a snapshot taken before the
        // loop: a task added mid-drain (another window, another host, this run's
        // own `reconcile`) has to be picked up by the same drain, and a stale
        // in-memory list is exactly how it would be missed.
        const items = queue.loadQueue(env);
        const recovered = queue.recoverStale(items);
        // Persisted, not just fixed in memory: without this write the items
        // stay `running` in the file, and the next drain re-pends them all over
        // again (a task whose worker was killed would look alive forever to
        // every other reader).
        if (recovered.length) {
          queue.saveQueue(env, items);
          emit({ type: 'recovered', ids: recovered });
        }
        const next = queue.pending(items)[0];
        if (!next) break;
        const outcome = await runOne(next, { commit, carry });
        carry = outcome.carry;
        ran.push(outcome);
        if (!outcome.ok && stopOnError) break;
      }
    } finally {
      queue.releaseLock(env);
    }
    return { ok: true, ran, carry };
  }

  /** Claim one task from the file, run it, write the outcome back. */
  async function runOne(item, { commit, carry = '' } = {}) {
    const items = queue.loadQueue(env);
    const claimed = queue.markRunning(items, item.id, { now: now() });
    if (!claimed) return { ok: false, error: `unknown task #${item.id}`, carry };
    queue.saveQueue(env, items);

    const result = await runTask(claimed, { carry, commit });

    const after = queue.loadQueue(env);
    queue.settle(after, claimed.id, {
      status: result.ok ? 'done' : 'error',
      result: {
        ok: result.ok,
        output: result.output || '',
        usage: result.usage || null,
        ms: result.ms,
        commit: result.commit || null,
        files: result.files || [],
      },
      error: result.ok ? null : result.error,
      now: now(),
    });
    queue.saveQueue(env, after);
    queue.appendRun(env, {
      id: claimed.id,
      task: claimed.task,
      cwd: claimed.cwd,
      model: resolveModel({ model: claimed.model, env }),
      status: result.ok ? 'done' : 'error',
      at: new Date(now()).toISOString(),
      ms: result.ms,
      usage: result.usage || null,
      files: result.files || [],
      error: result.ok ? null : result.error,
    });
    return { ...result, id: claimed.id, carry: appendDigest(carry, digestLine(claimed, result)) };
  }

  /**
   * Queue the next unfinished PLAN.md phase (and optionally work it straight
   * away). The phase text is looked up rather than pasted, so the task points
   * the model at the spec instead of paraphrasing it — a paraphrase in the
   * prompt is a second spec that can disagree with the file.
   */
  async function reconcile({ cwd = process.cwd(), auto = false, commit, max = 0, stopOnError = false } = {}) {
    const plan = queue.reconcilePlan(cwd, { write: true });
    if (!plan.ok) return { ok: false, error: plan.reason };
    if (plan.healed && plan.healed.changed) {
      emit({ type: 'healed', phases: plan.healed.added });
    }
    if (plan.next == null) return { ok: true, exhausted: true };

    const marker = `Work Phase ${plan.next} from PLAN.md`;
    const items = queue.loadQueue(env);
    const existing = items.find(
      (i) => i.cwd === cwd && String(i.task).startsWith(marker) && i.status !== 'done'
    );
    if (existing) {
      emit({ type: 'already-queued', phase: plan.next, id: existing.id, status: existing.status });
      if (!auto) return { ok: true, phase: plan.next, id: existing.id, existing: true };
    } else {
      const item = queue.addTask(env, {
        task:
          `${marker} ("${plan.title}") at ${cwd}. Read the full "## Phase ${plan.next}" section in ` +
          'PLAN.md at the repo root for the spec, exit criteria and constraints, and implement it ' +
          'exactly as scoped there. Keep the repo\'s checks green (`npm run check`, plus that ' +
          `package's tests). When every exit criterion is met, mark the "## Phase ${plan.next}" ` +
          'heading with ✅ in PLAN.md and update its line in the top Status checklist.',
        cwd,
        source: 'reconcile',
        model: resolveModel({ env }),
      });
      emit({ type: 'queued', phase: plan.next, id: item.id, title: plan.title });
    }
    if (!auto) return { ok: true, phase: plan.next, title: plan.title };
    const drained = await proceed({ commit, max, stopOnError });
    return { ok: true, phase: plan.next, title: plan.title, ...drained };
  }

  /**
   * The engine's session id for one task. Deterministic, because the engine
   * keeps its AbortController under this key (engine.js cancel()), so this is
   * the handle both writing the outcome and stopping the turn go through.
   */
  const sessionIdFor = (id) => `queue-${id}`;

  /**
   * Stop the task currently running. The engine owns cancellation through the
   * session id it registered, so this delegates instead of keeping a second
   * controller — a locally-held AbortSignal would be one the engine never reads.
   */
  function cancel(id) {
    if (id == null) return { ok: false, error: 'cancel needs a task id' };
    if (typeof engine.cancel !== 'function') return { ok: false, error: 'this engine cannot cancel a turn' };
    const res = engine.cancel(sessionIdFor(id));
    return { ok: Boolean(res && res.ok), sessionId: sessionIdFor(id) };
  }

  return { runTask, runOne, proceed, reconcile, cancel, sessionIdFor, resolveModel: (o) => resolveModel({ ...o, env }) };
}

/** One-line commit message for a task: its first line, clipped, and labelled. */
function commitMessage(item) {
  const first = String(item.task || 'queued task').split('\n')[0].replace(/\s+/g, ' ').trim();
  return `autonomous: ${first.slice(0, 66)}${first.length > 66 ? '…' : ''}`;
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_ROUNDS,
  isAutonomousRequest,
  maxRounds,
  withRoundHorizon,
  resolveModel,
  resolveEffort,
  autonomousDirective,
  taskPrompt,
  appendDigest,
  digestLine,
  assistantText,
  errorText,
  commitMessage,
  createQueueWorker,
};
