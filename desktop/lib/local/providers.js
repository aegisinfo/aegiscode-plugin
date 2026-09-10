'use strict';

/**
 * providers.js — direct streaming transport for two wire formats (plan P1
 * §5.1). Pure Node (Electron main), no engine/routing logic: it only speaks
 * the OpenAI-compatible and Anthropic Messages wire formats and normalises
 * both to the shared `{ delta }` chunk shape plus a final result.
 *
 *   - OpenAI-compatible: POST {baseURL}/v1/chat/completions (Bearer or keyless)
 *   - Anthropic Messages: POST {baseURL}/v1/messages (x-api-key when a key is
 *     set + version header; the credential header is omitted, never blanked)
 *
 * Every function returns the same normalised result the renderer already
 * paints: { model, choices: [{ message: { content } }], usage? }.
 */

/** Normalise arbitrary message entries to { role, content } (no system). */
function normalizeMessages(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    if (!m) continue;
    const role = m.role || 'user';
    const content =
      typeof m.content === 'string' ? m.content : m.text != null ? String(m.text) : '';
    out.push({ role, content });
  }
  return out;
}

/** OpenAI-format message list with the system message prepended. */
function openAIMessages(messages, system, prompt) {
  if (prompt != null && prompt !== '') {
    return [{ role: 'user', content: prompt }];
  }
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  return out.concat(normalizeMessages(messages));
}

/** Anthropic-format message list (system is a top-level field, not a turn). */
function buildAnthropicMessages(messages, prompt) {
  if (prompt != null && prompt !== '') {
    return [{ role: 'user', content: prompt }];
  }
  return normalizeMessages(messages);
}

/** Read an SSE body, invoking onEvent(json) for each parsed `data:` payload. */
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep the trailing partial line
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // keepalive / partial line
      }
      onEvent(json);
    }
  }
}

/** POST with stream:true; streams SSE events or falls back to plain JSON. */
async function requestStream({ url, headers, body, signal, onEvent }) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(
      `upstream ${res.status}: ${(text || res.statusText).slice(0, 300)}`
    );
    err.status = res.status;
    throw err;
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    await readSSE(res, onEvent);
    return;
  }

  // Server ignored stream:true and answered with plain JSON — one-shot fallback.
  const data = await res.json().catch(() => null);
  if (data) onEvent(data);
}

/** OpenAI-compatible streaming chat (Bearer auth or keyless for Ollama). */
async function openaiCompatible({
  baseURL,
  apiKey,
  model,
  messages,
  system,
  prompt,
  maxTokens = 4096,
  temperature,
  signal,
  onDelta,
} = {}) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: openAIMessages(messages, system, prompt),
    max_tokens: maxTokens || 4096,
    stream: true,
  };
  if (temperature != null) body.temperature = temperature;

  let fullText = '';
  let resultModel = model;
  let usage = null;

  await requestStream({
    url,
    headers,
    body,
    signal,
    onEvent: (json) => {
      if (json.error) return;
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
        if (onDelta) onDelta({ delta });
      }
    },
  });

  const result = { model: resultModel, choices: [{ message: { content: fullText } }] };
  if (usage) result.usage = usage;
  return result;
}

/** Anthropic Messages streaming chat (x-api-key + anthropic-version). */
async function anthropicMessages({
  baseURL,
  apiKey,
  model,
  messages,
  system,
  prompt,
  maxTokens = 4096,
  temperature,
  signal,
  onDelta,
} = {}) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/v1/messages`;
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  // Omit the credential header entirely when no key is configured: an empty
  // `x-api-key: ''` is still a credential attempt and turns a proxied/keyless
  // endpoint into a 401 (defect #3).
  if (apiKey) headers['x-api-key'] = apiKey;

  const body = {
    model,
    max_tokens: maxTokens || 4096,
    stream: true,
    messages: buildAnthropicMessages(messages, prompt),
  };
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;

  let fullText = '';
  let resultModel = model;
  let usage = null;

  await requestStream({
    url,
    headers,
    body,
    signal,
    onEvent: (json) => {
      if (!json || json.type === 'error' || json.error) {
        if (json && (json.error || json.type === 'error')) {
          const e = json.error || {};
          const msg =
            (typeof e === 'string' ? e : e.message) || 'anthropic stream error';
          const err = new Error(msg);
          err.status = err.status || 400;
          throw err;
        }
        return;
      }
      if (json.type === 'message_start' && json.message) {
        if (json.message.model) resultModel = json.message.model;
        if (json.message.usage) usage = json.message.usage;
      }
      if (json.type === 'content_block_delta' && json.delta) {
        const delta = typeof json.delta.text === 'string' ? json.delta.text : '';
        if (delta) {
          fullText += delta;
          if (onDelta) onDelta({ delta });
        }
      }
      if (json.type === 'message_delta' && json.usage) {
        usage = json.usage;
      }
    },
  });

  const result = { model: resultModel, choices: [{ message: { content: fullText } }] };
  if (usage) result.usage = usage;
  return result;
}

module.exports = {
  normalizeMessages,
  openAIMessages,
  buildAnthropicMessages,
  readSSE,
  requestStream,
  openaiCompatible,
  anthropicMessages,
};
