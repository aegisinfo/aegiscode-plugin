// A provider that holds the connection open and emits only SSE keep-alive
// comments must time out, not hang the host forever. Observed live on
// 2026-09-14: api.deepseek.com answered a trivial prompt with ": keep-alive"
// and nothing else — bytes kept arriving, so a watchdog armed per read() was
// reset by every one of them and never fired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSSE } from '../desktop/lib/local/providers.js';

const encoder = new TextEncoder();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Response-shaped object whose body streams `frames` with `gap` between. */
function sseResponse(frames, gap) {
  return {
    body: new ReadableStream({
      async start(controller) {
        for (const f of frames) {
          await wait(gap);
          controller.enqueue(encoder.encode(f));
        }
        controller.close();
      },
    }),
  };
}

test('keep-alive-only stream times out instead of hanging', async () => {
  const frames = Array.from({ length: 100 }, () => ': keep-alive\n\n');
  const started = Date.now();
  await assert.rejects(
    () => readSSE(sseResponse(frames, 20), () => {}, { idleTimeoutMs: 200 }),
    /stalled.*keep-alives/,
    'the error names the provider stall, not a dead network'
  );
  assert.ok(Date.now() - started < 3000, 'settled promptly, not after minutes');
});

test('keep-alives interleaved with real frames do not shorten the stream', async () => {
  const frames = [];
  for (let i = 0; i < 4; i++) {
    frames.push(': keep-alive\n\n');
    frames.push(`data: {"choices":[{"delta":{"content":"part${i} "}}]}\n\n`);
  }
  frames.push('data: [DONE]\n\n');
  const seen = [];
  // Each gap (60ms) is under the budget, but the whole stream (540ms) is well
  // past it — an idle budget measured from the last payload must survive that.
  await readSSE(sseResponse(frames, 60), (j) => seen.push(j), { idleTimeoutMs: 200 });
  const text = seen.map((j) => j.choices[0].delta.content).join('');
  assert.equal(text, 'part0 part1 part2 part3 ');
});

test('a stream that goes truly silent still times out', async () => {
  const res = { body: new ReadableStream({ start() {} }) }; // never enqueues, never closes
  await assert.rejects(
    () => readSSE(res, () => {}, { idleTimeoutMs: 150 }),
    /stalled - no data/
  );
});

console.log('keep-alive stall tests passed');
