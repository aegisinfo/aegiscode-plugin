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
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

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

// The shared credential store (`client/credentials.js`) — the same 0600 file
// the terminal host writes with `aegiscode login` and the MCP plugin reads. The
// app resolves its own account key through it, so signing in once serves all
// four hosts; see resolveStartupKey() and persistApiKey() below.
let credentials;
try {
  credentials = require('../client/credentials.js');
} catch {
  credentials = require('./vendor/credentials.js');
}

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
const persistGate = require('./lib/sync/persist-gate.js');
const windowState = require('./lib/window-state.js');
const deepLink = require('./lib/deep-link.js');
const quickLauncherLib = require('./lib/quick-launcher.js');
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

// The local autonomous work queue (commit 96fb64f): a durable task list plus
// the unattended worker that drives the local engine's tool loop. MAIN-process
// only, like the tool executor above — the renderer reaches it solely through
// the `queue:` IPC surface registered by registerQueueIpc() below.
const queueModule = require('./lib/local/queue.js');
const autonomousModule = require('./lib/local/autonomous.js');

const IPC_PREFIX = 'aegis:';
const MODEL_PREFIX = 'model:';
const SYNC_PREFIX = 'sync:';
const TOOLS_PREFIX = 'tools:';
const QUICK_PREFIX = 'quick:';
const QUEUE_PREFIX = 'queue:';

/**
 * Main -> renderer push channel for chat SSE deltas (D2.1 streaming render).
 * The invoke of aegis:chatCompletion still resolves once with the normalised
 * final result; live chunks travel on this single dedicated channel.
 */
const CHAT_DELTA_CHANNEL = `${IPC_PREFIX}chatDelta`;

/** Main -> renderer pushes for native menu accelerators (Cmd/Ctrl+N,
 *  Cmd/Ctrl+K) that have no Electron role to bind to — the renderer owns
 *  "new chat" and "open search" behaviour, so the menu just asks for it. */
const MENU_NEW_CHAT_CHANNEL = `${IPC_PREFIX}menuNewChat`;
const MENU_SEARCH_CHANNEL = `${IPC_PREFIX}menuSearch`;
/** File > Save as… / Export session — same "menu has no state of its own,
 *  renderer does the work" pattern as the two channels above: the renderer
 *  knows the open session id, main.js just pings it. */
const MENU_EXPORT_MARKDOWN_CHANNEL = `${IPC_PREFIX}menuExportMarkdown`;
const MENU_EXPORT_JSON_CHANNEL = `${IPC_PREFIX}menuExportJson`;

/**
 * Main -> renderer push for a resolved aegis:// deep link (D? deep linking).
 * Delivered once per link, after the target window has finished loading
 * (see sendDeepLinkToWindow) so the renderer's listener is always attached
 * before it arrives.
 */
const DEEP_LINK_CHANNEL = `${IPC_PREFIX}deepLink`;

/**
 * Main -> renderer push for a quick-launcher answer the user chose to keep
 * (D? quick launcher §4). Carries `{ prompt, response, model }`; the main
 * window's renderer already owns "add a turn to the open thread" (send()'s
 * addMessage + sync.append), so — same "menu pings, renderer acts" pattern as
 * MENU_NEW_CHAT_CHANNEL etc. — this just delivers the payload.
 */
const QUICK_LAUNCHER_PUSH_CHANNEL = `${IPC_PREFIX}quickLauncherPush`;

/**
 * Main -> renderer push for a queue drain's progress (one event per turn frame:
 * start/tool/delta/finish, plus recovered/queued/locked). Deliberately its OWN
 * channel rather than CHAT_DELTA_CHANNEL.
 *
 * A drain runs an unattended turn in a repository, and every one of its frames
 * is about that task — its tool calls, its output, its cost. Pushed onto the
 * chat delta channel they would be typed into whatever conversation the user
 * happens to have open (the preload's sessionId filter would have to be widened
 * to let them through at all), so the transcript would grow a second, unattached
 * answer nobody asked for. The queue is not a chat surface: the renderer shows
 * state and outcomes from this event, and the transcript stays clean.
 */
const QUEUE_PROGRESS_CHANNEL = `${QUEUE_PREFIX}progress`;

/**
 * How much task text the queue surface accepts, and how many rounds a queued
 * task may take. Both are ceilings on what ONE renderer call can ask the app to
 * spend: without them a pasted file would be queued as a task (every round
 * re-sends the prompt) and a task could pin the loop open indefinitely.
 * `workers` is capped at 8 to match the Model card's own input.
 */
const QUEUE_MAX_TASK_CHARS = 8000;
const QUEUE_MAX_ROUNDS = 200;
const QUEUE_MAX_WORKERS = 8;

/** The efforts the queue accepts; anything else means "let the worker decide"
 *  (autonomous.js resolveEffort, whose default is high for unattended work). */
const QUEUE_EFFORTS = new Set(['low', 'medium', 'high']);

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
 * Precise classification of a cloud-sync refusal — the desktop port of
 * `describeError()` in cli/src/cloudsync.js, so both hosts name a 402/401 the
 * same way instead of surfacing whatever sentence the server happened to use.
 *
 * `push()`/`pull()` used to hand the renderer `err.message` alone, so a
 * per-session memory-token 401 or a 402 reached the banner as
 * "sync failed: free_session_limit_reached" — a string that reads like a bug
 * and names no fix. The shared client attaches `err.status` / `err.data`
 * (vendor/aegis.js parseResponse) while the error is still in main, which is
 * why the classification happens here.
 *
 * `kind` is `quota` | `auth` | `error`; `hint` is the actionable half of the
 * sentence (what to do about it), null when there is nothing to say.
 */
function describeSyncError(err) {
  const status =
    (err && (err.status || (err.response && err.response.status))) || 0;
  const message = errorText(err);
  // upgradeInfo() already knows the cap: either a 402 or the server's
  // `free_session_limit_reached` code (an older body without a status).
  if (upgradeInfo(err)) {
    return {
      kind: 'quota',
      status: status || 402,
      message,
      hint:
        "the plan's synced-token ceiling is reached — free space in the account dashboard or upgrade to keep syncing",
    };
  }
  if (status === 401) {
    return {
      kind: 'auth',
      status,
      message,
      hint: 'the memory token was refused — re-enter your AEGIS API key to exchange a new one',
    };
  }
  return { kind: 'error', status: status || null, message, hint: null };
}

/** The banner line for a classified failure: the server's words + the fix. */
function syncErrorReason(info) {
  if (!info) return 'sync failed';
  return info.hint ? `${info.message} — ${info.hint}` : info.message;
}

/**
 * Result shape for the two billing actions (`aegis:billingCheckout` and
 * `aegis:tokenBankTopup`). Both end in a Stripe-hosted checkout URL created
 * server-side, and both have failure modes the user has to be able to tell
 * apart: the free-plan cap (402), no/invalid API key (401), an amount the
 * server rejects (400), Stripe not configured on the server (503
 * `setup_required`), and a plain transport/500 error.
 *
 * The classification happens HERE for the same reason the memory paths
 * normalise: `ipcRenderer.invoke` carries only the message STRING across the
 * boundary, so `err.status` / `err.data` are gone by the time the renderer
 * sees a rejection. The renderer gets a resolved payload instead — never a
 * throw it would have to string-match.
 */
async function billingResult(run) {
  try {
    const data = await run();
    return {
      ok: true,
      url: (data && data.url) || null,
      status: 0,
      reason: null,
      setupRequired: false,
      upgrade: null,
    };
  } catch (err) {
    const data = (err && err.data) || {};
    return {
      ok: false,
      url: null,
      status: (err && err.status) || 0,
      reason: errorText(err),
      setupRequired: Boolean(data.setup_required),
      upgrade: upgradeInfo(err),
    };
  }
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

/** Only http/https may be opened externally — file://, javascript:, etc.
 *  would hand the OS shell an arbitrary URI straight from model output. */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Pure mapping: IPC payload -> shared-client call. No Electron types here, so
 * tests can drive it with a stub client and a fake ipcMain. `openExternal` is
 * the one exception — it is itself just a function (default a harmless
 * reject), injected by bootstrap() so this module still needs no `electron`
 * import to stay unit-testable.
 */
function createIpcDispatch(aegis, dir, persistApiKey, openExternal) {
  const openExternalFn = openExternal || (() => Promise.reject(new Error('no opener configured')));
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

    // Billing (plan upgrade + token-bank top-up). aegis1 creates a Stripe
    // checkout session and answers `{ url }`; the renderer opens that URL
    // through the same aegis:openExternal path the upgrade notices use, so a
    // payment page is never rendered inside the app's own window. Both
    // resolve a shaped result instead of rejecting — see billingResult().
    billingCheckout: () => billingResult(() => aegis.billingCheckout()),
    tokenBankTopup: (payload) =>
      billingResult(() => aegis.tokenBankTopup(payload && payload.amountEur)),

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

    // Links inside rendered markdown must never navigate the app's own
    // BrowserWindow (that would point the chat UI at an arbitrary model-
    // supplied origin) — they open in the OS default browser instead.
    openExternal: (payload) => {
      const url = payload && payload.url;
      if (!isSafeExternalUrl(url)) {
        return Promise.resolve({ ok: false, reason: 'unsupported URL scheme' });
      }
      return Promise.resolve(openExternalFn(url)).then(
        () => ({ ok: true }),
        (err) => ({ ok: false, reason: errorText(err) })
      );
    },
  };
  return dispatch;
}

/** Chain `onReplyFinished(event, result)` onto a dispatch promise without
 *  changing what it resolves/rejects with — the notifier is best-effort
 *  (native-notification side effect) and optional (undefined in every
 *  headless test path, where it is simply never called). */
function withReplyNotify(promise, event, onReplyFinished) {
  if (!onReplyFinished) return promise;
  return promise.then((result) => {
    onReplyFinished(event, result);
    return result;
  });
}

/** Register every dispatch method as `aegis:<name>` on ipcMain. `dir` (the
 *  user-data dir) is optional and threaded through only for the memorySave
 *  offline-queue fallback — see saveMemoryWithQueue(). `openExternal` is the
 *  real electron.shell.openExternal, injected by bootstrap(); omitted in
 *  tests, where the safe no-op default in createIpcDispatch takes over.
 *  `onReplyFinished` is likewise bootstrap()-only: it fires the native
 *  "reply ready" notification when the window is unfocused/hidden. */
