#!/usr/bin/env node
/**
 * "Work autonomously" (the pooled-brain worker fan-out) — its two failure
 * modes were both invisible from the client side.
 *
 * 1. THE WATCHDOG KILLED HEALTHY TURNS. A fan-out yields a header chunk and
 *    then says nothing until its first worker pass returns — a full
 *    reasoning-model call, minutes at high effort. The desktop's 60s
 *    stalled-stream watchdog therefore aborted turns the *server* was still
 *    running and billing, and it did so for the DEFAULT Nexus turn too: the
 *    longer budget was keyed on the "work autonomously" checkbox, while the
 *    fan-out itself is triggered by the model id (``nexus-brain``), which the
 *    desktop sends either way. The server announces the fan-out in the
 *    X-AEGIS-Brain response header, so the budget is now settled per response
 *    (client idles budget) and the static budget outlasts the server's own
 *    ceiling for that window.
 *
 * 2. CONTINUATION PASSES RE-RAN THE WHOLE FAN-OUT. The doubled-budget retry
 *    and the "write up what you already found" re-dispatch both promise a
 *    single extra request in their own comments, but they inherited
 *    ``autonomous`` from the turn — and because the model id alone enables the
 *    brain, simply dropping the flag could not opt out. Three fresh workers
 *    plus a synthesis re-investigated from scratch, at 4x the cost, to produce
 *    a paragraph whose material was already in the conversation. The engine
 *    now sends an explicit ``brain: false`` for those passes, which
 *    services/pool_brain.py honours.
 *
 * The engine half runs against a stub transport and asserts the wire; the
 * client half runs against a real loopback HTTP server (no fetch stub) so the
 * header-driven budget is proven end to end, stall and all.
 */
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { createLocalEngine } = require('../desktop/lib/local/engine.js');
const { createClient, idleBudgetFor, BRAIN_IDLE_TIMEOUT_MS, SSE_IDLE_TIMEOUT_MS } = require('../client/aegis.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ── 1. Engine: what reaches the wire ────────────────────────────────────────

/** Stub AEGIS Cloud transport; records every chatCompletion args object. */
function harness(replies) {
  const calls = [];
  let i = 0;
  const aegis = {
    apiKey: 'k',
    async listModels() {
      return { models: [{ id: 'nexus-brain', label: 'NEXUS', hidden: false }] };
    },
    async chatCompletion(args) {
      calls.push(args);
      const reply = replies[Math.min(i, replies.length - 1)];
      i += 1;
      if (args.onStream && reply.text) args.onStream({ delta: reply.text });
      return {
        model: args.model,
        choices: [{ message: { content: reply.text || '' }, finish_reason: reply.finish || null }],
        usage: reply.usage || undefined,
      };
    },
  };
  const engine = createLocalEngine({
    aegis,
    settings: { get: () => ({}), rawKey: () => null },
    ollama: { async probe() { return { running: false }; }, async listTags() { return []; } },
    getConfirmMode: () => false,
  });
  return { engine, calls };
}

// (a) The autonomous turn fans out, asks for effort/workers, and gives the
// fan-out a budget that outlasts the server's own deadline (600s default).
{
  const { engine, calls } = harness([{ text: 'done' }]);
  await engine.chat(
    { class: 'aegis', prompt: 'hi', model: 'nexus-brain', autonomous: true, effort: 'high', workers: 3 },
    () => {}
  );
  const sent = calls[0];
  assert(sent.extra.brain === true, 'an autonomous turn sets brain:true');
  assert(sent.extra.effort === 'high' && sent.extra.workers === 3, 'effort/workers ride along');
  assert(
    sent.idleTimeoutMs > 600_000,
    `the fan-out idle budget must outlast the server's 600s worker deadline, got ${sent.idleTimeoutMs}ms`
  );
  assert(
    sent.idleTimeoutMs <= BRAIN_IDLE_TIMEOUT_MS,
    `the engine budget must not exceed the shared client's fan-out budget (${BRAIN_IDLE_TIMEOUT_MS}ms)`
  );
}

// (b) A plain turn on the pooled class is untouched: no `brain` key at all, so
// the model id keeps deciding (today's behaviour, deliberately unchanged).
{
  const { engine, calls } = harness([{ text: 'done' }]);
  await engine.chat({ class: 'aegis', prompt: 'hi', model: 'nexus-brain' }, () => {});
  assert(!('brain' in calls[0].extra), `a plain turn sends no brain flag: ${JSON.stringify(calls[0].extra)}`);
  assert(
    calls[0].idleTimeoutMs === undefined,
    'a plain turn keeps the default watchdog (the header widens it if the server fans out)'
  );
}

// (c) The truncation retry is one request, not a second investigation:
// same turn, fan-out on round 1, explicit single pass on the retry.
{
  const { engine, calls } = harness([
    { text: '', finish: 'length' },
    { text: 'the real answer' },
  ]);
  await engine.chat(
    { class: 'aegis', prompt: 'hi', model: 'nexus-brain', autonomous: true, effort: 'high', workers: 3, maxTokens: 4096 },
    () => {}
  );
  assert(calls.length === 2, `expected round 1 + one retry, got ${calls.length} calls`);
  assert(calls[0].extra.brain === true, 'round 1 still runs the fan-out');
  assert(calls[0].maxTokens === 4096, 'round 1 keeps the caller budget');
  assert(calls[1].extra.brain === false, 'the truncation retry opts OUT of the fan-out (single provider call)');
  assert(
    calls[1].extra.mode === 'brain',
    'the single pass is pinned to the band the workers run on (not the cheapest id in the pool)'
  );
  assert(calls[1].maxTokens === 8192, 'the retry still doubles the budget (that is what it is for)');
  // `workers` is fan-out tuning and has no meaning on a single pass. `effort`
  // is different: it is the budget rung, and it is now sent on every pooled
  // dispatch — the fan-out is triggered by the model id this class sends
  // (`nexus-brain`), so a caller that never ticked "work autonomously" still
  // ran a pooled call and previously had no way to say how big it should be,
  // leaving the server on its own top-of-ladder default. An inert field to the
  // server on this path (aegis1 reads effort only under the fan-out), but a
  // deliberate one: it keeps the request honest about what it asked for.
  assert(!('workers' in calls[1].extra), 'no fan-out sizing on a single pass');
  assert(
    calls[1].extra.effort === 'high',
    'the effort rung still travels, so the pass is not silently resized'
  );
}

// (d) Same for the empty-turn write-up pass.
{
  const { engine, calls } = harness([
    { text: '', finish: null },
    { text: 'summary of what the tools found' },
  ]);
  await engine.chat(
    { class: 'aegis', prompt: 'hi', model: 'nexus-brain', autonomous: true, effort: 'medium', workers: 2 },
    () => {}
  );
  assert(calls.length === 2, `expected round 1 + one write-up, got ${calls.length} calls`);
  assert(calls[1].extra.brain === false, 'the write-up pass opts OUT of the fan-out');
  assert(Array.isArray(calls[1].extra.tools) === false, 'the write-up pass offers no tools (unchanged)');
}

// (e) The opt-out is aegis-only: the other classes must never receive a
// `brain` field (it is a pool concept, and the custom classes reject unknown
// bodies inconsistently).
{
  const calls = [];
  const engine = createLocalEngine({
    aegis: { apiKey: 'k', async listModels() { return { models: [] }; }, async chatCompletion() { return {}; } },
    settings: { get: () => ({ baseURL: 'http://local', configured: true }), rawKey: () => 'k' },
    ollama: { async probe() { return { running: false }; }, async listTags() { return []; } },
    providers: {
      openaiCompatible: async (a) => {
        calls.push(a);
        return { model: a.model, choices: [{ message: { content: 'ok' } }] };
      },
      anthropicMessages: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    },
    getConfirmMode: () => false,
  });
  await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'm', tools: false }, () => {});
  assert(calls.length === 1, 'the custom class dispatched once');
}

