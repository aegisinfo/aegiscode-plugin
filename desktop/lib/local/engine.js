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
];

/**
 * Mirrors aegiscodex-dev's src/backend.js DEEPSEEK_REASONING_MODEL_RE +
 * EFFORT_TOKEN_BUDGET verbatim. DeepSeek's reasoning models (deepseek-flash,
 * deepseek-v4-pro, the deprecated deepseek-reasoner, and the legacy
 * v4-flash/v4.1-flash aliases some configs still carry) spend part of
 * max_tokens on hidden chain-of-thought before ever emitting visible
 * content — DeepSeek counts reasoning tokens against the same budget as
 * content. At the renderer's 4k default (index.html's max-tokens select),
 * any non-trivial question can burn the whole budget reasoning and finish
 * with empty content: no error, no tool calls, just a turn that "completes"
 * with nothing to show for it (the empty-response bug). A user pointing the
 * Custom OpenAI-compatible class straight at DeepSeek's API hits exactly
 * this, so the request floors to the same effort budget aegiscodex-dev uses
 * for its own direct DeepSeek calls instead of shipping whatever the
 * dropdown happens to have selected.
 */
const DEEPSEEK_REASONING_MODEL_RE = /^deepseek-(v4(\.\d+)?-(flash|pro)|flash|pro|reasoner)$/;
const EFFORT_TOKEN_BUDGET = { low: 8192, medium: 16384, high: 32768 };

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
 */
const AUTONOMOUS_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * Only ever raises a too-low budget for a DeepSeek reasoning model — never
 * lowers whatever the caller (renderer dropdown, or "adaptive" ceiling)
 * already asked for. Everything else (non-DeepSeek models, non-reasoning
 * DeepSeek ids like deepseek-chat) passes through untouched. Effort defaults
 * to 'high' since custom endpoints have no effort selector of their own
 * (that UI is aegis-class/autonomous-only) — matching aegiscodex-dev's own
 * default effort.
 */
function deepseekReasoningFloor(model, maxTokens, effort) {
  if (!DEEPSEEK_REASONING_MODEL_RE.test(String(model || ''))) return maxTokens;
  const eff = effort === 'low' || effort === 'medium' ? effort : 'high';
  return Math.max(Number(maxTokens) || 0, EFFORT_TOKEN_BUDGET[eff]);
}

/** Relay model entries arrive as ids or objects; keep only real model ids. */
function normalizeCatalog(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && m.id);
}

/**
 * The Aegis Cloud catalog (`/api/v1/models`) also lists internal routing
 * aliases — per-provider variants like `openai-gpt4o-mini`/`anthropic-haiku`,
 * and six pooled-brain tier ids (`{aegis,nexus}-brain[-smart|-neo]`) that all
 * run the same worker pool on the same backend model. None of those are a
 * human's model choice; picking between them put six near-duplicate "brain"
 * entries in the desktop dropdown. Surface only the four platform models the
 * user actually selects between, plus one collapsed "Nexus" entry standing
 * in for whichever brain tier the pool advertises.
 */
const AEGIS_PLATFORM_MODELS = Object.freeze(['openai', 'anthropic', 'groq', 'gemini']);
const NEXUS_BRAIN_ID = 'aegis-brain';
const NEXUS_LABEL = 'Nexus (Aegis brain)';

