#!/usr/bin/env node
/**
 * AEGIS Desktop — thin Electron main shell (host 2).
 *
 * This process owns the ONLY privileged object in the app: an instance of the
 * shared thin client (../client/aegis.js), which holds the AEGIS_API_KEY read
 * from the environment. The renderer never sees the key; it talks exclusively
 * over a whitelisted, context-isolated IPC surface (see preload.js).
 *
 * Hard boundary: this file is a window + IPC shell. It contains no engine,
 * orchestration, routing, tier, or memory logic — that all lives behind
 * aegiscloud.org. If it grows beyond a thin shell, it is wrong.
 *
 * Layout:
 *   - bootstrap()      Electron-only: window + IPC registration + lifecycle
 *   - createIpcDispatch()  pure: method-name -> client call (unit-testable
 *                     in plain Node, no Electron binary needed)
 */

'use strict';

const path = require('node:path');

// Dev / CI / smoke-test layout: desktop/ lives inside the repo, so the shared
// client resolves via ../client/aegis.js. In the packaged app the client is
// copied to desktop/vendor/aegis.js by the predist step (electron-builder
// cannot reach outside the app dir), so fall back to that copy. Both files
// are the same thin transport — never brain logic.
let sharedClient;
try {
  sharedClient = require('../client/aegis.js');
} catch {
  sharedClient = require('./vendor/aegis.js');
}
const { createClient } = sharedClient;

let electron = null;
try {
  // In plain Node (CI smoke test, `node --check`) this either throws
  // (module absent) or resolves to the electron binary path string with no
  // `.app` — either way bootstrap() is skipped and the pure exports survive.
  electron = require('electron');
} catch {
  /* not running under Electron */
}

// LocalEngine wiring (plan P1 §5.2): the model:/sync: surfaces are additive,
// backed by transport-only modules in desktop/lib/. No brain logic enters here.
const os = require('node:os');
const { createLocalEngine } = require('./lib/local/engine.js');
const { createSettingsStore } = require('./lib/settings.js');
const ollama = require('./lib/local/ollama.js');
const providers = require('./lib/local/providers.js');
const sessionStore = require('./lib/sync/sessions.js');
const memoryQueue = require('./lib/sync/memory-queue.js');

const IPC_PREFIX = 'aegis:';
const MODEL_PREFIX = 'model:';
const SYNC_PREFIX = 'sync:';

/**
 * Main -> renderer push channel for chat SSE deltas (D2.1 streaming render).
 * The invoke of aegis:chatCompletion still resolves once with the normalised
 * final result; live chunks travel on this single dedicated channel.
 */
const CHAT_DELTA_CHANNEL = `${IPC_PREFIX}chatDelta`;

const APP_VERSION = require('./package.json').version;

/** Never ship a full key to the renderer — only a masked preview. */
function maskKey(key) {
  if (!key) return null;
  if (key.length <= 10) return 'configured';
  return `${key.slice(0, 9)}\u2026${key.slice(-4)}`;
}

/**
 * `aegis:memorySave` with the offline-first fallback (plan P3 §7): try the
 * cloud save first; if it fails (no key, offline, transient error) queue the
 * entry in <dir>/memory-queue.json instead of throwing, so the renderer's
 * "remember" affordance never surfaces an error for the no-key case. `dir` is
 * optional — callers that omit it (e.g. the desktop-shell smoke test) simply
 * get the un-queued rejection back, unchanged from before this existed.
 */
async function saveMemoryWithQueue(aegis, dir, entry) {
  try {
    return await aegis.memorySave(entry);
  } catch (err) {
    if (!dir || !entry) throw err;
    memoryQueue.enqueue(dir, entry);
    return { ok: true, queued: true, reason: err && err.message ? err.message : String(err) };
  }
}

/**
 * Pure mapping: IPC payload -> shared-client call. No Electron types here, so
 * tests can drive it with a stub client and a fake ipcMain.
 */
