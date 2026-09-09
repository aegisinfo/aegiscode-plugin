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
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : envVar('AEGIS_API_KEY');
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

  // -------------------------------------------------------------------------
  // High-level API (returns raw backend data; hosts decide how to format it)
  // -------------------------------------------------------------------------

  async function verifyApiKey() {
    return apiPost('/api/verify-api-key', { api_key: apiKey });
  }

  /** Build the OpenAI-style messages array from either a full history or the
   *  single-shot { system, prompt } shorthand. */
  function buildMessages(messages, system, prompt) {
    if (Array.isArray(messages) && messages.length) return messages;
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    out.push({ role: 'user', content: prompt || '' });
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
    return postStream('/api/v1/chat/completions', body, authHeaders(), onStream, signal);
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
  async function postStream(path, body, headers, onStream, signal) {
    let res;
    try {
      res = await fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, stream: true }),
        signal,
      });
    } catch (err) {
      throw err; // network-level failure; nothing to fall back to
    }

    if (!res.ok) {
      // The endpoint may not accept `stream: true`. Retry once without it so
      // the caller gets the normal structured JSON (result or error).
      const data = await apiPost(path, { ...body, stream: false }, headers);
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

    for (;;) {
      const { done, value } = await reader.read();
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
        const delta =
          (choice &&
            ((choice.delta && choice.delta.content) ||
              (choice.message && choice.message.content))) ||
          '';
        if (delta) {
          fullText += delta;
          onStream({ delta });
        }
      }
    }

    if (!fullText && sseError) {
      const err = new Error(sseError);
      err.status = res.status;
      throw err;
    }

    const result = {
      model: resultModel,
      choices: [{ message: { content: fullText } }],
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
    apiKey,
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

const api = { createClient, envVar, randomUUID, DEFAULT_API_BASE, CLIENT_VERSION };

// Node / Electron (CommonJS): the MCP plugin and desktop shell require() this.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
// Browser <script>: expose a single namespaced global for the aegis-online SPA.
if (typeof window !== 'undefined') {
  window.AegisClient = api;
}