function registerIpc(ipcMain, aegis, dir, persistApiKey, openExternal, onReplyFinished) {
  const dispatch = createIpcDispatch(aegis, dir, persistApiKey, openExternal);
  for (const [name, handler] of Object.entries(dispatch)) {
    if (name === 'chatCompletion') {
      // Streaming render (D2.1): when the renderer asks for stream, SSE deltas
      // are pushed over CHAT_DELTA_CHANNEL as they arrive while the invoke
      // promise still resolves once with the normalised final result. When the
      // payload does not request stream, behaviour is the plain non-streaming
      // dispatch (what the headless shell test drives directly).
      ipcMain.handle(`${IPC_PREFIX}${name}`, (event, payload) => {
        const opts = { ...(payload || {}) };
        if (!opts.stream) return withReplyNotify(handler(opts), event, onReplyFinished);
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
        return withReplyNotify(
          handler({ ...opts, stream: true, onStream: forward }),
          event,
          onReplyFinished
        );
      });
      continue;
    }
    ipcMain.handle(`${IPC_PREFIX}${name}`, (_event, payload) => handler(payload));
  }
  return dispatch;
}

/**
 * Tool-call approval toggle ("confirm mode"): `aegis:getConfirmMode` /
 * `aegis:setConfirmMode` (see registerConfirmModeIpc below). Pure injection of
 * the settings store, same shape as createQuickLauncherDispatch — so it is
 * unit-testable in plain Node with a stub store, and bootstrap() wires the
 * real one (desktop/lib/settings.js, reserved `__confirmMode` namespace).
 *
 * `{ enabled: true }` (the default) is the historical behaviour: the engine's
 * gate (desktop/lib/local/engine.js gatedExecuteTool) previews and asks before
 * every exec/writeFile/editFile. `false` lets the renderer's Settings switch
 * turn that off for good — the engine reads the flag per tool call, so the
 * change applies to the very next call, no restart.
 */
function createConfirmModeDispatch(settings) {
  if (!settings) throw new Error('createConfirmModeDispatch requires a settings store');
  return {
    getConfirmMode: () => ({ enabled: settings.getConfirmMode() }),
    setConfirmMode: (payload) => {
      // Absent/undefined means "off"? No — an explicit boolean is required to
      // change anything: a malformed payload must not silently disable the
      // approval gate, so it only ever sets what was clearly asked for.
      const enabled = payload && payload.enabled;
      if (typeof enabled !== 'boolean') return { enabled: settings.getConfirmMode() };
      return { enabled: settings.setConfirmMode(enabled) };
    },
  };
}

/** Register getConfirmMode/setConfirmMode as `aegis:<name>` on ipcMain —
 *  the same ${IPC_PREFIX}<method> convention registerIpc uses for the rest of
 *  the renderer's aegis.* bridge (their handlers need nothing but the
 *  payload, so the event is dropped exactly like every non-chatCompletion
 *  method there). */
function registerConfirmModeIpc(ipcMain, dispatch) {
  for (const [name, handler] of Object.entries(dispatch)) {
    ipcMain.handle(`${IPC_PREFIX}${name}`, (_event, payload) => handler(payload));
  }
  return dispatch;
}

/** Turn a session title/id into a filesystem-safe base filename. */
function safeExportBasename(session) {
  const base = (session && (session.title || session.id)) || 'session';
  return base.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'session';
}

/**
 * Pure mapping: `aegis:exportSession` -> read the session from the sessions
 * store (lib/sync/sessions.js is the single source of truth for its shape),
 * serialize it, then hand the (defaultPath, filters) to an injected
 * `showSaveDialog` and the resulting path + content to an injected
 * `writeFile`. Both are injected — exactly like `openExternal` on
 * createIpcDispatch — so this is unit-testable with stub functions and needs
 * no Electron import of its own; bootstrap() wires the real
 * dialog.showSaveDialog / fs.promises.writeFile.
 */
function createExportDispatch(sessions, dir, showSaveDialog, writeFile) {
  return {
    exportSession: async (payload) => {
      const sessionId = payload && payload.sessionId;
      const format = payload && payload.format === 'json' ? 'json' : 'markdown';
      const session = sessionId ? sessions.getSession(dir, sessionId) : null;
      if (!session) return { ok: false, reason: 'session not found' };

      const content = format === 'json' ? sessions.toJson(session) : sessions.toMarkdown(session);
      const ext = format === 'json' ? 'json' : 'md';
      const filters = format === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [{ name: 'Markdown', extensions: ['md'] }];

      const dialogResult = await showSaveDialog({
        defaultPath: `${safeExportBasename(session)}.${ext}`,
        filters,
      });
      if (!dialogResult || dialogResult.canceled || !dialogResult.filePath) {
        return { ok: false, canceled: true };
      }

      try {
        await writeFile(dialogResult.filePath, content);
      } catch (err) {
        return { ok: false, reason: errorText(err) };
      }
      return { ok: true, filePath: dialogResult.filePath };
    },
  };
}

/** Register export dispatch methods as `aegis:<name>`, same convention as
 *  registerIpc()/registerUpdateIpc() above. */
function registerExportIpc(ipcMain, sessions, dir, showSaveDialog, writeFile) {
  const dispatch = createExportDispatch(sessions, dir, showSaveDialog, writeFile);
  for (const [name, handler] of Object.entries(dispatch)) {
    ipcMain.handle(`${IPC_PREFIX}${name}`, (_event, payload) => handler(payload));
  }
  return dispatch;
}

/**
 * Pure mapping: `quick:<name>` -> quick-launcher state. `opts.isPackaged`,
 * `opts.applyConfig` and `opts.pushToMain` are injected (default no-ops) so
 * this is unit-testable in plain Node, same pattern as createExportDispatch's
 * injected showSaveDialog/writeFile — bootstrap() wires the real
 * globalShortcut-backed applyConfig and window-relaying pushToMain.
 *
 * `applyConfig(cfg)` is expected to (re)register or unregister the global
 * shortcut for the given `{ enabled, shortcut }` and resolve/return
 * `{ active, reason }` — `reason` carries a human-readable cause the one time
 * registration fails (e.g. the accelerator is already claimed by another
 * app), so the renderer's settings card can show it instead of a silent
 * no-op. This module never throws on a failed registration; it degrades to
 * `active:false` and surfaces `reason`.
 */
function createQuickLauncherDispatch(settings, opts = {}) {
  const isPackaged = Boolean(opts.isPackaged);
  const applyConfig = opts.applyConfig || (() => ({ active: false, reason: null }));
  const pushToMain = opts.pushToMain || (() => ({ ok: false, reason: 'no main window' }));
  let state = { active: false, reason: null };

  function status() {
    return { ...settings.quickLauncherConfig(), packaged: isPackaged, ...state };
  }

  function setConfig(payload) {
    const saved = settings.setQuickLauncherConfig({
      enabled: payload && payload.enabled,
      shortcut: payload && payload.shortcut,
    });
    state = applyConfig(saved) || { active: false, reason: null };
    return { ...saved, packaged: isPackaged, ...state };
  }

  return {
    status,
    setConfig,
    pushToMain: (payload, event) => pushToMain(payload, event),
  };
}

/** Register quick:<name> on ipcMain. `pushToMain` needs the raw IPC `event`
 *  (to hide the launcher window that sent it — see bootstrap()'s
 *  pushQuickLauncherResult), so it is special-cased exactly like
 *  aegis:chatCompletion is in registerIpc(); every other method drops the
 *  event, matching the rest of this file's convention. */
