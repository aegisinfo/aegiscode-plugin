#!/usr/bin/env node
/**
 * AEGIS thin client — zero-dependency transport to aegiscloud.org.
 *
 * This file is the ONLY public surface that talks to the AEGIS backend. It
 * forwards requests and normalises responses; it contains NO engine, brain,
 * orchestration, routing, or tier logic. All of that lives in the private
 * ae-guix product and behind aegiscloud.org.
 *
 * Runs unchanged under three hosts:
 *   - mcp/server.js   (Claude Code MCP plugin)         — CommonJS require
 *   - desktop/        (thin Electron shell)            — CommonJS require
 *                     (vendored byte-identical copy at desktop/vendor/aegis.js)
 *   - aegis-online    (browser SPA, vendored copy)     — <script> tag →
 *                     window.AegisClient
 *
 * Usage (Node):
 *   const { createClient } = require('./client/aegis.js');
 *   const aegis = createClient();            // reads AEGIS_API_KEY from env
 *   const aegis = createClient({ apiBase, apiKey, memoryToken });
 *
 * Usage (browser):
 *   <script src="/static/vendor/aegis.js"></script>
 *   const aegis = window.AegisClient.createClient({ apiKey });
 *
 * BYOK note: byokChatCompletion() takes the provider key per request (or from
 * opts.providerKey) and sends it as X-Provider-Key — it is relayed to the
 * provider for that request only and never stored server-side.
 */

'use strict';

// ---------------------------------------------------------------------------
// Environment-agnostic preamble. This file must parse in Node AND in a plain
// browser <script> tag, so no bare require/process/window/module references
// may appear at load time.
// ---------------------------------------------------------------------------

/** Read an env var, treating unexpanded "${VAR}" templates as absent. */
function envVar(name) {
  if (typeof process === 'undefined' || !process.env) return '';
  const v = process.env[name];
  return v && !/^\$\{[A-Z_]+\}$/.test(v) ? v : '';
}

/**
 * UUID v4 that works everywhere: Web Crypto first (browsers, Node ≥ 19),
 * then Node's CJS crypto module (Node < 19), then a Math.random fallback for
 * sandboxed contexts (e.g. a VM or an opaque browser context) that expose no
 * crypto API at all. Used by hosts for session/conversation ids only.
 */
