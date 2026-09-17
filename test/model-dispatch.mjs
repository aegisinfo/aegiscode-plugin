#!/usr/bin/env node
/**
 * Headless smoke test for the desktop host's model:/sync: IPC surfaces
 * (plan P1 §5.2). No Electron binary is booted; we drive the pure dispatch
 * maps with a stub engine and the real sessions store against a temp dir.
 */
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  createModelDispatch,
  createSyncDispatch,
  registerModelIpc,
  createHeartbeatRetry,
  describeSyncError,
  MODEL_PREFIX,
  SYNC_PREFIX,
  CHAT_DELTA_CHANNEL,
  taggedChunk,
} = require('../desktop/main.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const calls = [];
const engine = {
  async listClasses() {
    calls.push(['listClasses']);
    return [{ class: 'ollama', label: 'Ollama (local)', kind: 'local', configured: true }];
  },
  async listModels(cls) {
    calls.push(['listModels', cls]);
    return { class: cls, models: [{ id: 'm1' }] };
  },
  async chat(payload, onStream) {
    calls.push(['chat', payload && payload.class, payload && payload.model, typeof onStream]);
    if (typeof onStream === 'function') onStream({ delta: 'hi' });
    return { model: payload && payload.model, choices: [{ message: { content: 'hi' } }] };
  },
  settings: {
    // The real store's list() is synchronous (it returns an array directly);
    // the dispatch's `settings.get` chains `.filter()` on the return value, so
    // an async stub would hand it a Promise and throw `filter is not a function`.
    list() {
      calls.push(['settings.list']);
      return [{ provider: 'openai-compat', keyMask: 'sk-…' }];
    },
    async set(provider, cfg) {
      calls.push(['settings.set', provider, cfg]);
      return { ok: true };
    },
    async remove(provider) {
      calls.push(['settings.remove', provider]);
      return { ok: true };
    },
  },
  async cancel(sessionId) {
    calls.push(['cancel', sessionId]);
    return { ok: true };
  },
};

const MODEL_NAMES = [
  'listClasses',
  'listModels',
  'chat',
  'settings.get',
  'settings.set',
  'settings.remove',
  'cancel',
  'respondApproval',
  'clearApprovals',
  'memoryPersist.get',
  'memoryPersist.set',
];

const SYNC_NAMES = ['listSessions', 'open', 'save', 'append', 'delete', 'push', 'pull', 'status', 'auto', 'memoryPersistState'];

try {
  // 1. model: dispatch maps exactly the whitelist.
  const modelDispatch = createModelDispatch(engine);
  const modelKeys = Object.keys(modelDispatch).sort();
  assert(
    modelKeys.length === MODEL_NAMES.length,
    `expected ${MODEL_NAMES.length} model methods, got ${modelKeys.length}`
  );
  for (const n of MODEL_NAMES) {
    assert(typeof modelDispatch[n] === 'function', `missing model dispatch.${n}`);
  }

  const classes = await modelDispatch.listClasses();
  assert(classes[0].class === 'ollama', 'listClasses passes through');
  const listed = await modelDispatch.listModels({ class: 'ollama' });
  assert(listed.models[0].id === 'm1', 'listModels passes through');

  await modelDispatch.chat({ class: 'ollama', model: 'm1', onStream: null });
  assert(calls[calls.length - 1][2] === 'm1', 'chat forwards model');
  assert(calls[calls.length - 1][3] === 'object', 'chat forwards onStream type');

  const settings = await modelDispatch['settings.get']();
  assert(settings[0].provider === 'openai-compat', 'settings.get passes through');
  await modelDispatch['settings.set']({ provider: 'openai-compat', baseURL: 'http://x', key: 'k' });
  assert(
    calls[calls.length - 1][0] === 'settings.set' &&
      calls[calls.length - 1][1] === 'openai-compat' &&
      calls[calls.length - 1][2].baseURL === 'http://x',
    'settings.set forwards provider + config'
  );

  // 2. sync: dispatch against the real sessions store in a temp dir, offline
  //    (no aegis client passed) — every local flow still works, push/status
  //    report the no-cloud branch without throwing.
  const dir = mkdtempSync(join(tmpdir(), 'aegis-model-sync-'));
  const sessionsStore = require('../desktop/lib/sync/sessions.js');
  const syncDispatch = createSyncDispatch(sessionsStore, dir);
  const syncKeys = Object.keys(syncDispatch).sort();
  assert(
    syncKeys.length === SYNC_NAMES.length,
    `expected ${SYNC_NAMES.length} sync methods, got ${syncKeys.length}`
  );

  await syncDispatch.append({ sessionId: 's1', message: { role: 'user', content: 'hello' } });
  const listed2 = await syncDispatch.listSessions();
  assert(listed2.sessions.length === 1 && listed2.sessions[0].id === 's1', 'append + list round-trip');
  const opened = await syncDispatch.open({ sessionId: 's1' });
  assert(opened.messages.length === 1, 'open returns the session');
  const offlinePush = await syncDispatch.push();
  assert(offlinePush.ok === false && offlinePush.queued === 1, 'push with no cloud client reports queued, not thrown');
  const offlinePull = await syncDispatch.pull();
  assert(offlinePull.ok === false, 'pull with no cloud client reports ok:false, not thrown');
  const status = await syncDispatch.status();
  assert(
    status.count === 1 && status.pending === 1 && status.cloud === false,
    'status reports local count/pending with cloud:false when no key'
  );

  // 2b. sync: dispatch with a stub cloud client — push clears `pending` via
  //     markSynced, pull merges a remote session into the local store, and
  //     flushes any locally-queued memory saves (plan P3 §7).
  const memoryQueue = require('../desktop/lib/sync/memory-queue.js');
  memoryQueue.enqueue(dir, { text: 'remember me', source: 'aegis-desktop', session: 's1' });
  assert(memoryQueue.listQueued(dir).length === 1, 'memory entry queued locally before any cloud client exists');

  const cloudCalls = [];
  const stubAegis = {
    apiKey: 'k',
    async conversationSyncPush(transcript) {
      cloudCalls.push(['push', transcript.session_id]);
      return { session_id: `remote-${transcript.session_id}` };
    },
    async conversationSyncPull() {
      cloudCalls.push(['pull']);
      return { sessions: [{ session_id: 's-remote', title: 'from another machine', messages: [{ role: 'user', content: 'hi' }], updated_at: Date.now() }] };
    },
    async memorySave(entry) {
      cloudCalls.push(['memorySave', entry.text]);
      return { ok: true };
    },
  };
  const cloudSyncDispatch = createSyncDispatch(sessionsStore, dir, stubAegis);
  const cloudPush = await cloudSyncDispatch.push();
  assert(cloudPush.ok === true && cloudPush.pushed === 1 && cloudPush.queued === 0, 'push with a cloud client clears the pending queue');
  assert(cloudPush.memoryFlushed === 1, 'push also flushes the queued memory entry');
  assert(memoryQueue.listQueued(dir).length === 0, 'flushed memory entry is removed from the local queue');
  assert(cloudCalls.some((c) => c[0] === 'memorySave' && c[1] === 'remember me'), 'the queued entry was saved via aegis.memorySave');
  assert(sessionsStore.getSession(dir, 's1').pending === false, 'markSynced cleared pending on the store');
  const cloudPull = await cloudSyncDispatch.pull();
  assert(cloudPull.ok === true && cloudPull.merged === 1, 'pull merges the remote session');
  assert(sessionsStore.getSession(dir, 's-remote').title === 'from another machine', 'pulled session rehydrated locally');
  const cloudStatus = await cloudSyncDispatch.status();
  assert(cloudStatus.cloud === true && cloudStatus.pending === 0, 'status reflects cloud:true and no pending after sync');

  // 2c. The auto-push gate (persisting memory) must read the SAME directory
  //     Electron's settings store writes to. In a real install `sessionsDir`
  //     (aegisHome) and `settingsDir` (app.getPath('userData')) are two
  //     different paths — the regression this pins had the gate wired to
  //     `sessionsDir`, so turning persistence off in Settings never reached
  //     the thing enforcing it.
  const settingsStoreLib = require('../desktop/lib/settings.js');
  const otherDir = mkdtempSync(join(tmpdir(), 'aegis-model-settings-'));
  settingsStoreLib.createSettingsStore({ dir: otherDir }).setMemoryPersist(false);
  const gatedDispatch = createSyncDispatch(sessionsStore, dir, stubAegis, otherDir);
  const gateState = await gatedDispatch.memoryPersistState();
  assert(
    gateState.enabled === false,
    `auto-push gate must read settingsDir, not sessionsDir (got enabled:${gateState.enabled})`
  );
  const gatedRun = await gatedDispatch.auto();
  assert(gatedRun.skipped === true, 'auto() must skip the push once settingsDir reports persistence off');

  // 3. registerModelIpc wires model:<name> and sync:<name> channels, and
  //    model:chat forwards deltas over CHAT_DELTA_CHANNEL.
  const fakeIpc = {
    handles: {},
    handle(name, cb) {
      this.handles[name] = cb;
    },
  };
  registerModelIpc(fakeIpc, engine, dir);
  const channels = Object.keys(fakeIpc.handles).sort();
  for (const n of MODEL_NAMES) {
    assert(fakeIpc.handles[`${MODEL_PREFIX}${n}`], `missing channel ${MODEL_PREFIX}${n}`);
  }
  for (const n of SYNC_NAMES) {
    assert(fakeIpc.handles[`${SYNC_PREFIX}${n}`], `missing channel ${SYNC_PREFIX}${n}`);
  }

  const sentDeltas = [];
  const fakeSender = {
    isDestroyed: () => false,
    send(_channel, chunk) {
      sentDeltas.push(chunk);
    },
  };
  const result = await fakeIpc.handles[`${MODEL_PREFIX}chat`](
    { sender: fakeSender },
    { class: 'ollama', model: 'm1', sessionId: 's2' }
  );
  assert(
    result.choices[0].message.content === 'hi',
    'model:chat resolves with the final normalised result'
  );
  assert(
    sentDeltas.length === 1 && sentDeltas[0].delta === 'hi',
    `model:chat deltas forwarded over ${CHAT_DELTA_CHANNEL}`
  );
  // D2.2: every delta is addressed with the request's sessionId so the
  // renderer can run the main answer and the discovery lane as concurrent
  // streams without interleaving them (`{ delta }` must stay intact).
  assert(
    sentDeltas[0].id === 's2',
    'model:chat tags each delta with the request sessionId'
  );
  assert(
    taggedChunk({ delta: 'x' }, 'abc').id === 'abc' &&
      taggedChunk({ delta: 'x' }, 'abc').delta === 'x',
    'taggedChunk adds the routing id and preserves the delta field'
  );
  assert(
    taggedChunk({ delta: 'x' }, undefined).id === undefined,
    'an untagged request keeps the legacy chunk shape (id: undefined)'
  );

  await fakeIpc.handles[`${MODEL_PREFIX}cancel`]({}, { sessionId: 's2' });
  assert(calls[calls.length - 1][0] === 'cancel', 'cancel forwards sessionId');

  // 4. A quota or auth refusal is NAMED, not handed over as a bare server
  //    sentence (the desktop twin of test/cli-sync.test.mjs §4). Same stub
  //    harness pattern as 2b: the real sessions store in its own temp dir, and
  //    an injected client that throws the shape vendor/aegis.js parseResponse
  //    produces (err.status + err.data), which is what main.js can still see
  //    while the renderer only ever gets a message string.
  assert(typeof describeSyncError === 'function', 'describeSyncError is exported for the host + tests');

  const capError = () => {
    const err = new Error('free session limit reached');
    err.status = 402;
    err.data = {
      error: 'free_session_limit_reached',
      upgradeUrl: 'https://aegiscloud.org/subscribe',
      tokensUsed: 12,
      tokenLimit: 10,
    };
    return err;
  };
  const authError = () => {
    const err = new Error('unauthorized');
    err.status = 401;
    err.data = { error: 'invalid_memory_token' };
    return err;
  };
  const seedPending = (targetDir, id, title) => {
    sessionsStore.upsertSession(targetDir, {
      id,
      title,
      messages: [{ role: 'user', content: 'hi' }],
    });
    sessionsStore.markPending(targetDir, id);
  };

  // 4a. 402 on a SESSION push (the path that hits the cap most often): the
  //     renderer's capNotice() reads `upgrade`, so a session push that leaves
  //     it null means the paywall is invisible. It must also stay queued.
  const capDir = mkdtempSync(join(tmpdir(), 'aegis-model-cap-'));
  seedPending(capDir, 'cap-1', 'first capped');
  seedPending(capDir, 'cap-2', 'second capped');
  const capRequests = [];
  const capDispatch = createSyncDispatch(sessionsStore, capDir, {
    apiKey: 'k',
    async conversationSyncPush(transcript) {
      capRequests.push(transcript.session_id);
      throw capError();
    },
    async conversationSyncPull() {
      throw capError();
    },
    async memorySave() {
      return { ok: true };
    },
  });
  const capPush = await capDispatch.push();
  assert(capPush.ok === false, 'a capped session push resolves ok:false, never throws');
  assert(
    capPush.upgrade && capPush.upgrade.used === 12 && capPush.upgrade.limit === 10,
    `a 402 session push carries the quota numbers (got ${JSON.stringify(capPush.upgrade)})`
  );
  assert(
    capPush.upgrade.url === 'https://aegiscloud.org/subscribe',
    'the cap carries the URL the renderer opens'
  );
  assert(capPush.kind === 'quota', `a 402 is classified as quota (got ${capPush.kind})`);
  assert(
    /ceiling|quota|limit/i.test(capPush.reason || ''),
    `the reason names the cap, not just the server's words (got ${JSON.stringify(capPush.reason)})`
  );
  assert(
    capPush.queued === 2 && sessionsStore.getSession(capDir, 'cap-1').pending === true,
    'a capped session stays pending — never markSynced'
  );
  assert(
    capRequests.length === 1,
    `push stops at the cap instead of one request per queued session (got ${capRequests.length})`
  );
  const capPull = await capDispatch.pull();
  assert(
    capPull.ok === false && capPull.upgrade && capPull.upgrade.limit === 10,
    'a capped pull carries the upgrade metadata too (renderer reads pullResult.upgrade)'
  );
  assert(
    capPull.failed.length === 1 && capPull.failed[0].kind === 'quota',
    'pull() reports its failure classified, in failed[]'
  );

  // 4b. 401 — the per-session memory token was refused. Same shape, different
  //     diagnosis: this is not an upgrade prompt, it is a credential problem.
  const authDir = mkdtempSync(join(tmpdir(), 'aegis-model-auth-'));
  seedPending(authDir, 'auth-1', 'refused');
  const authDispatch = createSyncDispatch(sessionsStore, authDir, {
    apiKey: 'k',
    async conversationSyncPush() {
      throw authError();
    },
    async conversationSyncPull() {
      throw authError();
    },
    async memorySave() {
      return { ok: true };
    },
  });
  const authPush = await authDispatch.push();
  assert(
    authPush.ok === false && authPush.kind === 'auth' && authPush.status === 401,
    `a 401 session push is classified as auth (got ${authPush.kind}/${authPush.status})`
  );
  assert(/key/i.test(authPush.hint || ''), 'the auth hint points at the credential that fixes it');
  assert(
    /unauthorized/.test(authPush.reason || '') && /key/i.test(authPush.reason || ''),
    `the reason keeps the server's words and adds the fix (got ${JSON.stringify(authPush.reason)})`
  );
  assert(authPush.upgrade === null, 'a 401 is not dressed up as an upgrade prompt');
  assert(
    sessionsStore.getSession(authDir, 'auth-1').pending === true,
    'an auth-refused session stays queued'
  );
  const authPull = await authDispatch.pull();
  assert(
    authPull.failed.length === 1 &&
      authPull.failed[0].kind === 'auth' &&
      authPull.failed[0].status === 401,
    'pull() classifies a refused memory token as auth'
  );
  assert(authPull.upgrade === null, 'the auth failure carries no upgrade metadata');

  // 4c. The heartbeat retry (fired on every model:listModels / sync:status)
  //     backs off exponentially, caps at 30s, and resets on success — so a
  //     permanently failing push no longer burns a request per renderer poll,
  //     and its last error stays visible on sync:status instead of being
  //     swallowed by `.catch(() => {})`. The clock is injected, so the ladder
  //     is driven without sleeping.
  const hbDir = mkdtempSync(join(tmpdir(), 'aegis-model-heartbeat-'));
  seedPending(hbDir, 'hb-1', 'heartbeat');
  let clock = 1000;
  const hbRequests = [];
  const hbServer = { fail: true };
  const hbIpc = {
    handles: {},
    handle(name, cb) {
      this.handles[name] = cb;
    },
  };
  const hbWired = registerModelIpc(
    hbIpc,
    engine,
    hbDir,
    {
      apiKey: 'k',
      async conversationSyncPush(transcript) {
        hbRequests.push(clock);
        if (hbServer.fail) {
          const err = new Error('upstream unavailable');
          err.status = 503;
          throw err;
        }
        return { session_id: `remote-${transcript.session_id}` };
      },
      async conversationSyncPull() {
        return { sessions: [] };
      },
      async memorySave() {
        return { ok: true };
      },
    },
    undefined,
    { now: () => clock, baseMs: 1000, maxMs: 30000 }
  );
  assert(
    hbWired && hbWired.heartbeat && typeof hbWired.heartbeat.state === 'function',
    'registerModelIpc exposes the heartbeat controller for the host + tests'
  );
  const hbTick = () => hbIpc.handles[`${MODEL_PREFIX}listModels`]({}, { class: 'ollama' });
  const hbDrain = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
  };

  await hbTick();
  await hbDrain();
  assert(hbRequests.length === 1, `the first heartbeat pushes (got ${hbRequests.length})`);
  for (let i = 0; i < 3; i += 1) {
    await hbTick();
    await hbDrain();
  }
  assert(
    hbRequests.length === 1,
    `further polls inside the backoff window send nothing (got ${hbRequests.length})`
  );

  const hbStatusInBackoff = await hbIpc.handles[`${SYNC_PREFIX}status`]({}, undefined);
  await hbDrain();
  assert(
    hbStatusInBackoff.retry && typeof hbStatusInBackoff.retry.lastError === 'string',
    'sync:status carries the retained heartbeat error — not swallowed'
  );
  assert(
    hbStatusInBackoff.retry.failures === 1 && hbStatusInBackoff.retry.retryInMs === 1000,
    `the status payload reports the failure count and the wait (got ${JSON.stringify(hbStatusInBackoff.retry)})`
  );
  assert(
    hbStatusInBackoff.pending === 1 && hbStatusInBackoff.count === 1,
    'the pre-existing status fields are untouched'
  );

  // Walk the ladder: 1s, 2s, 4s, 8s, 16s, then the 30s cap.
  const waits = [];
  for (const step of [1000, 1000, 1000, 10000, 10000, 30000]) {
    clock += step;
    const before = hbRequests.length;
    await hbTick();
    await hbDrain();
    waits.push(hbRequests.length - before);
  }
  assert(
    waits.join(',') === '1,0,1,1,1,1',
    `the retry ladder fires only when the wait has elapsed (got ${waits.join(',')})`
  );
  assert(hbRequests.length === 6, `six attempts over the ladder (got ${hbRequests.length})`);

  // The 30s cap: after the 6th failure the next attempt is exactly 30s away,
  // not 32s (which is where an uncapped doubling would land).
  const cappedStatus = hbWired.heartbeat.state();
  assert(
    cappedStatus.failures === 6 && cappedStatus.retryInMs === 30000,
    `the backoff is capped at 30s (got ${JSON.stringify(cappedStatus)})`
  );
  const beforeCap = hbRequests.length;
  clock += 29999;
  await hbTick();
  await hbDrain();
  assert(
    hbRequests.length === beforeCap,
    'a poll 1ms before the capped deadline still sends nothing'
  );

  // Success resets the ladder — and the session that was failing is now synced.
  hbServer.fail = false;
  clock += 1;
  await hbTick();
  await hbDrain();
  assert(hbRequests.length === beforeCap + 1, 'the attempt at the capped deadline goes out');
  assert(
    hbWired.heartbeat.state().failures === 0 && hbWired.heartbeat.state().lastError === null,
    'a successful push resets the backoff and clears the retained error'
  );
  assert(
    sessionsStore.getSession(hbDir, 'hb-1').pending === false,
    'the session that finally went out is marked synced'
  );

  // …and the reset is real: a fresh failure is attempted immediately rather
  // than waiting out the previous ladder.
  seedPending(hbDir, 'hb-2', 'failing again');
  hbServer.fail = true;
  const beforeReFail = hbRequests.length;
  await hbTick();
  await hbDrain();
  assert(
    hbRequests.length === beforeReFail + 1,
    'after a reset the next failure is attempted immediately (no stale backoff)'
  );
  const afterReFail = await hbIpc.handles[`${SYNC_PREFIX}status`]({}, undefined);
  await hbDrain();
  assert(
    afterReFail.retry.failures === 1 && /upstream unavailable/.test(afterReFail.retry.lastError),
    `the new failure is retained with its message (got ${JSON.stringify(afterReFail.retry)})`
  );
  assert(
    createHeartbeatRetry(() => ({ ok: true })).state().failures === 0,
    'a fresh heartbeat controller starts with no failures'
  );

  console.log(`Model/sync dispatch smoke test passed: ${channels.join(', ')}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