function registerQuickLauncherIpc(ipcMain, dispatch) {
  for (const [name, handler] of Object.entries(dispatch)) {
    if (name === 'pushToMain') {
      ipcMain.handle(`${QUICK_PREFIX}${name}`, (event, payload) => handler(payload, event));
      continue;
    }
    ipcMain.handle(`${QUICK_PREFIX}${name}`, (_event, payload) => handler(payload));
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
function createEngine(aegis, { app, safeStorage, dir: dirOverride, sessionsDir: sessionsOverride } = {}) {
  // Settings (the safeStorage-encrypted key, window state, provider entries)
  // stay in Electron's userData: they are this host's own, and the key is only
  // readable by this process.
  const settingsDir = dirOverride || resolveUserDataDir(app);
  const settings = createSettingsStore({ dir: settingsDir, safeStorage });
  // Relocate a pre-fix `settings['aegis']` key into the reserved namespace so
  // it stops showing up as a provider. Ciphertext-level, so safe pre-'ready'.
  settings.migrateLegacyAegisKey();
  const engine = createLocalEngine({ aegis, settings, ollama, providers });
  // Sessions/memory live in the SHARED data dir ($AEGISCODE_HOME or
  // ~/.aegiscode) — the same file the terminal host and the MCP plugin read —
  // so a thread started in either shows up in the other without cloud sync and
  // without a key. resolveStoreDir() also adopts a pre-unification
  // userData/sessions.json, once, when the shared store is still empty, so an
  // upgrade does not look like every conversation was deleted.
  const sessionsDir = sessionsOverride || sessionStore.resolveStoreDir(settingsDir);
  return { engine, sessionsDir, settingsDir, settings };
}

/** Largest pre-edit read the diff bridge will hand the renderer (bytes). */
const PREVIEW_READ_MAX_BYTES = 512 * 1024;

/**
 * The contained, capped read behind the renderer's diff preview — the only
 * filesystem capability the renderer has, and the narrowest form of it.
 *
 * The renderer supplies a file plus the cwd of the session it is displaying.
 * Every path is resolved with `realpath` *before* the containment test, so a
 * symlink planted inside the workspace cannot point the read outside it, and
 * containment is judged with `path.relative` rather than a `startsWith` prefix
 * (which would let `/home/neo-evil` pass a naive `/home/neo` check). Anything
 * refused — relative cwd, escape, missing file, directory, non-regular file —
 * returns null, which degrades the preview to a create-style diff instead of
 * throwing onto the render path.
 *
 * @returns {{text: string, truncated: boolean}|null}
 */
function readTextFileForPreview(payload) {
  try {
    const file = payload && typeof payload.file === 'string' ? payload.file : '';
    const cwd = payload && typeof payload.cwd === 'string' ? payload.cwd : '';
    if (!file || !cwd || !path.isAbsolute(cwd)) return null;

    // realpath both sides: resolving the root too keeps this correct on hosts
    // where the workspace itself is reached through a symlink (/tmp, /var).
    const root = fs.realpathSync(cwd);
    const abs = fs.realpathSync(path.resolve(root, file));
    const rel = path.relative(root, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;

    const st = fs.statSync(abs);
    if (!st.isFile()) return null;

    if (st.size <= PREVIEW_READ_MAX_BYTES) {
      return { text: fs.readFileSync(abs, 'utf8'), truncated: false };
    }
    // Oversized: read only the head of the file and cut back to the last
    // newline, so a byte-boundary truncation cannot leave a half-decoded
    // multi-byte sequence at the end of the preview.
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(PREVIEW_READ_MAX_BYTES);
      const n = fs.readSync(fd, buf, 0, PREVIEW_READ_MAX_BYTES, 0);
      let text = buf.toString('utf8', 0, n);
      const nl = text.lastIndexOf('\n');
      if (nl > 0) text = text.slice(0, nl + 1);
      return { text, truncated: true };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
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
    // Persisting memory ("sync finished turns to cloud memory automatically").
    // Reserved namespace, so it is invisible to the provider CRUD above — but
    // unlike a provider it IS reachable deliberately, through these two. The
    // gate that enforces it lives in lib/sync/persist-gate.js and reads the
    // same file, so a `false` written here stops the next automatic push.
    'memoryPersist.get': () => engine.settings.memoryPersistState(),
    'memoryPersist.set': (payload) =>
      engine.settings.setMemoryPersist(Boolean(payload && payload.enabled)),
    cancel: (payload) => engine.cancel(payload && payload.sessionId),
    // Tool-call approval gate (desktop/lib/local/engine.js gatedExecuteTool):
    // the renderer's approval card answers a pending exec/writeFile/editFile
    // request here; newChat() clears a conversation's "allow for this
    // session" grants so a fresh thread never inherits a prior one's.
    respondApproval: (payload) =>
      engine.respondApproval(payload && payload.approvalId, payload && payload.decision),
    clearApprovals: (payload) =>
      engine.clearSessionApprovals(payload && payload.sessionId),
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
function createSyncDispatch(sessions, dir, aegis, settingsDir) {
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
    let lastInfo = null;
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
        lastInfo = describeSyncError(err);
        // A cap (402) or a refused memory token (401) fails identically for
        // every later session — same reason the CLI stops there. One request
        // per queued transcript against a refusal that cannot succeed is
        // nothing but noise, so stop. The rest are left untouched (markSynced
        // is never reached for them) and drain after the account is fixed.
        if (lastInfo.kind === 'quota' || lastInfo.kind === 'auth') break;
      }
    }
    const queued = sessions.listPending(dir).length;
    if (pushed) lastSyncAt = Date.now();
    // The session push is the path that hits the free-plan cap most often —
    // every queued transcript re-bills the synced-token ceiling — so its
    // upgrade metadata wins over the memory flush's. Without this, a capped
    // session push answered `upgrade: null` and the renderer's capNotice()
    // (the one place the paywall is visible) never fired.
    const sessionUpgrade = lastError ? upgradeInfo(lastError) : null;
    const upgrade = sessionUpgrade || memoryFlush.upgrade;
    if (pushed === 0 && lastError) {
      return {
        ok: false,
        queued,
        reason: syncErrorReason(lastInfo),
        // Additive: the renderer reads ok/queued/reason/upgrade exactly as
        // before; these name the refusal without string-matching its wording.
        failed: lastInfo ? [lastInfo] : [],
        kind: lastInfo ? lastInfo.kind : 'error',
        status: lastInfo ? lastInfo.status : 0,
        hint: lastInfo ? lastInfo.hint : null,
        memoryFlushed: memoryFlush.flushed,
        upgrade,
      };
    }
    return {
      ok: true,
      queued,
      pushed,
      // A partially failed push is still `ok` (the ones that went out are
      // synced), but the reason is carried so nothing looks silently clean.
      failed: lastInfo ? [lastInfo] : [],
      memoryFlushed: memoryFlush.flushed,
      upgrade,
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
      return { ok: true, merged, failed: [], upgrade: null };
    } catch (err) {
      const info = describeSyncError(err);
      // Same shape as cli/src/cloudsync.js pull(): a classified `failed[]`
      // instead of a bare message to string-match, plus the cap metadata when
      // this was a 402 — the renderer's syncNow() reads `pullResult.upgrade`
      // alongside the push's, so a pull that hits the cap now lights the
      // upgrade banner too.
      return {
        ok: false,
        merged: 0,
        reason: syncErrorReason(info),
        failed: [info],
        kind: info.kind,
        status: info.status,
        hint: info.hint,
        upgrade: upgradeInfo(err),
      };
    }
  }

  // The automatic post-turn push (persisting memory for every account). Gated
  // by the `__memoryPersist` preference in settings.json, which the Settings
  // pane writes through the memoryPersist:* IPC below; the gate is read from
  // disk in the main process so the renderer cannot push past it. This must
  // read `settingsDir` (Electron's userData path), NOT `dir` — `dir` here is
  // the shared aegisHome() sessions/credentials directory, a different path
  // from userData in a real install, and the settings store is created with
  // `settingsDir`. Falling back to `dir` only covers callers (tests) that
  // never pass `settingsDir` and use one directory for everything.
  const autoPush = persistGate.createAutoPush({ push, dir: settingsDir || dir });

  return {
    auto: () => autoPush.auto(),
    memoryPersistState: () => autoPush.gate(),
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

/** First retry delay and the ceiling for the heartbeat push backoff. */
const HEARTBEAT_RETRY_BASE_MS = 5000;
const HEARTBEAT_RETRY_MAX_MS = 30000;

/**
 * Backoff for the fire-and-forget heartbeat push (plan §7 "retry on a
 * heartbeat"). `model:listModels` and `sync:status` each fire one, and the
 * renderer polls both — so a permanently failing push (offline, refused
 * memory token, free-plan cap) used to burn a request on every single one,
 * forever, with `.catch(() => {})` swallowing the reason.
 *
 * Now: exponential backoff from `baseMs` to `maxMs`, reset on success, and the
 * last error is retained (`state()`) so a stuck sync is visible on the
 * sync:status payload instead of disappearing into an empty catch.
 *
 * `push` is expected to resolve a `{ ok:false, reason }` result rather than
 * throw (that is createSyncDispatch's contract) — both are counted, because
 * only counting throws would leave the offline case retrying every heartbeat.
 * `now`/`baseMs`/`maxMs` are injectable so the tests can drive the ladder
 * without sleeping.
 */
function createHeartbeatRetry(push, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const baseMs = Number(opts.baseMs) > 0 ? Number(opts.baseMs) : HEARTBEAT_RETRY_BASE_MS;
  const maxMs = Number(opts.maxMs) > 0 ? Number(opts.maxMs) : HEARTBEAT_RETRY_MAX_MS;
  let failures = 0;
  let nextAttemptAt = 0;
  let lastError = null;
  let inFlight = false;

  /** 5s, 10s, 20s, 30s, 30s… — capped, never unbounded. */
  const delayFor = () => Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));

  function fail(reason) {
    failures += 1;
    const wait = delayFor();
    lastError = reason || 'push failed';
    nextAttemptAt = now() + wait;
    return { attempted: true, ok: false, error: lastError, failures, retryInMs: wait };
  }

  async function run() {
    const t = now();
    if (failures > 0 && t < nextAttemptAt) {
      // Backing off: no request, no state change — the caller keeps whatever
      // reason is already on record.
      return { attempted: false, ok: false, error: lastError, failures, retryInMs: nextAttemptAt - t };
    }
    if (inFlight) {
      return { attempted: false, ok: false, error: lastError, failures, retryInMs: 0 };
    }
    inFlight = true;
    try {
      const result = await push();
      if (result && result.ok === false) {
        return fail(result.reason || result.kind || 'push failed');
      }
      // Success resets the ladder: the next heartbeat goes straight out.
      failures = 0;
      nextAttemptAt = 0;
      lastError = null;
      return { attempted: true, ok: true, error: null, failures: 0, retryInMs: 0, result };
    } catch (err) {
      return fail(errorText(err));
    } finally {
      inFlight = false;
    }
  }

  /** Snapshot for the renderer: what failed and how long until the retry. */
  function state() {
    const t = now();
    return {
      failures,
      lastError,
      retryInMs: failures > 0 && nextAttemptAt > t ? nextAttemptAt - t : 0,
    };
  }

  return { run, state, recordFailure: (err) => fail(errorText(err)) };
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
 * chance to sync without a dedicated poller. The retry is rate-limited by
 * createHeartbeatRetry (exponential backoff, reset on success); its last error
 * rides along on the sync:status result so the renderer can show it.
 *
 * `onReplyFinished`, like the identical param on registerIpc, is
 * bootstrap()-only — it fires the native "reply ready" notification when the
 * window is unfocused/hidden and is never set in the headless test path.
 * `heartbeatOpts` ({ now, baseMs, maxMs }) is for tests only. `settingsDir`
 * is Electron's userData path — where settings.json (and so the
 * `__memoryPersist` preference the auto-push gate reads) actually lives;
 * `sessionsDir` is the separate shared aegisHome() directory and must not be
 * used for that gate. Falls back to `sessionsDir` for callers that don't pass
 * it, i.e. tests that use one directory for everything.
 */
function registerModelIpc(ipcMain, engine, sessionsDir, aegis, onReplyFinished, heartbeatOpts, settingsDir) {
  const modelDispatch = createModelDispatch(engine);
  const syncDispatch = createSyncDispatch(sessionStore, sessionsDir, aegis, settingsDir);

  const heartbeat = createHeartbeatRetry(() => syncDispatch.push(), heartbeatOpts);

  function heartbeatRetry() {
    // run() classifies its own failures, so this catch is a last-resort guard
    // (never an empty swallow): the reason is recorded for the banner either way.
    const attempt = heartbeat.run();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch((err) => heartbeat.recordFailure(err));
    }
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
        return withReplyNotify(
          handler({ ...opts, onStream: forward }),
          event,
          onReplyFinished
        );
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

  // Diff-preview pre-edit read (preload.js `readTextFile`). Registered with
  // `on` + `event.returnValue`, NOT `handle`: the bridge is `sendSync` because
  // editPreview consumes its reader synchronously and cannot await an invoke
  // promise, and `sendSync` is answered only by an `ipcMain.on` listener.
  // Putting it in modelDispatch above would register a `handle` that sendSync
  // never reaches. Fires on every edit tool's run frame, so the refusal path
  // is the common case (a `writeFile` creating a new file) and must stay cheap.
  ipcMain.on(`${MODEL_PREFIX}readTextFile`, (event, payload) => {
    event.returnValue = readTextFileForPreview(payload);
  });

  for (const [name, handler] of Object.entries(syncDispatch)) {
    if (name === 'status') {
      ipcMain.handle(`${SYNC_PREFIX}${name}`, (_event, payload) => {
        heartbeatRetry();
        const result = handler(payload);
        // Additive: `retry` carries the last heartbeat failure and the wait
        // until the next attempt, so a stuck sync is visible instead of
        // swallowed. The local status fields are untouched.
        return result && typeof result === 'object'
          ? { ...result, retry: heartbeat.state() }
          : result;
      });
      continue;
    }
    ipcMain.handle(`${SYNC_PREFIX}${name}`, (_event, payload) => handler(payload));
  }

  return { modelDispatch, syncDispatch, heartbeat };
}

// ─────────────────────────── the local autonomous work queue ───────────────
//
// `desktop/lib/local/queue.js` (the durable queue) and
// `desktop/lib/local/autonomous.js` (the worker that drives the engine's tool
// loop) shipped with no host using them. This is the desktop host's half: a
// `queue:` IPC surface, a settings-independent engine for the worker, and the
// one rule that makes the whole thing safe to leave in a GUI — NOTHING DRAINS
// UNLESS THE USER ASKED. There is no interval, no drain at startup, and no
// drain-on-idle anywhere in this file. Draining is spend (a full tool loop on a
// real model, in the user's checkout); a queue that starts itself when the
// window is left alone is a feature nobody consented to, so the only callers of
// `drain`/`proceed` are the two buttons on the renderer's queue card.

/**
 * A local engine for the queue worker: the same tool loop the interactive chat
 * runs, with the tool-approval gate hard OFF.
 *
 * The gate exists to ask a human before exec/writeFile/editFile. A queued task
 * is unattended BY DEFINITION — there is nobody to click — and engine.js's
 * requestApproval() resolves only on a click or on an abort, so a gated engine
 * here would mean a worker parked on an approval card forever (a `running`
 * queue item, a held lock, and no record of why). Gate off is the honest
 * configuration: the worker runs the tools it was asked to run, and the
 * renderer's card says so in as many words.
 */
function createQueueEngine(aegis, settings) {
  return createLocalEngine({
    aegis,
    settings,
    ollama,
    providers,
    getConfirmMode: () => false,
  });
}

/**
 * The second net under createQueueEngine's gate-off engine.
 *
 * If an approval request still reaches a drain — a caller that wired the
 * interactive engine by mistake, or a future engine change — answer it here
 * rather than leave a card nobody can click. The answer is always 'deny': a
 * queued task may decide to run the tools it was configured to run, but it may
 * never silently grant a permission the user reserves for a click. Denying lets
 * the turn continue to its own conclusion, where autonomous.js — which watches
 * the same `{ approval }` frame — settles the task as failed with the reason
 * written down. A hang would have recorded nothing at all.
 */
function queueEngineWithDeniedApprovals(engine) {
  if (!engine || typeof engine.chat !== 'function') return engine;
  const deny = (chunk) => {
    const approval = chunk && chunk.approval;
    if (!approval || !approval.id) return;
    if (typeof engine.respondApproval !== 'function') return;
    try {
      engine.respondApproval(approval.id, 'deny');
    } catch {
      /* the turn's own error path reports a gate that cannot be answered */
    }
  };
  return {
    ...engine,
    chat(payload, onDelta) {
      return engine.chat(payload, (chunk) => {
        deny(chunk);
        if (typeof onDelta === 'function') onDelta(chunk);
      });
    },
  };
}

/** True when `p` is an existing directory (the only path check this surface
 *  makes: a task's cwd is where its tool loop runs, so a typo there has to be
 *  refused now rather than fail minutes later inside a turn's output). */
function isExistingDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** An integer within [min,max], or null for "not stated". */
function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/**
 * Pure mapping: `queue:<name>` -> queue.js + autonomous.js. Unit-testable in
 * plain Node with a stub engine and a temp AEGIS_QUEUE_FILE, exactly like
 * createIpcDispatch/createExportDispatch above — `engine` is injected (the
 * real one comes from createQueueEngine in bootstrap()), and every path the
 * queue touches comes from `env`.
 *
 * The methods are thin: `enqueue`/`retry`/`remove`/`clear` are the queue file's
 * own vocabulary, and `drain`/`proceed` are one and many `worker.proceed({max:
 * 1})` ticks. The worker itself owns the lock, the digest, the round horizon
 * and the settle-back-into-the-file write; none of that is re-implemented here.
 *
 * `stop` is the renderer's Stop button. It has to be its own method rather than
 * "cancel the current turn": cancelling a turn leaves the next pending task to
 * start immediately, which is not what a user who just pressed Stop asked for.
 */
function createQueueDispatch({
  engine,
  env = process.env,
  queue = queueModule,
  autonomous = autonomousModule,
  log = () => {},
} = {}) {
  if (!engine || typeof engine.chat !== 'function') {
    throw new Error('createQueueDispatch: a local engine with chat() is required');
  }

  // The task the current drain is working, learned from the worker's own
  // start/finish frames, so `stop` can cancel the turn actually in flight.
  let running = null;
  // Set by `stop`, read between ticks by drainAll. Reset when a drain starts.
  let stopRequested = false;
  // This window's drain. queue.js's file lock is what stops a SECOND process;
  // this flag stops a second click in the same window from queueing up a second
  // loop (which would only be refused by the lock after a round trip).
  let draining = false;

  const emit = (event) => {
    if (event && event.type === 'start') running = event.taskId;
    if (event && event.type === 'finish') running = null;
    log(event);
  };

  const worker = autonomous.createQueueWorker({
    engine: queueEngineWithDeniedApprovals(engine),
    env,
    log: emit,
  });

  /** What the renderer paints from: the queue file, the run log, and whether
   *  this window is currently draining. Read fresh on every call — the queue is
   *  a file several hosts write to, so a cached copy would show a stale list. */
  function snapshot() {
    const items = queue.loadQueue(env);
    return {
      ok: true,
      items,
      pending: queue.pendingCount(items),
      running: items.find((i) => i && i.status === 'running') || null,
      draining,
      stopping: stopRequested,
      defaultCwd: process.cwd(),
      // What a task with no model of its own actually runs on. The queue is
      // Aegis Cloud only, so this is a pooled tier id — and the card prints it,
      // because "which model is this drain spending on" was previously
      // unanswerable from the UI.
      defaultModel: autonomous.resolveModel({ env }),
      queueFile: queue.queuePath(env),
      runs: queue.readRuns(env, { limit: 20 }),
    };
  }

  /**
   * Coerce one renderer payload into queue.addTask's opts.
   *
   * There is no shell field on this surface and no path the main process reads
   * or writes on the renderer's behalf: `cwd` is the directory the task's own
   * tool loop runs in, it must be absolute and already exist, and it is passed
   * through unmodified. model/effort/workers/maxRounds are ids, rungs and small
   * integers — never commands — and every one of them is range-checked here so
   * a malformed payload is refused with a reason instead of queued as work that
   * silently runs with defaults.
   */
  function taskOpts(payload) {
    const p = payload || {};
    const task = String(p.task == null ? '' : p.task).trim();
    if (!task) return { error: 'a queued task needs text' };
    if (task.length > QUEUE_MAX_TASK_CHARS) {
      return { error: `task text is too long (${task.length} > ${QUEUE_MAX_TASK_CHARS} chars)` };
    }
    const cwd = String(p.cwd == null ? '' : p.cwd).trim() || process.cwd();
    if (!path.isAbsolute(cwd)) return { error: 'the working directory must be an absolute path' };
    if (!isExistingDir(cwd)) return { error: `not a directory: ${cwd}` };

    const model = String(p.model == null ? '' : p.model).trim().slice(0, 120) || null;
    // Aegis Cloud only (autonomous.js modelRefusal): the worker's requests go
    // out as `class: 'aegis'`, so a model the pool does not serve is a task that
    // fails inside a drain. Refused HERE so the card gets the reason at the
    // moment of queueing instead of a red row later. queue.addTask enforces the
    // same rule for the CLI and for hand-written queue files.
    const modelRefusal = model ? autonomous.modelRefusal(model) : '';
    if (modelRefusal) return { error: modelRefusal };
    const effortRaw = String(p.effort == null ? '' : p.effort).trim().toLowerCase();
    return {
      opts: {
        task,
        cwd,
        model,
        effort: QUEUE_EFFORTS.has(effortRaw) ? effortRaw : null,
        workers: clampInt(p.workers, 1, QUEUE_MAX_WORKERS),
        maxRounds: clampInt(p.maxRounds, 1, QUEUE_MAX_ROUNDS),
        // The pooled-brain fan-out is opt-in (autonomous.js resolveFanout):
        // it costs about workers+1 full reasoning calls on one task, so the
        // card has to ask for it per task. queue.addTask stores the inverse
        // (`singlePass`), which is also the field a hand-written queue file
        // or the CLI uses.
        singlePass: !(p.fanout === true || p.autonomous === true),
        commit: Boolean(p.commit),
        source: 'desktop',
      },
    };
  }

  /** `settle`-shaped one-liner per finished task, so the drain's answer carries
   *  the outcome of every task it ran rather than only the last one. */
  const summarize = (ran) =>
    (ran || []).map((r) => ({ id: r.id, ok: Boolean(r.ok), error: r.error || null }));

  // Note on `commit`: neither drain accepts a commit override from the
  // renderer. Whether a task commits is a property of the TASK (the checkbox it
  // was queued with, carried in the queue file), so `worker.proceed` is called
  // with the flag undefined and autonomous.js falls back to each item's own
  // `commit`. A drain-level flag would let one click rewrite another task's
  // decision.

  async function drainOnce() {
    if (draining) return { ok: false, reason: 'a drain is already running in this window', ...snapshot() };
    draining = true;
    stopRequested = false;
    let result;
    try {
      const tick = await worker.proceed({ max: 1 });
      result = tick.locked
        ? { ok: false, locked: true, holder: tick.holder, ran: [] }
        : { ok: true, ran: summarize(tick.ran) };
    } catch (err) {
      // A drain that throws must still leave a readable answer (and a queue
      // that can be inspected), not a rejected IPC promise the renderer would
      // paint as "Invoke failed".
      result = { ok: false, reason: errorText(err), ran: [] };
    }
    draining = false;
    running = null;
    return { ...result, ...snapshot() };
  }

  async function drainAll() {
    if (draining) return { ok: false, reason: 'a drain is already running in this window', ...snapshot() };
    draining = true;
    stopRequested = false;
    const ran = [];
    let result;
    try {
      for (;;) {
        // One task per tick through the worker's own proceed: it re-reads the
        // FILE each time (so a task added mid-drain is picked up) and takes and
        // releases the lock around each task, which is what lets Stop land
        // between two tasks instead of after the whole queue.
        const tick = await worker.proceed({ max: 1 });
        if (tick.locked) {
          result = { ok: false, locked: true, holder: tick.holder, ran: summarize(ran) };
          break;
        }
        if (!tick.ran.length) {
          result = { ok: true, stopped: stopRequested, ran: summarize(ran) };
          break;
        }
        ran.push(...tick.ran);
        if (stopRequested) {
          result = { ok: true, stopped: true, ran: summarize(ran) };
          break;
        }
      }
    } catch (err) {
      result = { ok: false, reason: errorText(err), ran: summarize(ran) };
    }
    draining = false;
    running = null;
    return { ...result, ...snapshot() };
  }

  return {
    /** Queue one task. */
    enqueue: (payload) => {
      const { opts, error } = taskOpts(payload);
      if (error) return { ok: false, reason: error, ...snapshot() };
      const item = queue.addTask(env, opts);
      return { ok: true, item, ...snapshot() };
    },

    /** Current state: the list, what is running, what is pending, recent runs. */
    list: () => snapshot(),

    /** Drop finished tasks (or everything with `all`). Pending and running tasks
     *  are kept — queue.clearQueue's rule, not this surface's. */
    clear: (payload) => ({
      ...queue.clearQueue(env, { all: Boolean(payload && payload.all) }),
      ok: true,
      ...snapshot(),
    }),

    /** Put a finished/failed task back in line, keeping its attempt count. */
    retry: (payload) => {
      const id = payload && payload.id;
      const item = queue.retryTask(env, id);
      if (!item) return { ok: false, reason: `no task #${id}`, ...snapshot() };
      return { ok: true, item, ...snapshot() };
    },

    /** Remove one task by id. A running task is refused: the worker holds it in
     *  memory and writes its outcome back, so deleting it mid-turn would just be
     *  re-created by that settle — stop it first. */
    remove: (payload) => {
      const id = payload && payload.id;
      const items = queue.loadQueue(env);
      const item = queue.findTask(items, id);
      if (!item) return { ok: false, reason: `no task #${id}`, ...snapshot() };
      if (item.status === 'running') {
        return { ok: false, reason: `task #${item.id} is running — stop the drain first`, ...snapshot() };
      }
      queue.saveQueue(env, items.filter((i) => Number(i && i.id) !== Number(item.id)));
      return { ok: true, removed: item.id, ...snapshot() };
    },

    /** Work exactly one pending task (the card's "Run one"). */
    drain: () => drainOnce(),

    /** Work pending tasks until the queue is empty, or Stop is pressed. */
    proceed: () => drainAll(),

    /** Stop: cancel the turn in flight AND the loop, so the next pending task
     *  does not simply start. */
    stop: (payload) => {
      stopRequested = true;
      const id = payload && payload.id != null ? payload.id : running;
      const cancel = id == null ? null : worker.cancel(id);
      return { ok: true, wasDraining: draining, cancelled: cancel, ...snapshot() };
    },
  };
}

/**
 * Register the queue surface as `queue:<name>` on ipcMain — the same
 * per-namespace pattern as MODEL_PREFIX/SYNC_PREFIX/QUICK_PREFIX above, with
 * one addition: drain/proceed need the raw IPC event, because their progress
 * frames are pushed to the window that ASKED for the drain, over
 * QUEUE_PROGRESS_CHANNEL (never CHAT_DELTA_CHANNEL — see that constant).
 */
function registerQueueIpc(ipcMain, { engine, env, queue, autonomous } = {}) {
  // The window a drain's frames go to. One drain runs at a time process-wide
  // (queue.js's lock), so a single target is enough, and a second window's
  // drain is refused by the lock rather than interleaving two progress streams.
  let target = null;
  const dispatch = createQueueDispatch({
    engine,
    env,
    queue,
    autonomous,
    log: (event) => {
      if (!target || typeof target.send !== 'function') return;
      if (typeof target.isDestroyed === 'function' && target.isDestroyed()) return;
      target.send(QUEUE_PROGRESS_CHANNEL, event);
    },
  });
  for (const [name, handler] of Object.entries(dispatch)) {
    if (name === 'drain' || name === 'proceed') {
      ipcMain.handle(`${QUEUE_PREFIX}${name}`, (event, payload) => {
        target = (event && event.sender) || null;
        return handler(payload);
      });
      continue;
    }
    ipcMain.handle(`${QUEUE_PREFIX}${name}`, (_event, payload) => handler(payload));
  }
  return dispatch;
}

/**
 * Main -> renderer push channel for auto-update status (mirrors
 * CHAT_DELTA_CHANNEL): the renderer's update banner listens here instead of
 * polling `aegis:updateStatus`.
 */
const UPDATE_STATUS_CHANNEL = `${IPC_PREFIX}updateStatus`;

/** Re-check for a new release every few hours — frequent enough that a
 *  long-lived session still notices a release, rare enough to not hammer
 *  the GitHub Releases API. */
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Auto-update state machine over electron-updater (GitHub Releases provider,
 * configured via desktop/electron-builder.yml `publish:` — see main.js's
 * top-of-file note and that file's comment for the feed this points at).
 *
 * Deliberately inert outside a packaged app: `electron .` in dev has no
 * app-update.yml (electron-builder only writes one at build time), so
 * calling checkForUpdates() there would just throw on every launch. Rather
 * than special-case that error, `isPackaged: false` skips wiring the real
 * autoUpdater entirely and every method resolves a harmless 'disabled'
 * state — dev never touches the network or the update machinery.
 *
 * `autoDownload` stays false: checking happens automatically (on ready and
 * on the interval below), but the multi-hundred-MB download itself only
 * starts when the renderer's banner "Download" button calls download() —
 * see the IPC dispatch below. This keeps every step user-visible and
 * matches the "never auto-restart without consent" rule: quitAndInstall()
 * is likewise only ever invoked by an explicit "Restart to install" click.
 */

/**
 * Update state backed by the npm registry, for installs that are not packaged
 * electron builds (i.e. `npm i -g aegis-desktop`).
 *
 * Mirrors the electron-updater manager's shape exactly so the IPC dispatch and
 * the renderer banner need no branch: status/check/download/quitAndInstall/
 * start. `download` and `quitAndInstall` are no-ops that report the install
 * command instead of acting — npm owns installation here, and silently
 * swapping the package under a running process is not something to do on the
 * user's behalf.
 */
/**
 * How long to wait before re-checking after a FAILED background check: 1m, 5m,
 * 15m, then hourly.
 *
 * The 4h interval is right for a successful check — the answer changes slowly —
 * and wrong for a failure, whose usual cause (no network yet at login, a VPN
 * still coming up, a one-off registry blip) is gone inside a minute. Before
 * this, a machine that launched before its Wi-Fi associated showed a hard error
 * for the next four hours.
 */
const UPDATE_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/**
 * The sentence the banner shows. Every one of these used to be the single fixed
 * string "registry unreachable" — including a 404 and a 2.5s timeout, neither of
 * which is evidence the registry was unreachable. Only the last two are claims
 * about the network, and only when the socket actually failed.
 */
function describeRegistryFailure(reason, status, pkg) {
  switch (reason) {
    case 'not-found':
      return `${pkg} is not published on the npm registry (404)`;
    case 'forbidden':
      return `the npm registry refused the request (${status || 'auth'})`;
    case 'malformed':
      return 'the npm registry sent a response this app could not read';
    case 'too-large':
      return 'the npm registry response was too large to read';
    case 'timeout':
      return 'the npm registry did not respond in time';
    case 'network':
      return 'the npm registry could not be reached';
    default:
      return 'the update check did not complete';
  }
}

function createNpmUpdateManager({
  onStatus,
  now = () => Date.now(),
  fetchImpl,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const PKG = 'aegis-desktop';
  let current = 'unknown';
  try {
    current = require('./package.json').version;
  } catch {
    /* version is cosmetic here */
  }
  // `reason`/`transient`/`attempts`/`retryInMs`/`canDownload` are additive: the
  // banner needs them to decide whether a failure deserves the user's
  // attention at all, and whether there is a button worth offering.
  let state = {
    status: 'idle',
    version: null,
    error: null,
    channel: 'npm',
    reason: null,
    transient: false,
    attempts: 0,
    retryInMs: 0,
    command: null,
    canDownload: false,
  };
  const set = (patch) => {
    state = { ...state, ...patch };
    if (onStatus) onStatus(state);
    return state;
  };

  // Same repo-then-vendor idiom every other shared module here uses.
  let updater = null;
  try {
    updater = require('../client/update.js');
  } catch {
    try {
      updater = require('./vendor/update.js');
    } catch {
      updater = null;
    }
  }

  let attempts = 0;
  let retryAt = 0;
  let retryTimer = null;
  let inFlight = null;
  let interval = null;

  /** 1m, 5m, 15m, 60m, 60m… — capped, never unbounded. */
  const delayFor = () =>
    UPDATE_RETRY_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), UPDATE_RETRY_BACKOFF_MS.length - 1)];

  function clearRetry() {
    if (retryTimer) clearTimeoutImpl(retryTimer);
    retryTimer = null;
  }

  /** One silent re-check after a transient failure, instead of a 4h wait. */
  function scheduleRetry() {
    clearRetry();
    const delay = delayFor();
    retryAt = now() + delay;
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      check().catch(() => {});
    }, delay);
    if (retryTimer && retryTimer.unref) retryTimer.unref();
    set({ retryInMs: delay });
  }

  /**
   * Always a detailed result, even against a vendor copy staged before
   * `fetchLatestDetailed` existed (an already-installed older release, whose
   * `./vendor/update.js` predates it) — falling back to the old null-or-version
   * contract rather than throwing on `undefined is not a function`.
   */
  async function fetchDetailed() {
    if (fetchImpl) return fetchImpl({ pkg: PKG });
    if (typeof updater.fetchLatestDetailed === 'function') {
      return updater.fetchLatestDetailed({ pkg: PKG });
    }
    const latest = await updater.fetchLatest({ pkg: PKG });
    return latest
      ? { ok: true, latest, reason: null, status: 200 }
      : { ok: false, latest: null, reason: 'unknown', status: null };
  }

  const isTransient = (reason, status) => {
    if (typeof updater.isTransientReason === 'function') return updater.isTransientReason(reason, status);
    return reason === 'unknown'; // unclassified: assume retryable, stay quiet
  };

  /**
   * `announce: false` (the default) is the background check: a network failure
   * is swallowed and re-tried on the backoff ladder. `announce: true` is a
   * check the user explicitly asked for (the app menu, the banner's Retry
   * button) — they are looking at the answer, so they get it.
   *
   * Coalesced: the interval, the menu, the Retry button and the renderer's
   * initial status poll can all land together, and three registry hits for one
   * question is pointless.
   */
  async function check({ announce = false } = {}) {
    if (!updater) return set({ status: 'disabled', error: 'update checker unavailable' });
    if (inFlight) return inFlight;

    inFlight = (async () => {
      // What we already knew, so a transient failure cannot erase it.
      const priorStatus = state.status;
      const priorVersion = state.version;
      set({ status: 'checking', error: null, reason: null, transient: false });

      let res;
      try {
        res = await fetchDetailed();
      } catch (err) {
        res = { ok: false, latest: null, reason: 'unknown', status: null, error: errorText(err) };
      }

      if (res.ok) {
        attempts = 0;
        retryAt = 0;
        clearRetry();
        if (!updater.isNewer(res.latest, current)) {
          return set({
            status: 'up-to-date', version: res.latest, error: null, reason: null,
            transient: false, attempts: 0, retryInMs: 0,
          });
        }
        return set({
          status: 'available',
          version: res.latest,
          error: null,
          reason: null,
          transient: false,
          attempts: 0,
          retryInMs: 0,
          command: `npm i -g ${PKG}@latest`,
          // npm owns installation here, so there is nothing for this process
          // to download — the banner must offer the command, not a Download
          // button that would silently do nothing.
          canDownload: false,
        });
      }

      attempts += 1;
      const message = res.error || describeRegistryFailure(res.reason, res.status, PKG);

      if (isTransient(res.reason, res.status)) {
        scheduleRetry();
        if (!announce) {
          // Nobody asked. The network was not there yet; that is not news, and
          // an 'available' verdict we already earned must survive it.
          return set({
            status: priorStatus === 'available' ? 'available' : 'unavailable',
            version: priorVersion,
            error: message,
            reason: res.reason,
            transient: true,
            attempts,
          });
        }
        return set({ status: 'error', error: message, reason: res.reason, transient: true, attempts });
      }

      // The registry answered and the answer was no (404, 403, unreadable). That
      // is a real condition, it will not fix itself in a minute, and only the
      // user can act on it — so it is shown either way, named accurately.
      clearRetry();
      retryAt = 0;
      return set({
        status: 'error', error: message, reason: res.reason,
        transient: false, attempts, retryInMs: 0,
      });
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return {
    status: () => state,
    check,
    // npm installs are the user's to run; saying so beats pretending to act.
    download: async () => set({
      status: state.status === 'available' ? 'available' : state.status,
      command: `npm i -g ${PKG}@latest`,
      canDownload: false,
    }),
    quitAndInstall: () => {},
    start: () => {
      check().catch(() => {});
      interval = setInterval(() => check().catch(() => {}), UPDATE_CHECK_INTERVAL_MS);
      if (interval.unref) interval.unref();
    },
    // Timers are the reason this exists: a retry timer outliving the window
    // would keep a dead check alive past app quit.
    stop: () => {
      clearRetry();
      if (interval) clearInterval(interval);
      interval = null;
    },
    retryState: () => ({ attempts, retryAt, inFlight: !!inFlight, hasTimer: !!retryTimer }),
  };
}

function createUpdateManager({ autoUpdater, isPackaged, onStatus }) {
  let state = { status: 'idle', version: null, error: null, canDownload: false };

  function setState(patch) {
    state = { ...state, ...patch };
    if (onStatus) onStatus(state);
  }

  if (!isPackaged || !autoUpdater) {
    // Not a packaged build — which is how this app is INSTALLED FROM NPM, not
    // just how it runs in dev. That case used to resolve a flat 'disabled' and
    // never check anything, so an npm-installed desktop could never learn a
    // new version existed.
    //
    // electron-updater's configured feed is GitHub Releases
    // (electron-builder.yml `publish:`), and there has never been a published
    // release to read — the only one is a draft, invisible to the updater, and
    // the release workflow cannot run while Actions is billing-locked. So the
    // feed the packaged path depends on does not exist, while the registry we
    // actually publish to does.
    //
    // npm is therefore the real update channel. Checking it costs one request
    // a day, reports the version and the exact command, and deliberately does
    // NOT self-install: replacing your own running process mid-session is a
    // different promise from telling you an update exists.
    return createNpmUpdateManager({ onStatus: setState });
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) =>
    setState({ status: 'available', version: info && info.version, error: null, canDownload: true })
  );
  autoUpdater.on('update-not-available', () => setState({ status: 'up-to-date', error: null }));
  autoUpdater.on('download-progress', (progress) =>
    setState({ status: 'downloading', progress: progress && progress.percent })
  );
  autoUpdater.on('update-downloaded', (info) =>
    setState({ status: 'downloaded', version: info && info.version, error: null })
  );
  // Any failure — offline, a malformed feed, a 404 on latest.yml — lands
  // here instead of an unhandled rejection, since electron-updater emits
  // 'error' for background failures that occur outside the promise a
  // check()/download() call is awaiting.
  autoUpdater.on('error', (err) => setState({ status: 'error', error: errorText(err) }));

  async function check() {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      setState({ status: 'error', error: errorText(err) });
    }
    return state;
  }

  async function download() {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      setState({ status: 'error', error: errorText(err) });
    }
    return state;
  }

  function quitAndInstall() {
    autoUpdater.quitAndInstall();
  }

  function start() {
    check();
    const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    // Never keep the process alive solely to poll for updates.
    if (timer.unref) timer.unref();
  }

  return { status: () => state, check, download, quitAndInstall, start };
}

