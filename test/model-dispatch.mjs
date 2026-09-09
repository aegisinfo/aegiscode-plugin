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

const SYNC_NAMES = ['listSessions', 'open', 'save', 'append', 'delete', 'push', 'status'];

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

  // 2. sync: dispatch against the real sessions store in a temp dir.
  const dir = mkdtempSync(join(tmpdir(), 'aegis-model-sync-'));
  const syncDispatch = createSyncDispatch(require('../desktop/lib/sync/sessions.js'), dir);
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
  const push = await syncDispatch.push();
  assert(push.queued === false, 'push is the P3 no-op stub');
  const status = await syncDispatch.status();
  assert(status.count === 1 && status.cloud === false, 'status reports local count');

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
