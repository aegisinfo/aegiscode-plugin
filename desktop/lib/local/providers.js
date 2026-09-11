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

/**
 * Version/endpoint segments a user may already have typed into "base URL".
 * Both OpenAI's and Anthropic's docs hand out base URLs that end in `/v1`, and
 * the settings field invites pasting exactly that — so blindly appending
 * `/v1/<endpoint>` produced `.../v1/v1/chat/completions`, a 404/400 on every
 * call (defect A). A base URL that already names the endpoint
 * (`…/v1/messages`) or carries a longer prefix (`…/openai/v1`) must normalise
 * to the same single `/v1` too.
 */
const TRAILING_ENDPOINT = /\/(?:chat\/completions|completions|messages|models)$/;
const TRAILING_VERSION = /\/v\d+(?:\.\d+)?$/;

/** Drop a trailing version and/or endpoint segment, keeping any prefix. */
function stripEndpointSuffix(path) {
  let out = path;
  for (;;) {
    const trimmed = out.replace(/\/+$/, '');
    if (TRAILING_ENDPOINT.test(trimmed)) {
      out = trimmed.replace(TRAILING_ENDPOINT, '');
      continue;
    }
    if (TRAILING_VERSION.test(trimmed)) {
      out = trimmed.replace(TRAILING_VERSION, '');
      continue;
    }
    return trimmed;
  }
}

/**
 * Build the absolute request URL for a wire-format endpoint. `baseURL` may be
 * bare (`https://api.openai.com`), versioned (`…/v1`), versioned with a
 * trailing slash, or already name the endpoint — all of them resolve to
 * exactly one version segment. Any other path prefix survives, as does a
 * query string or fragment. The endpoint path is supplied by the caller so
 * this stays the single shared path builder for both transports.
 */
function endpointURL(baseURL, endpointPath) {
  const raw = String(baseURL == null ? '' : baseURL).trim();
  const cut = raw.search(/[?#]/);
  const base = cut === -1 ? raw : raw.slice(0, cut);
  const tail = cut === -1 ? '' : raw.slice(cut);
  return `${stripEndpointSuffix(base)}${endpointPath}${tail}`;
}

/** A model id is mandatory over both wire formats; a URL is never one. */
function requireModel(model) {
  if (typeof model === 'string' && model.trim()) return model.trim();
  const err = new Error(
    'a model id is required — type the provider\'s model name (a base URL is not a model)'
  );
  err.status = 400;
  throw err;
}

/**
 * Normalise arbitrary message entries to a wire-safe { role, content } row.
 *
 * The agent loop threads tool traffic through this same list: an assistant row
 * carrying `tool_calls` and a `tool` row carrying `tool_call_id` must survive
 * verbatim, and an Anthropic row may carry structured `content` blocks
 * (tool_use / tool_result) instead of a string. Both are passed through
 * untouched; a plain string row normalises exactly as before.
 */
function normalizeMessages(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    if (!m) continue;
    const role = m.role || 'user';
    const structured = m.content != null && typeof m.content !== 'string';
    const content = structured
      ? m.content
      : typeof m.content === 'string'
        ? m.content
        : m.text != null
          ? String(m.text)
          : '';
    const row = { role, content };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) row.tool_calls = m.tool_calls;
    if (m.tool_call_id) row.tool_call_id = m.tool_call_id;
    if (m.name) row.name = m.name;
    out.push(row);
  }
  return out;
}

/**
 * Append the single-shot `prompt` shorthand as a final user turn.
 *
 * The old builder *replaced* the whole list whenever `prompt` was non-empty:
 * a turn carrying both an agent-loop history and a fresh prompt silently lost
 * every prior message — including any system message, which is why the ported
 * persona would have vanished on the renderer's own call path. History is now
 * preserved and the prompt is appended once (skipped when the history already
 * ends with that exact user turn, so a caller that sends both is not doubled).
 */
function appendPrompt(out, prompt) {
  if (prompt == null || prompt === '') return out;
  const last = out[out.length - 1];
  if (last && last.role === 'user' && last.content === prompt) return out;
  out.push({ role: 'user', content: prompt });
  return out;
}

/** OpenAI-format message list with the system message prepended. */
function openAIMessages(messages, system, prompt) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  out.push(...normalizeMessages(messages));
  return appendPrompt(out, prompt);
}

