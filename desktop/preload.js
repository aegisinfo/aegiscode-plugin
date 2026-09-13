'use strict';

/**
 * Preload — the ONLY bridge between the isolated renderer and the main
 * process. Exposes a whitelisted window.aegis.* surface backed by
 * ipcRenderer.invoke over the aegis:<method> channels registered in main.js.
 *
 * Security: contextIsolation + sandbox are enabled in main.js; no Node
 * globals leak through this bridge. Every method returns the backend's plain
 * JSON payload, and the API key never crosses this bridge — the renderer only
 * ever sees a masked preview via `status`.
 */

const { contextBridge, ipcRenderer } = require('electron');

const IPC_PREFIX = 'aegis:';
const MODEL_PREFIX = 'model:';
const SYNC_PREFIX = 'sync:';
const QUICK_PREFIX = 'quick:';
const CHAT_DELTA_CHANNEL = `${IPC_PREFIX}chatDelta`;
const UPDATE_STATUS_CHANNEL = `${IPC_PREFIX}updateStatus`;
const MENU_NEW_CHAT_CHANNEL = `${IPC_PREFIX}menuNewChat`;
const MENU_SEARCH_CHANNEL = `${IPC_PREFIX}menuSearch`;
const MENU_EXPORT_MARKDOWN_CHANNEL = `${IPC_PREFIX}menuExportMarkdown`;
const MENU_EXPORT_JSON_CHANNEL = `${IPC_PREFIX}menuExportJson`;
const DEEP_LINK_CHANNEL = `${IPC_PREFIX}deepLink`;
const QUICK_LAUNCHER_PUSH_CHANNEL = `${IPC_PREFIX}quickLauncherPush`;

function invoke(name, payload) {
  return ipcRenderer.invoke(
    IPC_PREFIX + name,
    payload === undefined ? undefined : payload
  );
}

function invokeModel(name, payload) {
  return ipcRenderer.invoke(
    MODEL_PREFIX + name,
    payload === undefined ? undefined : payload
  );
}

function invokeSync(name, payload) {
  return ipcRenderer.invoke(
    SYNC_PREFIX + name,
    payload === undefined ? undefined : payload
  );
}

function invokeQuick(name, payload) {
  return ipcRenderer.invoke(
    QUICK_PREFIX + name,
    payload === undefined ? undefined : payload
  );
}

/**
 * Build the chatDelta listener for one streaming request.
 *
 * Chunks arrive on a single shared channel, tagged by the main process with
 * the sessionId of the request they came from (see `taggedChunk` in main.js).
 * Filtering here is what makes concurrent streams safe: the primary answer and
 * each card of the horizontal discovery lane subscribe with their own
 * sessionId, so one reply can never bleed into another card's body.
 *
 * The normalisation is deliberately loose-strict: `undefined`/`''` ids
 * (legacy single-stream callers that pass no sessionId) are treated as one
 * bucket, so the old behaviour — receive every untagged chunk — is preserved
 * byte for byte.
 */
function deltaListener(sessionId, onDelta) {
  const want = sessionId || null;
  return (_event, chunk) => {
    const id = chunk && chunk.id ? chunk.id : null;
    if (id !== want) return;
    onDelta(chunk);
  };
}

