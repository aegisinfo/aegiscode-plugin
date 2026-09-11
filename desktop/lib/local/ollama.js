'use strict';

/**
 * ollama.js — local Ollama transport (plan P1 §5.1). Wire calls only: probe
 * the daemon, list tags, and chat over its OpenAI-compatible
 * /v1/chat/completions (keyless). No orchestration/routing logic.
 */

const { openaiCompatible } = require('./providers.js');

const DEFAULT_BASE = 'http://localhost:11434';

function baseOf(baseURL) {
  return String(baseURL || DEFAULT_BASE).replace(/\/+$/, '');
}

/** Probe the local daemon (with a short timeout). Never throws. */
async function probe(baseURL = DEFAULT_BASE) {
  try {
    const res = await fetch(`${baseOf(baseURL)}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    return { running: res.ok, baseURL: baseOf(baseURL) };
  } catch {
    return { running: false, baseURL: baseOf(baseURL) };
  }
}

/** List installed model tags (`GET /api/tags` → [{ id, ...details }]). */
async function listTags(baseURL = DEFAULT_BASE) {
  const res = await fetch(`${baseOf(baseURL)}/api/tags`);
  if (!res.ok) {
    const err = new Error(`ollama /api/tags ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const models = (data && data.models) || [];
  return models.map((m) => ({
    id: m.name,
    ...(m.details ? { details: m.details } : {}),
  }));
}

/** Streaming chat against a local model (OpenAI-compatible, keyless). */
async function chat({
  baseURL = DEFAULT_BASE,
  model,
  messages,
  system,
  prompt,
  maxTokens = 4096,
  temperature,
  tools,
  toolChoice,
  signal,
  onDelta,
} = {}) {
  return openaiCompatible({
    baseURL: baseOf(baseURL),
    apiKey: null,
    model,
    messages,
    system,
    prompt,
    maxTokens,
    temperature,
    // Ollama's OpenAI-compatible shim accepts `tools` on current builds; the
    // engine retries without them once if an older daemon 400s.
    tools,
    toolChoice,
    signal,
    onDelta,
  });
}

module.exports = { DEFAULT_BASE, baseOf, probe, listTags, chat };
