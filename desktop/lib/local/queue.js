'use strict';

/**
 * queue.js — the autonomous work queue.
 *
 * "Do X autonomously" means: nobody is at the keyboard, so the task has to
 * survive the conversation that produced it. This module is that survival: a
 * durable, crash-safe list of tasks in
 * `~/.aegiscode/queue.jsonl` (`$AEGISCODE_HOME`/`$AEGIS_HOME` override the dir,
 * `$AEGIS_QUEUE_FILE` the file) that any host — the desktop app, the
 * `aegiscode` CLI, a systemd timer — can add to, and that a worker drains one
 * task at a time.
 *
 * Why a FILE and not the renderer's in-memory state: the same reason the
 * session store exists. The desktop app owns the queue while it is open, but a
 * task queued at 18:00 has to still be there at 08:00 after a reboot, and the
 * CLI has to see the tasks the GUI queued. A process-local list answers
 * neither, so the queue is the file and every host is just a reader/writer of
 * it.
 *
 * Three properties are load-bearing, and each one exists because its absence
 * was a real failure:
 *
 * 1. WRITES ARE ATOMIC (temp file + rename). A queue that is rewritten in
 *    place loses everything on a crash mid-write — the same defect the session
 *    store was fixed for. Rename is atomic within a filesystem, so a reader
 *    sees either the old queue or the new one, never half of each.
 *
 * 2. WRITES ARE AN UPSERT keyed on id, never a blind overwrite of the whole
 *    file. A drain holds the queue in memory for minutes at a time, and
 *    anything added during that window (another host, another window, the
 *    queue's own `reconcile`) would be silently erased by the stale copy the
 *    drain saves back. The drain only ever writes back *its own* item's status
 *    (`settle`), and `upsert` merges instead of replacing, so a mid-drain add
 *    survives.
 *
 * 3. A `running` ITEM WHOSE PROCESS IS GONE IS `pending` AGAIN. A task is
 *    marked running with the pid holding it; when a worker is killed
 *    (SIGKILL, a reboot, a closed laptop) nothing gets to clear that flag, and
 *    a queue that trusts the flag is a queue that never runs that task again.
 *    `recoverStale` re-reads liveness instead of trusting the file, the same
 *    no-staleness-window pattern the worktree and session locks use.
 *
 * Pure-ish on purpose: every function takes its paths/clock/env from the
 * caller (or a `process.env` default), so the whole module is testable against
 * a temp dir with no Electron, no network, and no home directory.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The only legal statuses. `error` (not "failed") matches the runs log's. */
const STATUSES = Object.freeze(['pending', 'running', 'done', 'error']);

/**
 * The per-user data dir the whole repo already agrees on: `$AEGISCODE_HOME`
 * (this plugin's convention — see worktree-lock.js's worktreeLockDir and
 * config.js's aegisDir) or `~/.aegiscode`. `$AEGIS_HOME` is honoured as well so
 * a host that already exports it (the generic spelling) points at the same
 * place rather than quietly queueing into a second directory — two hosts
 * disagreeing about where the queue file goes is indistinguishable from having
 * no queue.
 */
function dataDir(env = process.env) {
  const e = env || {};
  const home = e.AEGISCODE_HOME || e.AEGIS_HOME;
  return home ? path.resolve(home) : path.join(os.homedir(), '.aegiscode');
}

/** The queue file for this environment (tests point AEGIS_QUEUE_FILE at a temp dir). */
function queuePath(env = process.env) {
  return (env && env.AEGIS_QUEUE_FILE) || path.join(dataDir(env), 'queue.jsonl');
}

/** Append-only accounting: one line per finished task, never rewritten. */
function runsPath(env = process.env) {
  return (env && env.AEGIS_RUNS_FILE) || path.join(dataDir(env), 'runs.jsonl');
}

/** The single-worker lock. One drain at a time; a second worker backs off. */
function lockPath(env = process.env) {
  return (env && env.AEGIS_QUEUE_LOCK) || path.join(dataDir(env), 'queue.lock');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── reading and writing ─────────────────────────────────────────────────────

/**
 * Parse a queue file. A line that does not parse is skipped rather than
 * thrown on: an interrupted append (power loss between `write` and `fsync`)
 * can leave a torn final line, and losing the whole queue to one bad byte is
 * a worse outcome than losing the one item that was mid-write.
 */
function readQueue(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // no queue yet is the normal first-run state, not an error
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const item = JSON.parse(text);
      if (item && typeof item === 'object' && item.id != null) out.push(item);
    } catch {
      /* torn or hand-edited line — skip it, keep the rest */
    }
  }
  return out;
}

/** Write the whole queue atomically (temp file + rename), mode 0600. */
function writeQueue(file, items) {
  ensureDir(path.dirname(file));
  const body = items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return items;
}