/** Pure mapping: IPC payload -> update-manager call, same shape as
 *  createIpcDispatch — unit-testable with a stub updateManager. */
function createUpdateDispatch(updateManager) {
  return {
    // The renderer only ever calls this from an explicit click (the banner's
    // Retry), so it is announced: a user who asks gets a truthful answer about
    // a failure instead of the silence the background check prefers.
    checkForUpdates: () => updateManager.check({ announce: true }),
    downloadUpdate: () => updateManager.download(),
    quitAndInstallUpdate: () => {
      updateManager.quitAndInstall();
      return { ok: true };
    },
    updateStatus: () => Promise.resolve(updateManager.status()),
  };
}

/** Register update dispatch methods as `aegis:<name>`, same convention as
 *  registerIpc() above. */
function registerUpdateIpc(ipcMain, updateManager) {
  const dispatch = createUpdateDispatch(updateManager);
  for (const [name, handler] of Object.entries(dispatch)) {
    ipcMain.handle(`${IPC_PREFIX}${name}`, (_event, payload) => handler(payload));
  }
  return dispatch;
}

/** Send a no-payload ping to whichever window currently has focus (falling
 *  back to the first open window so a menu click still does something when
 *  triggered via a global accelerator with no window focused, e.g. right
 *  after 'activate' on mac). Used for the two accelerators that have no
 *  built-in Electron role — "new chat" and "search" are renderer state, not
 *  something main.js can act on directly. */
