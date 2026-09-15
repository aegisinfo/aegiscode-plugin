/**
 * A stream must never show the same text twice, and a turn that was answered
 * must never render as "(no response)".
 *
 * Both symptoms were reported together from the CLI ("double glyphs and no
 * answer"), and both come from the same confusion between the two shapes an
 * OpenAI-compatible frame can carry:
 *
 *   choice.delta.content    an INCREMENT — append it
 *   choice.message.content  a SNAPSHOT of the whole message — do not append
 *
 * client/aegis.js collapsed them with `||`, so a stream that ended with a
 * message snapshot appended the entire answer a second time.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createClient } = require(join(root, 'client', 'aegis.js'));

function assert(c, m) { if (!c) throw new Error(`ASSERT FAILED: ${m}`); }
const eq = (a, b, m) => assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const enc = new TextEncoder();
/** A fetch that replays `frames` as one SSE body. */
function fakeFetch(frames) {
  return async () => ({
    ok: true, status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    text: async () => '',
    json: async () => ({}),
    body: new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    }),
  });
}

const frame = (obj) => ({ id: 'x', object: 'chat.completion.chunk', choices: [obj] });

async function run(frames) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(frames);
  try {
    const client = createClient({ apiKey: 'sk-test', baseUrl: 'https://example.invalid' });
    const seen = [];
    const res = await client.chatCompletion({
      prompt: 'hi',
      stream: true,
      onStream: (c) => { if (c.delta) seen.push(c.delta); },
    });
    const msg = res && res.choices && res.choices[0] && res.choices[0].message;
    return { emitted: seen.join(''), text: msg && msg.content };
  } finally { globalThis.fetch = realFetch; }
}

// 1. deltas then a full snapshot — the reported bug
{
  const { emitted, text } = await run([
    frame({ index: 0, delta: { content: 'Hello ' } }),
    frame({ index: 0, delta: { content: 'world' } }),
    frame({ index: 0, message: { content: 'Hello world' }, finish_reason: 'stop' }),
  ]);
  eq(emitted, 'Hello world', 'the snapshot must not re-emit what already streamed');
  eq(text, 'Hello world', 'and must not double the accumulated text');
}

// 2. a snapshot carrying MORE than was streamed: only the tail is new
{
  const { emitted, text } = await run([
    frame({ index: 0, delta: { content: 'Hello' } }),
    frame({ index: 0, message: { content: 'Hello world' }, finish_reason: 'stop' }),
  ]);
  eq(emitted, 'Hello world', 'the unseen tail is emitted exactly once');
  eq(text, 'Hello world', 'accumulated text matches the snapshot');
}

// 3. snapshot only, nothing streamed — a non-streaming-shaped answer
{
  const { emitted, text } = await run([
    frame({ index: 0, message: { content: 'Only answer' }, finish_reason: 'stop' }),
  ]);
  eq(emitted, 'Only answer', 'a snapshot-only stream still produces the answer');
  eq(text, 'Only answer', 'and records it');
}

// 4. plain incremental deltas are untouched
{
  const { emitted, text } = await run([
    frame({ index: 0, delta: { content: 'a' } }),
    frame({ index: 0, delta: { content: 'b' } }),
    frame({ index: 0, delta: { content: 'c' }, finish_reason: 'stop' }),
  ]);
  eq(emitted, 'abc', 'normal streaming is unchanged');
  eq(text, 'abc', 'and accumulates correctly');
}

// 5. reasoning snapshots deduplicate the same way
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch([
    frame({ index: 0, delta: { reasoning_content: 'think ' } }),
    frame({ index: 0, message: { reasoning_content: 'think harder' } }),
    frame({ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }),
  ]);
  try {
    const client = createClient({ apiKey: 'sk-test', baseUrl: 'https://example.invalid' });
    const r = [];
    await client.chatCompletion({ prompt: 'hi', stream: true, onStream: (c) => { if (c.reasoning) r.push(c.reasoning); } });
    eq(r.join(''), 'think harder', 'a reasoning snapshot must not repeat the streamed prefix');
  } finally { globalThis.fetch = realFetch; }
}

console.log('stream duplication tests passed');
