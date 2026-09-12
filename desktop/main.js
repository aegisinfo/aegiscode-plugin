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
const { createSettingsStore, isReservedNamespace } = require('./lib/settings.js');
const ollama = require('./lib/local/ollama.js');
const providers = require('./lib/local/providers.js');
const sessionStore = require('./lib/sync/sessions.js');
const memoryQueue = require('./lib/sync/memory-queue.js');
// Foreign-memory scanner (shared with client/foreign-memory.js). Same
// resolution rule as the transport above: the canonical file inside the repo,
// the predist-staged copy in a packaged app. Never forked logic — so it needs
// no wrapper module of its own.
let foreignMemory;
try {
  foreignMemory = require('../client/foreign-memory.js');
} catch {
  foreignMemory = require('./vendor/foreign-memory.js');
}
// Builtin tool executor for the agent loop (client half of aegiscodex-dev's
// tool calling). MAIN-process only: it is reachable from the renderer solely
// through the whitelisted `tools:` IPC surface registered below — see the
// sandbox note on registerToolsIpc().
const localTools = require('./lib/local/tools.js');

const IPC_PREFIX = 'aegis:';
const MODEL_PREFIX = 'model:';
const SYNC_PREFIX = 'sync:';
const TOOLS_PREFIX = 'tools:';

/**
 * Main -> renderer push channel for chat SSE deltas (D2.1 streaming render).
 * The invoke of aegis:chatCompletion still resolves once with the normalised
 * final result; live chunks travel on this single dedicated channel.
 */
const CHAT_DELTA_CHANNEL = `${IPC_PREFIX}chatDelta`;

/**
 * Address one SSE delta to the stream that produced it (D2.2 multi-stream).
 *
 * The renderer's chat flow runs a *set* of concurrent streams — the primary
 * answer plus the horizontal discovery lane — so every chunk must say which
 * sessionId it belongs to. `id` is added last so the routing tag stays
 * authoritative, while `delta` (and any future field the client sends) is
 * copied through untouched: existing single-stream callers that never set a
 * sessionId simply receive `id: undefined`, exactly the shape they see today.
 */
function taggedChunk(chunk, sessionId) {
  const base = chunk && typeof chunk === 'object' ? chunk : { delta: chunk };
  return { ...base, id: sessionId };
}

const APP_VERSION = require('./package.json').version;

/** Never ship a full key to the renderer — only a masked preview. */
function maskKey(key) {
  if (!key) return null;
  if (key.length <= 10) return 'configured';
  return `${key.slice(0, 9)}\u2026${key.slice(-4)}`;
}

/**
 * Classify a memory-endpoint failure: is this the plan's sync quota, or is it
 * just offline? aegis1 answers HTTP 402 `free_session_limit_reached` when a
 * WRITE would exceed the plan's synced-token ceiling (free = 1M, pro = 10M).
 * Since the quota became token-denominated, reads (search/pull) are always
 * served over quota, so only pushes can answer 402 — a pull that 402s is an
 * older server.
 *
 * The shared client attaches `err.status` / `err.data` (vendor/aegis.js
 * parseResponse) — but `ipcRenderer.invoke` only carries the *message string*
 * across the process boundary. A thrown cap therefore reaches the renderer as
 * the bare text "free_session_limit_reached" with `status`/`data` stripped,
 * which is why the upgrade UI in fetchMemory() never fired. So: detect it here,
 * in main, where the fields still exist, and hand the renderer a plain resolved
 * payload.
 *
 * Returns null for anything that is not a cap (offline, no key, 500, …).
 */
function upgradeInfo(err) {
  const status = err && err.status;
  const data = (err && err.data) || {};
  const code = typeof data.error === 'string' ? data.error : '';
  if (status !== 402 && code !== 'free_session_limit_reached') return null;
  // Quota numbers are TOKENS now (`tokensUsed` / `tokenLimit`). The legacy
  // session-named keys are read only as a fallback so this build still shows a
  // number against a server that predates the rename.
  const used = data.tokensUsed != null
    ? data.tokensUsed
    : (data.sessionsUsed != null ? data.sessionsUsed : null);
  const limit = data.tokenLimit != null
    ? data.tokenLimit
    : (data.freeSessionLimit != null ? data.freeSessionLimit : null);
  return {
    url: data.upgradeUrl || 'https://aegiscloud.org/subscribe',
    used,
    limit,
    code: code || 'free_session_limit_reached',
  };
}

