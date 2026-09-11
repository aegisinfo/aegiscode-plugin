#!/usr/bin/env node
/**
 * Unit tests for client/aegis.js request-body shaping (plan P0 §4.1 / §9).
 * No network access: we stub globalThis.fetch and assert on the serialised
 * bodies the thin client sends.
 *
 * The two invariants under test:
 *   - `model` is omitted from the body when absent (model-first, no
 *     client-invented tier id).
 *   - no `nexus-*` id is ever built anywhere in the request.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClient } = require('../client/aegis.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

let captured = [];
const originalFetch = globalThis.fetch;

function okJson(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (url, opts) => {
  captured.push({ url, opts });
  return okJson({
    model: 'server-chosen-model',
    choices: [{ message: { content: 'ok' } }],
    usage: { total_tokens: 3 },
  });
};

try {
  const client = createClient({ apiKey: 'test-key', apiBase: 'https://example.test' });

  // 1. No model + no mode -> body has no `model` key and no `nexus-*`.
  await client.chatCompletion({ prompt: 'hi' });
  let body = JSON.parse(captured[captured.length - 1].opts.body);
  assert(!('model' in body), 'model must be omitted when absent');
  assert(!('mode' in body), 'mode must not be defaulted client-side');
  assert(body.max_tokens === 4096, `default max_tokens should be 4096, got ${body.max_tokens}`);
  assert(body.messages.length === 1 && body.messages[0].role === 'user', 'prompt wrapped as a user turn');
  assert(!JSON.stringify(body).includes('nexus'), 'no nexus-* id may appear in the body');

  // 2. Explicit model is forwarded verbatim (still no nexus fabrication).
  await client.chatCompletion({ prompt: 'hi', model: 'deepseek-v4-pro' });
  body = JSON.parse(captured[captured.length - 1].opts.body);
  assert(body.model === 'deepseek-v4-pro', 'explicit model forwarded verbatim');
  assert(!JSON.stringify(body).includes('nexus'), 'no nexus-* id may appear');

  // 3. Legacy `mode` is only forwarded when the caller supplies it.
  await client.chatCompletion({ prompt: 'hi', mode: 'smart' });
  body = JSON.parse(captured[captured.length - 1].opts.body);
  assert(body.mode === 'smart' && !('model' in body), 'caller-supplied mode forwarded, model omitted');

  // 4. BYOK path: same model-omission rule, default provider openai.
  await client.byokChatCompletion({ prompt: 'hi' });
  body = JSON.parse(captured[captured.length - 1].opts.body);
  assert(!('model' in body), 'byok omits model when absent');
  assert(body.provider === 'openai', 'byok defaults provider to openai');
  assert(body.max_tokens === 4096, 'byok default max_tokens 4096');

  // 5. A full-history `messages` array is preserved, a second `system` is not
  // duplicated, and a non-empty `prompt` is appended as the live user turn.
  // (Superseding the history with the prompt alone used to drop every prior
  // message — including the system turn — on this transport.)
  await client.chatCompletion({
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
    ],
    system: 'ignored',
    prompt: 'live turn',
  });
  body = JSON.parse(captured[captured.length - 1].opts.body);
  assert(body.messages.length === 3, 'history is preserved and the prompt appended');
  assert(body.messages[0].role === 'system' && body.messages[0].content === 'be brief', 'the original system turn is kept');
  assert(
    body.messages.filter((m) => m.role === 'system').length === 1,
    'a second system turn is never added to an explicit history'
  );
  assert(body.messages[1].content === 'hello', 'the history turns survive in order');
  assert(body.messages[2].role === 'user' && body.messages[2].content === 'live turn', 'the prompt becomes the final user turn');

  // 6. listModels() passes server model metadata through unmodified — the
  // desktop output-ceiling picker (plan P2 §6.3) depends on `max_output` and
  // `context_window` surviving the round trip untouched.
  const rawModels = {
    models: [
      { id: 'deepseek-v4-pro', max_output: 8192, context_window: 128000 },
      { id: 'legacy-model' },
    ],
  };
  globalThis.fetch = async (url) => {
    captured.push({ url, opts: {} });
    return okJson(rawModels);
  };
  const listed = await client.listModels();
  assert(
    JSON.stringify(listed) === JSON.stringify(rawModels),
    'listModels() must not strip or reshape model metadata'
  );
  assert(listed.models[0].max_output === 8192, 'max_output survives pass-through');
  assert(listed.models[0].context_window === 128000, 'context_window survives pass-through');
  assert(!('max_output' in listed.models[1]), 'models without metadata are not backfilled');

  // 7. conversationSyncPush/Pull (plan P3 §6/§7): authenticate with the
  // memory token exchanged via /api/verify-api-key — never the API key
  // directly — exactly like memorySave()/memoryPull().
  captured = [];
  globalThis.fetch = async (url, opts) => {
    captured.push({ url, opts });
    if (String(url).endsWith('/api/verify-api-key')) {
      return okJson({ memory_token: 'mem-token-123' });
    }
    if (String(url).endsWith('/api/conversations/sync')) {
      return okJson({ session_id: 'remote-abc', sessions: [{ session_id: 'r1', title: 'from cloud' }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const pushResult = await client.conversationSyncPush({
    session_id: 's1',
    title: 'local session',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert(pushResult.session_id === 'remote-abc', 'conversationSyncPush returns the server response verbatim');
  const pushCall = captured[captured.length - 1];
  assert(pushCall.url.endsWith('/api/conversations/sync'), 'conversationSyncPush posts to /api/conversations/sync');
  assert(
    pushCall.opts.headers.Authorization === 'Bearer mem-token-123',
    'conversationSyncPush authenticates with the memory token, not the API key'
  );
  assert(!('X-API-Key' in pushCall.opts.headers), 'conversationSyncPush never sends the raw API key header');
  const pushBody = JSON.parse(pushCall.opts.body);
  assert(pushBody.session_id === 's1' && pushBody.title === 'local session', 'conversationSyncPush forwards the transcript');

  const pullResult = await client.conversationSyncPull();
  assert(pullResult.sessions[0].id === undefined && pullResult.sessions[0].session_id === 'r1', 'conversationSyncPull returns the raw remote session list');
  const pullCall = captured[captured.length - 1];
  assert(
    pullCall.opts.headers.Authorization === 'Bearer mem-token-123',
    'conversationSyncPull reuses the cached memory token (no second verify-api-key round trip)'
  );
  const verifyCalls = captured.filter((c) => String(c.url).endsWith('/api/verify-api-key'));
  assert(verifyCalls.length === 1, 'the memory token is cached across push and pull');

  console.log('client body-builder tests passed');
} finally {
  globalThis.fetch = originalFetch;
}
