#!/usr/bin/env node
/**
 * AEGIS thin client — zero-dependency transport to aegiscloud.org.
 *
 * This file is the ONLY public surface that talks to the AEGIS backend. It
 * forwards requests and normalises responses; it contains NO engine, brain,
 * orchestration, routing, or tier logic. All of that lives in the private
 * ae-guix product and behind aegiscloud.org.
 *
 * Shared by both hosts:
 *   - mcp/server.js   (Claude Code MCP plugin)
 *   - desktop/        (thin Electron shell)
 *
 * Usage:
 *   const { createClient } = require('./client/aegis.js');
 *   const aegis = createClient();            // reads AEGIS_API_KEY from env
 *   const aegis = createClient({ apiBase, apiKey, memoryToken });
 */

'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_API_BASE = 'https://aegiscloud.org';
const CLIENT_VERSION = '3.1.0';

/**
 * .mcp.json / Electron pass config as "${VAR}" template refs. When the var is
 * unset, hosts have been observed to leave the template literally unexpanded
 * (e.g. "${AEGIS_API_BASE}") instead of omitting it — which defeats a plain
 * `|| default` fallback since the literal string is truthy. Treat anything
 * shaped like an unexpanded template as absent.
 */
function envVar(name) {
  const v = process.env[name];
  return v && !/^\$\{[A-Z_]+\}$/.test(v) ? v : '';
}

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

  /** Base headers every request carries (version gate + key). */
  function authHeaders(extra) {
    return {
      'Content-Type': 'application/json',
      'X-AEGIS-Version': clientVersion,
      'X-API-Key': apiKey,
      Authorization: `Bearer ${apiKey}`,
      ...extra,
    };
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

  /**
   * Chat completion. Non-streaming by default (structured JSON error bodies —
   * this is what the MCP host relies on). When `stream: true` AND `onStream`
   * is a function, the request is sent with `stream: true` and each SSE delta
   * is delivered as `onStream({ delta })`. The resolved value is normalised to
   * the same shape as the non-streaming response either way, so hosts can
   * reconcile final text after the last chunk.
   */
  async function chatCompletion({
    prompt,
    system,
    model,
    mode,
    maxTokens,
    stream = false,
    onStream,
    signal,
  } = {}) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    const resolvedMode = mode || 'smart';
    const requestedModel = model || `nexus-${resolvedMode}`;
    const body = {
      model: requestedModel,
      messages,
      max_tokens: maxTokens || 1024,
    };

    if (!stream || typeof onStream !== 'function') {
      return apiPost('/api/v1/chat/completions', { ...body, stream: false });
    }
    return streamChatCompletion(body, onStream, signal);
  }

  /** Extract the assistant text from a full (non-streamed) completion JSON. */
  function textOf(data) {
    const choice = data && data.choices && data.choices[0];
    const content = choice && (choice.message && choice.message.content);
    return typeof content === 'string' ? content : '';
  }

  /**
   * POST body with `stream: true` and forward SSE deltas to onStream.
   *
   * Handles two servers gracefully:
   *  - a real SSE endpoint  -> incremental deltas, normalised final result
   *  - an endpoint that ignores `stream` and replies with plain JSON (or
   *    rejects `stream: true` outright) -> one-shot fallback: deliver the full
   *    text as a single delta and resolve the parsed JSON, unchanged.
   * This keeps streaming purely additive for hosts that opt in.
   */
  async function streamChatCompletion(body, onStream, signal) {
    let res;
    try {
      res = await fetch(`${apiBase}/api/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ ...body, stream: true }),
        signal,
      });
    } catch (err) {
      throw err; // network-level failure; nothing to fall back to
    }

    if (!res.ok) {
      // The endpoint may not accept `stream: true`. Retry once without it so
      // the caller gets the normal structured JSON (result or error).
      const data = await apiPost('/api/v1/chat/completions', {
        ...body,
        stream: false,
      });
      const fullText = textOf(data);
      if (fullText) onStream({ delta: fullText });
      return data;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      // Server ignored the stream flag and answered with plain JSON.
      const data = await parseResponse(res);
      const fullText = textOf(data);
      if (fullText) onStream({ delta: fullText });
      return data;
    }

    // Real SSE: parse `data:` lines incrementally, OpenAI-chunk shape.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let resultModel = body.model;
    let usage = null;

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
        if (json.model) resultModel = json.model;
        if (json.usage) usage = json.usage;
        const choice = json.choices && json.choices[0];
        const delta =
          choice &&
          (choice.delta && choice.delta.content) ||
          (choice.message && choice.message.content);
        if (typeof delta === 'string' && delta) {
          fullText += delta;
          onStream({ delta });
        }
      }
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

  return {
    apiBase,
    apiKey,
    get clientVersion() {
      return clientVersion;
    },
    verifyApiKey,
    chatCompletion,
    listModels,
    tokenBankBalance,
    byokStatus,
    byokSet,
    getMemoryToken,
    memorySearch,
    memorySave,
    memoryList,
    randomUUID,
  };
}

module.exports = { createClient, envVar, DEFAULT_API_BASE, CLIENT_VERSION };