// Whitelist — mirrors the dispatch map in main.js. If a method is not listed
// here the renderer cannot call it: add surface here AND there deliberately.
const api = {
  status: () => invoke('status'),
  // In-app key entry: the raw key flows renderer -> main only (never back).
  // The main process persists it encrypted and returns a masked preview.
  setApiKey: (key) => invoke('setApiKey', { key }),
  verifyApiKey: () => invoke('verifyApiKey'),
  tokenBankBalance: () => invoke('tokenBankBalance'),
  listModels: () => invoke('listModels'),
  // Streaming chat (D2.1): pass an onDelta callback to receive SSE chunks as
  // they arrive (pushed from main over aegis:chatDelta). The invoke promise
  // resolves once with the normalised final result. Without a callback the
  // request is plain non-streaming, exactly as before.
  chatCompletion: (payload, onDelta) => {
    const opts = payload || {};
    if (typeof onDelta !== 'function') {
      return invoke('chatCompletion', { ...opts, stream: false });
    }
    const listener = deltaListener(opts.sessionId, onDelta);
    const cleanup = () =>
      ipcRenderer.removeListener(CHAT_DELTA_CHANNEL, listener);
    ipcRenderer.on(CHAT_DELTA_CHANNEL, listener);
    return invoke('chatCompletion', { ...opts, stream: true }).then(
      (result) => {
        cleanup();
        return result;
      },
      (err) => {
        cleanup();
        throw err;
      }
    );
  },
  byokStatus: () => invoke('byokStatus'),
  byokSet: (provider, apiKey) => invoke('byokSet', { provider, apiKey }),
  memorySearch: (query, limit) => invoke('memorySearch', { query, limit }),
  memorySave: (entry) => invoke('memorySave', { entry }),
  memoryList: (limit) => invoke('memoryList', { limit }),
  verifyToken: (token) => invoke('verifyToken', { token }),
  memoryActivate: (token) => invoke('memoryActivate', { token }),
  memoryPull: (since) => invoke('memoryPull', { since }),
  memorySaveBatch: (entries) => invoke('memorySaveBatch', { entries }),
  memoryImport: (payload) => invoke('memoryImport', payload || {}),
  importConversation: (payload) => invoke('importConversation', payload || {}),
  // Rendered markdown's links (and the discovery lane's) open in the OS
  // default browser, never the app's own BrowserWindow — see main.js
  // isSafeExternalUrl for the http/https-only allowlist.
  openExternal: (url) => invoke('openExternal', { url }),

  // Tool-call approval toggle (Settings → "Confirm before running tools"):
  // main.js createConfirmModeDispatch persists it in the settings store's
  // reserved `__confirmMode` namespace, and the engine's gate
  // (lib/local/engine.js gatedExecuteTool) reads it on every mutating tool
  // call. Both resolve `{ enabled }`.
  getConfirmMode: () => invoke('getConfirmMode'),
  setConfirmMode: (enabled) => invoke('setConfirmMode', { enabled: Boolean(enabled) }),

  // Auto-update (electron-updater over GitHub Releases — see main.js
  // createUpdateManager). check/download resolve the same status shape the
  // push channel delivers; both are no-ops that resolve `{ status:
  // 'disabled' }` in an unpackaged dev build. quitAndInstallUpdate must only
  // ever be called from an explicit user action (the banner's "Restart to
  // install" button) — main.js never restarts on its own.
  checkForUpdates: () => invoke('checkForUpdates'),
  downloadUpdate: () => invoke('downloadUpdate'),
  quitAndInstallUpdate: () => invoke('quitAndInstallUpdate'),
  updateStatus: () => invoke('updateStatus'),
  // Live push as the state machine advances (checking -> available ->
  // downloading -> downloaded, or -> error at any point). Returns an
  // unsubscribe function, same shape as the chat delta listeners above.
  onUpdateStatus: (onStatus) => {
    const listener = (_event, state) => onStatus(state);
    ipcRenderer.on(UPDATE_STATUS_CHANNEL, listener);
    return () => ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, listener);
  },
  // Native menu accelerators with no built-in Electron role (Cmd/Ctrl+N,
  // Cmd/Ctrl+K — see main.js buildAppMenu): main.js just pings the channel,
  // the renderer owns what "new chat" / "search" actually do.
  onMenuNewChat: (onTrigger) => {
    const listener = () => onTrigger();
    ipcRenderer.on(MENU_NEW_CHAT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(MENU_NEW_CHAT_CHANNEL, listener);
  },
  onMenuSearch: (onTrigger) => {
    const listener = () => onTrigger();
    ipcRenderer.on(MENU_SEARCH_CHANNEL, listener);
    return () => ipcRenderer.removeListener(MENU_SEARCH_CHANNEL, listener);
  },
  // File > Save as… / Export Session… (see main.js buildAppMenu): the menu
  // has no renderer state of its own, so it just pings which format was
  // asked for; the renderer's handler knows the open session id and calls
  // exportSession() below — the same path the sidebar's Export button uses.
  onMenuExportMarkdown: (onTrigger) => {
    const listener = () => onTrigger();
    ipcRenderer.on(MENU_EXPORT_MARKDOWN_CHANNEL, listener);
    return () => ipcRenderer.removeListener(MENU_EXPORT_MARKDOWN_CHANNEL, listener);
  },
  onMenuExportJson: (onTrigger) => {
    const listener = () => onTrigger();
    ipcRenderer.on(MENU_EXPORT_JSON_CHANNEL, listener);
    return () => ipcRenderer.removeListener(MENU_EXPORT_JSON_CHANNEL, listener);
  },
  // Writes the given session to a user-picked file (dialog.showSaveDialog
  // runs in main — see main.js createExportDispatch); resolves
  // { ok, filePath } or { ok: false, canceled | reason }.
  exportSession: (sessionId, format) => invoke('exportSession', { sessionId, format }),
  // aegis:// deep link (main.js sendDeepLinkToWindow): fires with
  // { action: 'open', sessionId } or { action: 'new', prompt }.
  onDeepLink: (onLink) => {
    const listener = (_event, parsed) => onLink(parsed);
    ipcRenderer.on(DEEP_LINK_CHANNEL, listener);
    return () => ipcRenderer.removeListener(DEEP_LINK_CHANNEL, listener);
  },
  // Quick launcher "add to chat" (main.js pushQuickLauncherResult): fires
  // with { prompt, response, model } once the user pushes a launcher answer
  // into the main window — see renderer/app.js's handler for what it builds.
  onQuickLauncherPush: (onPush) => {
    const listener = (_event, payload) => onPush(payload);
    ipcRenderer.on(QUICK_LAUNCHER_PUSH_CHANNEL, listener);
    return () => ipcRenderer.removeListener(QUICK_LAUNCHER_PUSH_CHANNEL, listener);
  },
};

