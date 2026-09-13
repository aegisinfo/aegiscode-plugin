#!/usr/bin/env node
/**
 * The Aegis Cloud (pooled "Nexus" brain) stream must report token usage.
 *
 * This is the bug class the desktop kept hitting: the cloud class is the only
 * one that talks to the pool over SSE, and an OpenAI-compatible SSE response
 * carries no `usage` unless the caller asks for it with
 * `stream_options.include_usage`. So the pooled brain answered with text but
 * never a token count — while the same model through the non-streaming MCP
 * path reported both — and the desktop's "tokens:" line stayed empty for the
 * default class alone.
 *
 * Locks down, against a stubbed fetch (no network):
 *   1. `includeUsage` adds `stream_options` to the *streaming* request only.
 *      It must never ride on a non-stream request — the field is invalid with
 *      `stream:false`, so leaking it there turns the graceful fallback into a
 *      hard 400.
 *   2. A usage-only final frame (`choices: []`, the OpenAI `include_usage`
 *      sentinel) is captured, not dropped: the parser must not require a choice
 *      to be present to read `usage`.
 *   3. A server that predates `stream_options` and rejects the request is
 *      retried *streaming, without the hint* — losing the token count is
 *      survivable, silently downgrading the cloud class to a non-streamed
 *      one-lump answer is not.
 *   4. When the stream is impossible either way, the non-stream fallback goes
 *      out clean and still returns the server's structured JSON.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClient } = require('../client/aegis.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const SSE_HEADERS = { 'content-type': 'text/event-stream' };
const originalFetch = globalThis.fetch;
const enc = new TextEncoder();

/** A Response whose body streams the given SSE `data:` payloads, then closes. */
function sseResponse(frames) {
  const body = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

function textResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// A realistic pooled-brain stream: answer chunks, then the usage-only sentinel
// frame OpenAI-compatible servers send when `include_usage` is set.
const BRAIN_FRAMES = [
  { id: 'chatcmpl-1', model: 'nexus-brain', choices: [{ index: 0, delta: { content: 'the ' } }] },
  { id: 'chatcmpl-1', model: 'nexus-brain', choices: [{ index: 0, delta: { content: 'answer' } }] },
  { id: 'chatcmpl-1', model: 'nexus-brain', choices: [{ index: 0, finish_reason: 'stop' }] },
  {
    id: 'chatcmpl-1',
    model: 'nexus-brain',
    choices: [],
    usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
  },
];

let captured = [];

try {
  const client = createClient({ apiKey: 'test-key', apiBase: 'https://example.test' });

  // 1. Streaming + includeUsage asks for usage; a usage-only frame is captured
  // even though it carries no `choices[0]`.
  captured = [];
  globalThis.fetch = async (url, opts) => {
    captured.push({ url, opts });
    return sseResponse(BRAIN_FRAMES);
  };
  const deltas = [];
  const streamed = await client.chatCompletion({
    prompt: 'hi',
    model: 'nexus-brain',
    stream: true,
    includeUsage: true,
    onStream: (c) => {
      if (c.delta) deltas.push(c.delta);
    },
  });
  let body = JSON.parse(captured[captured.length - 1].opts.body);
  assert(
    body.stream_options && body.stream_options.include_usage === true,
    'a streaming cloud call must ask the server for usage (stream_options.include_usage)'
  );
  assert(body.stream === true, 'the streaming request keeps stream:true');
  assert(
    streamed.usage && streamed.usage.total_tokens === 1500,
    `a usage-only frame must be captured, got ${JSON.stringify(streamed.usage)}`
  );
  assert(streamed.usage.prompt_tokens === 1200, 'the prompt half of the usage survives');
  assert(deltas.join('') === 'the answer', 'the text still streams in order');

  // 2. includeUsage on a NON-stream call is dropped, not forwarded: the field is
  // only legal alongside stream:true, and leaking it here would 400.
  captured = [];
  globalThis.fetch = async (url, opts) => {
    captured.push({ url, opts });
    return textResponse({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 3 } });
  };
  await client.chatCompletion({ prompt: 'hi', includeUsage: true });
  body = JSON.parse(captured[captured.length - 1].opts.body);
  assert(body.stream === false, 'a request with no onStream is non-streaming');
  assert(!('stream_options' in body), 'stream_options must never ride on a non-stream request');

  // 3. No includeUsage -> no stream_options (the field is opt-in, so a caller
  // that doesn't want it can't be surprised by it).
  captured = [];
  globalThis.fetch = async (url, opts) => {
    captured.push({ url, opts });
    return sseResponse(BRAIN_FRAMES);
  };
  await client.chatCompletion({ prompt: 'hi', stream: true, onStream: () => {} });
  body = JSON.parse(captured[captured.length - 1].opts.body);
  assert(!('stream_options' in body), 'stream_options is opt-in via includeUsage');

  // 4. A server that rejects `stream_options` keeps its stream: the retry drops
  // just the hint instead of collapsing to the non-stream fallback.
  captured = [];
  globalThis.fetch = async (url, opts) => {
    captured.push({ url, opts });
    const sent = JSON.parse(opts.body);
    if (sent.stream_options) return textResponse({ error: 'unknown field stream_options' }, 400);
    return sseResponse(BRAIN_FRAMES);
  };
  const retryDeltas = [];
  const retried = await client.chatCompletion({
    prompt: 'hi',
    model: 'nexus-brain',
    stream: true,
    includeUsage: true,
    onStream: (c) => {
      if (c.delta) retryDeltas.push(c.delta);
    },
  });
  assert(captured.length === 2, `expected one retry, saw ${captured.length} requests`);
  const first = JSON.parse(captured[0].opts.body);
  const second = JSON.parse(captured[1].opts.body);
  assert(first.stream_options, 'the first attempt asks for usage');
  assert(!('stream_options' in second), 'the retry drops the rejected hint');
  assert(second.stream === true, 'the retry is still a streaming request — not the non-stream fallback');
  assert(retried.usage && retried.usage.total_tokens === 1500, 'the retried stream still yields usage');
  assert(retryDeltas.join('') === 'the answer', 'the retried stream still streams');

  // 5. Stream rejected outright -> the non-stream fallback body is clean and
  // the structured JSON comes back.
  captured = [];
  globalThis.fetch = async (url, opts) => {
    captured.push({ url, opts });
    const sent = JSON.parse(opts.body);
    if (sent.stream) return textResponse({ error: 'streaming unsupported' }, 400);
    return textResponse({
      choices: [{ message: { content: 'fallback answer' } }],
      usage: { total_tokens: 42 },
    });
  };
  const fallback = await client.chatCompletion({
    prompt: 'hi',
    stream: true,
    includeUsage: true,
    onStream: () => {},
  });
  const fallbackBody = JSON.parse(captured[captured.length - 1].opts.body);
  assert(fallbackBody.stream === false, 'the fallback is a non-stream request');
  assert(!('stream_options' in fallbackBody), 'the fallback body must not carry stream_options');
  assert(fallback.usage.total_tokens === 42, 'the fallback returns the server JSON (usage included)');

  // 6. End-to-end through the REAL engine and a REAL HTTP stream: the client and
  // the engine together, no fetch stub. This is the assertion that would have
  // caught the reported defect — the desktop's cloud class answering with text
  // but no token count.
  const { createLocalEngine } = require('../desktop/lib/local/engine.js');
  const http = require('node:http');
  // Restore the real fetch: the stubs above must not shadow the live round trip
  // this section is supposed to prove.
  globalThis.fetch = originalFetch;
  let receivedBody = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      receivedBody = JSON.parse(raw);
      res.writeHead(200, SSE_HEADERS);
      for (const f of BRAIN_FRAMES) res.write(`data: ${JSON.stringify(f)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const liveClient = createClient({ apiKey: 'test-key', apiBase: base });
    const noop = async () => ({});
    const liveEngine = createLocalEngine({
      aegis: liveClient,
      settings: { get: () => ({}), rawKey: () => null },
      ollama: noop,
      providers: { openaiCompatible: noop, anthropicMessages: noop },
    });
    const turn = await liveEngine.chat(
      { class: 'aegis', prompt: 'hi', model: 'nexus-brain', tools: false },
      () => {}
    );
    assert(
      receivedBody.stream_options && receivedBody.stream_options.include_usage === true,
      'the live pooled request asks the server for usage'
    );
    assert(
      receivedBody.model === 'nexus-brain',
      `the pooled brain is pinned on the canonical id, got ${receivedBody.model}`
    );
    assert(
      turn.usage && turn.usage.total_tokens === 1500,
      `a live pooled turn must report its tokens, got ${JSON.stringify(turn.usage)}`
    );
    assert(
      turn.choices[0].message.content === 'the answer',
      'the answer text still comes through the engine'
    );
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log('cloud usage tests passed');
} finally {
  globalThis.fetch = originalFetch;
}
