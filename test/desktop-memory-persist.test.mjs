import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeOs from 'node:os';
import { createRequire } from 'node:module';

/**
 * Desktop half of "persisting memory for every account": the settings
 * preference, and the gate that decides whether a finished turn is pushed.
 *
 * The gate is deliberately tested twice over — once directly (`gateState`) and
 * once through the real settings store — because the whole value of the
 * feature rests on those two agreeing about the same file. A gate that reads a
 * different path than the pane writes is an off switch that does nothing.
 */
const require = createRequire(import.meta.url);

const { createSettingsStore, MEMORY_PERSIST_NAMESPACE } = require('../desktop/lib/settings.js');
const persistGate = require('../desktop/lib/sync/persist-gate.js');

const tmpdir = () => fs.mkdtempSync(fs.realpathSync(nodeOs.tmpdir()) + '/aegis-persist-');

// --- the gate ---------------------------------------------------------------

test('persisting memory is ON out of the box', () => {
  const dir = tmpdir();
  assert.deepEqual(persistGate.gateState(dir), { enabled: true, source: 'default' });
});

test('an explicit false on disk turns the gate off, and says so', () => {
  const dir = tmpdir();
  fs.writeFileSync(
    persistGate.settingsFile(dir),
    JSON.stringify({ [MEMORY_PERSIST_NAMESPACE]: { enabled: false } })
  );
  assert.deepEqual(persistGate.gateState(dir), { enabled: false, source: 'config' });
});

test('an unreadable settings file is a default, not a crash', () => {
  const dir = tmpdir();
  fs.writeFileSync(persistGate.settingsFile(dir), '{ this is not json');
  assert.deepEqual(persistGate.gateState(dir), { enabled: true, source: 'default' });
});

test('settingsFile() accepts the file path itself', () => {
  const dir = tmpdir();
  assert.equal(
    persistGate.settingsFile(persistGate.settingsFile(dir)),
    persistGate.settingsFile(dir)
  );
});

// --- the store and the gate agree on one file -------------------------------

test('the Settings pane and the gate read the same namespace', () => {
  const dir = tmpdir();
  const store = createSettingsStore({ dir });
  assert.deepEqual(store.memoryPersistState(), { enabled: true, source: 'default' });

  // Turning it off through the store must stop the NEXT automatic push — the
  // gate is a second reader of the same file, with no cache between them.
  assert.deepEqual(store.setMemoryPersist(false), { enabled: false, source: 'config' });
  assert.deepEqual(persistGate.gateState(dir), { enabled: false, source: 'config' });

  // ...and back on, through a fresh store, as a restart would.
  const reopened = createSettingsStore({ dir });
  assert.deepEqual(reopened.memoryPersistState(), { enabled: false, source: 'config' });
  reopened.setMemoryPersist(true);
  assert.deepEqual(persistGate.gateState(dir), { enabled: true, source: 'config' });
});

test('the preference is stored in its own file/namespace, never as a provider', () => {
  const dir = tmpdir();
  const store = createSettingsStore({ dir });
  store.setMemoryPersist(false);

  const raw = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(raw[MEMORY_PERSIST_NAMESPACE].enabled, false);
  assert.equal(store.file, persistGate.settingsFile(dir));

  // Reserved: the provider surface must not list it, and must refuse to touch
  // it — the same protection the AEGIS key namespace gets.
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.set(MEMORY_PERSIST_NAMESPACE, { key: 'x' }), /reserved namespace/);
});

// --- the automatic push -----------------------------------------------------

test('a finished turn pushes when persistence is on', async () => {
  const dir = tmpdir();
  let calls = 0;
  const { auto } = persistGate.createAutoPush({
    dir,
    push: async () => {
      calls += 1;
      return { ok: true, pushed: 1, queued: 0, memoryFlushed: 2 };
    },
  });

  const result = await auto();
  assert.equal(calls, 1);
  assert.equal(result.skipped, false);
  assert.equal(result.pushed, 1);
  // The queue fallback is inherited from push(), not reimplemented here.
  assert.equal(result.memoryFlushed, 2);
  assert.deepEqual(result.gate, { enabled: true, source: 'default' });
});

test('the switch actually stops the push — push() is never entered', async () => {
  const dir = tmpdir();
  createSettingsStore({ dir }).setMemoryPersist(false);
  let calls = 0;
  const { auto } = persistGate.createAutoPush({
    dir,
    push: async () => {
      calls += 1;
      return { ok: true };
    },
  });

  const result = await auto();
  assert.equal(calls, 0);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /off/);
});

test('concurrent turns open one drain, not two', async () => {
  let calls = 0;
  let release = null;
  const { auto } = persistGate.createAutoPush({
    gate: () => ({ enabled: true, source: 'default' }),
    push: () => {
      calls += 1;
      return new Promise((r) => {
        release = r;
      });
    },
  });

  const a = auto();
  const b = auto();
  assert.equal(calls, 1);
  release({ ok: true, pushed: 1 });
  await Promise.all([a, b]);

  // A later turn drains again: the coalescing window is one in-flight call,
  // not a permanent latch.
  const c = auto();
  assert.equal(calls, 2);
  release({ ok: true, pushed: 2 });
  assert.equal((await c).pushed, 2);
});

test('an unexpected push failure resolves, it does not reject a chat turn', async () => {
  const { auto } = persistGate.createAutoPush({
    gate: () => ({ enabled: true, source: 'default' }),
    push: async () => {
      throw new Error('socket hang up');
    },
  });
  const result = await auto();
  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.match(result.reason, /socket hang up/);
});

test('createAutoPush refuses to build an ungated pusher', () => {
  assert.throws(() => persistGate.createAutoPush({}), /requires a push/);
});