/**
 * Fold OpenAI-shaped tool traffic into Anthropic content-block turns.
 *
 * Anthropic's Messages API has no `tool` role and no `tool_calls` field: an
 * assistant turn's tool calls must become `tool_use` content blocks, and each
 * result must become a `tool_result` block inside the *following* `user`
 * turn (parallel results share one turn, not one each — Anthropic 400s on
 * separate turns). Passing the OpenAI shapes through verbatim, which
 * `normalizeMessages` alone did, is a hard 400 on any real tool round-trip.
 */
function toAnthropicToolTurns(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role;
    if (role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id || '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const tc of m.tool_calls) {
        const fn = tc.function || {};
        let input = {};
        if (typeof fn.arguments === 'string') {
          try {
            input = fn.arguments.trim() ? JSON.parse(fn.arguments) : {};
          } catch {
            input = {};
          }
        } else if (fn.arguments && typeof fn.arguments === 'object') {
          input = fn.arguments;
        }
        blocks.push({ type: 'tool_use', id: tc.id || '', name: fn.name || '', input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push(m);
  }
  return out;
}

/** Anthropic-format message list (system is a top-level field, not a turn). */
function buildAnthropicMessages(messages, prompt) {
  return toAnthropicToolTurns(appendPrompt(normalizeMessages(messages), prompt));
}

// ── Tool-call accumulation ──────────────────────────────────────────────────
//
// Both wire formats stream a call in fragments: OpenAI sends
// `delta.tool_calls[{index, id?, function:{name?, arguments?}}]` and Anthropic
// sends a `content_block_start` (tool_use) followed by `input_json_delta`
// fragments keyed by content-block index. The parsers below used to keep only
// the text delta; the agent loop needs the calls themselves, so each transport
// accumulates them and reports a normalised `toolCalls: [{id, name, args}]`
// on its result (plus the provider's own shape, so a caller that speaks one
// wire format natively can read it unchanged).

/** Parse accumulated argument JSON; a malformed fragment degrades to {}. */
function parseToolArgs(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Stamp one OpenAI `tool_calls` fragment list into an index-keyed map. */
function addOpenAIToolCall(map, tc) {
  if (!tc) return;
  const idx = tc.index == null ? 0 : tc.index;
  const cur = map.get(idx) || { id: '', name: '', args: '' };
  if (tc.id) cur.id = tc.id;
  const fn = tc.function || {};
  if (fn.name) cur.name = fn.name;
  if (typeof fn.arguments === 'string') cur.args += fn.arguments;
  map.set(idx, cur);
}

/** Map → normalised calls, preserving the provider's index order. */
function finalizeToolCalls(map) {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => ({ id: c.id, name: c.name, args: parseToolArgs(c.args) }));
}

/** One OpenAI-format tool definition → Anthropic's {name, input_schema}. */
function openaiToAnthropicTool(tool) {
  const fn = (tool && tool.function) || tool || {};
  return {
    name: fn.name,
    description: fn.description || '',
    input_schema: fn.parameters || { type: 'object', properties: {} },
  };
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
  tools,
  toolChoice,
  signal,
  onDelta,
} = {}) {
  const url = endpointURL(baseURL, '/v1/chat/completions');
  const modelId = requireModel(model);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model: modelId,
    messages: openAIMessages(messages, system, prompt),
    max_tokens: maxTokens || 4096,
    stream: true,
  };
  if (temperature != null) body.temperature = temperature;
  // Only advertise tools when the caller passes a non-empty list — an empty
  // `tools: []` is a 400 on some gateways.
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }

  let fullText = '';
  let resultModel = modelId;
  let usage = null;
  let finishReason = null;
  const toolCallMap = new Map(); // index → {id, name, args}

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
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      const delta =
        (choice &&
          ((choice.delta && choice.delta.content) ||
            (choice.message && choice.message.content))) ||
        '';
      if (delta) {
        fullText += delta;
        if (onDelta) onDelta({ delta });
      }
      // Streamed fragments (delta.tool_calls) and the whole-answer shape a
      // non-streaming fallback returns (message.tool_calls) both land here.
      const fragments =
        (choice && choice.delta && choice.delta.tool_calls) ||
        (choice && choice.message && choice.message.tool_calls);
      if (Array.isArray(fragments)) {
        for (const tc of fragments) addOpenAIToolCall(toolCallMap, tc);
      }
    },
  });

  const toolCalls = finalizeToolCalls(toolCallMap);
  const message = { content: fullText };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
  }
  const result = {
    model: resultModel,
    choices: [{ message, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  };
  if (usage) result.usage = usage;
  if (toolCalls.length) result.toolCalls = toolCalls;
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
  tools,
  toolChoice,
  signal,
  onDelta,
} = {}) {
  const url = endpointURL(baseURL, '/v1/messages');
  const modelId = requireModel(model);
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  // Omit the credential header entirely when no key is configured: an empty
  // `x-api-key: ''` is still a credential attempt and turns a proxied/keyless
  // endpoint into a 401 (defect #3).
  if (apiKey) headers['x-api-key'] = apiKey;

  const body = {
    model: modelId,
    max_tokens: maxTokens || 4096,
    stream: true,
    messages: buildAnthropicMessages(messages, prompt),
  };
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;
  // Anthropic wants {name, description, input_schema} — an OpenAI-shaped list
  // is converted rather than sent raw (this is the documented footgun).
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools.map((t) => (t && t.function ? openaiToAnthropicTool(t) : t));
    if (toolChoice) body.tool_choice = toolChoice;
  }

  let fullText = '';
  let resultModel = modelId;
  let usage = null;
  let stopReason = null;
  const toolBlocks = new Map(); // content-block index → {id, name, args}

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
      // A tool_use block opens here; its arguments arrive as
      // input_json_delta fragments below (the text deltas we already parsed
      // are `text_delta`, which carry `.text`).
      if (json.type === 'content_block_start' && json.content_block) {
        const cb = json.content_block;
        if (cb.type === 'tool_use') {
          toolBlocks.set(json.index == null ? 0 : json.index, {
            id: cb.id || '',
            name: cb.name || '',
            args: '',
          });
        }
      }
      if (json.type === 'content_block_delta' && json.delta) {
        if (json.delta.type === 'input_json_delta') {
          const block = toolBlocks.get(json.index == null ? 0 : json.index);
          if (block) block.args += json.delta.partial_json || '';
        } else {
          const delta = typeof json.delta.text === 'string' ? json.delta.text : '';
          if (delta) {
            fullText += delta;
            if (onDelta) onDelta({ delta });
          }
        }
      }
      if (json.type === 'message_delta') {
        if (json.usage) usage = json.usage;
        if (json.delta && json.delta.stop_reason) stopReason = json.delta.stop_reason;
      }
      // Non-streaming fallback: a full Anthropic Message with content blocks.
      if (Array.isArray(json.content)) {
        if (json.model) resultModel = json.model;
        if (json.usage) usage = json.usage;
        if (json.stop_reason) stopReason = json.stop_reason;
        json.content.forEach((block, i) => {
          if (block && block.type === 'text' && block.text && !fullText) {
            fullText += block.text;
            if (onDelta) onDelta({ delta: block.text });
          }
          if (block && block.type === 'tool_use') {
            toolBlocks.set(i, {
              id: block.id || '',
              name: block.name || '',
              args: JSON.stringify(block.input || {}),
            });
          }
        });
      }
    },
  });

  const toolCalls = finalizeToolCalls(toolBlocks);
  const result = { model: resultModel, choices: [{ message: { content: fullText } }] };
  if (usage) result.usage = usage;
  if (stopReason) result.stop_reason = stopReason;
  if (toolCalls.length) {
    result.toolCalls = toolCalls;
    // Provider-native shape, for callers that read Anthropic blocks directly.
    result.choices[0].message.tool_calls = toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
  }
  return result;
}

module.exports = {
  normalizeMessages,
  openAIMessages,
  buildAnthropicMessages,
  appendPrompt,
  readSSE,
  requestStream,
  openaiCompatible,
  anthropicMessages,
  // shared path builder + model-id guard (unit-tested directly)
  endpointURL,
  stripEndpointSuffix,
  requireModel,
  // tool-call plumbing (unit-tested directly)
  addOpenAIToolCall,
  finalizeToolCalls,
  parseToolArgs,
  openaiToAnthropicTool,
};
