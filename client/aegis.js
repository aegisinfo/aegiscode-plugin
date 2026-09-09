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

  async function chatCompletion({ prompt, system, model, mode, maxTokens }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    const resolvedMode = mode || 'smart';
    const requestedModel = model || `nexus-${resolvedMode}`;
    return apiPost('/api/v1/chat/completions', {
      model: requestedModel,
      messages,
      max_tokens: maxTokens || 1024,
      stream: false,
    });
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
