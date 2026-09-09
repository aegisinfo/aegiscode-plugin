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
  chatCompletion: (payload) => invoke('chatCompletion', payload || {}),
  byokStatus: () => invoke('byokStatus'),
  byokSet: (provider, apiKey) => invoke('byokSet', { provider, apiKey }),
  memorySearch: (query, limit) => invoke('memorySearch', { query, limit }),
  memorySave: (entry) => invoke('memorySave', { entry }),
  memoryList: (limit) => invoke('memoryList', { limit }),
};

contextBridge.exposeInMainWorld('aegis', Object.freeze(api));
