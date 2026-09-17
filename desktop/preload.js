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
const QUEUE_PREFIX = 'queue:';
const QUEUE_PROGRESS_CHANNEL = `${QUEUE_PREFIX}progress`;
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

function invokeQueue(name, payload) {
  return ipcRenderer.invoke(
    QUEUE_PREFIX + name,
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
  // Billing: both start a Stripe-hosted checkout and resolve a shaped
  // `{ ok, url | status, reason, upgrade }` (main.js billingResult). The
  // renderer opens the returned URL with openExternal below — the checkout
  // page itself never loads in this window.
  billingCheckout: () => invoke('billingCheckout'),
  tokenBankTopup: (amountEur) => invoke('tokenBankTopup', { amountEur }),
  listModels: () => invoke('listModels'),
  // Pre-edit file read for the diff preview (renderer/deriveDiff). A Write's
  // preview needs the file's contents as they were *before* the executor
  // overwrites them, and editPreview consumes a reader synchronously — so this
  // one method is sentSync, not invoke. It is the narrowest possible widening
  // of the bridge: main constrains the path to inside `cwd` and caps the read
  // (main.js readTextFileForPreview), so the renderer can only ever reach files
  // the session it is displaying is already allowed to edit. Returns
  // `{ text, truncated }` or null; a bridge failure reports null rather than
  // throwing onto the render path, which degrades the diff to a create-style
  // "all additions" block.
  readTextFile: (file, cwd) => {
    try {
      return ipcRenderer.sendSync(MODEL_PREFIX + 'readTextFile', {
        file,
        cwd,
      });
    } catch {
      return null;
    }
  },
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
  // Persisting memory (the desktop counterpart of the CLI's `memoryPersist`):
  // whether a finished turn is pushed to cloud memory automatically. Default
  // ON; `source` distinguishes a stored preference from that default.
  getMemoryPersist: () => invoke('memoryPersist.get'),
  setMemoryPersist: (enabled) => invoke('memoryPersist.set', { enabled: Boolean(enabled) }),

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
  // The automatic post-turn push ("persisting memory"). Gate-checked in main
  // against the `__memoryPersist` preference, so calling this on every turn is
  // cheap when persistence is off — it returns `{ skipped: true }` without
  // opening a request. `memoryPersistState()` reports the gate itself.
  auto: () => invokeSync('auto'),
  memoryPersistState: () => invokeSync('memoryPersistState'),
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

// Local autonomous work queue: the desktop half of the durable queue
// (desktop/lib/local/queue.js) plus the unattended worker
// (desktop/lib/local/autonomous.js), wired in main.js registerQueueIpc.
//
// Two things this surface deliberately does NOT have:
//
//   1. No shell and no free-form path passthrough. Every field is named and
//      coerced here, so the renderer can never smuggle an extra key (a `source`,
//      an `id`, a future `command`) into a queue file the CLI and the other
//      hosts also read. The one path-like field is `cwd` — the directory the
//      task's own tool loop runs in — and main.js refuses it unless it is an
//      absolute path that already exists; this file never joins, reads or writes
//      a path itself.
//   2. No drain that starts by itself. `drain`/`proceed` are invoked only from
//      the queue card's two buttons. Draining spends money on a real model in a
//      real checkout, so the trigger is a click and nothing else — main.js has
//      no timer to call it, and this file has no default.
const queue = {
  // Queue one task. `payload` is { task, cwd, model, effort, workers, maxRounds,
  // commit }; main.js range-checks every field and answers
  // { ok, item, items, pending, running, runs, … } or { ok: false, reason }.
  enqueue: (payload) => invokeQueue('enqueue', queueTaskFields(payload)),
  // Full state: { items, pending, running, draining, runs, defaultCwd, … }.
  list: () => invokeQueue('list'),
  // Drop finished tasks; `all` is the explicit "empty the queue" escape hatch.
  clear: (all) => invokeQueue('clear', { all: Boolean(all) }),
  // Put a finished/failed task back in line (by id), or drop it (by id).
  retry: (id) => queueWithId('retry', id),
  remove: (id) => queueWithId('remove', id),
  // Work one pending task, or all of them. `stop` cancels the turn in flight
  // AND the loop, so the next pending task does not simply start.
  drain: () => invokeQueue('drain', {}),
  proceed: () => invokeQueue('proceed', {}),
  stop: (id) => {
    const taskId = queueTaskId(id);
    return invokeQueue('stop', taskId == null ? {} : { id: taskId });
  },
  // Live drain progress pushed from main over queue:progress — one event per
  // turn frame ({ type: 'start'|'tool'|'delta'|'reasoning'|'finish', taskId, … }).
  // Note the channel: a worker's output is NOT a chat answer, so it never rides
  // aegis:chatDelta and can never be typed into the open transcript. Returns an
  // unsubscribe function, same shape as onUpdateStatus above.
  onProgress: (onEvent) => {
    if (typeof onEvent !== 'function') return () => {};
    const listener = (_event, payload) => onEvent(payload);
    ipcRenderer.on(QUEUE_PROGRESS_CHANNEL, listener);
    return () => ipcRenderer.removeListener(QUEUE_PROGRESS_CHANNEL, listener);
  },
};

/**
 * Task ids are the queue file's positive integers (queue.js nextId). A retry or
 * a remove with anything else is answered locally instead of being sent as a
 * string that would find no task and read as "no task #NaN" in the UI.
 */
function queueTaskId(id) {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function queueWithId(name, id) {
  const taskId = queueTaskId(id);
  if (taskId == null) {
    return Promise.resolve({ ok: false, reason: `${name} needs a task id` });
  }
  return invokeQueue(name, { id: taskId });
}

/** Pick the enqueue fields explicitly (never the raw payload) and coerce them to
 *  the types main.js range-checks, exactly like byokSet/setConfirmMode above. */
function queueTaskFields(payload) {
  const p = payload || {};
  return {
    task: String(p.task == null ? '' : p.task),
    cwd: String(p.cwd == null ? '' : p.cwd),
    model: p.model == null ? null : String(p.model),
    effort: p.effort == null ? null : String(p.effort),
    workers: p.workers == null ? null : Number(p.workers),
    maxRounds: p.maxRounds == null ? null : Number(p.maxRounds),
    commit: Boolean(p.commit),
  };
}

contextBridge.exposeInMainWorld('aegis', Object.freeze(api));
contextBridge.exposeInMainWorld('models', Object.freeze(models));
contextBridge.exposeInMainWorld('sync', Object.freeze(sync));
contextBridge.exposeInMainWorld('quickLauncher', Object.freeze(quickLauncher));
contextBridge.exposeInMainWorld('queue', Object.freeze(queue));
