#!/usr/bin/env node
/**
 * Regression tests for the pooled-brain streaming path (autonomous mode).
 *
 * Two defects this file exists to catch, both of which were silent:
 *
 *   1. The worker fan-out streams every worker's finding as
 *      `delta.reasoning_content` (see pool_brain.py). The transport only ever
 *      read `delta.content`, so the whole worker phase was discarded and the
 *      user watched an apparently idle bubble until the synthesis pass
 *      finished. The reasoning must reach the caller on its own channel and
 *      must NOT be folded into the visible answer — deliberation is not an
 *      answer, and counting it would make a no-answer turn look answered to
 *      every caller's empty-turn guard.
 *
 *   2. The SSE idle watchdog (60s) is correct for a single provider call but
 *      wrong for a pooled brain call: the fan-out yields a header chunk and
 *      then stays silent until the FIRST worker pass returns, which is a full
 *      reasoning-model call. A healthy turn was therefore aborted mid-flight —
 *      after the server had already run and billed every worker. The budget
 *      must be caller-overridable, and the engine must raise it when (and
 *      only when) the turn is autonomous.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readFileSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { fileURLToPath } = require('node:url');

/**
 * Import the TRACKED source, not `desktop/vendor/aegis.js`.
 *
 * `desktop/vendor/` is gitignored (.gitignore:8) — it is a staged copy that
 * `desktop/scripts/predist.mjs` regenerates from this file on every build. A
 * test that imports the copy therefore passes only on a machine that happens
 * to hold a generated one, and fails to load on a fresh clone. Worse, when the
 * transport fix was first written into `vendor/` alone, the next `predist` run
 * silently reverted it.
 */
