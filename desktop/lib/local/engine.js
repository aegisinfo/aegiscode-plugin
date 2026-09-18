'use strict';

/**
 * engine.js — the desktop LocalEngine registry (plan P1 §5.2). Transport-only:
 * it owns the provider settings/credentials and routes a chat payload to the
 * cloud client, the local Ollama module, or a custom OpenAI/Anthropic-
 * compatible endpoint. No tier/brain/routing decisions are made here — the
 * chosen class is the user's explicit selection.
 *
 * Since the tool-calling port it ALSO owns the agent loop (the client half of
 * aegiscodex-dev's src/backend.js runProvider): every turn carries a real
 * system prompt (prompt.js) and the builtin tool schemas (tools.js), and when
 * a provider answers with tool calls the loop executes them in-process and
 * feeds the results back for as many rounds as the model keeps calling tools
 * — there is no round cap; a turn ends when the model answers with text, or
 * the user cancels it (cancel()/AbortController).
 *
 * Because a provider can signal "finished" with no answer attached, the two
 * exit paths are guarded against the empty turn (see the loop's comment):
 * a `finish_reason: 'length'` completion with no text is retried once with a
 * doubled budget, and a turn that ends with neither text nor a tool call is
 * re-dispatched once with `tools: []` plus a nudge so the model has to write
 * up what it already gathered. A turn still empty after both throws instead
 * of returning a blank completion for the renderer to paint "(empty
 * response)" over. The window stays
 * contextIsolated + sandboxed: this module runs in the MAIN process, so the
 * executor never has to be exposed to the renderer.
 *
 * Two turn-scoped resources ride along with the loop, mirroring
 * aegiscodex-dev's runProvider exactly:
 *   - a lazily-started ShellSession (shell.js) that the `exec` tool shares,
 *     so cd/export state persists across calls within one turn instead of
 *     each call spawning a fresh process;
 *   - the `task` tool, executed as a nested `chat()` call on the chosen
 *     specialist preset (agents.js) rather than a local tool — a subagent
 *     turn with its own tool rounds, bounded by MAX_SUBAGENT_DEPTH so a
 *     delegation chain can't recurse forever.
 *
 * Pure Node + dependency-injected (aegis client, settings store, ollama,
 * providers, optionally tools/prompt) so it unit-tests without Electron.
 */

const { randomUUID } = require('node:crypto');
const os = require('node:os');

const toolsModule = require('./tools.js');
const promptModule = require('./prompt.js');
const { ShellSession } = require('./shell.js');
const { agentSystemPrompt, agentRoleLabel } = require('./agents.js');
// Cooperative working-tree sharing (see each module's header). The lock
// serialises two hosts that start a turn on one checkout close together; the
// guard is the load-bearing half — it refuses a tree-wide git operation while
// another session's uncommitted work is present, which is the operation that
// destroyed a peer's file for real. Both live beside the engine because the
// CLI vendors this directory wholesale (cli/scripts/predist.mjs), so the GUI
// and the terminal get one implementation rather than two that drift.
const { beginTurnGuard, recordWrite, blocksDestructive } = require('./turn-guard.js');
const { acquireWorktreeLock, releaseWorktreeLock } = require('./worktree-lock.js');

/**
 * How long a turn waits for the working-tree lock before running anyway.
 *
 * Short on purpose. This engine serves interactive hosts — a desktop window
 * and a terminal — where stalling for the lock's own 11-minute default would
 * be a worse failure than contending: the user is watching a spinner. So the
 * lock is best-effort mutual exclusion for turns that start near-simultaneously
 * (the common overlap), and the turn guard covers everything after that. A
 * non-interactive caller that can afford to queue should pass
 * `payload.worktreeWaitMs` with the long DEFAULT_WORKTREE_WAIT_MS instead.
 */
const WORKTREE_LOCK_WAIT_MS = 1500;

/** Classes whose transport is a user-supplied endpoint + credential. */
const CUSTOM_CLASSES = Object.freeze(['openai-compat', 'anthropic']);

/**
 * Depth at which the task tool stops being offered. The main chat (depth 0)
 * and subagents down to depth MAX_SUBAGENT_DEPTH - 1 can all delegate, so
 * legitimate hierarchical work (scan -> review -> patch, etc.) has room to
 * nest without hitting a wall. Past that the tool is dropped, hard-cutting a
 * runaway chain instead of letting it recurse unbounded.
 */
const MAX_SUBAGENT_DEPTH = 4;

const CLASSES = [
  { class: 'aegis', label: 'Aegis Cloud', kind: 'cloud' },
  { class: 'ollama', label: 'Ollama (local)', kind: 'local' },
  { class: 'openai-compat', label: 'Custom OpenAI-compatible', kind: 'custom' },
  { class: 'anthropic', label: 'Anthropic-compatible', kind: 'custom' },
  { class: 'byok', label: 'Bring your own key', kind: 'cloud' },
];

/** Local settings namespace for one BYOK provider's key. A `byok:` prefix
 *  keeps this out of the 'anthropic'/'openai-compat' CUSTOM_CLASSES' own
 *  namespaces, which are a different feature (a self-hosted/compatible
 *  endpoint's base URL + key) — same store, deliberately separate rows. */
function byokNamespace(providerId) {
  return `byok:${providerId}`;
}

/** Split a byok model id ("anthropic:claude-sonnet-5") into its provider and
 *  bare model parts. `modelId` may itself contain ':' (none of today's
 *  catalog ids do, but nothing guarantees that), so only the FIRST segment is
 *  the provider — the rest re-joins as the model. */
function splitByokModel(compound) {
  const s = typeof compound === 'string' ? compound : '';
  const i = s.indexOf(':');
  if (i < 0) return { provider: '', model: s };
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

/**
 * Mirrors aegiscodex-dev's src/backend.js DEEPSEEK_REASONING_MODEL_RE +
 * EFFORT_TOKEN_BUDGET verbatim. DeepSeek's reasoning models (deepseek-flash,
 * i.e. "Flash 4.1", deepseek-v4-pro, the deprecated deepseek-reasoner, and the
 * legacy v4-flash/v4.1-flash aliases some configs still carry) spend part of
 * the budget on hidden chain-of-thought before ever emitting visible content —
 * DeepSeek counts reasoning tokens against the same budget as content. Under
 * the renderer's removed 4k dropdown default, any non-trivial question could
 * burn the whole budget reasoning and finish with empty content: no error, no
 * tool calls, just a turn that "completes" with nothing to show for it (the
 * empty-response bug). A user pointing the Custom OpenAI-compatible class
 * straight at DeepSeek's API hits exactly this, so the request is sized by the
 * same effort budget aegiscodex-dev uses for its own direct DeepSeek calls.
 *
 * desktop/renderer/budget.js carries the renderer's copy of these two
 * constants plus budgetFor() below; test/budget.test.mjs requires both and
 * asserts they agree, so the mirror cannot drift silently.
 */
const DEEPSEEK_REASONING_MODEL_RE = /^deepseek-(v4(\.\d+)?-(flash|pro)|flash|pro|reasoner)$/;
const EFFORT_TOKEN_BUDGET = { low: 8192, medium: 16384, high: 32768 };

/** The one class whose wire format REQUIRES a stated `max_tokens`: Anthropic's
 *  Messages API 400s without it, so that field is derived from the effort rung
 *  rather than invented by the transport (which is what a blanket
 *  `max_tokens: maxTokens || 4096` did — see providers.anthropicMessages). */
const REQUIRES_STATED_BUDGET = new Set(['anthropic']);

/**
 * Idle-stream budget for a pooled brain call ("work autonomously"). The
 * generic watchdog in vendor/aegis.js kills a stream that goes 60s without a
 * byte — right default for one provider call answering, wrong for a worker
 * fan-out: pool_brain yields a header chunk, then stays silent until the
 * FIRST worker pass *returns*, and each worker is a full reasoning-model call
 * at roughly 1/(workers+1) of the effort budget. At high effort, 3 workers,
 * that is a multi-thousand-token reasoning pass per worker — easily past a
 * minute. Timing out there aborts a perfectly healthy autonomous turn
 * mid-flight, after the server has already run and billed every worker.
 *
 * 15 minutes deliberately outlasts the server's OWN ceiling for that window
 * (aegis1 services/pool_brain.py: NEXUS_BRAIN_WORKER_TIMEOUT, default 600s),
 * because aborting first leaves the server running and billing a fan-out
 * nobody will ever see. Raising that env var past ~14 minutes means raising
 * this constant too; the shared client applies the same budget from the
 * server's X-AEGIS-Brain response header (see client/aegis.js idleBudgetFor),
 * which is what covers a fan-out the caller did not flag — test/
 * autonomous-mode.test.mjs pins both halves.
 */
const AUTONOMOUS_IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * The budget a request travels with, resolved from EXACTLY ONE authority per
 * call — the engine-side half of the rule desktop/renderer/budget.js mirrors
 * and test/budget.test.mjs compares the two halves of, so neither can drift.
 *
 *   1. a caller-stated number IS the budget and is returned verbatim. It is a
 *      deliberate liability ceiling (aegis1 pass_budgets honours it downward:
 *      total = min(ladder, max_tokens x passes)) and no rung may raise it — the
 *      old `Math.max(stated, EFFORT_TOKEN_BUDGET[eff])` form did exactly that,
 *      so a caller asking for 1024 silently ran on 32768.
 *   2. with nothing stated, a model that reasons against its own output budget
 *      (DeepSeek bills hidden chain-of-thought against the SAME budget as the
 *      answer) or a class whose wire format REQUIRES the field (Anthropic's
 *      Messages API) gets the Effort rung. This is why the renderer's
 *      max-tokens dropdown was removed rather than fixed: at its 4k default a
 *      reasoning model spent the entire budget thinking and finished empty —
 *      no error, no tool call, just a "completed" turn with nothing in it.
 *   3. otherwise `undefined` — no `max_tokens` goes on the wire and the
 *      provider's own output limit governs. The transport used to fill this
 *      gap with an invented 4096 default, which is the defect in (2).
 *
 * Truncated and empty turns are still handled where they belong — the
 * doubled-budget retry plus emptyTurnError — rather than by inflating the
 * caller's ceiling up front.
 */
function reasoningBudget(cls, model, maxTokens, effort) {
  const stated = Number(maxTokens);
  if (Number.isFinite(stated) && stated > 0) return stated;
  if (DEEPSEEK_REASONING_MODEL_RE.test(String(model || '')) || REQUIRES_STATED_BUDGET.has(cls)) {
    const eff = effort === 'low' || effort === 'medium' ? effort : 'high';
    return EFFORT_TOKEN_BUDGET[eff];
  }
  return undefined;
}

/** Relay model entries arrive as ids or objects; keep only real model ids. */
function normalizeCatalog(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && m.id);
}

