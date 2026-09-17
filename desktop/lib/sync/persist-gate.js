'use strict';

/**
 * persist-gate.js — the desktop half of "persisting memory for every account".
 *
 * `cli/` flips this default in config.json (`memoryPersist`, migrated off the
 * legacy `cloudSync` key). The desktop has no config.json, so its preference
 * lives in the same settings.json the Settings pane already writes, under the
 * reserved `__memoryPersist` namespace — and it is read HERE, from disk, by the
 * main process that performs the push.
 *
 * Two reasons the gate is not taken from the renderer:
 *
 *  1. The decision has to be enforceable in the main process whatever the
 *     renderer believes. A renderer-held flag is a suggestion; the process
 *     that opens the socket decides.
 *  2. `createSyncDispatch()` / createAutoPush() are unit-tested in plain Node,
 *     where no renderer and no Electron exist.
 *
 * Default is ON, matching cli/. `source` keeps "the user turned this off" and
 * "nobody has been asked yet" tellable apart — the whole point of shipping a
 * default is that the absence of a stored key is not the same as a stored no.
 */

const fs = require('node:fs');
const path = require('node:path');

const { MEMORY_PERSIST_NAMESPACE, SETTINGS_FILE } = require('../settings.js');

/** The settings file the store writes (`createSettingsStore` uses the same
 *  `path.join(dir, SETTINGS_FILE)`, so both agree on one source of truth).
 *  A caller that already holds the file path may pass it directly. */
function settingsFile(dir) {
  const p = dir || '';
  return p.endsWith(SETTINGS_FILE) ? p : path.join(p, SETTINGS_FILE);
}

function readSettings(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/**
 * `{ enabled, source }`. `source` is 'config' only when the file actually
 * carries the key — an explicit `false` survives, an absent namespace is ON.
 */
function gateState(dir) {
  const cfg = readSettings(dir)[MEMORY_PERSIST_NAMESPACE];
  if (!cfg || cfg.enabled === undefined) return { enabled: true, source: 'default' };
  return { enabled: Boolean(cfg.enabled), source: 'config' };
}

/**
 * The post-turn push, gated.
 *
 * `push` is `createSyncDispatch`'s own drain, so this inherits the queue
 * fallback for free: a push flushes `memory-queue.json` before it touches the
 * session list, which is exactly the "offline now, sync later" behaviour the
 * manual button had and the automatic path must not lose.
 *
 * Coalesced: a turn that ends while a drain is still in flight does not open a
 * second one. `push()` snapshots `sessions.listPending(dir)`, so a concurrent
 * call would race the same rows; the newest session instead goes out on the
 * next trigger (the following turn's auto push, or "Sync now"). One turn of
 * delay is the correct trade against two writers marking the same session
 * synced.
 */
function createAutoPush({ push, dir, gate } = {}) {
  if (typeof push !== 'function') throw new Error('createAutoPush requires a push()');
  const readGate = typeof gate === 'function' ? gate : () => gateState(dir);
  let inFlight = null;

  async function run() {
    const state = readGate();
    if (!state.enabled) {
      return {
        ok: true,
        skipped: true,
        gate: state,
        reason: 'persisting memory is off',
      };
    }
    try {
      const result = await push();
      return Object.assign({}, result, { skipped: false, gate: state });
    } catch (err) {
      // A chat turn must never fail because a background push did. `push()`
      // already resolves `{ ok:false, … }` for its expected failures; this
      // catches the unexpected so the caller's fire-and-forget cannot become
      // an unhandled rejection.
      return {
        ok: false,
        skipped: false,
        gate: state,
        reason: (err && err.message) || String(err),
      };
    }
  }

  function auto() {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return { auto, gate: () => readGate(), state: () => readGate() };
}

module.exports = {
  settingsFile,
  readSettings,
  gateState,
  createAutoPush,
};