const { createClient } = require('../client/aegis.js');
const { createLocalEngine } = require('../desktop/lib/local/engine.js');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// The generated copy must stay byte-identical to the tracked source, or a
// build would ship a transport without the fixes this file covers. Skipped
// when predist has not run yet (vendor/ absent) — that is not a failure.
const vendorPath = join(repoRoot, 'desktop', 'vendor', 'aegis.js');
if (existsSync(vendorPath)) {
  const src = readFileSync(join(repoRoot, 'client', 'aegis.js'), 'utf8');
  const vendor = readFileSync(vendorPath, 'utf8');
  assert(
    src === vendor,
    'desktop/vendor/aegis.js has drifted from client/aegis.js — re-run predist.mjs',
  );
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const originalFetch = globalThis.fetch;
const enc = new TextEncoder();

/** A Response whose body is the given SSE lines, then closed. */
function sseResponse(lines) {
  const body = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A Response that sends one chunk and then never closes — a stalled stream. */
function stallingResponse(firstChunk) {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(firstChunk));
      // deliberately never closed: simulates the pool's silent fan-out window
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

try {
  // ── 1. reasoning_content reaches onReasoning, never the visible answer ────

  let reasoning = '';
  let streamed = '';
  globalThis.fetch = async () =>
    sseResponse([
      sse({ choices: [{ delta: { reasoning_content: 'worker A: found foo in bar.js' } }] }),
      sse({ choices: [{ delta: { reasoning_content: 'worker B: no path' } }] }),
      sse({ choices: [{ delta: { content: 'Answer: foo lives in bar.js' }, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);

  const client = createClient({ apiKey: 'test-key', apiBase: 'https://example.test' });
  const res = await client.chatCompletion({
    prompt: 'where is foo',
    stream: true,
    onStream: (c) => {
      if (c && typeof c.delta === 'string') streamed += c.delta;
    },
    onReasoning: (t) => {
      reasoning += t;
    },
  });

  assert(
    reasoning.includes('worker A') && reasoning.includes('worker B'),
    `both worker findings must reach onReasoning, got ${JSON.stringify(reasoning)}`
  );
  const content = res.choices[0].message.content;
  assert(
    !content.includes('worker A') && !content.includes('worker B'),
    `deliberation must NOT be folded into the answer, got ${JSON.stringify(content)}`
  );
  assert(content.includes('foo lives in bar.js'), 'the synthesized answer is still delivered');
  assert(streamed === 'Answer: foo lives in bar.js', `only answer text hits onStream, got ${JSON.stringify(streamed)}`);

  // Without an onReasoning callback the trace must fall back to onStream as a
  // tagged chunk — otherwise a caller that predates the channel silently loses
  // it again (the original defect).
  const tagged = [];
  globalThis.fetch = async () =>
    sseResponse([
      sse({ choices: [{ delta: { reasoning_content: 'thinking' } }] }),
      sse({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);
  await client.chatCompletion({
    prompt: 'hi',
    stream: true,
    onStream: (c) => tagged.push(c),
  });
  assert(
    tagged.some((c) => c && c.reasoning === 'thinking'),
    'with no onReasoning, reasoning falls back to onStream({reasoning})'
  );

  // ── 2. idle watchdog honors the caller's budget ──────────────────────────

  globalThis.fetch = async () => stallingResponse(sse({ choices: [{ delta: { content: '' } }] }));
  const t0 = Date.now();
  let stalled = null;
  try {
    await client.chatCompletion({
      prompt: 'hi',
      stream: true,
      onStream: () => {},
      idleTimeoutMs: 150,
    });
  } catch (err) {
    stalled = err;
  }
  const elapsed = Date.now() - t0;
  assert(stalled !== null, 'a stalled stream must reject rather than hang forever');
  assert(
    /stream stalled/.test(stalled.message),
    `stall error should name the stall, got ${JSON.stringify(stalled.message)}`
  );
  assert(
    elapsed < 5000,
    `an explicit 150ms idle budget must be honored (took ${elapsed}ms) — a 60s default here would abort autonomous fan-outs`
  );

  // ── 3. the engine raises the budget ONLY for autonomous turns ────────────

  const seen = [];
  const aegis = {
    apiKey: 'k',
    async listModels() {
      return { models: [{ id: 'm1' }] };
    },
    async chatCompletion(args) {
      seen.push(args);
      if (args.onStream) args.onStream({ delta: 'hi' });
      return { model: args.model, choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] };
    },
  };
  const engine = createLocalEngine({
    aegis,
    settings: { get: () => ({}), rawKey: () => null },
    ollama: { async probe() {}, async listTags() { return []; } },
    providers: {},
    tools: { toolsFor: () => [], run: async () => ({}) },
  });

  await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1' }, () => {});
  const plain = seen[seen.length - 1];
  assert(
    plain.idleTimeoutMs === undefined,
    `a normal turn keeps the 60s default (got ${plain.idleTimeoutMs}) — raising it unconditionally would let a genuinely stuck stream hang for 5 minutes`
  );

  await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1', autonomous: true }, () => {});
  const auto = seen[seen.length - 1];
  // The invariant, not the number: the fan-out is silent until its first
  // worker returns, and the server allows that phase 600s of its own
  // (aegis1 services/pool_brain.py DEFAULT_WORKER_DEADLINE). A client budget
  // below it aborts a healthy turn the server is still running and billing.
  assert(
    auto.idleTimeoutMs > 600_000,
    `an autonomous turn must outlast the server's 600s fan-out deadline, got ${auto.idleTimeoutMs}`
  );

  // ── 4. the engine forwards reasoning on the delta channel ───────────────
  //
  // The renderer receives everything through onDelta, so the engine has to
  // re-tag reasoning as `{ reasoning }` — if it forwarded it as a plain
  // string the renderer would append worker output to the answer bubble.

  const chunks = [];
  const aegis2 = {
    apiKey: 'k',
    async listModels() {
      return { models: [{ id: 'm1' }] };
    },
    async chatCompletion(args) {
      assert(typeof args.onReasoning === 'function', 'the engine must hand aegis an onReasoning callback');
      args.onReasoning('worker finding');
      if (args.onStream) args.onStream({ delta: 'answer' });
      return { model: args.model, choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] };
    },
  };
  const engine2 = createLocalEngine({
    aegis: aegis2,
    settings: { get: () => ({}), rawKey: () => null },
    ollama: { async probe() {}, async listTags() { return []; } },
    providers: {},
    tools: { toolsFor: () => [], run: async () => ({}) },
  });
  await engine2.chat({ class: 'aegis', prompt: 'hi', model: 'm1', autonomous: true }, (c) => chunks.push(c));
  assert(
    chunks.some((c) => c && c.reasoning === 'worker finding'),
    'the engine must re-tag reasoning as { reasoning } for the renderer'
  );
  assert(
    chunks.some((c) => c && c.delta === 'answer'),
    'answer text still flows through onDelta untouched'
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('# aegis-reasoning tests passed');
