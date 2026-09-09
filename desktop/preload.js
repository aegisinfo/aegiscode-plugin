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
const CHAT_DELTA_CHANNEL = `${IPC_PREFIX}chatDelta`;

function invoke(name, payload) {
  return ipcRenderer.invoke(
    IPC_PREFIX + name,
    payload === undefined ? undefined : payload
  );
}

// Whitelist — mirrors the dispatch map in main.js. If a method is not listed
// here the renderer cannot call it: add surface here AND there deliberately.
const api = {
  status: () => invoke('status'),
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
};

contextBridge.exposeInMainWorld('aegis', Object.freeze(api));
