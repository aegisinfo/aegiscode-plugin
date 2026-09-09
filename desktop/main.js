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
 * Pure mapping: IPC payload -> shared-client call. No Electron types here, so
 * tests can drive it with a stub client and a fake ipcMain.
 */
function createIpcDispatch(aegis) {
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
      aegis.memorySave(payload && payload.entry),
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

/** Register every dispatch method as `aegis:<name>` on ipcMain. */
function registerIpc(ipcMain, aegis) {
  const dispatch = createIpcDispatch(aegis);
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
function createEngine(aegis, { app, safeStorage } = {}) {
  const dir = resolveUserDataDir(app);
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
 * `push` is a P3 cloud-sync surface: for now it is a no-op stub that reports
 * nothing queued — local persistence is fully wired (§5.1/P3 §7).
 */
function createSyncDispatch(sessions, dir) {
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
    push: () => ({
      ok: false,
      queued: false,
      reason: 'cloud sync (P3) not implemented',
    }),
    status: () => ({
      count: sessions.listSessions(dir).length,
      pending: 0,
      cloud: false,
    }),
  };
}

/**
 * Register model:<name> and sync:<name> on ipcMain. `model:chat` is always
 * streaming: deltas are pushed over CHAT_DELTA_CHANNEL exactly like the
 * existing `aegis:chatCompletion` special case.
 */
function registerModelIpc(ipcMain, engine, sessionsDir) {
  const modelDispatch = createModelDispatch(engine);
  const syncDispatch = createSyncDispatch(sessionStore, sessionsDir);

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
    ipcMain.handle(`${MODEL_PREFIX}${name}`, (_event, payload) => handler(payload));
  }

  for (const [name, handler] of Object.entries(syncDispatch)) {
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
  registerIpc(ipcMain, aegis);
  const { engine, sessionsDir } = createEngine(aegis, { app, safeStorage });
  registerModelIpc(ipcMain, engine, sessionsDir);

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