function filterAegisCatalog(models) {
  const platform = models.filter((m) => AEGIS_PLATFORM_MODELS.includes(m.id));
  const nexus = models.find((m) => m.id === NEXUS_BRAIN_ID);
  return nexus ? [...platform, { ...nexus, label: NEXUS_LABEL }] : platform;
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
      `(stop reason: ${finishReason || 'none'}, max_tokens: ${maxTokens}). The token budget ` +
      'was most likely consumed before any visible text — raise the max-tokens setting, ' +
      'or lower effort.'
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
  const pendingApprovals = new Map(); // approvalId -> { resolve }

  function sessionAllows(rootId, name) {
    const set = sessionAllowlists.get(rootId);
    return Boolean(set && set.has(name));
  }

  function allowForSession(rootId, name) {
    if (!sessionAllowlists.has(rootId)) sessionAllowlists.set(rootId, new Set());
    sessionAllowlists.get(rootId).add(name);
  }

  /** newChat() in the renderer calls this so a fresh conversation never
   *  inherits a prior thread's blanket allows. */
  function clearSessionApprovals(rootSessionId) {
    sessionAllowlists.delete(rootSessionId);
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
   * 'session' or 'deny'. Sent over `rootOnDelta` (see chat()) as an
   * `{ approval }` chunk so it rides the exact same streaming channel as
   * tool-activity chunks — no new IPC surface needed on the push side, only
   * on the reply side (respondApproval). Fails safe: no listener able to
   * ever answer (no onDelta, or the turn was aborted) resolves 'deny'
   * instead of hanging the tool round forever.
   */
  function requestApproval(rootSessionId, rootOnDelta, signal, info) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) {
        resolve('deny');
        return;
      }
      const id = randomUUID();
      let settled = false;
      const onAbort = () => finish('deny');
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
        finish('deny');
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
  async function gatedExecuteTool(call, { toolCtx, rootSessionId, rootOnDelta, signal }) {
    const { name, args } = call;
    if (!T.MUTATING_TOOLS.has(name)) return T.executeTool(name, args, toolCtx);
    if (!confirmModeEnabled()) return T.executeTool(name, args, toolCtx);
    if (sessionAllows(rootSessionId, name)) return T.executeTool(name, args, toolCtx);

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

    if (decision === 'deny') {
      return { ok: false, error: `${name} was not executed — the user denied the request.` };
    }
    if (decision === 'session') allowForSession(rootSessionId, name);

    if (preview) return T.applyChecked(name, args, preview);
    return T.executeTool(name, args, toolCtx);
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
      return { ...c, ...customStatus(c.class) };
    });
  }

  async function listModels(cls) {
    if (cls === 'aegis') {
      const data = await aegis.listModels();
      return { class: cls, models: filterAegisCatalog(normalizeCatalog(data && data.models)) };
    }
    if (cls === 'ollama') {
      const tags = await ollama.listTags();
      return { class: cls, models: tags.map((t) => ({ id: t.id })) };
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
      return aegis.chatCompletion({
        prompt: opts.prompt,
        system: opts.system,
        messages: opts.messages,
        model: opts.model,
        mode: opts.mode,
        maxTokens: opts.maxTokens,
        stream: true,
        onStream: opts.onDelta,
        // Extended-reasoning trace (the fan-out's worker findings). Its own
        // channel so it never counts as answer text — see vendor/aegis.js.
        onReasoning: opts.onReasoning,
        // A brain fan-out is silent between passes; give it room (see
        // AUTONOMOUS_IDLE_TIMEOUT_MS). Undefined elsewhere -> 60s default.
        idleTimeoutMs: opts.idleTimeoutMs,
        signal: opts.signal,
        // aegis_memory: automatic, no button — the server both reads prior
        // synced memory into context AND writes this turn back to it, the
        // same flag aegis-online sets. Matches aegiscodex-dev's own
        // cross-session memory (auto-indexed, no manual tagging).
        extra: {
          aegis_memory: true,
          session: opts.sessionId,
          ...(opts.autonomous ? { brain: true } : {}),
          // Only meaningful (and only sent) alongside `brain` — aegis1
          // services/pool_brain.py parse_brain_request reads `effort`/
          // `workers` straight off the body and clamps them itself
          // (EFFORT_LEVELS / MAX_WORKERS), so no client-side validation here.
          ...(opts.autonomous && opts.effort ? { effort: opts.effort } : {}),
          ...(opts.autonomous && opts.workers ? { workers: opts.workers } : {}),
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
    const maxTokens = deepseekReasoningFloor(model, payload && payload.maxTokens, payload && payload.effort);
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
    // the old single-shot turn back.
    const toolsEnabled = !(payload && payload.tools === false);
    const wire = cls === 'anthropic' ? 'anthropic' : 'openai';
    const toolSchemas = toolsEnabled ? T.toolsFor(wire, { includeSubagent: depth < MAX_SUBAGENT_DEPTH }) : [];
    const toolChoice = (payload && payload.toolChoice) || null;

    const system = (payload && payload.system) || buildSystemPrompt(envFor(payload));
    const history = Array.isArray(payload && payload.messages) ? payload.messages.filter(Boolean).slice() : [];
    let prompt = (payload && payload.prompt) || '';

    // Lazily start ONE shell session for this turn; the exec tool shares it so
    // cd/env/state persist across calls. Only spawned if exec actually runs,
    // and always disposed when the turn ends.
    let shell = null;
    const getShell = () => shell || (shell = new ShellSession({ cwd: envFor(payload).cwd }));
    const toolCtx = { getShell, signal };

    try {
      const cfg = cls === 'aegis' || cls === 'ollama' ? {} : settings.get(cls) || {};
      const apiKey = cls === 'aegis' || cls === 'ollama' ? null : settings.rawKey(cls);

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
        cls, model, mode: payload && payload.mode, maxTokens, autonomous, sessionId, signal, onDelta, cfg, apiKey, toolChoice,
        effort: payload && payload.effort,
        workers: payload && payload.workers,
        onReasoning,
        idleTimeoutMs: autonomous ? AUTONOMOUS_IDLE_TIMEOUT_MS : undefined,
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

      for (;;) {
        const opts = { ...base, system, messages: history, prompt, tools: toolSchemas };
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
          res = await dispatch(cls, { ...opts, maxTokens: doubledBudget(opts.maxTokens) });
        }

        const calls = toolSchemas.length ? extractToolCalls(res) : [];
        if (!calls.length) {
          if (assistantText(res) || synthesisDone || !toolsEnabled) return res;
          // The model stopped without calling a tool and without saying
          // anything. Force the summary out of the context it already holds
          // instead of handing the renderer a blank completion. Skipped when
          // the caller opted out of the agent loop (`tools: false`): there is
          // no gathered context to rescue, so a bare completion is just that.
          synthesisDone = true;
          foldPromptIntoHistory();
          history.push({ role: 'user', content: EMPTY_TURN_NUDGE });
          res = await dispatch(cls, { ...opts, messages: history, prompt: '', tools: [] });
          if (!assistantText(res)) {
            throw emptyTurnError({
              cls,
              model,
              maxTokens: opts.maxTokens,
              finishReason: finishReasonOf(res),
            });
          }
          return res;
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
          const result = call.name === T.SUBAGENT_TOOL
            ? await runSubagent(call.args, {
                cls, model, maxTokens, mode: payload && payload.mode, parentSignal: signal, depth, rootSessionId, rootOnDelta,
              })
            : await gatedExecuteTool(call, { toolCtx, rootSessionId, rootOnDelta, signal });
          if (onDelta) onDelta({ delta: '', tool: { name: call.name, args: call.args, ok: result.ok } });
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
    { cls, model, maxTokens, mode, parentSignal, depth, rootSessionId, rootOnDelta } = {}
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
          class: cls, model, maxTokens, mode, system, prompt: task, sessionId: subSessionId, depth: (depth || 0) + 1,
          rootSessionId, rootOnDelta,
        },
        () => {}
      );
      const text = assistantText(res);
      return text
        ? { ok: true, output: text }
        : { ok: false, error: `subagent (${label}) produced no output` };
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

module.exports = { CLASSES, createLocalEngine, extractToolCalls, parseArgs };