function loadQueue(env = process.env) {
  return readQueue(queuePath(env));
}

function saveQueue(env, items) {
  return writeQueue(queuePath(env), items);
}

/**
 * Highest id in the queue, +1. Ids increase for as long as the queue file has
 * any history to count, so they are never reused while anything remains. They
 * are NOT globally unique across generations: `clear --all` empties the file and
 * the next `add` starts again at #1. The runs log therefore records each task's
 * text and time alongside its id — a `#7` is unique within one queue generation,
 * and the text is what makes it identifiable across a `clear --all`.
 */
function nextId(items) {
  let max = 0;
  for (const i of items) {
    const n = Number(i && i.id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Insert or replace by id, leaving every other item in the list untouched.
 *
 * This is the ONLY way a drain writes back — `saveQueue(env, upsert(loadQueue(env),
 * myItem))` — and the load has to be FRESH, taken immediately before the write.
 * upsert can only preserve what the caller actually passed it: hand it a stale
 * snapshot and anything added since is erased, because `saveQueue` rewrites the
 * whole file. The worker re-reads before each of its two writes for exactly this
 * reason (autonomous.js: claim and settle). The remaining window is the instant
 * between that read and the write, which is why `add` never takes the drain lock
 * and a queue is a work list, not a ledger.
 */
function upsert(items, entry) {
  const list = Array.isArray(items) ? items : [];
  const idx = list.findIndex((i) => i && i.id === entry.id);
  if (idx === -1) list.push(entry);
  else list[idx] = { ...list[idx], ...entry };
  return list;
}

// ── the queue's own vocabulary ──────────────────────────────────────────────

/**
 * Queue a task. `cwd` is where the work happens (the worker runs the turn
 * with it as the tool loop's working directory), `model` is the AEGIS Cloud
 * model id to run it on, and `commit` asks the worker to commit what the task
 * changed (scoped — see autonomous.js).
 *
 * AEGIS CLOUD ONLY, REFUSED AT THE DOOR. The worker sends every task out as
 * `class: 'aegis'`, so a model the pool does not serve cannot run here at all —
 * it is a task that fails minutes into a drain, after being picked up, with an
 * opaque server error. `model: null` stays legal: that is "no pick", and
 * autonomous.resolveModel fills in the pooled brain. Anything else has to pass
 * that module's own accept-list, so the CLI (`aegiscode autonomous add
 * --model`), the desktop card and a hand-written queue file are all held to the
 * same rule. Required lazily: queue.js is a dependency of autonomous.js, and
 * this check must not turn that into a load-order cycle.
 */
function addTask(env, opts = {}) {
  const task = String(opts.task == null ? '' : opts.task).trim();
  if (!task) throw new Error('queue: a task needs text');
  const statedModel = String(opts.model == null ? '' : opts.model).trim();
  if (statedModel) {
    const refusal = require('./autonomous.js').modelRefusal(statedModel);
    if (refusal) throw new Error(`queue: ${refusal}`);
  }
  const items = loadQueue(env);
  const now = opts.now || Date.now();
  const entry = {
    id: nextId(items),
    task,
    cwd: opts.cwd || process.cwd(),
    model: statedModel || null,
    effort: opts.effort || null,
    workers: Number.isInteger(opts.workers) ? opts.workers : null,
    singlePass: Boolean(opts.singlePass),
    commit: Boolean(opts.commit),
    maxRounds: Number.isInteger(opts.maxRounds) ? opts.maxRounds : null,
    source: opts.source || 'manual',
    status: 'pending',
    attempts: 0,
    created: now,
    updated: now,
  };
  upsert(items, entry);
  saveQueue(env, items);
  return entry;
}

function findTask(items, id) {
  const n = Number(id);
  return (items || []).find((i) => Number(i && i.id) === n) || null;
}

/** Claim a task: `pending` → `running`, stamped with the pid that owns it. */
function markRunning(items, id, opts = {}) {
  const item = findTask(items, id);
  if (!item) return null;
  const now = opts.now || Date.now();
  item.status = 'running';
  item.pid = opts.pid || process.pid;
  item.startedAt = now;
  item.updated = now;
  item.attempts = (Number(item.attempts) || 0) + 1;
  return item;
}

/**
 * Record a finished task. `result` is whatever the worker learned (output
 * text, token usage, round count, the commit it made); it is kept verbatim so
 * the runs log and the queue never disagree about what happened.
 */
function settle(items, id, { status, result, error, now = Date.now() } = {}) {
  const item = findTask(items, id);
  if (!item) return null;
  item.status = STATUSES.includes(status) ? status : 'error';
  item.updated = now;
  item.finishedAt = now;
  delete item.pid;
  if (result !== undefined) item.result = result;
  if (error) item.error = String(error);
  else delete item.error;
  return item;
}

/** Put a task back at the head of the queue, keeping its attempt count. */
function retryTask(env, id, opts = {}) {
  const items = loadQueue(env);
  const item = findTask(items, id);
  if (!item) return null;
  item.status = 'pending';
  item.updated = opts.now || Date.now();
  delete item.error;
  delete item.pid;
  // A manual retry is a fresh deliberate ask, so it gets its own full run of
  // MAX_ROUND_STOPS chances (autonomous.js) rather than inheriting whatever
  // count a previous, unrelated failure left behind.
  delete item.roundStops;
  saveQueue(env, items);
  return item;
}

/**
 * Drop finished items. Pending and running are NEVER removed: `clear` is the
 * "tidy the log" command, and a user who runs it mid-drain must not lose the
 * task that is running or the ones waiting. `all: true` (`--all`) is the
 * explicit "empty it" escape hatch.
 */
function clearQueue(env, { all = false } = {}) {
  const items = loadQueue(env);
  const kept = all ? [] : items.filter((i) => i.status === 'pending' || i.status === 'running');
  const removed = items.length - kept.length;
  saveQueue(env, kept);
  return { removed, kept: kept.length };
}

/** True if `pid` names a live process (EPERM means it exists but isn't ours). */
function isAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

/**
 * Re-read liveness for every `running` item. A running item whose pid is gone
 * (or which never recorded one) goes back to `pending`; the queue's promise is
 * that a task is worked eventually, and "a dead process left the flag up" is
 * not an acceptable reason for it never to be.
 *
 * Items held by a LIVE pid are left alone — that process is the drain, and
 * re-pending its item would run it twice.
 */
function recoverStale(items, { isAliveFn = isAlive, now = Date.now() } = {}) {
  const recovered = [];
  for (const item of items || []) {
    if (!item || item.status !== 'running') continue;
    if (item.pid && isAliveFn(item.pid)) continue;
    item.status = 'pending';
    item.updated = now;
    item.recoveredAt = now;
    delete item.pid;
    recovered.push(item.id);
  }
  return recovered;
}

/** Count of tasks a drain still has to work. */
function pendingCount(items) {
  return (items || []).filter((i) => i && i.status === 'pending').length;
}

/** Pending tasks in queue order (the order they were added). */
function pending(items) {
  return (items || []).filter((i) => i && i.status === 'pending');
}

// ── single-worker lock ──────────────────────────────────────────────────────

function lockHolder(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(env), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Take the drain lock, or report who holds it.
 *
 * Only ONE drain may run at a time. Two drains are not twice as fast: they
 * share a working tree, and the second one's `git add`/commit races the
 * first's — the exact multi-agent-one-checkout failure the worktree lock
 * exists for. The lock is a marker with a pid in it, not a timeout, so a
 * worker killed with SIGKILL is reclaimed by the next caller immediately
 * rather than after a staleness window nobody can tune correctly.
 */
function acquireLock(env = process.env, { pid = process.pid, now = Date.now(), isAliveFn = isAlive } = {}) {
  const file = lockPath(env);
  const holder = lockHolder(env);
  if (holder && holder.pid && holder.pid !== pid && isAliveFn(holder.pid)) {
    return { ok: false, holder };
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ pid, host: os.hostname(), startedAt: now }), { mode: 0o600 });
  return { ok: true, holder: { pid, startedAt: now } };
}

/** Release the lock, but only if we still hold it (never free another's). */
function releaseLock(env = process.env, { pid = process.pid } = {}) {
  const holder = lockHolder(env);
  if (holder && holder.pid && holder.pid !== pid) return { ok: false, holder };
  try {
    fs.unlinkSync(lockPath(env));
    return { ok: true };
  } catch {
    return { ok: true, already: true };
  }
}

// ── run accounting ──────────────────────────────────────────────────────────

/**
 * Append one finished run. Append-only and never rewritten: the queue is
 * current state (and is deliberately small), the runs log is history, and
 * history that can be truncated by a crash is not history.
 */
function appendRun(env, record) {
  const file = runsPath(env);
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

function readRuns(env = process.env, { limit = 20 } = {}) {
  let raw = '';
  try {
    raw = fs.readFileSync(runsPath(env), 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const slice = limit > 0 ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* same tolerance as readQueue */
    }
  }
  return out;
}

// ── reconcile: pull the next PLAN.md phase into the queue ───────────────────
//
// PLAN.md carries a top `Status:` checklist (`- [x] Phase N — …`) plus one
// `## Phase N …` section per phase, marked done with a ✅ in the heading. The
// two have drifted here before (a phase shipped with a ✅ heading and no
// checklist line), so a phase counts as done if EITHER says so, and a missing
// checklist line under a ✅ heading is healed from the heading rather than
// silently re-queued as work.

function planPath(cwd) {
  return path.join(cwd, 'PLAN.md');
}

function parsePlanStatus(text) {
  const statusDone = new Map(); // phase number -> checked?
  const headerDone = new Set(); // phase numbers whose heading carries ✅
  const headerNums = new Set(); // every phase number with a heading
  let inStatus = false;
  for (const line of String(text || '').split('\n')) {
    if (/^Status:/.test(line)) {
      inStatus = true;
      continue;
    }
    if (inStatus) {
      const m = line.match(/^- \[([ x])\] Phase (\d+)/);
      if (m) {
        statusDone.set(Number(m[2]), m[1] === 'x');
        continue;
      }
      // Blank lines and indented wraps belong to the same list item/block.
      if (line.trim() === '' || /^\s+\S/.test(line)) continue;
      inStatus = false; // anything else (e.g. '---') ends the block
    }
    // Every PLAN.md in these repos writes `## Phase 7 ✅ — title` (✅ right after
    // the number). A trailing `## Phase 7 — title ✅` is accepted too, because
    // reconcile reads plans other sessions and agents wrote, and a heading that
    // says it shipped means it shipped wherever the ✅ sits.
    const hm = line.match(/^##\s*Phase\s+(\d+)\b/);
    if (hm) {
      const num = Number(hm[1]);
      headerNums.add(num);
      if (/✅/.test(line.slice(hm[0].length))) headerDone.add(num);
    }
  }
  return { statusDone, headerDone, headerNums };
}

function extractPhaseTitle(text, num) {
  const m = String(text || '').match(new RegExp(`^## Phase ${num}\\b(.*)$`, 'm'));
  if (!m) return `Phase ${num}`;
  const rest = m[1]
    .trim()
    .replace(/^(✅|⚠️)\s*/, '')
    .replace(/\s*(✅|⚠️)$/, '')
    .replace(/^[—-]\s*/, '')
    .trim();
  return rest || `Phase ${num}`;
}

/** Append a checklist line for any ✅ heading the Status list never got. */
function healPlanStatus(text, parsed) {
  const missing = [...parsed.headerDone].filter((n) => !parsed.statusDone.has(n)).sort((a, b) => a - b);
  if (!missing.length) return { text, changed: false, added: [] };
  const lines = String(text || '').split('\n');
  const statusStart = lines.findIndex((l) => /^Status:/.test(l));
  if (statusStart === -1) return { text, changed: false, added: [] };
  let lastListIdx = -1;
  for (let i = statusStart + 1; i < lines.length; i++) {
    if (/^- \[[ x]\] Phase \d+/.test(lines[i])) {
      lastListIdx = i;
      continue;
    }
    if (lines[i].trim() === '' || /^\s+\S/.test(lines[i])) continue;
    break;
  }
  if (lastListIdx === -1) return { text, changed: false, added: [] };
  const newLines = missing.map((n) => `- [x] Phase ${n} — ${extractPhaseTitle(text, n)}`);
  lines.splice(lastListIdx + 1, 0, ...newLines);
  return { text: lines.join('\n'), changed: true, added: missing };
}

/**
 * Read PLAN.md and say what the next uncompleted phase is, healing the Status
 * checklist on the way (when `write` is true). Returns `{ ok, text, parsed,
 * healed, next, title }` — the caller decides what to do with it, so the pure
 * read is testable and nothing here queues on its own.
 */
function reconcilePlan(cwd, { write = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(planPath(cwd), 'utf8');
  } catch {
    return { ok: false, reason: `no PLAN.md in ${cwd}`, next: null };
  }
  const parsed = parsePlanStatus(text);
  const healed = healPlanStatus(text, parsed);
  if (healed.changed && write) {
    fs.writeFileSync(planPath(cwd), healed.text);
    text = healed.text;
  }
  const done = new Set(parsed.headerDone);
  for (const [num, checked] of parsed.statusDone) if (checked) done.add(num);
  const next = [...parsed.headerNums].filter((n) => !done.has(n)).sort((a, b) => a - b)[0];
  if (next == null) return { ok: true, text, parsed, healed, next: null, title: null };
  return { ok: true, text, parsed, healed, next, title: extractPhaseTitle(text, next) };
}

module.exports = {
  STATUSES,
  dataDir,
  queuePath,
  runsPath,
  lockPath,
  ensureDir,
  readQueue,
  writeQueue,
  loadQueue,
  saveQueue,
  nextId,
  upsert,
  addTask,
  findTask,
  markRunning,
  settle,
  retryTask,
  clearQueue,
  isAlive,
  recoverStale,
  pendingCount,
  pending,
  lockHolder,
  acquireLock,
  releaseLock,
  appendRun,
  readRuns,
  planPath,
  parsePlanStatus,
  extractPhaseTitle,
  healPlanStatus,
  reconcilePlan,
};
