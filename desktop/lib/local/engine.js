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
 * feeds the results back until the model answers with text or the round cap is
 * hit. The window stays contextIsolated + sandboxed: this module runs in the
 * MAIN process, so the executor never has to be exposed to the renderer.
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

/** Hard cap on tool rounds per turn — mirrors the CLI's bounded loop. */
const MAX_TOOL_ROUNDS = 12;

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

function createLocalEngine({ aegis, settings, ollama, providers, tools, promptBuilder, env }) {
  const controllers = new Map(); // sessionId -> AbortController
  const T = tools || toolsModule;
  const buildSystemPrompt = (promptBuilder && promptBuilder.buildSystemPrompt) || promptModule.buildSystemPrompt;

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
    const maxTokens = payload && payload.maxTokens;
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
      };

      let last = null;
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
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
        last = res;

        const calls = toolSchemas.length ? extractToolCalls(res) : [];
        if (!calls.length) return res;
        if (round === MAX_TOOL_ROUNDS) return res; // round cap: hand back what we have

        // Continuing the loop means round 1's shorthand prompt has to become
        // part of the history — it was sent as `prompt`, not as a message, so
        // without this the model would see a tool result and no question.
        if (prompt !== '') {
          const last = history[history.length - 1];
          if (!(last && last.role === 'user' && last.content === prompt)) {
            history.push({ role: 'user', content: prompt });
          }
          prompt = '';
        }

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
            ? await runSubagent(call.args, { cls, model, maxTokens, mode: payload && payload.mode, parentSignal: signal, depth })
            : await T.executeTool(call.name, call.args, toolCtx);
          if (onDelta) onDelta({ delta: '', tool: { name: call.name, args: call.args, ok: result.ok } });
          history.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: T.toolResultText(result),
          });
        }
      }
      return last;
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
  async function runSubagent({ description, subagent_type, prompt: subPrompt } = {}, { cls, model, maxTokens, mode, parentSignal, depth } = {}) {
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
      const res = await chat(
        { class: cls, model, maxTokens, mode, system, prompt: task, sessionId: subSessionId, depth: (depth || 0) + 1 },
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
    MAX_TOOL_ROUNDS,
    listClasses,
    listModels,
    chat,
    cancel,
    settings,
  };
}

module.exports = { CLASSES, MAX_TOOL_ROUNDS, createLocalEngine, extractToolCalls, parseArgs };
