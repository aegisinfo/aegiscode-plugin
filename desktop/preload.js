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
const CHAT_DELTA_CHANNEL = `${IPC_PREFIX}chatDelta`;

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
    const listener = (_event, chunk) => onDelta(chunk);
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
  importConversation: (payload) => invoke('importConversation', payload || {}),
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
    const listener = (_event, chunk) => onDelta(chunk);
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

contextBridge.exposeInMainWorld('aegis', Object.freeze(api));
contextBridge.exposeInMainWorld('models', Object.freeze(models));
contextBridge.exposeInMainWorld('sync', Object.freeze(sync));