// Model-class surface (plan P1 §5.3): backed by the `model:` channels in
// main.js. Full keys never cross this bridge — settings.get/set return only
// masked previews.
const models = {
  listClasses: () => invokeModel('listClasses'),
  listModels: (cls) => invokeModel('listModels', { class: cls }),
  // Always streaming: pass an onDelta callback to receive live chunks over
  // CHAT_DELTA_CHANNEL; the invoke resolves once with the final result.
  chat: (payload, onDelta) => {
    const opts = payload || {};
    if (typeof onDelta !== 'function') {
      return invokeModel('chat', opts);
    }
    const listener = deltaListener(opts.sessionId, onDelta);
    const cleanup = () =>
      ipcRenderer.removeListener(CHAT_DELTA_CHANNEL, listener);
    ipcRenderer.on(CHAT_DELTA_CHANNEL, listener);
    return invokeModel('chat', opts).then(
      (result) => {
        cleanup();
        return result;
      },
      (err) => {
        cleanup();
        throw err;
      }
    );
  },
  settings: {
    get: () => invokeModel('settings.get'),
    set: (provider, cfg) =>
      invokeModel('settings.set', {
        provider,
        baseURL: cfg && cfg.baseURL,
        key: cfg && cfg.key,
      }),
    remove: (provider) => invokeModel('settings.remove', { provider }),
  },
  cancel: (sessionId) => invokeModel('cancel', { sessionId }),
  // Tool-call approval gate: the renderer's approval card calls this to
  // answer a pending exec/writeFile/editFile request (the approval itself
  // arrives as a `{ approval }` chunk on the same chat() delta stream — see
  // deltaListener above). clearApprovals wipes a conversation's "allow for
  // this session" grants; newChat() calls it so a fresh thread starts clean.
  respondApproval: (approvalId, decision) =>
    invokeModel('respondApproval', { approvalId, decision }),
  clearApprovals: (sessionId) => invokeModel('clearApprovals', { sessionId }),
};

// Session sync surface (plan P1 §5.3 / P3 §7): local persistence now, cloud
// push/pull later.
const sync = {
  listSessions: () => invokeSync('listSessions'),
  open: (sessionId) => invokeSync('open', { sessionId }),
  save: (session) => invokeSync('save', session || {}),
  append: (sessionId, message) => invokeSync('append', { sessionId, message }),
  delete: (sessionId) => invokeSync('delete', { sessionId }),
  push: () => invokeSync('push'),
  pull: () => invokeSync('pull'),
  status: () => invokeSync('status'),
};

// Quick launcher surface: loaded by BOTH renderer/index.html (the settings
// card that configures the global shortcut) and renderer/quick.html (the
// launcher popup itself, which calls pushToMain when the user keeps an
// answer) — one bridge, two consumers, same whitelist-only shape as
// aegis/models/sync above.
const quickLauncher = {
  // { enabled, shortcut, packaged, active, reason } — see main.js
  // createQuickLauncherDispatch. `active` reflects whether the shortcut is
  // actually registered right now; `reason` explains a failed registration.
  status: () => invokeQuick('status'),
  setConfig: (cfg) =>
    invokeQuick('setConfig', {
      enabled: cfg && cfg.enabled,
      shortcut: cfg && cfg.shortcut,
    }),
  // Called by renderer/quick.js once an answer exists; resolves
  // { ok, reason? }.
  pushToMain: (payload) => invokeQuick('pushToMain', payload || {}),
};

contextBridge.exposeInMainWorld('aegis', Object.freeze(api));
contextBridge.exposeInMainWorld('models', Object.freeze(models));
contextBridge.exposeInMainWorld('sync', Object.freeze(sync));
contextBridge.exposeInMainWorld('quickLauncher', Object.freeze(quickLauncher));
