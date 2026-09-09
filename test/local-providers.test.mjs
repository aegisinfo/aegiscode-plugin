#!/usr/bin/env node
/** Unit tests for desktop/lib/local/providers.js (plan P1 §5.1). */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  openaiCompatible,
  anthropicMessages,
  openAIMessages,
  buildAnthropicMessages,
} = require('../desktop/lib/local/providers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// Runtime-built key so the CI secret scanner stays quiet — never a literal.
const KEY = `sk-${'x'.repeat(24)}`;

function sseResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ---- message builders -----------------------------------------------------
const oa = openAIMessages([{ role: 'user', content: 'hi' }], 'sys', null);
assert(oa[0].role === 'system' && oa[0].content === 'sys', 'OpenAI system first');
assert(oa[1].role === 'user' && oa[1].content === 'hi', 'OpenAI user turn');
const an = buildAnthropicMessages([{ role: 'user', content: 'hi' }], null);
assert(an.length === 1 && an[0].role === 'user', 'Anthropic has no system turn');

// ---- OpenAI-compatible streaming ------------------------------------------
let lastFetch = null;
globalThis.fetch = async (url, opts) => {
  lastFetch = { url, opts };
  return sseResponse([
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}],"model":"gpt-x","usage":{"total_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ]);
};

{
  const deltas = [];
  const r = await openaiCompatible({
    baseURL: 'https://api.example.com',
    apiKey: KEY,
    model: 'gpt-x',
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (c) => deltas.push(c.delta),
  });
  assert(deltas.join('') === 'Hello', `OpenAI deltas join to Hello, got "${deltas.join('')}"`);
  assert(r.choices[0].message.content === 'Hello', 'OpenAI normalised text');
  assert(r.model === 'gpt-x', 'OpenAI model captured from stream');
  assert(r.usage.total_tokens === 5, 'OpenAI usage captured');
  assert(lastFetch.url === 'https://api.example.com/v1/chat/completions', 'OpenAI URL');
  const body = JSON.parse(lastFetch.opts.body);
  assert(body.stream === true && body.model === 'gpt-x', 'OpenAI body stream+model');
  assert(lastFetch.opts.headers.Authorization === `Bearer ${KEY}`, 'OpenAI bearer auth');
}

// ---- OpenAI plain-JSON fallback (server ignored stream:true) --------------
globalThis.fetch = async () =>
  jsonResponse({ model: 'gpt-x', choices: [{ message: { content: 'full' } }], usage: { total_tokens: 4 } });
{
  const r = await openaiCompatible({ baseURL: 'https://api.example.com', apiKey: KEY, model: 'gpt-x', messages: [] });
  assert(r.choices[0].message.content === 'full', 'OpenAI plain-JSON fallback text');
}

// ---- Anthropic Messages streaming -----------------------------------------
globalThis.fetch = async (url, opts) => {
  lastFetch = { url, opts };
  return sseResponse([
    'data: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":3}}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hey"}}\n\n',
    'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
};
{
  const r = await anthropicMessages({
    baseURL: 'https://api.example.com',
    apiKey: KEY,
    model: 'claude-x',
    system: 'be brief',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert(r.choices[0].message.content === 'Hey', 'Anthropic normalised text');
  assert(r.model === 'claude-x', 'Anthropic model captured');
  assert(r.usage.output_tokens === 3, 'Anthropic usage captured');
  assert(lastFetch.opts.headers['x-api-key'] === KEY, 'Anthropic x-api-key');
  assert(lastFetch.opts.headers['anthropic-version'] === '2023-06-01', 'Anthropic version header');
}

console.log('providers tests passed');
