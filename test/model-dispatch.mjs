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
  MODEL_PREFIX,
  SYNC_PREFIX,
  CHAT_DELTA_CHANNEL,
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
    async list() {
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
];

const SYNC_NAMES = ['listSessions', 'open', 'save', 'append', 'delete', 'push', 'pull', 'status'];

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

  await fakeIpc.handles[`${MODEL_PREFIX}cancel`]({}, { sessionId: 's2' });
  assert(calls[calls.length - 1][0] === 'cancel', 'cancel forwards sessionId');

  console.log(`Model/sync dispatch smoke test passed: ${channels.join(', ')}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