function createIpcDispatch(aegis, dir) {
  const dispatch = {
    status: () => ({
      appVersion: APP_VERSION,
      clientVersion: aegis.clientVersion,
      apiBase: aegis.apiBase,
      keyConfigured: Boolean(aegis.apiKey),
      keyMask: maskKey(aegis.apiKey),
    }),

    verifyApiKey: () => aegis.verifyApiKey(),
    tokenBankBalance: () => aegis.tokenBankBalance(),

    listModels: () => aegis.listModels(),

    chatCompletion: (payload) =>
      aegis.chatCompletion({
        prompt: payload && payload.prompt,
        system: payload && payload.system,
        model: payload && payload.model,
        mode: payload && payload.mode,
        maxTokens: payload && payload.maxTokens,
        // stream/onStream are forwarded when present; registerIpc() injects
        // the IPC chunk forwarder for the desktop host (see below).
        stream: payload && payload.stream,
        onStream: payload && payload.onStream,
      }),

    byokStatus: () => aegis.byokStatus(),
    byokSet: (payload) =>
      aegis.byokSet(
        payload && payload.provider,
        payload && payload.apiKey
      ),

    memorySearch: (payload) =>
      aegis.memorySearch(payload && payload.query, payload && payload.limit),
    memorySave: (payload) =>
      saveMemoryWithQueue(aegis, dir, payload && payload.entry),
    memoryList: (payload) =>
      aegis.memoryList(payload && payload.limit),

    verifyToken: (payload) =>
      aegis.verifyToken(payload && payload.token),
    memoryActivate: (payload) =>
      aegis.memoryActivate(payload && payload.token),
    memoryPull: (payload) =>
      aegis.memoryPull(payload && payload.since),
    memorySaveBatch: (payload) =>
      aegis.memorySaveBatch(payload && payload.entries),
    importConversation: (payload) =>
      aegis.importConversation(payload || {}),
  };
  return dispatch;
}

/** Register every dispatch method as `aegis:<name>` on ipcMain. `dir` (the
 *  user-data dir) is optional and threaded through only for the memorySave
 *  offline-queue fallback — see saveMemoryWithQueue(). */
function registerIpc(ipcMain, aegis, dir) {
  const dispatch = createIpcDispatch(aegis, dir);
  for (const [name, handler] of Object.entries(dispatch)) {
    if (name === 'chatCompletion') {
      // Streaming render (D2.1): when the renderer asks for stream, SSE deltas
      // are pushed over CHAT_DELTA_CHANNEL as they arrive while the invoke
      // promise still resolves once with the normalised final result. When the
      // payload does not request stream, behaviour is the plain non-streaming
      // dispatch (what the headless shell test drives directly).
      ipcMain.handle(`${IPC_PREFIX}${name}`, (event, payload) => {
        const opts = { ...(payload || {}) };
        if (!opts.stream) return handler(opts);
        const sender = event && event.sender;
        const forward = (chunk) => {
          if (
            sender &&
            typeof sender.send === 'function' &&
            !sender.isDestroyed()
          ) {
            sender.send(CHAT_DELTA_CHANNEL, chunk);
          }
        };
        return handler({ ...opts, stream: true, onStream: forward });
      });
      continue;
    }
    ipcMain.handle(`${IPC_PREFIX}${name}`, (_event, payload) => handler(payload));
  }
  return dispatch;
}

/**
 * Resolve the per-user data directory for settings + sessions. Electron gives
 * us app.getPath('userData'); outside Electron (headless smoke tests) fall back
 * to ~/.aegiscode so the pure functions can still be exercised.
 */
function resolveUserDataDir(app) {
  if (app && typeof app.getPath === 'function') {
    try {
      return app.getPath('userData');
    } catch {
      /* fall through */
    }
  }
  return path.join(os.homedir(), '.aegiscode');
}

/**
 * Wire the real LocalEngine registry: settings store + ollama/providers
 * transports + the shared cloud client. Transport-only — no brain logic.
 */
