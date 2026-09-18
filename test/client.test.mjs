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
  // memoryToken: '' pins the client to the mocked /api/verify-api-key exchange
  // below rather than a real AEGIS_MEMORY_TOKEN left in the dev shell's
  // environment — createClient() only falls back to the env var when the opt
  // is `undefined`, and this suite's memory-token assertions (section 7) must
  // see the token *this test* hands back, not whatever machine it runs on.
  const client = createClient({ apiKey: 'test-key', apiBase: 'https://example.test', memoryToken: '' });

  // 1. No model + no mode -> body has no `model` key and no `nexus-*`.
  await client.chatCompletion({ prompt: 'hi' });
  let body = JSON.parse(captured[captured.length - 1].opts.body);
  assert(!('model' in body), 'model must be omitted when absent');
  assert(!('mode' in body), 'mode must not be defaulted client-side');
  // No invented token ceiling either. An unstated `max_tokens` used to default
  // to 4096 here, and the server treats a body max_tokens as a per-pass ceiling
  // *over* its effort ladder — so the client was silently capping every pass of
  // a pooled fan-out at 4k and overriding the budget its own effort selected,
  // while the UI displayed the ladder as if it had been honoured. Omitting the
  // key is the documented way to ask for the server's own default.
  assert(!('max_tokens' in body), `max_tokens must be omitted when unstated, got ${body.max_tokens}`);
  // A ceiling the caller *does* state still travels — this is a cap, not a
  // veto on caps.
  await client.chatCompletion({ prompt: 'hi', maxTokens: 2048 });
  body = JSON.parse(captured[captured.length - 1].opts.body);
  assert(body.max_tokens === 2048, `a stated max_tokens must be forwarded, got ${body.max_tokens}`);
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
    // BYOK relay (aegis1 app.py:9117). Registered here because step 9 below
    // asserts on the headers this call sends — a stub that throws on the path
    // would fail the test for the wrong reason (no assertion ever ran).
    if (String(url).endsWith('/api/v1/byok/chat/completions')) {
      return okJson({
        model: 'server-chosen-model',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
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

  // 9. BYOK must send the caller's *AEGIS* key (X-AEGIS-Key) alongside their
  // provider key, or the server cannot tell whose bank pays the handling fee.
  //
  // This is what makes the BYOK lane billable at all. Without the header,
  // `_byok_identify_user` on aegis1 returns 0 for every call, so BYOK traffic
  // was attributed to no one and charged to no one — the lane ran at a
  // permanent loss and the loss was invisible (the audit rows read as free
  // rather than as missing). The two credentials are distinct and must never
  // be conflated: the provider key authenticates the upstream call, the AEGIS
  // key says who pays. Conflating them would bill a stranger who happened to
  // own whichever row matched.
  await client.byokChatCompletion({ prompt: 'hi', providerKey: 'sk-provider-key' });
  let hdrs = captured[captured.length - 1].opts.headers;
  assert(hdrs['X-AEGIS-Key'] === 'test-key', `byok must send the AEGIS key, got ${hdrs['X-AEGIS-Key']}`);
  assert(hdrs['X-Provider-Key'] === 'sk-provider-key', 'byok must send the provider key');
  assert(hdrs['X-AEGIS-Key'] !== hdrs['X-Provider-Key'], 'the two credentials must not be conflated');

  // 9b. No AEGIS key configured -> the header is OMITTED, not sent empty.
  // The transport stays anonymous-capable on purpose (the route is
  // unauthenticated by design, and this must not start throwing), but a
  // keyless BYOK turn is now refused one layer up, by the shared local engine,
  // because an unattributed turn is served and billed to nobody. What is pinned
  // HERE is only the wire detail: omit the header, never send it empty — an
  // empty-string header is a credential that is present-and-invalid, which is a
  // different thing to the server.
  const anon = createClient({ apiKey: '', apiBase: 'https://example.test' });
  await anon.byokChatCompletion({ prompt: 'hi', providerKey: 'sk-anon' });
  hdrs = captured[captured.length - 1].opts.headers;
  assert(!('X-AEGIS-Key' in hdrs), 'an unconfigured AEGIS key must omit the header entirely');
  assert(hdrs['X-Provider-Key'] === 'sk-anon', 'an anonymous byok call still carries the provider key');

  console.log('client body-builder tests passed');
} finally {
  globalThis.fetch = originalFetch;
}