function sendToFocusedWindow(BrowserWindow, channel) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(channel);
}

/**
 * Deliver a resolved deep link to one window over DEEP_LINK_CHANNEL. A cold
 * launch (`aegis://…` handed to the OS while the app wasn't running) reaches
 * this before the renderer script has run `aegis.onDeepLink(...)` — sending
 * immediately would be lost, so a still-loading page gets the payload queued
 * for its first 'did-finish-load' instead of sent right away.
 */
function sendDeepLinkToWindow(win, parsed) {
  if (!win || win.isDestroyed() || !parsed) return;
  const deliver = () => {
    if (!win.isDestroyed()) win.webContents.send(DEEP_LINK_CHANNEL, parsed);
  };
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', deliver);
  } else {
    deliver();
  }
}

/** Application menu: the platform defaults (Edit roles, mac's app/quit
 *  items) plus the native-shell accelerators this plan adds — New Chat
 *  (Cmd/Ctrl+N), Search (Cmd/Ctrl+K, opens the memory/session search
 *  overlay), Reload (Cmd/Ctrl+R) and Toggle DevTools (Cmd/Ctrl+Shift+I) are
 *  plain Electron roles that already carry the right accelerator on every
 *  platform — plus a manual "Check for Updates…" entry, since the automatic
 *  checks in createUpdateManager.start() only run on ready and every few
 *  hours, and an About item (mac gets one for free in the app submenu; other
 *  platforms get a Help menu — role 'about' shows app.setAboutPanelOptions()
 *  cross-platform since Electron 15). */