function createEngine(aegis, { app, safeStorage, dir: dirOverride } = {}) {
  const dir = dirOverride || resolveUserDataDir(app);
  const settings = createSettingsStore({ dir, safeStorage });
  const engine = createLocalEngine({ aegis, settings, ollama, providers });
  return { engine, sessionsDir: dir };
}

/**
 * Pure mapping: model:<name> -> LocalEngine call (unit-testable in Node).
 */
function createModelDispatch(engine) {
  return {
    listClasses: () => engine.listClasses(),
    listModels: (payload) => engine.listModels(payload && payload.class),
    chat: (payload) => engine.chat(payload, payload && payload.onStream),
    'settings.get': () => engine.settings.list(),
    'settings.set': (payload) =>
      engine.settings.set(payload && payload.provider, {
        baseURL: payload && payload.baseURL,
        key: payload && payload.key,
      }),
    'settings.remove': (payload) =>
      engine.settings.remove(payload && payload.provider),
    cancel: (payload) => engine.cancel(payload && payload.sessionId),
  };
}

/**
 * Pure mapping: sync:<name> -> sessions store call (unit-testable in Node).
 * `push`/`pull` are the P3 cloud-sync surface (plan §7/§8.5): they reuse the
 * shared client's memory-token auth (`aegis.conversationSyncPush/Pull`) — no
 * new credential flow. Offline-first: with no AEGIS key configured, both
 * resolve `{ ok: false, reason }` without ever throwing, and every local
 * flow (save/append/list) keeps working untouched.
 */
function createSyncDispatch(sessions, dir, aegis) {
  let lastSyncAt = null;

  function hasCloud() {
    return Boolean(aegis && aegis.apiKey);
  }

  /** Retry every locally queued memory-save (plan P3 §7 "queue locally and
   *  sync later") now that the cloud is reachable. Entries that still fail
   *  (e.g. one bad entry among several) stay queued for the next attempt. */
  async function flushMemoryQueue() {
    const queued = memoryQueue.listQueued(dir);
    if (!queued.length) return { flushed: 0 };
    const remaining = [];
    let flushed = 0;
    for (const entry of queued) {
      try {
        await aegis.memorySave(entry);
        flushed += 1;
      } catch {
        remaining.push(entry);
      }
    }
    memoryQueue.save(dir, remaining);
    return { flushed, remaining: remaining.length };
  }

  async function push() {
    const pending = sessions.listPending(dir);
    if (!hasCloud()) {
      return { ok: false, queued: pending.length, reason: 'no AEGIS key configured' };
    }
    const memoryFlush = await flushMemoryQueue();
    if (!pending.length) {
      return { ok: true, queued: 0, pushed: 0, memoryFlushed: memoryFlush.flushed };
    }

    let pushed = 0;
    let lastError = null;
    for (const session of pending) {
      try {
        const result = await aegis.conversationSyncPush({
          session_id: session.id,
          title: session.title,
          messages: session.messages,
        });
        const remoteId = result && (result.session_id || result.id);
        sessions.markSynced(dir, session.id, { remoteId });
        pushed += 1;
      } catch (err) {
        lastError = err;
      }
    }
    const queued = sessions.listPending(dir).length;
    if (pushed) lastSyncAt = Date.now();
    if (pushed === 0 && lastError) {
      return { ok: false, queued, reason: lastError.message || 'push failed', memoryFlushed: memoryFlush.flushed };
    }
    return { ok: true, queued, pushed, memoryFlushed: memoryFlush.flushed };
  }

  async function pull() {
    if (!hasCloud()) {
      return { ok: false, merged: 0, reason: 'no AEGIS key configured' };
    }
    try {
      const data = await aegis.conversationSyncPull();
      const merged = sessions.mergeRemoteSessions(dir, (data && data.sessions) || []);
      lastSyncAt = Date.now();
      return { ok: true, merged };
    } catch (err) {
      return { ok: false, merged: 0, reason: err && err.message ? err.message : String(err) };
    }
  }

  return {
    listSessions: () => ({ sessions: sessions.listSessions(dir) }),
    open: (payload) => sessions.getSession(dir, payload && payload.sessionId),
    save: (payload) => sessions.upsertSession(dir, payload || {}),
    append: (payload) =>
      sessions.appendMessage(
        dir,
        payload && payload.sessionId,
        payload && payload.message
      ),
    delete: (payload) =>
      sessions.deleteSession(dir, payload && payload.sessionId),
    push,
    pull,
    status: () => ({
      count: sessions.listSessions(dir).length,
      pending: sessions.listPending(dir).length,
      cloud: hasCloud(),
      lastSyncAt,
    }),
  };
}