/**
 * The Aegis Cloud catalog (`/api/v1/models`) lists every backend the pool can
 * reach: per-provider ids (`openai`, `anthropic`, `groq`, `gemini`, ...) and
 * six pooled-brain tier ids (`{aegis,nexus}-brain[-smart|-neo]`) that all run
 * the same worker pool on the same backend model. None of that is a human's
 * model choice — which providers currently hold a valid key is an ops detail
 * (today: deepseek/anthropic/groq; openai and gemini drift in and out), and
 * surfacing it invites picking a provider that happens to be dead right now.
 * The pool already auto-routes across whichever providers are live, so the
 * desktop dropdown offers exactly one entry for the "aegis" class: the
 * collapsed "Nexus" brain — never the raw provider list.
 */
const NEXUS_BRAIN_IDS = Object.freeze(['nexus-brain', 'aegis-brain']);
const NEXUS_LABEL = 'Nexus';

/**
 * Pick the one entry standing in for the pooled brain. The server serves
 * `nexus-brain` as the canonical tier (`hidden: false`, no `alias_of`) and
 * marks every other spelling — `aegis-brain` and the `-smart`/`-neo` tiers —
 * as `hidden: true, alias_of: "nexus-brain"`. Prefer the canonical id so the
 * request travels on the name the server owns; fall back to the alias, then to
 * any tier whose `alias_of` names the brain, so a renamed or trimmed catalog
 * still resolves to something selectable instead of silently emptying the
 * dropdown (the previous fixed-id lookup returned [] if `aegis-brain` was ever
 * retired, leaving the class with no model to choose).
 */
function selectBrainEntry(models) {
  return (
    models.find((m) => NEXUS_BRAIN_IDS.includes(m.id) && !m.hidden && m.alias_of === undefined)
    || models.find((m) => NEXUS_BRAIN_IDS.includes(m.id))
    || models.find((m) => m.alias_of && NEXUS_BRAIN_IDS.includes(m.alias_of))
    || null
  );
}

function filterAegisCatalog(models) {
  const nexus = selectBrainEntry(models);
  if (!nexus) return [];
  // Drop the alias bookkeeping: this entry *is* the selection, so the renderer
  // must never treat it as a hidden alias and filter it back out.
  const { hidden, alias_of, ...rest } = nexus;
  return [{ ...rest, label: NEXUS_LABEL }];
}

// ── Agent-loop helpers ──────────────────────────────────────────────────────

/** Parse a model-supplied argument blob (string or already-parsed object). */
function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Pull normalised tool calls out of whichever shape the transport returned:
 * the shared `result.toolCalls` both local parsers emit, or a provider-native
 * `choices[0].message.tool_calls` (the Aegis pool relays the upstream OpenAI
 * shape verbatim).
 */
function extractToolCalls(res) {
  if (!res) return [];
  if (Array.isArray(res.toolCalls) && res.toolCalls.length) {
    return res.toolCalls
      .map((c) => ({ id: c.id || '', name: c.name || '', args: parseArgs(c.args) }))
      .filter((c) => c.name);
  }
  const msg = res.choices && res.choices[0] && res.choices[0].message;
  const raw = (msg && msg.tool_calls) || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((tc) => {
      const fn = (tc && tc.function) || {};
      return { id: (tc && tc.id) || '', name: fn.name || (tc && tc.name) || '', args: parseArgs(fn.arguments) };
    })
    .filter((c) => c.name);
}

/** The textual content of one assistant turn (empty when it only called tools). */
function assistantText(res) {
  const msg = res && res.choices && res.choices[0] && res.choices[0].message;
  return (msg && typeof msg.content === 'string' && msg.content) || '';
}

/**
 * The provider's stop reason for a completion ('' when it sent none). The two
 * wire formats report it in different places and both have to be read: the
 * OpenAI shape carries `choices[0].finish_reason` (this is what providers.js
 * and vendor/aegis.js emit), while providers.js's Anthropic parser puts
 * `stop_reason` on the result and never sets a finish_reason on the choice.
 */
function finishReasonOf(res) {
  const choice = res && res.choices && res.choices[0];
  return (choice && choice.finish_reason) || (res && res.stop_reason) || '';
}

/**
 * True when the provider cut the answer off at the token budget instead of
 * the model choosing to stop. This is the diagnosis for the most common
 * flavour of the empty turn: DeepSeek (and other reasoning models that bill
 * hidden chain-of-thought against max_tokens) can spend the entire budget
 * before emitting a single visible token, and the completion still arrives
 * as a clean `finish_reason: 'length'` — no error, empty content. A tool
 * call whose JSON was truncated mid-argument lands here too, where
 * parseArgs() would otherwise silently yield `{}` and run the tool with no
 * arguments, which is worse than retrying.
 */
function isTruncated(res) {
  const reason = finishReasonOf(res);
  // 'length' is OpenAI's wording, 'max_tokens' is Anthropic's — same event.
  return reason === 'length' || reason === 'max_tokens';
}

/**
 * Double a budget for the one-shot truncation retry. A budget the caller set
 * on purpose (the flow lane's deliberate 1024-token cap, say) is merely
 * doubled — the floor only applies when nothing was set at all, so a retry
 * can never silently override a small cap by an order of magnitude.
 */
function doubledBudget(maxTokens) {
  const n = Number(maxTokens) || 0;
  return n > 0 ? n * 2 : 8192;
}

/**
 * The cap the CALLER stated, or `undefined` meaning "none was stated".
 *
 * The two branches resolve one question — whose number is this? — and the
 * first is the fix. An internal re-entry (runSubagent's nested chat()) passes
 * `statedMaxTokens` explicitly, because the `maxTokens` it holds is the rung
 * reasoningBudget() derived from `effort`: a number the server is about to
 * derive for itself. Re-reading that value as the caller's own is what put a
 * guessed 32768 on the wire as a *ceiling over* aegis1's ladder
 * (pass_budgets: total = min(ladder, max_tokens x passes)) — so a
 * high-effort subagent silently ran at 8192 and the ladder the UI advertised
 * was not the budget the call used.
 *
 * A non-numeric or non-positive value means "nothing stated" — never a 0- or
 * NaN-token ceiling.
 */
function statedCapOf(payload) {
  const asCap = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'statedMaxTokens')) {
    return asCap(payload.statedMaxTokens);
  }
  return asCap(payload && payload.maxTokens);
}

/**
 * The follow-up shown to a model that ended its turn with neither text nor a
 * tool call. Sent as a plain user message (never as a tool result — there is
 * no pending tool call to answer) so every provider accepts it verbatim.
 */
const EMPTY_TURN_NUDGE =
  'Your previous reply came back empty — it contained no answer and no tool call. ' +
  'Write your answer now, using only the information already gathered above. ' +
  'No tools are available in this reply, so do not call any: respond in plain ' +
  'prose or markdown.';

