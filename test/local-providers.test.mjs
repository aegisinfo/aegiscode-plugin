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

// ---- defect A: base URL normalisation (exactly one version segment) --------
//
// OpenAI and Anthropic both hand out base URLs that already end in `/v1`, and
// the settings field invites pasting exactly that. Appending `/v1/<endpoint>`
// blindly produced `.../v1/v1/chat/completions` — a 404/400 on every call.
const { endpointURL } = require('../desktop/lib/local/providers.js');

const NORMALISED = [
  'https://api.openai.com',
  'https://api.openai.com/',
  'https://api.openai.com/v1',
  'https://api.openai.com/v1/',
  'https://api.openai.com/v1/chat/completions',
];
for (const base of NORMALISED) {
  const url = endpointURL(base, '/v1/chat/completions');
  assert(
    url === 'https://api.openai.com/v1/chat/completions',
    `OpenAI base "${base}" normalises to one /v1, got "${url}"`
  );
  assert((url.match(/\/v1\//g) || []).length === 1, `exactly one /v1 in "${url}"`);
}
const ANTHROPIC_BASES = [
  'https://api.anthropic.com',
  'https://api.anthropic.com/',
  'https://api.anthropic.com/v1',
  'https://api.anthropic.com/v1/',
  'https://api.anthropic.com/v1/messages',
];
for (const base of ANTHROPIC_BASES) {
  const url = endpointURL(base, '/v1/messages');
  assert(
    url === 'https://api.anthropic.com/v1/messages',
    `Anthropic base "${base}" normalises to one /v1, got "${url}"`
  );
}

// A non-version path prefix survives; a query string is not swallowed.
assert(
  endpointURL('https://gateway.example.com/openai/v1', '/v1/chat/completions') ===
    'https://gateway.example.com/openai/v1/chat/completions',
  'path prefix survives normalisation'
);
assert(
  endpointURL('http://localhost:11434', '/v1/chat/completions') ===
    'http://localhost:11434/v1/chat/completions',
  'bare keyless base URL unchanged'
);
assert(
  endpointURL('https://proxy.example.com/v1?tenant=a', '/v1/chat/completions') ===
    'https://proxy.example.com/v1/chat/completions?tenant=a',
  'query string preserved'
);

// ---- defect A end-to-end: the normalised URL is what actually gets fetched -
let urlFetches = [];
globalThis.fetch = async (url) => {
  urlFetches.push(url);
  return jsonResponse({ model: 'gpt-x', choices: [{ message: { content: 'ok' } }] });
};
for (const base of NORMALISED) {
  await openaiCompatible({ baseURL: base, apiKey: KEY, model: 'gpt-x', messages: [] });
}
for (const base of ANTHROPIC_BASES) {
  await anthropicMessages({ baseURL: base, apiKey: KEY, model: 'claude-x', messages: [] });
}
assert(
  urlFetches.every((u) => (u.match(/\/v1\//g) || []).length === 1),
  `no double /v1 in any fetched URL, got ${JSON.stringify(urlFetches)}`
);
assert(
  urlFetches.slice(0, NORMALISED.length).every((u) => u === 'https://api.openai.com/v1/chat/completions'),
  `every OpenAI base fetches /v1/chat/completions, got ${JSON.stringify(urlFetches)}`
);
assert(
  urlFetches.slice(NORMALISED.length).every((u) => u === 'https://api.anthropic.com/v1/messages'),
  `every Anthropic base fetches /v1/messages, got ${JSON.stringify(urlFetches)}`
);

// ---- defect B: an empty/blank model id never reaches fetch() ---------------
let blankFetches = 0;
globalThis.fetch = async () => {
  blankFetches += 1;
  return jsonResponse({ choices: [{ message: { content: '' } }] });
};
for (const blank of [undefined, null, '', '   ']) {
  for (const [name, call] of [
    ['openaiCompatible', () => openaiCompatible({ baseURL: 'https://api.openai.com/v1', apiKey: KEY, model: blank, messages: [] })],
    ['anthropicMessages', () => anthropicMessages({ baseURL: 'https://api.anthropic.com/v1', apiKey: KEY, model: blank, messages: [] })],
  ]) {
    let threw = null;
    try {
      await call();
    } catch (err) {
      threw = err;
    }
    assert(threw, `${name} rejects model=${JSON.stringify(blank)}`);
    assert(
      /model id is required/.test(threw.message),
      `${name} blank-model error is actionable, got "${threw && threw.message}"`
    );
  }
}
assert(blankFetches === 0, `blank model never fetched, got ${blankFetches} fetch call(s)`);

console.log('providers tests passed');