function buildAppMenu({ app, Menu, BrowserWindow, updateManager }) {
  const isMac = process.platform === 'darwin';

  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
  });

  const checkForUpdatesItem = {
    label: 'Check for Updates…',
    // Announced: a menu click is a user asking, so a failure is reported to
    // them instead of being swallowed the way the background check prefers.
    click: () => updateManager.check({ announce: true }),
  };
  const newChatItem = {
    label: 'New Chat',
    accelerator: 'CmdOrCtrl+N',
    click: () => sendToFocusedWindow(BrowserWindow, MENU_NEW_CHAT_CHANNEL),
  };
  const searchItem = {
    label: 'Search…',
    accelerator: 'CmdOrCtrl+K',
    click: () => sendToFocusedWindow(BrowserWindow, MENU_SEARCH_CHANNEL),
  };
  // Neither item knows the open session id — that's renderer state — so, like
  // newChatItem/searchItem above, the click just pings the renderer, which
  // calls window.aegis.exportSession() with its own currentSessionId. "Save
  // as…" writes the human-readable Markdown form; "Export Session…" writes
  // the raw JSON record (round-trippable, e.g. for re-import).
  const saveAsItem = {
    label: 'Save as…',
    accelerator: 'CmdOrCtrl+S',
    click: () => sendToFocusedWindow(BrowserWindow, MENU_EXPORT_MARKDOWN_CHANNEL),
  };
  const exportSessionItem = {
    label: 'Export Session…',
    click: () => sendToFocusedWindow(BrowserWindow, MENU_EXPORT_JSON_CHANNEL),
  };

  const template = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: 'about' },
              checkForUpdatesItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        newChatItem,
        { type: 'separator' },
        saveAsItem,
        exportSessionItem,
        { type: 'separator' },
        ...(isMac ? [] : [checkForUpdatesItem, { type: 'separator' }]),
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        searchItem,
        { type: 'separator' },
        { role: 'reload', accelerator: 'CmdOrCtrl+R' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' },
      ],
    },
    ...(isMac
      ? []
      : [
          {
            label: 'Help',
            submenu: [{ role: 'about' }],
          },
        ]),
  ];
  return Menu.buildFromTemplate(template);
}