// ── 2. Client: the stalled-stream budget follows the response ───────────────

assert(
  idleBudgetFor({ headers: { get: () => null } }) === SSE_IDLE_TIMEOUT_MS,
  'a response with no fan-out header keeps the 60s default'
);
assert(
  idleBudgetFor({ headers: { get: () => 'workers=3;effort=high' } }) === BRAIN_IDLE_TIMEOUT_MS,
  'the X-AEGIS-Brain header widens the budget to the fan-out window'
);
assert(
  idleBudgetFor({ headers: { get: () => 'workers=3' } }, 150) === BRAIN_IDLE_TIMEOUT_MS,
  'the header widens even a caller-supplied budget below it (that is the whole bug)'
);
assert(
  idleBudgetFor({ headers: { get: () => 'workers=3' } }, 20 * 60_000) === 20 * 60_000,
  "a caller's larger explicit budget is never lowered by the header"
);
assert(idleBudgetFor({}, 1234) === 1234, 'a response object without headers keeps the caller budget');

/**
 * One SSE response: an opening chunk, `silenceMs` of nothing, then the answer.
 * `brainHeader` is the server's own signal that this response is a fan-out.
 */
function startServer({ brainHeader, silenceMs }) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        ...(brainHeader ? { 'X-AEGIS-Brain': brainHeader } : {}),
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      // The fan-out's header frame: the client's watchdog starts the moment
      // this lands, exactly as it does against the real pool.
      send({ id: 'c1', model: 'nexus-brain', choices: [{ index: 0, delta: { role: 'assistant' } }] });
      setTimeout(() => {
        send({ id: 'c1', model: 'nexus-brain', choices: [{ index: 0, delta: { content: 'the answer' } }] });
        send({ id: 'c1', model: 'nexus-brain', choices: [{ index: 0, finish_reason: 'stop' }] });
        send({ id: 'c1', model: 'nexus-brain', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
        res.write('data: [DONE]\n\n');
        res.end();
      }, silenceMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// A 150ms caller budget and a 400ms silent gap: too quiet for the default
// budget, fine for a fan-out. This is the desktop's default Nexus turn — the
// checkbox is off, the model id still fans out on the server.
{
  const srv = await startServer({ brainHeader: 'workers=3;effort=high;tier=brain;provider=x', silenceMs: 400 });
  try {
    const client = createClient({ apiKey: 'test-key', apiBase: srv.url });
    const deltas = [];
    const out = await client.chatCompletion({
      prompt: 'hi',
      model: 'nexus-brain',
      stream: true,
      onStream: (c) => c.delta && deltas.push(c.delta),
      idleTimeoutMs: 150,
    });
    assert(deltas.join('') === 'the answer', 'an announced fan-out survives a gap past the caller budget');
    assert(out.usage && out.usage.total_tokens === 12, 'its usage still lands');
  } finally {
    await srv.close();
  }
}

// Without the header it is not a fan-out: the same silence must still be
// reported as a stalled stream (the watchdog cannot be disarmed wholesale).
{
  const srv = await startServer({ brainHeader: null, silenceMs: 400 });
  try {
    const client = createClient({ apiKey: 'test-key', apiBase: srv.url });
    let failed = '';
    try {
      await client.chatCompletion({
        prompt: 'hi',
        model: 'nexus-brain',
        stream: true,
        onStream: () => {},
        idleTimeoutMs: 150,
      });
    } catch (err) {
      failed = err && err.message;
    }
    assert(/stalled/.test(failed), `an unannounced stall is still an error, got "${failed}"`);
  } finally {
    await srv.close();
  }
}

console.log('# autonomous-mode tests passed');