function randomUUID() {
  const root =
    (typeof globalThis !== 'undefined' && globalThis) ||
    (typeof self !== 'undefined' && self) ||
    null;
  const c = root && root.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch (_) {
      /* fall through */
    }
  }
  if (c && typeof c.getRandomValues === 'function') {
    try {
      const b = new Uint8Array(16);
      c.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40; // version 4
      b[8] = (b[8] & 0x3f) | 0x80; // variant 10
      const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    } catch (_) {
      /* fall through */
    }
  }
  if (typeof require === 'function') {
    try {
      const nodeCrypto = require('crypto');
      if (nodeCrypto && typeof nodeCrypto.randomUUID === 'function') {
        return nodeCrypto.randomUUID();
      }
    } catch (_) {
      /* not Node — keep going */
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const DEFAULT_API_BASE = 'https://aegiscloud.org';
const CLIENT_VERSION = '3.2.0';

/**
 * .mcp.json / Electron pass config as "${VAR}" template refs. When the var is
 * unset, hosts have been observed to leave the template literally unexpanded
 * (e.g. "${AEGIS_API_BASE}") instead of omitting it — which defeats a plain
 * `|| default` fallback since the literal string is truthy. Treat anything
 * shaped like an unexpanded template as absent.
 */
function createClient(opts = {}) {
  const apiBase = (
    opts.apiBase ||
    envVar('AEGIS_API_BASE') ||
    DEFAULT_API_BASE
  ).replace(/\/+$/, '');
  let apiKey = opts.apiKey !== undefined ? opts.apiKey : envVar('AEGIS_API_KEY');
  // Optional: a memory token supplied directly, bypassing the api_key exchange.
  const memoryToken =
    opts.memoryToken !== undefined ? opts.memoryToken : envVar('AEGIS_MEMORY_TOKEN');
  const clientVersion = opts.clientVersion || CLIENT_VERSION;

  let memoryTokenCache = null;

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  /** Base headers every request carries (version gate + key when present). */
  function authHeaders(extra) {
    const headers = {
      'Content-Type': 'application/json',
      'X-AEGIS-Version': clientVersion,
      ...extra,
    };
    // Keys are optional per-client (a BYOK-only browser page has none); when
    // absent, omit the auth headers entirely so no empty values are sent.
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  async function apiPost(path, body, headers) {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: headers || authHeaders(),
      body: JSON.stringify(body || {}),
    });
    return parseResponse(res);
  }

  async function apiGet(path, headers) {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'GET',
      headers: headers || authHeaders(),
    });
    return parseResponse(res);
  }

  async function parseResponse(res) {
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg =
        (data && (data.error?.message || data.error || data.message)) ||
        `HTTP ${res.status}`;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** Extract a human message from a structured backend error body. */
  function errorMessageOf(data) {
    if (!data) return '';
    const e = data.error;
    if (typeof e === 'string') return e;
    if (e && typeof e.message === 'string') return e.message;
    if (e && typeof e.error === 'string') return e.error;
    if (typeof data.message === 'string') return data.message;
    if (typeof data.error_message === 'string') return data.error_message;
    return '';
  }

  /** Throw an Error carrying status/data from a 2xx body that still has an
   *  error field (seen on streaming endpoints that answer JSON mid-stream). */
  function throwErrorFrom(data, status) {
    const msg = errorMessageOf(data);
    if (!msg) return;
    const err = new Error(msg);
    err.status = status || 500;
    err.data = data;
    throw err;
  }

  // Memory endpoints authenticate with a memory_token, not the API key.
  async function getMemoryToken() {
    if (memoryToken) return memoryToken;
    if (memoryTokenCache) return memoryTokenCache;
    const info = await apiPost('/api/verify-api-key', { api_key: apiKey });
    if (!info || !info.memory_token) {
      throw new Error(
        'This AEGIS account has no memory token. Enable cloud memory at https://aegiscloud.org/subscribe.'
      );
    }
    memoryTokenCache = info.memory_token;
    return memoryTokenCache;
  }

  function memoryHeaders(token) {
    return {
      'Content-Type': 'application/json',
      'X-AEGIS-Version': clientVersion,
      Authorization: `Bearer ${token}`,
    };
  }

  /**
   * Replace the API key at runtime (desktop in-app key entry). Clears the
   * cached memory token so the next memory/account call re-exchanges with the
   * new key. Returns the trimmed raw key — main-process only; hosts must mask
   * it before returning anything to a renderer.
   */
  function setApiKey(key) {
    apiKey = typeof key === 'string' ? key.trim() : '';
    memoryTokenCache = null;
    return apiKey;
  }

  // -------------------------------------------------------------------------
  // High-level API (returns raw backend data; hosts decide how to format it)
  // -------------------------------------------------------------------------

  async function verifyApiKey() {
    return apiPost('/api/verify-api-key', { api_key: apiKey });
  }

  /** Build the OpenAI-style messages array from either a full history or the
   *  single-shot { system, prompt } shorthand.
   *
   *  The history is no longer returned verbatim when present: doing so dropped
   *  `system` entirely, so the agent loop's ported persona disappeared on this
   *  transport alone. The system turn is prepended unless the caller already
   *  supplied one, and a non-empty `prompt` is appended as a final user turn
   *  (skipped when the history already ends with that same turn). */
  function buildMessages(messages, system, prompt) {
    const history = Array.isArray(messages) ? messages.filter(Boolean) : [];
    const out = [];
    if (system && !history.some((m) => m && m.role === 'system')) {
      out.push({ role: 'system', content: system });
    }
    out.push(...history);
    if (prompt != null && prompt !== '') {
      const last = out[out.length - 1];
      if (!(last && last.role === 'user' && last.content === prompt)) {
        out.push({ role: 'user', content: prompt });
      }
    }
    return out;
  }

  /**
   * Chat completion against the AEGIS pool (API key auth). Non-streaming by
   * default (structured JSON error bodies — this is what the MCP host relies
   * on). When `stream: true` AND `onStream` is a function, the request is sent
   * with `stream: true` and each SSE delta is delivered as `onStream({ delta })`.
   * The resolved value is normalised to the same shape as the non-streaming
   * response either way, so hosts can reconcile final text after the last chunk.
   *
   * Additive options shared with byokChatCompletion():
   *   - `messages`  full OpenAI-format history (supersedes prompt/system)
   *   - `extra`     extra body fields merged verbatim (e.g. { aegis_memory,
   *                 session } for the online host's synced-memory writeback)
   *   - `onReasoning`  receives `delta.reasoning_content` text as it streams
   *                 (pool-brain worker findings). Kept off the answer channel
   *                 so a reasoning-only stream still counts as unanswered.
   *   - `idleTimeoutMs`  override the stalled-stream watchdog for this call
   *                 (a worker fan-out is legitimately silent between passes)
   */
  async function chatCompletion({
    prompt,
    system,
    messages,
    model,
    mode,
    maxTokens,
    stream = false,
    onStream,
    onReasoning,
    idleTimeoutMs,
    includeUsage,
    signal,
    extra,
  } = {}) {
    // Model-first: an explicit `model` pins that provider id verbatim; with no
    // model the server picks its default (no client-invented tier id). `mode`
    // is a legacy server-side shorthand — forwarded verbatim only when the
    // caller supplies it, never defaulted, never built into a model id.
    const body = {
      messages: buildMessages(messages, system, prompt),
      max_tokens: maxTokens || 4096,
      ...(extra || {}),
    };
    if (model) body.model = model;
    else if (mode) body.mode = mode;
    if (!stream || typeof onStream !== 'function') {
      return apiPost('/api/v1/chat/completions', { ...body, stream: false });
    }
    // An OpenAI-compatible SSE response carries no `usage` unless the caller
    // asks for it (`stream_options.include_usage`). Without this the streamed
    // AEGIS pool call — the only path the desktop uses for the Nexus brain —
    // resolved with no usage at all, so a pooled turn could report its text but
    // never what it spent, while the same model through the non-streaming MCP
    // path reported both. Only the streaming request sets it: `stream_options`
    // is invalid alongside `stream:false`, so the non-stream branch above and
    // every non-stream fallback must stay clean.
    if (includeUsage) body.stream_options = { include_usage: true };
    return postStream('/api/v1/chat/completions', body, authHeaders(), onStream, signal, {
      onReasoning,
      idleTimeoutMs,
      // A server that predates `stream_options` 400s the whole request; the
      // stream is worth more than the token count, so retry on the wire without
      // the hint before sacrificing streaming for the non-stream fallback.
      retryWithoutStreamOptions: Boolean(includeUsage),
    });
  }

  /**
   * BYOK chat completion: relay a provider request through
   * /api/v1/byok/chat/completions using a per-request X-Provider-Key. The
   * provider key never touches AEGIS storage — it is forwarded straight to the
   * provider for this request only. Mirrors chatCompletion()'s streaming /
   * fallback semantics exactly.
   */
  async function byokChatCompletion({
    provider = 'openai',
    model,
    messages,
    prompt,
    system,
    maxTokens,
    stream = false,
    onStream,
    signal,
    providerKey,
  } = {}) {
    const key = providerKey !== undefined ? providerKey : opts.providerKey;
    const body = {
      provider,
      messages: buildMessages(messages, system, prompt),
      max_tokens: maxTokens || 4096,
    };
    if (model) body.model = model;
    const headers = {
      'Content-Type': 'application/json',
      'X-AEGIS-Version': clientVersion,
      'X-Provider-Key': key,
    };
    if (!stream || typeof onStream !== 'function') {
      return apiPost('/api/v1/byok/chat/completions', { ...body, stream: false }, headers);
    }
    return postStream('/api/v1/byok/chat/completions', body, headers, onStream, signal);
  }

  /** Extract the assistant text from a full (non-streamed) completion JSON. */
  function textOf(data) {
    const choice = data && data.choices && data.choices[0];
    const content = choice && (choice.message && choice.message.content);
    return typeof content === 'string' ? content : '';
  }

  /**
   * POST body with `stream: true` and forward SSE deltas to onStream.
   * Shared by the AEGIS pool and the BYOK relay so every host parses exactly
   * one wire format.
   *
   * Handles two servers gracefully:
   *  - a real SSE endpoint  -> incremental deltas, normalised final result
   *  - an endpoint that ignores `stream` and replies with plain JSON (or
   *    rejects `stream: true` outright) -> one-shot fallback: deliver the full
   *    text as a single delta and resolve the parsed JSON, unchanged.
   * This keeps streaming purely additive for hosts that opt in.
   */
  async function postStream(path, body, headers, onStream, signal, streamOpts) {
    const { onReasoning, idleTimeoutMs, retryWithoutStreamOptions } = streamOpts || {};
    const request = (payload) =>
      fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...payload, stream: true }),
        signal,
      });
    let res;
    try {
      res = await request(body);
    } catch (err) {
      throw err; // network-level failure; nothing to fall back to
    }

    // Ask for the token count, but never at the cost of the stream: a server
    // that predates `stream_options` rejects the request outright, so drop that
    // one hint and put it back on the wire before falling back to a non-stream
    // response (which would answer in one lump and end the live paint).
    if (!res.ok && retryWithoutStreamOptions && body.stream_options) {
      try {
        if (res.body) await res.body.cancel();
      } catch {
        /* the failed response is being discarded anyway */
      }
      const cleanBody = { ...body };
      delete cleanBody.stream_options;
      body = cleanBody;
      try {
        res = await request(body);
      } catch (err) {
        throw err;
      }
    }

    if (!res.ok) {
      // The endpoint may not accept `stream: true`. Retry once without it so
      // the caller gets the normal structured JSON (result or error). Strip
      // `stream_options` too — it is only legal with `stream: true`, so leaving
      // it on would turn this graceful fallback into a second rejection.
      const cleanBody = { ...body };
      delete cleanBody.stream_options;
      const data = await apiPost(path, { ...cleanBody, stream: false }, headers);
      const fullText = textOf(data);
      if (fullText) onStream({ delta: fullText });
      return data;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      // Server ignored the stream flag and answered with plain JSON.
      const data = await parseResponse(res);
      const fullText = textOf(data);
      if (fullText) {
        onStream({ delta: fullText });
      } else {
        throwErrorFrom(data, res.status);
      }
      return data;
    }

    // Real SSE: parse `data:` lines incrementally, OpenAI-chunk shape.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let resultModel = body.model;
    let usage = null;
    let sseError = '';
    // Tool-call fragments, keyed by the provider's index. The pool forwards
    // the provider's own `delta.tool_calls` chunks verbatim when the caller
    // sent `tools`, so the shared client has to reassemble them the same way
    // the non-streaming branch does — otherwise a tool-calling turn would
    // resolve with text only and the caller could never see the calls.
    const toolCallsByIndex = new Map();
    let finishReason = null;

    // Idle watchdog: if the server holds the connection open without ever
    // sending another byte (a stuck upstream call, a proxy that swallows the
    // close), reader.read() below waits forever and the whole desktop host
    // hangs with no way out but force-quit. Cap the gap between chunks —
    // not the whole response — so a slow-but-alive generation is untouched.
    //
    // The budget is per *response*, not per call site: a pooled brain call
    // announces its worker fan-out in the X-AEGIS-Brain response header, and a
    // fan-out is legitimately silent until its first worker returns. Keying the
    // longer budget on a request the caller remembered to flag left the
    // default Nexus turn (brain model id, checkbox off) dying at 60s — with
    // the server already past its own fan-out deadline and every worker
    // billed. See idleBudgetFor().
    const idleMs = idleBudgetFor(res, idleTimeoutMs);
    async function readWithIdleTimeout() {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`stream stalled - no data for ${idleMs / 1000}s`));
        }, idleMs);
      });
      try {
        return await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }

    for (;;) {
      let done, value;
      try {
        ({ done, value } = await readWithIdleTimeout());
      } catch (err) {
        reader.cancel().catch(() => {});
        throw err;
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep the last partial line for the next read

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue; // partial/keepalive line — ignore
        }
        if (json.error) {
          if (!sseError) {
            const e = json.error;
            sseError =
              typeof e === 'string'
                ? e
                : errorMessageOf({ error: e }) || 'stream error';
          }
          continue;
        }
        if (json.model) resultModel = json.model;
        if (json.usage) usage = json.usage;
        const choice = json.choices && json.choices[0];
        if (choice && choice.finish_reason) finishReason = choice.finish_reason;
        // Extended-reasoning trace: the pool's worker findings (and any
        // provider CoT) arrive as `delta.reasoning_content` *before* the
        // synthesis pass writes the visible answer. Deliberately kept out of
        // `fullText` — deliberation is not an answer, and counting it would
        // make a no-answer turn look answered to every caller's empty-check.
        const reasoning =
          (choice &&
            ((choice.delta && choice.delta.reasoning_content) ||
              (choice.message && choice.message.reasoning_content))) ||
          '';
        if (reasoning) {
          if (typeof onReasoning === 'function') onReasoning(reasoning);
          else onStream({ reasoning });
        }
        const delta =
          (choice &&
            ((choice.delta && choice.delta.content) ||
              (choice.message && choice.message.content))) ||
          '';
        if (delta) {
          fullText += delta;
          onStream({ delta });
        }
        const fragments =
          (choice && choice.delta && choice.delta.tool_calls) ||
          (choice && choice.message && choice.message.tool_calls);
        if (Array.isArray(fragments)) {
          for (const tc of fragments) {
            const idx = tc.index == null ? 0 : tc.index;
            const cur = toolCallsByIndex.get(idx) || {
              id: '',
              type: 'function',
              function: { name: '', arguments: '' },
            };
            if (tc.id) cur.id = tc.id;
            if (tc.type) cur.type = tc.type;
            const fn = tc.function || {};
            if (fn.name) cur.function.name = fn.name;
            if (typeof fn.arguments === 'string') cur.function.arguments += fn.arguments;
            toolCallsByIndex.set(idx, cur);
          }
        }
      }
    }

    if (!fullText && sseError) {
      const err = new Error(sseError);
      err.status = res.status;
      throw err;
    }

    // An id-less fragment stream still yields usable calls, but the caller
    // needs *an* id to pair results back, so synthesize one.
    const toolCalls = [...toolCallsByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, c]) => ({ ...c, id: c.id || `call_${idx}` }));

    const message = { content: fullText };
    if (toolCalls.length) message.tool_calls = toolCalls;
    const result = {
      model: resultModel,
      choices: [
        { message, ...(finishReason ? { finish_reason: finishReason } : {}) },
      ],
    };
    if (usage) result.usage = usage;
    return result;
  }

  async function listModels() {
    return apiGet('/api/v1/models');
  }

  async function tokenBankBalance() {
    return apiGet('/api/token-bank/balance');
  }

  /** Start a token-bank top-up; resolves to { url } for the payment page. */
  async function tokenBankTopup(amountEur) {
    return apiPost('/api/token-bank/topup', { amount_eur: amountEur });
  }

  async function byokStatus() {
    return apiGet('/api/user/api-keys');
  }

  async function byokSet(provider, providerApiKey) {
    return apiPost('/api/user/api-keys', {
      provider,
      api_key: providerApiKey || '',
    });
  }

  async function memorySearch(query, limit) {
    const token = await getMemoryToken();
    return apiPost(
      '/api/memory/search',
      { query: query || '', limit: limit || 5 },
      memoryHeaders(token)
    );
  }

  async function memorySave(entry) {
    const token = await getMemoryToken();
    return apiPost('/api/memory/save', { entry }, memoryHeaders(token));
  }

  async function memoryList(limit) {
    const token = await getMemoryToken();
    // /api/memory/list is session-cookie (dashboard) auth, unusable here.
    // The bearer-authenticated way to get recent entries is search with an
    // empty query, which the backend returns most-recent-first.
    return apiPost(
      '/api/memory/search',
      { query: '', limit: limit || 10 },
      memoryHeaders(token)
    );
  }

  /** Verify a bearer token (memory or API) against the backend. */
  async function verifyToken(token) {
    return apiPost(
      '/api/verify-token',
      { token: token || '' },
      {
        'Content-Type': 'application/json',
        'X-AEGIS-Version': clientVersion,
        Authorization: `Bearer ${token}`,
      }
    );
  }

  /** Activate cloud memory for the authenticated account. */
  async function memoryActivate(token) {
    const t = token || (await getMemoryToken());
    return apiPost('/api/memory/activate', {}, memoryHeaders(t));
  }

  /** Pull memory entries updated since a timestamp (epoch ms). */
  async function memoryPull(since) {
    const token = await getMemoryToken();
    return apiPost(
      '/api/memory/pull',
      { since: since || 0 },
      memoryHeaders(token)
    );
  }

  /** Save a batch of memory entries in one request. */
  async function memorySaveBatch(entries) {
    const token = await getMemoryToken();
    return apiPost(
      '/api/memory/save',
      { entries: entries || [] },
      memoryHeaders(token)
    );
  }

  /**
   * Push one local conversation transcript to aegis1's conversation-sync
   * surface (P4.5), authenticated the same way as the memory endpoints
   * (memory_token, not the API key — see getMemoryToken()). The response is
   * returned verbatim; callers read `session_id`/`sessions` off it.
   */
  async function conversationSyncPush(transcript) {
    const token = await getMemoryToken();
    return apiPost(
      '/api/conversations/sync',
      {
        session_id: transcript && transcript.session_id,
        title: (transcript && transcript.title) || '',
        messages: (transcript && transcript.messages) || [],
        source: (transcript && transcript.source) || 'aegis-desktop',
      },
      memoryHeaders(token)
    );
  }

  /** Pull the account's remote conversation sessions (no transcript to push —
   *  same endpoint, list-only request). */
  async function conversationSyncPull() {
    const token = await getMemoryToken();
    return apiPost('/api/conversations/sync', {}, memoryHeaders(token));
  }

  /** Import a conversation transcript for later memory/training use. */
  async function importConversation({ messages, url, title, source } = {}) {
    return apiPost('/api/import', {
      messages: messages || [],
      url: url || '',
      title: title || '',
      source: source || 'aegiscode-plugin',
    });
  }

  return {
    apiBase,
    get apiKey() {
      return apiKey;
    },
    setApiKey,
    get clientVersion() {
      return clientVersion;
    },
    verifyApiKey,
    chatCompletion,
    byokChatCompletion,
    listModels,
    tokenBankBalance,
    tokenBankTopup,
    byokStatus,
    byokSet,
    getMemoryToken,
    memorySearch,
    memorySave,
    memoryList,
    verifyToken,
    memoryActivate,
    memoryPull,
    memorySaveBatch,
    conversationSyncPush,
    conversationSyncPull,
    importConversation,
    randomUUID,
  };
}