/**
 * Last resort for a turn that is still empty after the synthesis pass.
 *
 * Throws rather than returning the blank completion. Returning it is what
 * produces the renderer's undiagnosable "(empty response)" bubble, and
 * synthesising fake assistant text instead would be worse: renderer/app.js
 * persists whatever comes back as the assistant's own message and syncs it
 * to the aegis account, so the notice would re-enter the model's context on
 * the next turn as something it had said. Failing loudly leaves the turn's
 * real tool log on screen, keeps the transcript honest, and names the cause
 * (renderer prints `Error: <message>`).
 */
function emptyTurnError({ cls, model, maxTokens, finishReason }) {
  const err = new Error(
    `The model returned no answer after ${cls}/${model} was asked to summarise its results ` +
      `(stop reason: ${finishReason || 'none'}, max_tokens: ${maxTokens || 'unstated'}). The token budget ` +
      'was most likely consumed before any visible text — raise the Effort rung, which is ' +
      'what sizes this call, or ask for a smaller piece of work.'
  );
  err.status = 502;
  return err;
}

function createLocalEngine({ aegis, settings, ollama, providers, tools, promptBuilder, env, getConfirmMode }) {
  const controllers = new Map(); // sessionId -> AbortController
  const T = tools || toolsModule;
  const buildSystemPrompt = (promptBuilder && promptBuilder.buildSystemPrompt) || promptModule.buildSystemPrompt;

  /** "Confirm before running tools" (Settings toggle, persisted by
   *  lib/settings.js. Because gatedExecuteTool is called for EVERY tool round
   *  it is read per call, not captured once at construction: flipping the
   *  switch takes effect on the next tool call, with no restart.
   *  An explicit `getConfirmMode` factory arg wins (used by tests); then the
   *  settings store's own accessor; then the safe default — ON, i.e. the gate
   *  stays up, so a store that predates the toggle can never silently
   *  disable it. */
  // Session-scoped round accounting (lib/local/session-rounds.js): the
  // tool-round cap is held against the *session* rather than the single turn,
  // so a turn that reaches its horizon is resumed by the next turn in the same
  // conversation instead of being cut off with the work lost. Module-level
  // state, so it survives `send()` and even a fresh engine instance.
  const sessionRounds = require('./session-rounds.js');
  const confirmModeEnabled = () => {

    if (typeof getConfirmMode === 'function') return getConfirmMode() !== false;
    if (settings && typeof settings.getConfirmMode === 'function') {
      const value = settings.getConfirmMode();
      return value === undefined ? true : Boolean(value);
    }
    return true;
  };

  // ── Tool-call approval gate (renderer confirms exec/writeFile/editFile
  // before they run) ─────────────────────────────────────────────────────
  //
  // `sessionAllowlists` is keyed by the CONVERSATION's root session id (the
  // one the renderer's `send()` mints once per thread and reuses across
  // turns — see rootSessionId below), never by the per-call sessionId a
  // subagent gets, so "allow for this session" reads the way the user sees
  // it: one decision per open conversation, not per nested tool round.
  // In-memory only, on purpose — never persisted, so a restart (or
  // newChat()'s clearSessionApprovals) always starts from a clean gate.
  const sessionAllowlists = new Map(); // rootSessionId -> Set<toolName>
  // Denials are remembered for the same reason allows are, mirroring it for
  // the other answer. Without this, a "Deny" was forgotten the instant it was
  // given: the model read `… the user denied the request`, re-planned, called
  // the SAME tool again, and the gate raised a SECOND card — so one "no" cost
  // the user a prompt per round for up to maxRounds (24 chat / 40 autonomous)
  // rounds, each round re-sending the whole conversation to the provider. A
  // gate that only remembers "yes" turns a single click into a retry storm;
  // remembering "no" makes the first answer stick.
  const sessionDenials = new Map(); // rootSessionId -> Set<toolName>
  const pendingApprovals = new Map(); // approvalId -> { resolve }

  function sessionAllows(rootId, name) {
    const set = sessionAllowlists.get(rootId);
    return Boolean(set && set.has(name));
  }

  function allowForSession(rootId, name) {
    if (!sessionAllowlists.has(rootId)) sessionAllowlists.set(rootId, new Set());
    sessionAllowlists.get(rootId).add(name);
  }

  /** Has this conversation already refused this tool? Checked before the card
   *  is raised, so a repeat call is refused outright instead of re-prompting. */
  function sessionDenies(rootId, name) {
    const set = sessionDenials.get(rootId);
    return Boolean(set && set.has(name));
  }

  function denyForSession(rootId, name) {
    if (!sessionDenials.has(rootId)) sessionDenials.set(rootId, new Set());
    sessionDenials.get(rootId).add(name);
  }

  /**
   * The text a refused tool hands back to the model. The old one-line
   * `"<tool> was not executed — the user denied the request."` read to a
   * capable agent as a transient failure to route around: it would apologise,
   * pick a different command that does the same thing, and call the gate
   * again. This says the durable part out loud (the refusal covers the rest of
   * the conversation, not just that call) and asks for the one response that
   * actually helps — say what you need and stop, so the user can re-enable it.
   */
  function denialText(name) {
    return (
      `${name} was not executed — the user denied this tool for this conversation. ` +
      `Do NOT retry it and do NOT attempt the same effect by another route ` +
      `(another command, a writeFile instead of an edit, a subagent). ` +
      `Stop calling tools and reply in plain text: say what you were trying to do, ` +
      `what you need, and that the user can re-enable ${name} to let it proceed.`
    );
  }

  /** newChat() in the renderer calls this so a fresh conversation never
   *  inherits a prior thread's blanket allows — or its refusals. A new chat is
   *  a new gate in both directions: leaving denials behind would silently
   *  refuse a tool in a thread where the user never said no. */
  function clearSessionApprovals(rootSessionId) {
    sessionAllowlists.delete(rootSessionId);
    sessionDenials.delete(rootSessionId);
    return { ok: true };
  }

  /** The renderer's approval card resolves the pending requestApproval()
   *  promise below. An unknown/already-answered id is a no-op — the card
   *  can only be clicked once (it disables itself), but a duplicate or
   *  late message must never throw. */
  function respondApproval(approvalId, decision) {
    const pending = pendingApprovals.get(approvalId);
    if (!pending) return { ok: false };
    pendingApprovals.delete(approvalId);
    pending.resolve(decision === 'session' || decision === 'once' ? decision : 'deny');
    return { ok: true };
  }

  /**
   * Ask the renderer to approve one mutating tool call. Resolves 'once',
   * 'session' or 'deny' (an explicit choice by the user) — or 'cancel' when
   * nobody ever answered: no listener able to reply, or the turn was aborted.
   * 'cancel' is kept apart from 'deny' on purpose. Both refuse the call, but
   * only 'deny' is a decision the user made, so only 'deny' may be remembered
   * as "this conversation said no" (see sessionDenials). Folding the two
   * together — which is what the old fail-safe did, resolving 'deny' for an
   * abort — would let a cancelled turn permanently refuse a tool the user
   * never ruled on. Sent over `rootOnDelta` (see chat()) as an `{ approval }`
   * chunk so it rides the exact same streaming channel as tool-activity
   * chunks — no new IPC surface needed on the push side, only on the reply
   * side (respondApproval). Fails safe: an unanswered request refuses the
   * call instead of hanging the tool round forever.
   */
  function requestApproval(rootSessionId, rootOnDelta, signal, info) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) {
        resolve('cancel');
        return;
      }
      const id = randomUUID();
      let settled = false;
      const onAbort = () => finish('cancel');
      const finish = (decision) => {
        if (settled) return;
        settled = true;
        pendingApprovals.delete(id);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(decision);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      pendingApprovals.set(id, { resolve: finish });
      if (typeof rootOnDelta !== 'function') {
        finish('cancel');
        return;
      }
      rootOnDelta({
        delta: '',
        approval: {
          id,
          sessionId: rootSessionId,
          tool: info.tool,
          args: info.args,
          diff: info.diff || null,
        },
      });
    });
  }

  /**
   * The gate itself: read-only tools and already-session-allowed mutating
   * tools run exactly like executeTool always did. A first-time mutating
   * call previews writeFile/editFile (a preview failure — e.g. old_string
   * not found — is returned as the ordinary tool error, no approval prompt
   * needed for a call that couldn't succeed anyway), asks the renderer, and
   * on approval either applies with a fresh hash check (writeFile/editFile)
   * or runs normally (exec — nothing to hash-check).
   *
   * Confirm mode off (Settings → "Confirm before running tools") short-circuits
   * ALL of that: no preview, no approval card, no requestApproval() — the call
   * runs straight through exactly like a session-allowed one, so "don't ask"
   * is one switch rather than a per-tool blanket allow in every conversation.
   */
  /**
   * The single place a tool executor is called from the chat loop, so the
   * turn guard cannot be bypassed by reaching a different branch (there are
   * four `return`s in gatedExecuteTool below; all of them come through here).
   *
   * exec is *checked* before running and writeFile/editFile are *recorded*
   * after, and the asymmetry is the point: a refusal has to happen before the
   * command runs, while "this path is mine" is only true once the write
   * actually happened — recording a denied or preview-failed write would hide
   * a genuinely foreign file behind a claim of ownership.
   *
   * A refusal is returned as an ordinary tool error, so the model reads it and
   * adapts (name the paths, or don't do it) with no new IPC or renderer
   * channel — the same reason it works identically in the GUI and the CLI.
   */
  async function guardedExecute(name, args, toolCtx) {
    const guard = toolCtx && toolCtx.guard;
    if (guard && name === 'exec') {
      const verdict = blocksDestructive(guard, args && args.command);
      if (!verdict.ok) return { ok: false, error: verdict.reason };
    }
    // Awaited, not merely returned: "this path is mine" is only true once the
    // write actually landed, and `executeTool` is async — inspecting `.ok` on
    // an un-awaited promise would read undefined and record every write,
    // including the ones that failed. Ownership is load-bearing in the other
    // direction too: a path wrongly claimed stops being reported as foreign.
    const result = await T.executeTool(name, args, toolCtx);
    if (guard && (name === 'writeFile' || name === 'editFile') && result && result.ok !== false) {
      recordWrite(guard, args && args.path);
    }
    return result;
  }

  async function gatedExecuteTool(call, { toolCtx, rootSessionId, rootOnDelta, signal }) {
    const { name, args } = call;
    if (!T.MUTATING_TOOLS.has(name)) return guardedExecute(name, args, toolCtx);
    if (!confirmModeEnabled()) return guardedExecute(name, args, toolCtx);
    if (sessionAllows(rootSessionId, name)) return guardedExecute(name, args, toolCtx);
    // Already refused in this conversation: refuse again WITHOUT raising a
    // second card. Before this, the model's retry after a denial re-prompted
    // the user for the same tool — one "no" produced a card per round for up
    // to maxRounds rounds, each one a billed provider call re-sending the
    // whole conversation. Checked after the confirm-mode short-circuit so
    // turning the gate off still overrides an earlier refusal.
    if (sessionDenies(rootSessionId, name)) return { ok: false, error: denialText(name) };

    let preview = null;
    if (name === 'writeFile' || name === 'editFile') {
      preview = T.previewMutation(name, args);
      if (!preview.ok) return { ok: false, error: preview.error };
    }

    const decision = await requestApproval(rootSessionId, rootOnDelta, signal, {
      tool: name,
      args,
      diff: preview && preview.diff,
    });

    // Only a click is remembered. 'cancel' (aborted turn / nobody able to
    // answer) refuses this call but must not write a durable "no" the user
    // never gave.
    if (decision === 'deny') {
      denyForSession(rootSessionId, name);
      return { ok: false, error: denialText(name) };
    }
    if (decision !== 'session' && decision !== 'once') {
      return { ok: false, error: `${name} was not executed — the request was cancelled.` };
    }
    if (decision === 'session') allowForSession(rootSessionId, name);

    if (preview) {
      const res = T.applyChecked(name, args, preview);
      // Recorded on the same condition as guardedExecute's path: only a write
      // that landed is this session's. (The previous form returned here
      // unconditionally, making every line below it unreachable — the
      // approved-write path recorded nothing at all.)
      if (res && res.ok !== false && toolCtx && toolCtx.guard) {
        recordWrite(toolCtx.guard, args && args.path);
      }
      return res;
    }
    return guardedExecute(name, args, toolCtx);
  }

  /**
   * Custom endpoints are only usable when they are actually configured:
   * a base URL is mandatory for both, and Anthropic additionally needs its own
   * key (the wire format authenticates with x-api-key). Reporting them as
   * always-ready made chat() POST to `${undefined}/v1/…` (defect #2).
   */
  function customStatus(cls) {
    const cfg = settings.get(cls) || {};
    const baseURL = typeof cfg.baseURL === 'string' ? cfg.baseURL.trim() : '';
    const hasBase = Boolean(baseURL);
    const hasKey = Boolean(cfg.configured);
    return {
      configured: cls === 'anthropic' ? hasBase && hasKey : hasBase,
      baseURL,
      keyMask: cfg.keyMask || null,
    };
  }

  async function listClasses() {
    const status = await ollama.probe().catch(() => ({ running: false }));
    return CLASSES.map((c) => {
      if (c.class === 'ollama') return { ...c, configured: Boolean(status.running) };
      if (c.class === 'aegis') {
        return { ...c, configured: Boolean(aegis.apiKey) };
      }
      if (c.class === 'byok') {
        // Configured means "at least one provider has a locally-stored key",
        // not a single baseURL+key pair like the CUSTOM_CLASSES below — byok
        // holds one row per provider (byokNamespace), so customStatus's shape
        // does not apply here.
        const anyConfigured = (settings.list() || []).some(
          (s) => s && typeof s.provider === 'string' && s.provider.startsWith('byok:') && s.configured
        );
        return { ...c, configured: anyConfigured };
      }
      return { ...c, ...customStatus(c.class) };
    });
  }

  async function listModels(cls) {
    if (cls === 'aegis') {
      // The catalog is behind the account's key: GET /api/v1/models answers
      // `401 {"error":{"message":"No API key"}}` without one (verified against
      // aegiscloud.org). Aegis Cloud is the *default* class, so firing the call
      // anyway painted a raw "listModels failed: … 401" over the default model
      // picker for every user who had just installed the app and not yet
      // pasted a key — the one state where the UI must say what unblocks it and
      // not what went wrong. Report the missing key as a state (`needsKey`) and
      // let the renderer invite the user to connect; nothing else about the
      // class changes, and the model dropdown keeps its "server default (auto)"
      // entry so the class is usable the moment a key lands.
      if (!aegis.apiKey) return { class: cls, models: [], needsKey: true };
      const data = await aegis.listModels();
      return { class: cls, models: filterAegisCatalog(normalizeCatalog(data && data.models)) };
    }
    if (cls === 'ollama') {
      const tags = await ollama.listTags();
      return { class: cls, models: tags.map((t) => ({ id: t.id })) };
    }
    if (cls === 'byok') {
      // The server's catalog names every provider it accepts a key for, the
      // models each unlocks, and whether an AEGIS account key is even needed
      // to ask (it is not — see byokProviders' own docstring). Deliberately
      // NOT gated on aegis.apiKey the way the pooled class above is: BYOK's
      // whole point is a caller who brings their own credential, and the
      // catalog itself answers to an anonymous request.
      let providers = [];
      try {
        const data = await aegis.byokProviders();
        providers = (data && data.providers) || [];
      } catch {
        providers = [];
      }
      const models = [];
      for (const p of providers) {
        if (!p || !p.id) continue;
        const local = settings.get(byokNamespace(p.id)) || {};
        const rawModels = Array.isArray(p.models) ? p.models : [];
        for (const m of rawModels) {
          const modelId = typeof m === 'string' ? m : m && m.id;
          if (!modelId) continue;
          models.push({
            id: `${p.id}:${modelId}`,
            label: `${p.label || p.id} — ${modelId}`,
            provider: p.id,
            configured: Boolean(local.configured),
          });
        }
      }
      return {
        class: cls, models, providers,
        needsProviderKey: models.length > 0 && !models.some((m) => m.configured),
      };
    }
    // Custom endpoints: the model id is the *user's* choice — a provider model
    // name, never a URL. Offering the configured base URL as an `id` meant that
    // leaving the default selection POSTed `model: "https://api.openai.com/v1"`,
    // an upstream 400 invalid-model on every call (defect B). There is nothing
    // to enumerate, so the list stays empty and `needsModelId` tells the
    // renderer to prompt for a typed id instead. The base URL still travels
    // along for display only.
    const cfg = settings.get(cls) || {};
    const baseURL = typeof cfg.baseURL === 'string' ? cfg.baseURL.trim() : '';
    return { class: cls, models: [], needsModelId: true, baseURL };
  }

  /**
   * The environment facts the model needs to stop asking which OS it is on.
   * Everything is best-effort: a missing field is simply omitted.
   */
  function envFor(payload) {
    const supplied = (payload && payload.env) || {};
    const base = env || {};
    const pick = (key, value) => (supplied[key] != null ? supplied[key] : value);
    let homedir = base.homedir;
    let cwd = base.cwd;
    try {
      if (!homedir) homedir = os.homedir();
      if (!cwd) cwd = process.cwd();
    } catch {
      /* keep whatever we have */
    }
    return {
      platform: pick('platform', base.platform || process.platform),
      arch: pick('arch', base.arch || process.arch),
      homedir: pick('homedir', homedir),
      cwd: pick('cwd', cwd),
      roots: pick('roots', base.roots),
      appVersion: pick('appVersion', base.appVersion),
      model: pick('model', payload && payload.model),
    };
  }

  /** One transport round for the chosen class. */
  async function dispatch(cls, opts) {
    if (cls === 'aegis') {
      // `undefined` = "leave the model id's own default alone" (a real user
      // turn on the pooled class: the selected Nexus id is what decides, so
      // today's behaviour is unchanged). `false` = an explicit single provider
      // call, for a pass that is a continuation rather than a new
      // investigation. `true` = the autonomous fan-out.
      const brainFlag = opts.singlePass ? false : opts.autonomous ? true : undefined;
      return aegis.chatCompletion({
        prompt: opts.prompt,
        system: opts.system,
        messages: opts.messages,
        model: opts.model,
        mode: opts.mode,
        // Only a cap the caller STATED travels; an effort-derived one does not.
        // The server derives its own budget from `effort` (aegis1 pass_budgets
        // splits its ladder across workers + synthesis), so forwarding the
        // derived number states one decision twice — and the copies had already
        // drifted: 974adc5 doubled aegis1's ladder while this side stood still,
        // leaving the client capping below the budget it displayed. The cap was
        // never the one the renderer showed either (the Max tokens dropdown
        // that used to claim a figure for the pooled class is gone — see
        // desktop/renderer/budget.js). Omitting the field is
        // what tells aegis1 "no cap stated — let effort decide", the same
        // contract aegiscodex-dev sends.
        //
        // A cap the caller DID state is a different thing, and dropping it was
        // a bug: aegis1 reads a body max_tokens as a ceiling over its ladder,
        // so omitting it does not bound the call — it grants the full top rung
        // instead. A deliberate 4096 would have run at 32768, which is the same
        // "only ever raise the caller's ceiling" failure the old
        // Math.max(Number(maxTokens) || 0, EFFORT_TOKEN_BUDGET[eff]) had.
        maxTokens: opts.statedMaxTokens,
        stream: opts.stream !== false,
        // The pooled (Nexus) brain is streamed, and an OpenAI-compatible SSE
        // stream reports no token usage unless asked. Without this the Aegis
        // Cloud class — the desktop's default — was the one class that answered
        // with text but never a token count, so a pooled turn's spend was
        // invisible here while the same model through the MCP path reported it.
        includeUsage: true,
        onStream: opts.onDelta,
        // Extended-reasoning trace (the fan-out's worker findings). Its own
        // channel so it never counts as answer text — see vendor/aegis.js.
        onReasoning: opts.onReasoning,
        // A brain fan-out is silent between passes; give it room (see
        // AUTONOMOUS_IDLE_TIMEOUT_MS). Undefined elsewhere -> 60s default.
        idleTimeoutMs: opts.idleTimeoutMs,
        signal: opts.signal,
        // aegis_recall — the read half of aegis_memory, and the only half a
        // client on this engine should send.
        //
        // aegis_memory is both halves: it injects the account's synced memory
        // into context AND persists this turn back into it, charging sync
        // quota for the write. That pairing is right for aegis-online, whose
        // chat has nowhere else to live. It is wrong here, because this engine
        // is shared by the GUI and the CLI (cli/src/deps.js loads this file):
        // either would be billed for every "hey" and would fill the user's
        // memory with greetings. Verified against aegis1 app.py: every
        // write-back site (the note/upsert calls) is gated on aegis_memory,
        // and aegis_memory implies aegis_recall there — so dropping the write
        // half leaves /online unchanged and costs nothing on the read side.
        //
        // Writing is still available, explicitly: the aegis_memory_save tool
        // (mcp/tools.js; the CLI exposes it as /memory). Recall on every turn,
        // store only what the user asks for — which is what aegiscodex-dev's
        // own cross-session memory does, and what this comment claimed to
        // match while sending both halves.
        //
        // Recall was previously unreachable for a client that would not pay
        // for it: services/tiered_recall.py only ran behind a flag that also
        // bought a write, so the tiered path existed with no caller able to
        // afford it. The split is what makes it reachable. The DEEP tier of the
        // same read is a third flag with its own price — see `opts.recallDeep`
        // below, which is off unless the session opted in.
        extra: {
          aegis_recall: true,
          // The DEEP tier of that read — brain corrections plus the semantic
          // answer cache — is not the same price, so it does not ride along.
          // aegis1 app.py:8367 reads `aegis_recall_deep` (or the
          // X-AEGIS-Recall-Deep header) and services/brain_memory.py
          // find_cached_answer embeds the query: one provider embedding per
          // turn, metered. The server deliberately implies it from
          // `aegis_memory` and NOT from `aegis_recall`, so that a terminal
          // client can buy the cheap read without the embedding.
          //
          // This client is that terminal client (the CLI loads this file via
          // cli/src/deps.js), so it must not opt itself in: the flag is sent
          // only when the SESSION asked for it — CLI `/memory-deep on`, a
          // desktop payload with `recallDeep: true` — and it defaults false
          // everywhere. It also travels only on the user's own turn
          // (`opts.recallDeep` is cleared for every other dispatch below): a
          // tool round, the doubled-budget retry and the write-up re-dispatch
          // all re-send a context whose embedding the first round already
          // bought, which would turn one embedding per turn into one per round.
          ...(opts.recallDeep ? { aegis_recall_deep: true } : {}),
          session: opts.sessionId,
          // The fan-out is opt-in per dispatch. `brain` is sent EXPLICITLY
          // whenever this dispatch is not the autonomous one, because the
          // model id this class sends (``nexus-brain``) enables the pooled
          // brain on its own: without the flag a continuation pass — the
          // doubled-budget retry, or the "write up what you already found"
          // re-dispatch — silently re-ran the whole workers+1 fan-out for a
          // pass whose documented cost is a single request. aegis1
          // services/pool_brain.py parse_brain_request honours the opt-out.
          ...(brainFlag === undefined ? {} : { brain: brainFlag }),
          // An opted-out pass is also told WHICH band to run on. A single call
          // on a brain model id infers its band from the id and lands on
          // "fast" (the cheapest id in the pool); "brain" is the band the
          // workers themselves run on (cheapest model that can think). Same
          // model as the fan-out, one sample instead of four — otherwise
          // dropping the fan-out would have quietly changed the model too.
          ...(brainFlag === false ? { mode: 'brain' } : {}),
          // `effort` is the budget rung, and it is sent whenever the caller has
          // one — not only alongside a fan-out. The fan-out is triggered by the
          // model id (this class sends ``nexus-brain``), so a caller that never
          // ticked "work autonomously" still ran a pooled call and had no way to
          // say how big it should be: the server fell through to its own default
          // rung. That is how a one-word prompt came to reserve the top of the
          // ladder. A single-pass pass carries it too — inert on that path, but
          // it keeps the request honest about what it asked for.
          ...(opts.effort ? { effort: opts.effort } : {}),
          // Only meaningful with a running fan-out — aegis1 services/pool_brain.py
          // parse_brain_request reads `workers` straight off the body and clamps
          // it itself (MAX_WORKERS), so no client-side validation here.
          ...(brainFlag === true && opts.workers ? { workers: opts.workers } : {}),
          // The pool forwards `tools` to the provider and returns tool_calls
          // (aegis1 app.py:7765 → provider, pool_brain synthesis keeps them).
          ...(opts.tools.length ? { tools: opts.tools } : {}),
          ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
        },
      });
    }

    if (cls === 'ollama') {
      return ollama.chat({
        model: opts.model,
        prompt: opts.prompt,
        system: opts.system,
        messages: opts.messages,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        onDelta: opts.onDelta,
        ...(opts.tools.length ? { tools: opts.tools, toolChoice: opts.toolChoice } : {}),
      });
    }

    if (cls === 'byok') {
      // opts.model is still the compound "provider:model" id here — the
      // relay wants them split (a `provider` field plus a bare `model`).
      // opts.apiKey is the PROVIDER key resolved by chat() above (from the
      // byokNamespace(provider) settings row), never the account's own AEGIS
      // key — that one is baked into the `aegis` client already and attached
      // automatically by byokChatCompletion() as X-AEGIS-Key so the account
      // gets billed the handling fee; see client/aegis.js.
      const { provider, model: bareModel } = splitByokModel(opts.model);
      return aegis.byokChatCompletion({
        provider,
        model: bareModel,
        providerKey: opts.apiKey,
        prompt: opts.prompt,
        system: opts.system,
        messages: opts.messages,
        maxTokens: opts.maxTokens,
        stream: true,
        onStream: opts.onDelta,
        signal: opts.signal,
      });
    }

    const common = {
      baseURL: opts.cfg.baseURL,
      apiKey: opts.apiKey,
      model: opts.model,
      prompt: opts.prompt,
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      onDelta: opts.onDelta,
      ...(opts.tools.length ? { tools: opts.tools, toolChoice: opts.toolChoice } : {}),
    };

    if (cls === 'anthropic') return providers.anthropicMessages(common);
    return providers.openaiCompatible(common);
  }

  async function chat(payload, onDelta) {
    const cls = payload && payload.class;
    const model = payload && payload.model;
    // byok's model id is "provider:model" (see splitByokModel) — strip the
    // provider prefix before pattern-matching, or a DeepSeek reasoning model
    // selected under byok ("byok" model "deepseek:deepseek-v4-flash") never
    // matches DEEPSEEK_REASONING_MODEL_RE's anchored pattern and silently
    // gets no stated budget, which is exactly the "hidden CoT ate the whole
    // default and returned nothing" failure this budget exists to prevent.
    const reasoningModelId = cls === 'byok' ? splitByokModel(model).model : model;
    const maxTokens = reasoningBudget(cls, reasoningModelId, payload && payload.maxTokens, payload && payload.effort);
    // The caller's OWN number, kept apart from `maxTokens` above. That one
    // collapses two different facts into a single value — "the caller stated
    // 4096" and "effort implies 32768" — and the pooled path must treat them
    // differently. A stated cap is a liability ceiling the server honours
    // downward (aegis1 pass_budgets: total = min(ladder, max_tokens x passes));
    // an effort-derived one is the server's own arithmetic stated twice, and
    // sending it is how the two copies came to disagree. So the pooled call
    // forwards only what the caller actually asked for.
    // ...and it is read through statedCapOf(), so a nested chat() that states
    // the key overrides its own derived `maxTokens` instead of being mistaken
    // for a caller who asked for that number (see statedCapOf).
    const statedMaxTokens = statedCapOf(payload);
    // "Work autonomously" — routes this call through aegis1's pool_brain
    // worker fan-out (services/pool_brain.py: N reasoning workers + a
    // synthesis pass) instead of a single provider call. UI-gated to the
    // 'aegis' class only (see AUTONOMOUS_CLASS in app.js).
    const autonomous = cls === 'aegis' && Boolean(payload && payload.autonomous);
    const sessionId = (payload && payload.sessionId) || randomUUID();
    // Recursion depth for the task tool: 0 for a real user turn, N+1 for a
    // subagent spawned by depth N. Never set by an IPC caller — only by
    // runSubagent's own recursive chat() call below.
    const depth = Number.isInteger(payload && payload.depth) ? payload.depth : 0;
    // The approval gate's identity for this whole conversation, regardless of
    // depth: a real user turn defines it (defaults to its own sessionId); a
    // subagent's nested chat() call always receives it explicitly from
    // runSubagent below, so "allow for this session" means the same thing
    // whether the call came from the top-level turn or three subagents deep.
    const rootSessionId = (payload && payload.rootSessionId) || sessionId;
    // Likewise, approval requests must always reach the ORIGINAL caller's
    // stream — a subagent's own chat() call is invoked with a no-op onDelta
    // (its tool activity/text is not streamed to the renderer), so without
    // this a nested approval request would call that no-op and hang forever
    // waiting for a response nobody can ever send.
    const rootOnDelta = (payload && payload.rootOnDelta) || onDelta;

    // A pooled brain call streams each worker's finding as extended reasoning
    // before the synthesis pass writes the visible answer. Forward it on its
    // own channel so the renderer can show the fan-out working instead of an
    // apparently idle bubble for the whole worker phase. Uses `onDelta` (not
    // rootOnDelta) on purpose: a subagent's reasoning should be suppressed
    // exactly as its text already is.
    const onReasoning =
      typeof onDelta === 'function' ? (text) => text && onDelta({ reasoning: text }) : undefined;

    const controller = new AbortController();
    controllers.set(sessionId, controller);
    const signal = controller.signal;

    // A caller can opt out of the agent loop entirely (`tools: false`) and get
    // the old single-shot turn back. byok is ALWAYS single-shot: the
    // stateless relay (aegis.byokChatCompletion, /api/v1/byok/chat/completions)
    // has no tools/tool_choice parameter at all, so sending schemas here would
    // build a prompt promising tool access the transport silently drops —
    // the model would reason about exec/readFile and never see a result.
    const toolsEnabled = cls !== 'byok' && !(payload && payload.tools === false);
    const wire = cls === 'anthropic' ? 'anthropic' : 'openai';
    const toolSchemas = toolsEnabled ? T.toolsFor(wire, { includeSubagent: depth < MAX_SUBAGENT_DEPTH }) : [];
    const toolChoice = (payload && payload.toolChoice) || null;

    const system = (payload && payload.system) || buildSystemPrompt(envFor(payload));
    const history = Array.isArray(payload && payload.messages) ? payload.messages.filter(Boolean).slice() : [];
    // Index into `history` of everything THIS turn added as opposed to what the
    // caller brought with it. Reset after the resume rehydration below, so a
    // restored transcript is never re-recorded as if this turn had produced it
    // (which would double it on every interruption in a chain).
    let historyStart = history.length;
    let prompt = (payload && payload.prompt) || '';

    // Lazily start ONE shell session for this turn; the exec tool shares it so
    // cd/env/state persist across calls. Only spawned if exec actually runs,
    // and always disposed when the turn ends.
    let shell = null;
    const getShell = () => shell || (shell = new ShellSession({ cwd: envFor(payload).cwd }));
    const toolCtx = { getShell, signal };
    // The turn's working directory. It rides on every tool frame because a
    // tool row's args are the command or the path — never the directory the
    // command runs in — which left "where is it working in" unanswerable from
    // the transcript.
    const turnCwd = envFor(payload).cwd;

    try {
      // byok's settings row lives under the provider named IN THE MODEL id
      // ("anthropic:claude-sonnet-5" -> byokNamespace('anthropic')), never
      // under the literal class name — one flat 'byok' row could not hold
      // more than one provider's key at a time.
      const byokParts = cls === 'byok' ? splitByokModel(model) : null;
      const cfg =
        cls === 'aegis' || cls === 'ollama' ? {}
        : cls === 'byok' ? settings.get(byokNamespace(byokParts.provider)) || {}
        : settings.get(cls) || {};
      const apiKey =
        cls === 'aegis' || cls === 'ollama' ? null
        : cls === 'byok' ? settings.rawKey(byokNamespace(byokParts.provider))
        : settings.rawKey(cls);

      if (cls === 'byok' && (!byokParts.provider || !byokParts.model)) {
        const err = new Error(
          "byok: model must be \"<provider>:<model>\" (pick one from /models) — got " +
            JSON.stringify(model || '')
        );
        err.status = 400;
        throw err;
      }
      if (cls === 'byok' && !apiKey) {
        const err = new Error(
          `byok: no key saved for "${byokParts.provider}" — add one before chatting with this model.`
        );
        err.status = 400;
        throw err;
      }

      // Custom classes carry no enumerable model list (see listModels), so a
      // blank id here means the user never typed one. Fail loudly in-process
      // instead of shipping `model: undefined` upstream (defect B).
      if (CUSTOM_CLASSES.includes(cls) && (typeof model !== 'string' || !model.trim())) {
        const err = new Error(
          `${cls}: a model id is required — type the provider's model name ` +
            '(the base URL is not a model).'
        );
        err.status = 400;
        throw err;
      }

      const base = {
        cls, model, mode: payload && payload.mode, maxTokens, statedMaxTokens, autonomous, sessionId, signal, onDelta, cfg, apiKey, toolChoice,
        effort: payload && payload.effort,
        workers: payload && payload.workers,
        // Deep recall (`aegis_recall_deep`) is an explicit per-session opt-in
        // and never a default: it costs one provider embedding per turn
        // server-side (aegis1 services/brain_memory.py find_cached_answer), so
        // a client that pays per turn must not turn it on for itself. Only a
        // literal `true` from the caller counts — an absent or `undefined`
        // field is off, which is what keeps every existing caller (the
        // renderer's IPC payloads included) on the cheap read.
        recallDeep: payload && payload.recallDeep === true,
        onReasoning,
        idleTimeoutMs: autonomous ? AUTONOMOUS_IDLE_TIMEOUT_MS : undefined,
        // A caller with no live streaming surface (a `--no-stream` CLI flag, a
        // one-shot script) can ask for the buffered non-stream wire form
        // instead. Undefined/anything but `false` keeps every existing caller
        // (the desktop renderer never sets this) on the streamed path.
        stream: payload && payload.stream === false ? false : true,
      };

      // No round cap: a model that keeps calling tools keeps going for as
      // long as it wants to. The old fixed cap (12 rounds) cut off genuinely
      // long research/exploration turns mid-investigation. A turn ends when
      // the model answers with text, or the user cancels.
      //
      // Both of those exit paths need a guard, because a provider's
      // "I'm finished" signal can arrive with no answer attached — which is
      // exactly how the renderer came to paint "(empty response)" over a turn
      // that had actually done real work:
      //   - truncated (finish_reason 'length'): the budget was consumed
      //     before any visible text (DeepSeek's hidden reasoning bills
      //     against max_tokens), or mid tool-call JSON. One doubled retry.
      //   - empty (no tool call AND no text): re-dispatch once with no tools
      //     and a nudge, so the model has to write up what it already found.
      // Each guard fires at most once per turn, so a provider that is simply
      // broken still terminates instead of looping.
      let truncationRetried = false;
      let synthesisDone = false;

      // Round cap — the bound aegiscodex-dev has had all along and this engine
      // did not. Removing the old fixed cap (12) was right in spirit and wrong
      // in effect: it left the turn with NO horizon, and on 2026-09-15 the
      // question "can you check the plan" ran ~70 rounds, grew the context
      // from 2,260 to 116,011 tokens, cost about EUR 2, and spent those rounds
      // writing 400 lines of unrequested code into the source tree. Each round
      // re-sends the whole conversation, so an unbounded loop gets more
      // expensive the longer it runs.
      //
      // The numbers match aegiscodex-dev's (src/autonomous.js) so both clients
      // behave the same: 24 rounds for a chat turn, 40 for an autonomous one.
      // Env-overridable for a deliberately long job.
      // A stated horizon (env) still wins outright — an explicit number is the
      // user overriding the engine, not something the ledger may pad.
      const roundEnvName = autonomous ? 'AEGIS_AUTONOMOUS_MAX_ROUNDS' : 'AEGIS_CHAT_MAX_ROUNDS';
      const statedRounds = (() => {
        const raw = Number.parseInt(process.env[roundEnvName] || '', 10);
        return Number.isFinite(raw) && raw > 0 ? raw : 0;
      })();
      const baseRounds = statedRounds || (autonomous ? 40 : 24);

      // Did the previous turn in this session die at its horizon? If so, this
      // turn is a continuation of it: same job, unfinished, and the model has
      // to be told — a cold restart is what made the old cap lose work.
      let roundSessionKey = sessionRounds.keyFor(payload, history);
      let resumed = sessionRounds.take(roundSessionKey);
      if (!resumed) {
        // The caller minted a fresh key this turn (no stated session id and a
        // rebuilt history array). Adopt the held work rather than dropping it,
        // but only within the ledger's recency window.
        const adopted = sessionRounds.adopt();
        if (adopted) {
          resumed = adopted.entry;
          roundSessionKey = adopted.key;
        }
      }
      if (resumed) {
        const preamble = sessionRounds.resumePreamble(resumed);
        // Restore the interrupted turn's transcript, because the preamble alone
        // says HOW MUCH was done, not WHAT. The two callers need different
        // halves of it, so `session-rounds` files both (see `record`):
        //
        //   · a caller who brings no conversation of its own — the queue
        //     worker's fresh dispatch; autonomous.js never sends `messages` —
        //     has nothing, so it gets the FULL transcript;
        //   · an interactive chat already carries the prior turns (and the
        //     "stopped at N rounds" note), so it gets only what THIS turn added
        //     that the caller never saw: the tool calls and their results. Full
        //     restore here would duplicate the caller's own text.
        //
        // The old `history.length === 0` guard did the first and not the second,
        // so the resume it was written for a queue task never reached the
        // interactive sessions this feature is actually used from.
        if (history.length === 0) {
          if (Array.isArray(resumed.messages) && resumed.messages.length) history.push(...resumed.messages);
        } else if (Array.isArray(resumed.added) && resumed.added.length) {
          history.push(...resumed.added);
        }
        // Round 1's ask travels as `prompt`; a follow-up dispatch (and every
        // turn that skips the shorthand) has to receive it through history.
        if (prompt) prompt = `${preamble}\n\n${prompt}`;
        else history.push({ role: 'user', content: preamble });
        if (rootOnDelta) {
          rootOnDelta({
            delta:
              `\n\n[resuming work this session left unfinished at ${resumed.rounds} tool rounds` +
              `${resumed.interruptions > 1 ? ` (cut off ${resumed.interruptions}×)` : ''}…]\n`,
          });
        }
      }
      // A resumed turn gets a small bonus on top of the base horizon so
      // re-orientation does not consume the new budget before any work lands.
      const maxRounds = statedRounds || baseRounds + (resumed ? sessionRounds.bonus(baseRounds) : 0);
      let round = 0;

      // Token accounting for the whole TURN, not just its last round. An
      // agentic turn makes one provider call per tool round, and returning only
      // the final round's `usage` (what this did) reported a fraction of what
      // was actually spent — the tool phase's tokens simply disappeared. Every
      // dispatch is summed, including the truncation retry and the synthesis
      // re-dispatch: both are real, separately billed provider calls.
      const turnUsage = { calls: 0 };
      const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens'];
      const addUsage = (res) => {
        const u = res && res.usage;
        if (!u || typeof u !== 'object') return;
        turnUsage.calls += 1;
        for (const key of USAGE_FIELDS) {
          if (typeof u[key] === 'number' && Number.isFinite(u[key])) {
            turnUsage[key] = (turnUsage[key] || 0) + u[key];
          }
        }
        // A provider that reports only the split (Anthropic-compatible) has no
        // total to sum, so derive one or the renderer has nothing to print.
        if (typeof u.total_tokens !== 'number') {
          const derived =
            (u.prompt_tokens ?? u.input_tokens ?? 0) + (u.completion_tokens ?? u.output_tokens ?? 0);
          if (derived) turnUsage.total_tokens = (turnUsage.total_tokens || 0) + derived;
        }
      };
      // The turn's totals win over any single round's, so the attached usage is
      // never the last round wearing the whole turn's label.
      const withTurnUsage = (res) => {
        if (!res || typeof res !== 'object' || !turnUsage.calls) return res;
        // Built from the accumulator alone: every field already present in a
        // round's usage was summed into it, so merging the last round back in
        // could only reintroduce a partial number under a whole-turn label.
        return { ...res, usage: { ...turnUsage } };
      };

      // Round 1's shorthand prompt was sent as `prompt`, not as a message, so
      // any follow-up dispatch in this turn must fold it into the history
      // first or the model would be shown a nudge with no question above it.
      const foldPromptIntoHistory = () => {
        if (prompt === '') return;
        const last = history[history.length - 1];
        if (!(last && last.role === 'user' && last.content === prompt)) {
          history.push({ role: 'user', content: prompt });
        }
        prompt = '';
      };

      // From here on, everything pushed into `history` is this turn's own work:
      // the restored transcript above (if any) belongs to the turn it came from,
      // and re-recording it would double the ledger on every interruption.
      historyStart = history.length;

      for (;;) {
        // Stop and SAY so. A turn that reaches its horizon has usually done
        // real work; ending silently would paint an empty answer over it,
        // which is the same "(empty response)" failure the guards below exist
        // to prevent.
        if (round >= maxRounds) {
          const note =
            `[stopped at ${maxRounds} tool rounds` +
            `${turnUsage.total_tokens ? `, ${turnUsage.total_tokens.toLocaleString()} tokens` : ''}` +
            `. This session holds the work: your next message here resumes it automatically` +
            ` (with a continuation preamble), or raise ${roundEnvName} for a longer single turn.]`;
          // File the interruption before returning, so the horizon is a pause
          // in the session rather than the end of the job. `chain` carries the
          // count forward across resumes.
          const held = sessionRounds.record(roundSessionKey, {
            rounds: round,
            tokens: turnUsage.total_tokens || 0,
            note,
            chain: resumed ? resumed.interruptions : 0,
            // The actual tool-call/tool-result transcript built up this turn —
            // everything folded/pushed into `history` by completed rounds — so
            // a resume can restore real memory of the work, not just a count
            // of it (see the `resumed.messages` rehydration above).
            messages: history,
            // …and only what this turn itself added, for the caller that
            // already has the rest of `history` in its own conversation.
            added: history.slice(historyStart),
          });
          if (rootOnDelta) rootOnDelta({ delta: `\n\n${note}` });
          return withTurnUsage({
            model: base.model,
            choices: [{ message: { content: note }, finish_reason: 'length' }],
            stoppedOnRounds: true,
            heldForSession: true,
            heldRounds: held.rounds,
            sessionInterruptions: held.interruptions,
            resumedFrom: roundSessionKey,
          });
        }
        round += 1;
        // `round === 1` is the user's own ask, and the ONLY dispatch allowed to
        // carry the deep-recall opt-in: the deep tier embeds the query once per
        // dispatch, so leaving it on for an agentic turn would charge one
        // embedding per tool round instead of one per turn (the retries below
        // clear it explicitly, being re-dispatches inside round 1).
        const opts = { ...base, system, messages: history, prompt, tools: toolSchemas, recallDeep: base.recallDeep && round === 1 };
        let res;
        try {
          res = await dispatch(cls, opts);
        } catch (e) {
          // Ollama's OpenAI shim rejects `tools` on older builds. Retrying once
          // without them keeps local chat working instead of turning an
          // unadvertised capability into a hard failure.
          const retriable = cls === 'ollama' && toolSchemas.length && e && (e.status === 400 || /tool/i.test(e.message || ''));
          if (!retriable) throw e;
          res = await dispatch(cls, { ...opts, tools: [] });
        }
        addUsage(res);

        // A cancelled turn is over. Both recoveries below exist for "the model
        // said nothing", and an aborted request resolves with exactly that —
        // no text — so without this guard a user pressing Esc to stop a slow
        // turn immediately issued ANOTHER billed provider call (and, because
        // every transport concatenates the deltas it forwards, streamed the
        // partial answer a second time onto the same bubble). Measured before
        // the guard: one interrupted turn == two dispatches.
        if (signal.aborted) return withTurnUsage(res);

        // Budget exhausted before the answer was written. Doubling it costs
        // one request and converts a dead turn into a real one; a second
        // 'length' result is accepted as-is so a hard-capped model can't
        // spin here forever.
        //
        // Gated on empty text on purpose. Every transport builds `content`
        // by concatenating the deltas it already forwarded to onDelta, so
        // empty content means nothing was streamed and re-dispatching cannot
        // double up in the renderer's live view. When text *has* arrived the
        // turn is not empty — the answer is merely truncated — and a retry
        // would stream it a second time onto the same bubble.
        if (!truncationRetried && !assistantText(res) && isTruncated(res)) {
          truncationRetried = true;
          // singlePass: this retry buys *budget*, not a second investigation.
          // The fan-out's workers would re-run the whole task from scratch for
          // it — 3 extra reasoning passes + a synthesis — which is the opposite
          // of what "one doubled request" means (and what the note above
          // promises). The pass itself is unchanged apart from that.
          res = await dispatch(cls, {
            ...opts,
            singlePass: true,
            // A re-dispatch, not a new ask: the deep tier's embedding was
            // bought by round 1, and buying it again here would charge a
            // second one for the same context.
            recallDeep: false,
            maxTokens: doubledBudget(opts.maxTokens),
            // Doubling applies to the pooled path only when the caller stated a
            // number. With none stated, the server's effort ladder IS the
            // budget, and sending doubledBudget's 8192 floor would *lower* it
            // (aegis1 reads max_tokens as a ceiling over the ladder) — a
            // "double the budget" retry that halves it at high effort.
            statedMaxTokens: opts.statedMaxTokens ? doubledBudget(opts.statedMaxTokens) : undefined,
          });
          addUsage(res);
        }

        const calls = toolSchemas.length ? extractToolCalls(res) : [];
        if (!calls.length) {
          if (assistantText(res) || synthesisDone || !toolsEnabled) return withTurnUsage(res);
          // The model stopped without calling a tool and without saying
          // anything. Force the summary out of the context it already holds
          // instead of handing the renderer a blank completion. Skipped when
          // the caller opted out of the agent loop (`tools: false`): there is
          // no gathered context to rescue, so a bare completion is just that.
          synthesisDone = true;
          foldPromptIntoHistory();
          history.push({ role: 'user', content: EMPTY_TURN_NUDGE });
          // singlePass: same reasoning as the truncation retry above, and it is
          // the same comment's literal promise ("force the summary out of the
          // context it already holds"). Escalating a write-up back into the
          // worker fan-out asked three fresh workers to redo an investigation
          // whose findings are already in `history`, at 4x the cost, to produce
          // a paragraph the model had all the material for.
          res = await dispatch(cls, {
            ...opts,
            singlePass: true,
            // Same as the truncation retry above: this pass writes up findings
            // already in `history`, and a fresh embedding buys it nothing.
            recallDeep: false,
            messages: history,
            prompt: '',
            tools: [],
          });
          addUsage(res);
          if (!assistantText(res)) {
            throw emptyTurnError({
              cls,
              model,
              maxTokens: opts.maxTokens,
              finishReason: finishReasonOf(res),
            });
          }
          return withTurnUsage(res);
        }

        foldPromptIntoHistory();

        // Thread the assistant turn (its tool_calls) and each result back in
        // the shapes both wire formats accept (providers.js normalises them).
        history.push({
          role: 'assistant',
          content: assistantText(res),
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        });

        for (const call of calls) {
          // Open the live row BEFORE the tool runs. The CLI paints
          // `Running N … · 3s` off a `phase: 'run'` frame and ticks it while
          // the tool is still going; reporting the tool only once, after it
          // finished, left the transcript showing a spinner verb and nothing
          // else for the whole exec timeout (120s, up to 600s) — which reads
          // as a wedged turn rather than a working one.
          if (onDelta) {
            onDelta({
              delta: '',
              tool: { name: call.name, args: call.args, id: call.id, cwd: turnCwd, phase: 'run' },
            });
          }
          const result = call.name === T.SUBAGENT_TOOL
            ? await runSubagent(call.args, {
                cls, model, statedMaxTokens, effort: payload && payload.effort,
                mode: payload && payload.mode, parentSignal: signal, depth, rootSessionId, rootOnDelta,
              })
            : await gatedExecuteTool(call, { toolCtx, rootSessionId, rootOnDelta, signal });
          // A subagent's spend rides back on its tool result (see runSubagent).
          if (result && result.usage) addUsage({ usage: result.usage });
          // The id is carried on both frames: the CLI pairs them by id first,
          // precisely so parallel same-name calls don't collapse into one row
          // with the wrong plural.
          if (onDelta) {
            onDelta({
              delta: '',
              tool: { name: call.name, args: call.args, ok: result.ok, id: call.id, cwd: turnCwd, phase: 'done' },
            });
          }
          history.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: T.toolResultText(result),
          });
        }
      }
    } finally {
      if (shell) shell.dispose();
      controllers.delete(sessionId);
    }
  }

  /**
   * Run a `task` tool call as a subagent: a nested chat() turn on the same
   * class/model, primed with the chosen specialist's system prompt (agents.js)
   * and its own tool access (including task, until MAX_SUBAGENT_DEPTH cuts
   * it off), returning the subagent's final text as the tool result. Never
   * throws — resolves { ok, output } or { ok:false, error }, matching
   * tools.js's executor contract so the caller treats it identically.
   */
  async function runSubagent(
    { description, subagent_type, prompt: subPrompt } = {},
    { cls, model, statedMaxTokens, effort, mode, parentSignal, depth, rootSessionId, rootOnDelta } = {}
  ) {
    const task = String(subPrompt || description || '').trim();
    if (!task) return { ok: false, error: 'task requires a prompt' };
    const label = subagent_type && subagent_type !== 'general' ? agentRoleLabel(subagent_type) : 'general';
    const system = agentSystemPrompt(subagent_type);
    const subSessionId = randomUUID();

    // Aborting the parent turn must also stop a running subagent instead of
    // leaving it to finish on its own (or sit out the whole turn timeout).
    let onParentAbort;
    if (parentSignal) {
      if (parentSignal.aborted) return { ok: false, error: 'aborted' };
      onParentAbort = () => cancel(subSessionId);
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }

    try {
      // rootSessionId/rootOnDelta ride along explicitly (see chat()) so the
      // subagent's own mutating tool calls still gate through the SAME
      // approval card the user sees for the top-level turn, instead of
      // silently hanging behind this call's no-op onDelta below.
      const res = await chat(
        {
          class: cls, model, mode, system, prompt: task, sessionId: subSessionId, depth: (depth || 0) + 1,
          rootSessionId, rootOnDelta,
          // The parent's budget AUTHORITY is forwarded, not the number it
          // implies. `maxTokens` is deliberately absent: it is the rung this
          // turn derived from `effort`, and a re-entry that hands it back gets
          // read as the caller's own cap (statedCapOf). The rung itself rides
          // along as `effort`, which is what aegis1 sizes the fan-out and its
          // ladder from — so a subagent now runs at the effort the user chose
          // instead of at a number that only meant anything for this model id.
          statedMaxTokens,
          effort,
        },
        () => {}
      );
      const text = assistantText(res);
      // The subagent's tokens were billed to the same account as the parent
      // turn, so its usage travels back on the tool result and is summed into
      // the parent's total. Attached even on the no-output branch: a subagent
      // that burned a full context and said nothing is precisely the spend the
      // user most needs to see.
      const spent = res && res.usage ? { usage: res.usage } : {};
      return text
        ? { ok: true, output: text, ...spent }
        : { ok: false, error: `subagent (${label}) produced no output`, ...spent };
    } catch (e) {
      return { ok: false, error: `subagent (${label}) failed: ${e && e.message ? e.message : e}` };
    } finally {
      if (parentSignal && onParentAbort) parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  function cancel(sessionId) {
    const controller = controllers.get(sessionId);
    if (controller) controller.abort();
    return { ok: Boolean(controller) };
  }

  return {
    CLASSES,
    listClasses,
    listModels,
    chat,
    cancel,
    respondApproval,
    clearSessionApprovals,
    settings,
  };
}

module.exports = { CLASSES, createLocalEngine, extractToolCalls, parseArgs, reasoningBudget };