// ---------------------------------------------------------------------------
// Electron-only bootstrap
// ---------------------------------------------------------------------------

function bootstrap() {
  const { app, BrowserWindow, ipcMain, safeStorage, shell, Menu, Notification, screen, dialog, globalShortcut } = electron;

  // A second launch (double-clicking the icon again, `aegis` from a second
  // terminal, …) must focus the existing window, not spawn a second process
  // fighting the first over the same on-disk settings/session/queue files —
  // see the 'second-instance' handler below, registered once the window
  // machinery it calls (createWindow/openWindows) exists later in this
  // function (safe: the event only fires well after bootstrap() returns).
  //
  // A second launch is also how an aegis:// link reaches an already-running
  // app on Windows/Linux: the OS starts a second process with the URL on its
  // argv, requestSingleInstanceLock() hands that argv to 'second-instance' on
  // *this* process below, and the second process exits here.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.setName('AEGIS Desktop');

  // Register the aegis:// scheme so the OS routes those links to this app.
  // Safe to call unconditionally (idempotent) and before 'ready'.
  app.setAsDefaultProtocolClient(deepLink.PROTOCOL);

  // macOS delivers a registered scheme via 'open-url', not argv — must be
  // listened for before 'ready' or an activation during launch is dropped.
  // A cold launch (app not yet running) races this handler against
  // createWindow() below, so the parsed link is stashed and flushed once the
  // first window exists; a warm launch (already running) delivers straight
  // to the focused window, mirroring 'second-instance' below.
  let pendingDeepLink = deepLink.parseDeepLinkArgv(process.argv);
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const parsed = deepLink.parseDeepLinkUrl(url);
    if (!parsed) return;
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) sendDeepLinkToWindow(win, parsed);
    else pendingDeepLink = parsed;
  });

  const aegis = createClient(credentials.clientOptions());
  const dataDir = resolveUserDataDir(app);

  // One settings store backs both the provider settings surface and the AEGIS
  // API key entry. It lives only in the main process and encrypts keys at rest
  // via Electron safeStorage (best-effort base64 when unavailable).
  const { engine, sessionsDir, settingsDir, settings } = createEngine(aegis, {
    app,
    safeStorage,
    dir: dataDir,
  });

  // Persist the in-app AEGIS key in its own reserved namespace, encrypted —
  // never as a provider named 'aegis' (that coupling let the Settings pane's
  // "Remove" delete the AEGIS key; defect #1).
  //
  // Mirrored into the shared 0600 store as well, so one sign-in covers this app,
  // `aegiscode` and the MCP plugin instead of each host needing its own. The
  // app's copy stays the encrypted one; resolveStartupKey() compares their
  // `savedAt` stamps so whichever host wrote last is the key in force.
  const persistApiKey = (key) => {
    const result = settings.setAegisKey(key);
    if (key) credentials.saveApiKey(key);
    else credentials.clearApiKey();
    return result;
  };

  // Native "reply ready" notification: main.js is exactly where every
  // chatCompletion/model:chat call already resolves (withReplyNotify above),
  // so this is the one place that can tell whether the window that asked for
  // it is still the one in front. Fires only when that window is
  // minimized/hidden/unfocused; a foregrounded chat needs no OS-level nudge.
  // Notification.isSupported() gates platforms/sandboxes with no native
  // notification centre so this never throws.
  function notifyReplyIfUnfocused(event) {
    const sender = event && event.sender;
    const win = sender && BrowserWindow.fromWebContents(sender);
    if (!win || win.isDestroyed()) return;
    if (win.isFocused() && win.isVisible()) return;
    if (!Notification || !Notification.isSupported()) return;
    const note = new Notification({ title: 'AEGIS Desktop', body: 'Reply ready' });
    note.on('click', () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    });
    note.show();
  }

  registerIpc(
    ipcMain,
    aegis,
    dataDir,
    persistApiKey,
    (url) => shell.openExternal(url),
    notifyReplyIfUnfocused
  );
  registerModelIpc(
    ipcMain,
    engine,
    sessionsDir,
    aegis,
    notifyReplyIfUnfocused,
    undefined,
    settingsDir
  );

  // Tool-call approval toggle (Settings → "Confirm before running tools"):
  // aegis:getConfirmMode / aegis:setConfirmMode. Registered here because this
  // is where the settings store lands — the exact tool gate it controls lives
  // in the engine created alongside it (lib/local/engine.js gatedExecuteTool
  // reads settings.getConfirmMode() on every mutating tool call).
  registerConfirmModeIpc(ipcMain, createConfirmModeDispatch(settings));

  // Local autonomous work queue: queue:<name> on ipcMain, backed by the durable
  // queue file (desktop/lib/local/queue.js — the SAME file the `aegiscode` CLI
  // and the other hosts read) and the unattended worker
  // (desktop/lib/local/autonomous.js).
  //
  // It gets its OWN engine, built with the approval gate off: a queued task has
  // nobody to answer a card, so the interactive engine is the wrong one to hand
  // a worker (see createQueueEngine). Registration alone drains nothing — the
  // queue runs only when the renderer's card asks it to, which is the whole
  // gate: no timer, no boot drain, no idle drain.
  registerQueueIpc(ipcMain, { engine: createQueueEngine(aegis, settings) });

  // ---------------------------------------------------------------------
  // Global quick-launcher (D? quick launcher): a frameless, always-on-top,
  // taskbar-hidden popup toggled by a systemwide shortcut, for a one-shot
  // question without switching to (or even seeing) the main window.
  // ---------------------------------------------------------------------

  // Set by createWindow() below once the main window exists; read by
  // pushQuickLauncherResult() to know where a "add to chat" push should land.
  // `let` (not `const`) because createWindow() can run more than once
  // (macOS 'activate' with no windows open, a 'second-instance' relaunch).
  let mainWindowRef = null;
  let quickWin = null;

  function getOrCreateQuickLauncherWindow() {
    if (quickWin && !quickWin.isDestroyed()) return quickWin;
    quickWin = new BrowserWindow({
      width: 560,
      height: 320,
      show: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: true,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: '#0d1117',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    quickWin.setMenuBarVisibility(false);
    quickWin.loadFile(path.join(__dirname, 'renderer', 'quick.html'));

    // Escape hides it. Caught at the Electron input-event level (rather than
    // a renderer keydown -> IPC round trip) so there is exactly one place —
    // here — that decides what "hide" means, matching the blur handler right
    // below: plain win.hide(), nothing more. Neither path ever calls
    // mainWindowRef.focus() or otherwise touches the main window, so hiding
    // the launcher — by Escape, by blur, or by pressing the toggle shortcut
    // again — can never steal focus from whatever window had it before the
    // launcher opened.
    quickWin.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !quickWin.isDestroyed()) {
        quickWin.hide();
      }
    });
    // Click-away / Alt-Tab away hides it too — a launcher that stays pinned
    // on screen after the user's attention has moved on is just clutter.
    quickWin.on('blur', () => {
      if (!quickWin.isDestroyed() && quickWin.isVisible()) quickWin.hide();
    });
    quickWin.on('closed', () => {
      quickWin = null;
    });
    return quickWin;
  }

  function toggleQuickLauncher() {
    const win = getOrCreateQuickLauncherWindow();
    if (win.isVisible()) {
      win.hide();
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const displays = screen.getAllDisplays();
    const current = win.getBounds();
    const bounds = quickLauncherLib.computeQuickLauncherBounds({
      cursor,
      displays,
      size: { width: current.width, height: current.height },
    });
    win.setBounds(bounds);
    win.show();
    win.focus();
  }

  /**
   * (Re)register the global shortcut for `{ enabled, shortcut }`, or
   * unregister it when this build/config doesn't want one active (dev run,
   * flag off). `globalShortcut.unregisterAll()` is safe here — this app
   * registers no other global accelerators (the menu's Cmd/Ctrl+N etc. are
   * plain Electron Menu roles, local to the focused window, not
   * globalShortcut). Never throws: a taken accelerator or an invalid
   * accelerator string both degrade to `{ active: false, reason }` with a
   * console.warn, exactly per the "gracefully degrading" requirement — a
   * bad shortcut must never crash the app or block it from starting.
   */
  function applyQuickLauncherConfig(cfg) {
    globalShortcut.unregisterAll();
    if (!quickLauncherLib.shouldEnableGlobalShortcut({ isPackaged: app.isPackaged, enabled: cfg.enabled })) {
      return { active: false, reason: null };
    }
    try {
      const ok = globalShortcut.register(cfg.shortcut, toggleQuickLauncher);
      if (!ok) {
        const reason = `"${cfg.shortcut}" could not be registered — it may already be in use by another application.`;
        console.warn(`[quick-launcher] ${reason}`);
        return { active: false, reason };
      }
      return { active: true, reason: null };
    } catch (err) {
      const reason = errorText(err);
      console.warn(`[quick-launcher] failed to register shortcut "${cfg.shortcut}": ${reason}`);
      return { active: false, reason };
    }
  }

  /**
   * `quick:pushToMain` — the launcher's "add to chat" keystroke. Hides the
   * launcher window that sent the request (never the reverse: the main
   * window is never hidden), delivers the payload to the main window over
   * QUICK_LAUNCHER_PUSH_CHANNEL (whose handler in renderer/app.js owns
   * actually building the chat turn — same "renderer owns the state" split
   * as every other menu-ping channel in this file), then brings the main
   * window forward so the user lands where the new turn appeared.
   */
  function pushQuickLauncherResult(payload, event) {
    const senderWin = event && event.sender && BrowserWindow.fromWebContents(event.sender);
    if (senderWin && !senderWin.isDestroyed()) senderWin.hide();
    const target =
      mainWindowRef && !mainWindowRef.isDestroyed()
        ? mainWindowRef
        : BrowserWindow.getAllWindows().find((w) => w !== senderWin) || null;
    if (!target) return { ok: false, reason: 'no main window is open' };
    target.webContents.send(QUICK_LAUNCHER_PUSH_CHANNEL, payload || {});
    if (target.isMinimized()) target.restore();
    if (!target.isVisible()) target.show();
    target.focus();
    return { ok: true };
  }

  const quickLauncherDispatch = createQuickLauncherDispatch(settings, {
    isPackaged: app.isPackaged,
    applyConfig: applyQuickLauncherConfig,
    pushToMain: pushQuickLauncherResult,
  });
  registerQuickLauncherIpc(ipcMain, quickLauncherDispatch);

  // A held global shortcut outlives this app if not released — every quit
  // path (explicit quit, window-all-closed on non-mac, OS shutdown) must
  // free it.
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    // The update manager's retry/interval timers are unref'd so they never
    // hold the process open, but an explicit quit should still cancel them
    // rather than let one land during teardown.
    if (updateManager && typeof updateManager.stop === 'function') updateManager.stop();
  });

  // electron-updater touches the network and expects a build-time
  // app-update.yml that only exists in a packaged app; requiring it is safe
  // either way, but it's wrapped defensively so a version mismatch or a
  // missing optional native dep degrades to "updates disabled" instead of
  // taking the whole app down.
  let realAutoUpdater = null;
  try {
    realAutoUpdater = require('electron-updater').autoUpdater;
  } catch {
    realAutoUpdater = null;
  }

  const openWindows = new Set();
  function broadcastUpdateStatus(state) {
    for (const win of openWindows) {
      if (!win.isDestroyed()) win.webContents.send(UPDATE_STATUS_CHANNEL, state);
    }
  }

  const updateManager = createUpdateManager({
    autoUpdater: realAutoUpdater,
    isPackaged: app.isPackaged,
    onStatus: broadcastUpdateStatus,
  });
  registerUpdateIpc(ipcMain, updateManager);
  registerExportIpc(
    ipcMain,
    sessionStore,
    sessionsDir,
    (opts) => dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), opts),
    (filePath, content) => fs.promises.writeFile(filePath, content, 'utf8')
  );
  Menu.setApplicationMenu(buildAppMenu({ app, Menu, BrowserWindow, updateManager }));

  // The local file this window is allowed to be at — used both to restore a
  // saved position/reload and to recognise (and block) any navigation away
  // from it. pathToFileURL normalises the platform path separators so the
  // will-navigate comparison below works identically on Windows.
  const appUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;

  function createWindow() {
    const defaultBounds = { width: 1080, height: 720 };
    const saved = windowState.load(dataDir);
    // A saved position from a monitor that's since been unplugged (or a
    // resolution that shrank) must never place the window off every
    // connected display — that's a window that "opens" but nobody can see
    // or reach.
    const bounds = windowState.clampToDisplay(saved, screen.getAllDisplays(), defaultBounds);

    const win = new BrowserWindow({
      ...bounds,
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

    if (saved && saved.isMaximized) win.maximize();

    // Popups (window.open, target=_blank, a model-rendered link that isn't
    // routed through the aegis:openExternal IPC method) never get a second
    // BrowserWindow inside this app: an http/https URL goes to the OS
    // browser, everything else (file://, javascript:, …) is dropped — same
    // allowlist as isSafeExternalUrl above.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    // In-page navigation is likewise locked to this one local file. Without
    // this, a compromised renderer script (or a link that reaches the
    // BrowserWindow's own navigation instead of window.open) could carry the
    // whole app to an arbitrary origin; http/https targets are hard-blocked
    // here too, exactly like the popup case, and handed to the OS browser.
    win.webContents.on('will-navigate', (navEvent, navigationUrl) => {
      if (navigationUrl === appUrl) return;
      navEvent.preventDefault();
      if (isSafeExternalUrl(navigationUrl)) shell.openExternal(navigationUrl);
    });

    // Bounds persistence: debounced on resize/move (dragging fires dozens of
    // events per second — writing a file on every one would be wasteful and
    // would fight the OS for disk I/O mid-drag), and flushed unconditionally
    // on close so the final size/position always lands. getNormalBounds() is
    // used while maximized so un-maximizing next launch restores the pre-
    // maximize rectangle instead of the full-screen one.
    let saveBoundsTimer = null;
    function persistBounds() {
      if (win.isDestroyed()) return;
      const isMaximized = win.isMaximized();
      const rect = isMaximized ? win.getNormalBounds() : win.getBounds();
      windowState.save(dataDir, { ...rect, isMaximized });
    }
    function scheduleBoundsSave() {
      if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
      saveBoundsTimer = setTimeout(persistBounds, 500);
    }
    win.on('resize', scheduleBoundsSave);
    win.on('move', scheduleBoundsSave);
    win.on('close', () => {
      if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
      persistBounds();
    });

    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    openWindows.add(win);
    mainWindowRef = win;
    win.on('closed', () => {
      openWindows.delete(win);
      if (mainWindowRef === win) mainWindowRef = null;
    });
    return win;
  }

  app.whenReady().then(() => {
    // Hydrate the client from the persisted key BEFORE the renderer issues any
    // status/model call, so class/model dropdowns populate immediately when a
    // key was saved in-app (safeStorage is usable only after app ready).
    //
    // `$AEGIS_API_KEY` still outranks both stores: createClient() already read
    // it, and nothing here may shadow an explicit export.
    const envKey = credentials.normalizeApiKey(process.env[credentials.KEY_ENV]);
    if (!envKey) {
      const chosen = credentials.preferNewest(settings.aegisRawKey(), settings.aegisKeySavedAt());
      if (chosen.key) {
        aegis.setApiKey(chosen.key);
        // The shared store is the newer write: bring this host's encrypted copy
        // up to date so a CLI rotation does not have to be redone in Settings.
        if (chosen.source === 'shared') settings.setAegisKey(chosen.key);
      }
    }
    // Apply whatever was last saved (or the default): ship the shortcut only
    // when app.isPackaged || the settings flag is on — see
    // shouldEnableGlobalShortcut — so a plain `electron .` dev run never
    // grabs a systemwide hotkey unless the developer opted in from Settings.
    // Must run after 'ready' — globalShortcut throws before then.
    quickLauncherDispatch.setConfig(settings.quickLauncherConfig());
    const win = createWindow();
    updateManager.start();
    // Cold-launch deep link (Linux/Windows argv, or a pre-ready macOS
    // 'open-url'): the window didn't exist when it was parsed above, so
    // deliver it now that one does.
    if (pendingDeepLink) sendDeepLinkToWindow(win, pendingDeepLink);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Second launch while already running: focus (and restore/show) the
  // existing window instead of leaving the new process to just exit having
  // done nothing visible. `argv` is the second process's argv — on
  // Windows/Linux this is how an aegis:// link reaches an already-running
  // app (see the 'open-url'/macOS comment above); the URL arrives as a bare
  // positional entry (the Linux argv quirk deepLink.extractDeepLinkUrl scans
  // for), not a named flag.
  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    const parsed = deepLink.parseDeepLinkArgv(argv);
    if (!win) {
      const created = createWindow();
      if (parsed) sendDeepLinkToWindow(created, parsed);
      return;
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    if (parsed) sendDeepLinkToWindow(win, parsed);
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
  MENU_NEW_CHAT_CHANNEL,
  MENU_SEARCH_CHANNEL,
  MENU_EXPORT_MARKDOWN_CHANNEL,
  MENU_EXPORT_JSON_CHANNEL,
  DEEP_LINK_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  UPDATE_CHECK_INTERVAL_MS,
  taggedChunk,
  maskKey,
  createModelDispatch,
  readTextFileForPreview,
  PREVIEW_READ_MAX_BYTES,
  createSyncDispatch,
  registerModelIpc,
  createHeartbeatRetry,
  describeSyncError,
  HEARTBEAT_RETRY_BASE_MS,
  HEARTBEAT_RETRY_MAX_MS,
  createEngine,
  resolveUserDataDir,
  importForeignMemory,
  isSafeExternalUrl,
  createUpdateManager,
  createNpmUpdateManager,
  createUpdateDispatch,
  describeRegistryFailure,
  UPDATE_RETRY_BACKOFF_MS,
  registerUpdateIpc,
  buildAppMenu,
  createExportDispatch,
  registerExportIpc,
  safeExportBasename,
  sendDeepLinkToWindow,
  QUICK_PREFIX,
  QUICK_LAUNCHER_PUSH_CHANNEL,
  createQuickLauncherDispatch,
  registerQuickLauncherIpc,
  createConfirmModeDispatch,
  registerConfirmModeIpc,
  QUEUE_PREFIX,
  QUEUE_PROGRESS_CHANNEL,
  QUEUE_MAX_TASK_CHARS,
  QUEUE_MAX_ROUNDS,
  createQueueEngine,
  queueEngineWithDeniedApprovals,
  createQueueDispatch,
  registerQueueIpc,
};