/** Gap between SSE chunks that counts as "the stream is dead", in ms. */
const SSE_IDLE_TIMEOUT_MS = 60_000;

/**
 * Gap allowed while a pooled brain call runs its worker fan-out, in ms.
 *
 * The fan-out yields a header chunk and then says nothing until its FIRST
 * worker pass returns — and each worker is a full reasoning-model call at
 * roughly 1/(workers+1) of the effort budget, so the silent window is minutes,
 * not seconds. The server bounds that window itself
 * (``services/pool_brain.py`` ``NEXUS_BRAIN_WORKER_TIMEOUT``, default 600s) and
 * announces it per-response with the ``X-AEGIS-Brain`` header, so this budget
 * has to outlast the *server's* deadline: aborting first kills a healthy turn
 * the server is still running and billing.
 *
 * Raising the server's env var above ~14 minutes requires raising this too.
 * desktop/lib/local/engine.js mirrors the same value for the explicit
 * "work autonomously" path (AUTONOMOUS_IDLE_TIMEOUT_MS); the desktop test
 * test/autonomous-mode.test.mjs fails if either drops below the server default.
 */
const BRAIN_IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * Idle budget for one SSE response: the caller's override when it asked for
 * one, widened to the fan-out budget when the server says this response *is* a
 * fan-out. The header is the authoritative signal — it is set by the same code
 * that runs the fan-out, so a renamed brain id or a caller that forgot its
 * flag cannot desynchronise the two. A response with no header (an older
 * server, or a single-pass call) keeps the caller's budget or the 60s default.
 */
function idleBudgetFor(res, requestedMs) {
  const base = Number(requestedMs) > 0 ? Number(requestedMs) : SSE_IDLE_TIMEOUT_MS;
  let header = '';
  try {
    const get = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get.bind(res.headers) : null;
    header = (get && get('X-AEGIS-Brain')) || '';
  } catch {
    header = ''; // an exotic fetch shim without headers: keep the caller's budget
  }
  return header && String(header).trim() ? Math.max(base, BRAIN_IDLE_TIMEOUT_MS) : base;
}

const api = { createClient, envVar, randomUUID, DEFAULT_API_BASE, CLIENT_VERSION, idleBudgetFor, SSE_IDLE_TIMEOUT_MS, BRAIN_IDLE_TIMEOUT_MS };

// Node / Electron (CommonJS): the MCP plugin and desktop shell require() this.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
// Browser <script>: expose a single namespaced global for the aegis-online SPA.
if (typeof window !== 'undefined') {
  window.AegisClient = api;
}