/** Message text for a failure, without assuming the Error shape. */
function errorText(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * `aegis:memorySave` with the offline-first fallback (plan P3 §7): try the
 * cloud save first; if it fails (no key, offline, transient error) queue the
 * entry in <dir>/memory-queue.json instead of throwing, so the renderer's
 * "remember" affordance never surfaces an error for the no-key case. `dir` is
 * optional — callers that omit it (e.g. the desktop-shell smoke test) simply
 * get the un-queued rejection back, unchanged from before this existed.
 *
 * The cap is the one failure that is deliberately NOT queued: see upgradeInfo.
 * A 402 resolves `{ ok:false, upgrade }` — never thrown, because the fields
 * would not survive the IPC trip — and the entry is left un-stored so the
 * renderer can keep it in the box and point at the subscribe page.
 */
async function saveMemoryWithQueue(aegis, dir, entry) {
  try {
    return await aegis.memorySave(entry);
  } catch (err) {
    const upgrade = upgradeInfo(err);
    if (upgrade) {
      return { ok: false, queued: 0, saved: 0, upgrade, reason: errorText(err) };
    }
    if (!dir || !entry) throw err;
    memoryQueue.enqueue(dir, entry);
    return { ok: true, queued: true, reason: errorText(err) };
  }
}

/**
 * Read side of the same normalisation. Since the sync quota became
 * token-denominated, aegis1 no longer refuses reads over quota — it serves
 * `memorySearch` / `memoryList` and reports `tokensUsed` / `tokenLimit` in the
 * payload. So an exhausted account arrives as a *success*, and the notice has
 * to be derived from the fields rather than from a thrown 402. The 402 branch
 * stays for an older server that still caps reads.
 *
 * Both paths resolve the same `upgrade` shape so the renderer keeps one branch.
 */
async function normalizeMemoryRead(promise) {
  try {
    const data = await promise;
    const quota = quotaFromPayload(data);
    // Entries are deliberately preserved: an over-quota account still owns its
    // memory and must see it. Only the notice is added.
    return quota ? Object.assign({}, data, { upgrade: quota }) : data;
  } catch (err) {
    const upgrade = upgradeInfo(err);
    if (!upgrade) throw err;
    return { entries: [], upgrade };
  }
}

/** Over-quota notice derived from a successful read payload, or null.
 *  `tokensUsed`/`tokenLimit` come from aegis1 `_token_quota_fields`. */
function quotaFromPayload(data) {
  if (!data || typeof data !== 'object') return null;
  const used = data.tokensUsed != null ? data.tokensUsed : null;
  const limit = data.tokenLimit != null ? data.tokenLimit : null;
  if (used == null || limit == null || limit <= 0) return null;
  if (used < limit) return null;
  return {
    url: 'https://aegiscloud.org/subscribe',
    used,
    limit,
    code: 'sync_quota_reached',
  };
}

/**
 * `aegis:memoryImport` — scan this machine for other AI tools' memory and,
 * when confirmed, push it into AEGIS cloud memory.
 *
 * Read-only against the foreign stores (client/foreign-memory.js never writes
 * to them). Two-phase by design: a dry run reports counts so the user can see
 * what would land before anything leaves the machine. When a confirmed save
 * can't reach the cloud (no key / offline), entries fall back to the same
 * local memory-queue the single-entry save path uses, so the import is not
 * lost — it flushes on the next "Sync now".
 *
 * The renderer gets counts and a summary string, never the entry bodies:
 * 1000 entries x 2 kB over IPC is pure waste, and the bodies are already
 * either in the cloud or in the queue by the time this resolves.
 */
async function importForeignMemory(aegis, dir, payload) {
  const opts = payload || {};
  const report = foreignMemory.scan({
    sources: opts.sources,
    limit: opts.limit || 1000,
  });
  const summary = foreignMemory.describe(report);
  const sources = report.sources.map((s) => ({
    id: s.id,
    label: s.label,
    verified: s.verified,
    present: s.present,
    count: s.count,
    skipped: s.skipped,
    files: s.files,
  }));

  const base = { summary, totals: report.totals, sources };

  if (!opts.confirm || !report.entries.length) {
    return { ...base, ok: true, dryRun: !opts.confirm, saved: 0, queued: 0 };
  }

  let saved = 0;
  let queued = 0;
  const errors = [];
  let upgrade = null;
  for (const batch of foreignMemory.chunk(report.entries, 200)) {
    try {
      const data = await aegis.memorySaveBatch(batch);
      saved += (data && data.saved) || batch.length;
    } catch (err) {
      // The cap is not an offline failure: don't queue the batch. The entries
      // are still in the foreign stores, so a later scan re-finds them — but a
      // queued copy would flush-fail forever and, worse, made a mid-import 402
      // report as a silent `queued` count. Report the upgrade instead.
      upgrade = upgradeInfo(err);
      if (!upgrade && dir) {
        // Offline-first, exactly like saveMemoryWithQueue(): keep the entries
        // rather than dropping them. Anything already saved stays saved.
        for (const entry of batch) {
          memoryQueue.enqueue(dir, entry);
          queued += 1;
        }
      }
      errors.push(errorText(err));
      break;
    }
  }

  return {
    ...base,
    ok: errors.length === 0,
    dryRun: false,
    saved,
    queued,
    upgrade,
    reason: errors[0] || null,
  };
}

/**
 * Pure mapping: IPC payload -> shared-client call. No Electron types here, so
 * tests can drive it with a stub client and a fake ipcMain.
 */
function createIpcDispatch(aegis, dir, persistApiKey) {
  const dispatch = {
    status: () => ({
      appVersion: APP_VERSION,
      clientVersion: aegis.clientVersion,
      apiBase: aegis.apiBase,
      keyConfigured: Boolean(aegis.apiKey),
      keyMask: maskKey(aegis.apiKey),
    }),

    // In-app API key entry (plan rebuild): replace the live client key and
    // persist it encrypted at rest via the settings store. The renderer only
    // ever sees the masked preview back — never the raw key.
    setApiKey: (payload) => {
      const key = payload && payload.key;
      aegis.setApiKey(key || '');
      if (persistApiKey) persistApiKey(aegis.apiKey);
      return { keyConfigured: Boolean(aegis.apiKey), keyMask: maskKey(aegis.apiKey) };
    },

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
      normalizeMemoryRead(
        aegis.memorySearch(payload && payload.query, payload && payload.limit)
      ),
    memorySave: (payload) =>
      saveMemoryWithQueue(aegis, dir, payload && payload.entry),
    memoryList: (payload) =>
      normalizeMemoryRead(aegis.memoryList(payload && payload.limit)),

    verifyToken: (payload) =>
      aegis.verifyToken(payload && payload.token),
    memoryActivate: (payload) =>
      aegis.memoryActivate(payload && payload.token),
    memoryPull: (payload) =>
      aegis.memoryPull(payload && payload.since),
    memorySaveBatch: (payload) =>
      aegis.memorySaveBatch(payload && payload.entries),
    memoryImport: (payload) =>
      importForeignMemory(aegis, dir, payload),
    importConversation: (payload) =>
      aegis.importConversation(payload || {}),
  };
  return dispatch;
}

/** Register every dispatch method as `aegis:<name>` on ipcMain. `dir` (the
 *  user-data dir) is optional and threaded through only for the memorySave
 *  offline-queue fallback — see saveMemoryWithQueue(). */
function registerIpc(ipcMain, aegis, dir, persistApiKey) {
  const dispatch = createIpcDispatch(aegis, dir, persistApiKey);
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
            // Address every delta with the request's sessionId (D2.2): the
            // chat flow can run more than one stream at a time (the primary
            // answer plus the horizontal discovery lane), so an unaddressed
            // broadcast would interleave both replies into one bubble. The
            // renderer's preload filters on `id`; chunks stay shape-compatible
            // ({ delta }) for callers that never set a sessionId.
            sender.send(CHAT_DELTA_CHANNEL, taggedChunk(chunk, opts.sessionId));
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
  // Relocate a pre-fix `settings['aegis']` key into the reserved namespace so
  // it stops showing up as a provider. Ciphertext-level, so safe pre-'ready'.
  settings.migrateLegacyAegisKey();
  const engine = createLocalEngine({ aegis, settings, ollama, providers });
  return { engine, sessionsDir: dir, settings };
}

/**
 * Pure mapping: model:<name> -> LocalEngine call (unit-testable in Node).
 */
function createModelDispatch(engine) {
  return {
    listClasses: () => engine.listClasses(),
    listModels: (payload) => engine.listModels(payload && payload.class),
    chat: (payload) => engine.chat(payload, payload && payload.onStream),
    // The AEGIS key lives in a reserved namespace the store refuses to expose
    // or delete through this surface; the filter is belt-and-braces so a
    // mis-wired store can never hand the renderer a removable AEGIS entry.
    'settings.get': () =>
      engine.settings.list().filter((s) => !(s && isReservedNamespace(s.provider))),
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
    if (!queued.length) return { flushed: 0, remaining: 0, upgrade: null };
    const remaining = [];
    let flushed = 0;
    let upgrade = null;
    for (let i = 0; i < queued.length; i += 1) {
      try {
        await aegis.memorySave(queued[i]);
        flushed += 1;
      } catch (err) {
        const capped = upgradeInfo(err);
        if (capped) {
          // A 402 is not "try again later": every remaining entry would fail
          // the same way, the queue would never drain, and the paywall would
          // stay invisible behind a "synced" toast. Stop, keep the rest
          // queued for after the upgrade, and surface the cap to the renderer.
          upgrade = capped;
          remaining.push(...queued.slice(i));
          break;
        }
        // Any other failure (offline / transient) keeps the entry queued.
        remaining.push(queued[i]);
      }
    }
    memoryQueue.save(dir, remaining);
    return { flushed, remaining: remaining.length, upgrade };
  }

  async function push() {
    const pending = sessions.listPending(dir);
    if (!hasCloud()) {
      return { ok: false, queued: pending.length, reason: 'no AEGIS key configured' };
    }
    const memoryFlush = await flushMemoryQueue();
    if (!pending.length) {
      return {
        ok: true,
        queued: 0,
        pushed: 0,
        memoryFlushed: memoryFlush.flushed,
        upgrade: memoryFlush.upgrade,
      };
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
      return {
        ok: false,
        queued,
        reason: lastError.message || 'push failed',
        memoryFlushed: memoryFlush.flushed,
        upgrade: memoryFlush.upgrade,
      };
    }
    return {
      ok: true,
      queued,
      pushed,
      memoryFlushed: memoryFlush.flushed,
      upgrade: memoryFlush.upgrade,
    };
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
            // Two streams can be live at once (main answer + discovery lane),
            // so each delta carries the sessionId it belongs to. See the
            // matching note on the aegis:chatCompletion forwarder.
            sender.send(CHAT_DELTA_CHANNEL, taggedChunk(chunk, opts.sessionId));
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

  // One settings store backs both the provider settings surface and the AEGIS
  // API key entry. It lives only in the main process and encrypts keys at rest
  // via Electron safeStorage (best-effort base64 when unavailable).
  const { engine, sessionsDir, settings } = createEngine(aegis, {
    app,
    safeStorage,
    dir: dataDir,
  });

  // Persist the in-app AEGIS key in its own reserved namespace, encrypted —
  // never as a provider named 'aegis' (that coupling let the Settings pane's
  // "Remove" delete the AEGIS key; defect #1).
  const persistApiKey = (key) => settings.setAegisKey(key);

  registerIpc(ipcMain, aegis, dataDir, persistApiKey);
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

  app.whenReady().then(() => {
    // Hydrate the client from the persisted key BEFORE the renderer issues any
    // status/model call, so class/model dropdowns populate immediately when a
    // key was saved in-app (safeStorage is usable only after app ready).
    const persistedKey = settings.aegisRawKey();
    if (persistedKey) aegis.setApiKey(persistedKey);
    createWindow();
  });

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
  taggedChunk,
  maskKey,
  createModelDispatch,
  createSyncDispatch,
  registerModelIpc,
  createEngine,
  resolveUserDataDir,
  importForeignMemory,
};
