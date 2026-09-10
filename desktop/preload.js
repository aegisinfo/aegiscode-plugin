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