/**
 * Register model:<name> and sync:<name> on ipcMain. `model:chat` is always
 * streaming: deltas are pushed over CHAT_DELTA_CHANNEL exactly like the
 * existing `aegis:chatCompletion` special case. `aegis` (the shared client)
 * is optional — headless/offline callers omit it and every sync method falls
 * back to its no-cloud branch.
 *
 * `model:listModels` and `sync:status` also fire a background retry push of
 * any pending sessions (plan §7 "retry on a heartbeat"): fire-and-forget,
 * never awaited, never throws — it just gives queued sessions another
 * chance to sync without a dedicated poller.
 */
function registerModelIpc(ipcMain, engine, sessionsDir, aegis) {
  const modelDispatch = createModelDispatch(engine);
  const syncDispatch = createSyncDispatch(sessionStore, sessionsDir, aegis);

  function heartbeatRetry() {
    syncDispatch.push().catch(() => {});
  }

  for (const [name, handler] of Object.entries(modelDispatch)) {
    if (name === 'chat') {
      ipcMain.handle(`${MODEL_PREFIX}${name}`, (event, payload) => {
        const opts = { ...(payload || {}) };
        const sender = event && event.sender;
        const forward = (chunk) => {
          if (
            sender &&
            typeof sender.send === 'function' &&
            !sender.isDestroyed()
          ) {
            sender.send(CHAT_DELTA_CHANNEL, chunk);
          }
        };
        return handler({ ...opts, onStream: forward });
      });
      continue;
    }
    if (name === 'listModels') {
      ipcMain.handle(`${MODEL_PREFIX}${name}`, (_event, payload) => {
        heartbeatRetry();
        return handler(payload);
      });
      continue;
    }
    ipcMain.handle(`${MODEL_PREFIX}${name}`, (_event, payload) => handler(payload));
  }

  for (const [name, handler] of Object.entries(syncDispatch)) {
    if (name === 'status') {
      ipcMain.handle(`${SYNC_PREFIX}${name}`, (_event, payload) => {
        heartbeatRetry();
        return handler(payload);
      });
      continue;
    }
    ipcMain.handle(`${SYNC_PREFIX}${name}`, (_event, payload) => handler(payload));
  }

  return { modelDispatch, syncDispatch };
}

// ---------------------------------------------------------------------------
// Electron-only bootstrap
// ---------------------------------------------------------------------------

function bootstrap() {
  const { app, BrowserWindow, ipcMain, safeStorage } = electron;

  app.setName('AEGIS Desktop');

  const aegis = createClient();
  const dataDir = resolveUserDataDir(app);
  registerIpc(ipcMain, aegis, dataDir);
  const { engine, sessionsDir } = createEngine(aegis, { app, safeStorage, dir: dataDir });
  registerModelIpc(ipcMain, engine, sessionsDir, aegis);

  function createWindow() {
    const win = new BrowserWindow({
      width: 1080,
      height: 720,
      minWidth: 720,
      minHeight: 480,
      backgroundColor: '#0d1117',
      title: 'AEGIS Desktop',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
      },
    });

    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    return win;
  }

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

if (electron && electron.app) {
  bootstrap();
}

module.exports = {
  createIpcDispatch,
  registerIpc,
  IPC_PREFIX,
  MODEL_PREFIX,
  SYNC_PREFIX,
  CHAT_DELTA_CHANNEL,
  maskKey,
  createModelDispatch,
  createSyncDispatch,
  registerModelIpc,
  createEngine,
  resolveUserDataDir,
};
