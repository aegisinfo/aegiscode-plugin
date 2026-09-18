'use strict';

/**
 * AEGIS Desktop renderer — thin UI only.
 *
 * Talks exclusively to the surfaces exposed by preload.js (contextBridge):
 *   - window.aegis.*   cloud status / memory / account (back-compat surface)
 *   - window.models.*  3-class provider layer (Aegis Cloud, Ollama,
 *                      custom OpenAI-/Anthropic-compatible) — the chat path
 *   - window.sync.*    local session persistence + cloud push/pull (P3 §7)
 *
 * No engine/routing logic lives here; the model class is the user's explicit
 * selection, routed in the main process. If this file grows engine logic it is
 * wrong.
 *
 * `budgetFor`/`maxTokensCeiling`/`FLAT_CEILING`/`EFFORT_TOKEN_BUDGET` come from
 * budget.js and `turnAccounting`/`fmtCost` from usage.js, sibling classic
 * scripts loaded before this one (see index.html). There is no
 * max-tokens control on this surface at all: the ceiling is display-only (what a
 * model says its own output limit is, reported in the Model hint) and
 * `budgetFor` answers — from the Effort rung — what a request actually travels
 * with. The token-usage → displayed-number mapping stays unit-testable without
 * window.aegis/models.
 */

// Everything below runs inside an IIFE. preload.js's contextBridge.exposeInMainWorld
// calls define window.aegis/models/sync as non-configurable globals; a
// top-level `const aegis = …` in a classic script binds into that *same*
// global lexical environment, and V8 refuses to shadow a non-configurable
// global property that way ("Identifier 'aegis' has already been declared").
// That SyntaxError kills the whole script before a single line runs — the UI
// is left stuck on "connecting…" with every button unbound. A function scope
// sidesteps the global environment entirely, so the same names are fine here.
(function () {

const aegis = window.aegis;
const models = window.models;
const sync = window.sync;
const quickLauncher = window.quickLauncher;
// The local autonomous work queue (main.js registerQueueIpc -> queue.js +
// autonomous.js). Optional: a preload that predates the queue surface simply
// has no `queue` key, and every function below no-ops on it rather than
// crashing boot the way a chat flow without window.aegis would.
const queueApi = window.queue;

if (!aegis || !models) {
  document.body.textContent =
    'This page must run inside the AEGIS Electron host (window.aegis/window.models missing).';
  throw new Error('window.aegis/window.models unavailable — not running under Electron');
}

// Element handles are resolved lazily instead of eagerly at script parse time.
// If this script is loaded in <head> before the body exists, an eager
// document.getElementById() would capture null for every control and leave the
// whole UI dead (Save/Verify never bound, class/model dropdowns empty). Lazy
// getters re-read the live DOM on each access, so boot order can never cause
// that failure mode.
const ELEMENT_IDS = {
  updateBanner: 'update-banner',
  updateBannerText: 'update-banner-text',
  updateDownloadBtn: 'update-download-btn',
  updateRestartBtn: 'update-restart-btn',
  updateRetryBtn: 'update-retry-btn',
  updateLaterBtn: 'update-later-btn',
  connDot: 'conn-dot',
  connText: 'conn-text',
  app: 'st-app',
  client: 'st-client',
  base: 'st-base',
  key: 'st-key',
  plan: 'st-plan',
  balance: 'st-balance',
  upgradePlan: 'upgrade-plan',
  topupBtn: 'topup-btn',
  topupAmount: 'topup-amount',
  billingHint: 'billing-hint',
  apiKeyInput: 'api-key-input',
  apiKeySave: 'api-key-save',
  apiKeyVerify: 'api-key-verify',
  apiKeyHint: 'api-key-hint',
  classSelect: 'class-select',
  modelSelect: 'model-select',
  modelPreset: 'model-preset',
  modelInput: 'model-input',
  budgetHint: 'budget-hint',
  autonomousToggle: 'autonomous-toggle',
  autonomousToggleWrap: 'autonomous-toggle-wrap',
  autonomousControls: 'autonomous-controls',
  effortSelect: 'effort-select',
  autonomousWorkers: 'autonomous-workers',
  modelHint: 'model-hint',
  settingsList: 'settings-list',
  settingsHint: 'settings-hint',
  quickLauncherEnabled: 'quick-launcher-enabled',
  quickLauncherShortcut: 'quick-launcher-shortcut',
  quickLauncherSave: 'quick-launcher-save',
  quickLauncherHint: 'quick-launcher-hint',
  confirmMode: 'confirm-mode-toggle',
  confirmModeHint: 'confirm-mode-hint',
  autoMode: 'auto-mode-toggle',
  autoModeLabel: 'auto-mode-label',
  autoModeHint: 'auto-mode-hint',
  sessionsRefresh: 'sessions-refresh',
  sessionsExport: 'sessions-export',
  sessionsList: 'sessions-list',
  sessionsHint: 'sessions-hint',
  syncNow: 'sync-now',
  syncStatus: 'sync-status',
  sessionMeter: 'session-meter',
  newChat: 'new-chat',
  memorySearchForm: 'memory-search-form',
  memoryQuery: 'memory-query',
  memoryResults: 'memory-results',
  memoryEntry: 'memory-entry',
  memorySaveBtn: 'memory-save-btn',
  memoryImportBtn: 'memory-import-btn',
  memoryHint: 'memory-hint',
  memoryOpen: 'memory-open',
  memoryOverlay: 'memory-overlay',
  memoryBackdrop: 'memory-backdrop',
  memoryClose: 'memory-close',
  memoryFilters: 'memory-filters',
  memoryOverlayQuery: 'memory-overlay-query',
  memoryFiltersClear: 'memory-filters-clear',
  memoryChips: 'memory-chips',
  memoryList: 'memory-list',
  memoryCount: 'memory-count',
  memoryOverlayEntry: 'memory-overlay-entry',
  memoryOverlaySave: 'memory-overlay-save',
  messages: 'messages',
  composer: 'composer',
  prompt: 'prompt',
  send: 'send',
  exploreToggle: 'explore-toggle',
  queueTask: 'queue-task',
  queueCwd: 'queue-cwd',
  queueCommit: 'queue-commit',
  queueEnqueue: 'queue-enqueue',
  queueDrain: 'queue-drain',
  queueProceed: 'queue-proceed',
  queueStop: 'queue-stop',
  queueList: 'queue-list',
  queueHint: 'queue-hint',
};

const els = {};
for (const [prop, id] of Object.entries(ELEMENT_IDS)) {
  Object.defineProperty(els, prop, {
    get: () => document.getElementById(id),
    enumerable: true,
    configurable: true,
  });
}

const CLASS_KEY = 'aegis.class';
const AUTONOMOUS_KEY = 'aegis.autonomous';
// The budget rung. Applies to every class now that the Max tokens dropdown is
// gone, so it is no longer stored under the autonomous-mode namespace; the old
// key is still read once at boot so an existing install keeps its rung.
const EFFORT_KEY = 'aegis.effort';
const LEGACY_EFFORT_KEY = 'aegis.autonomousEffort';
const AUTONOMOUS_WORKERS_KEY = 'aegis.autonomousWorkers';
const EXPLORE_KEY = 'aegis.explore';
// "Work autonomously" (pool_brain worker fan-out, aegis1 services/pool_brain.py)
// is only billable/routable through the pooled AEGIS Cloud class.
const AUTONOMOUS_CLASS = 'aegis';
const CUSTOM_CLASSES = new Set(['openai-compat', 'anthropic']);
// Placeholders for the typed model-id field: custom endpoints enumerate
// nothing, so the field has to say what a valid id looks like.
const MODEL_ID_PLACEHOLDER = {
  'openai-compat': 'type a model id — e.g. gpt-4o-mini',
  anthropic: 'type a model id — e.g. claude-sonnet-4-5',
};
// Quick-fill presets for the two custom-endpoint classes — model id + the
// base URL it actually lives at, since typing the right model string is only
// half the problem (the wrong base URL 400s just as hard). Base URLs and
// default model ids match aegis1 services/nexus_provider/catalog.py exactly:
// DeepSeek is served via Anthropic-Messages transport, Gemini via
// OpenAI-chat transport — that is why each shows up under the *other*
// custom class from what its own name suggests.
const CUSTOM_MODEL_PRESETS = {
  'openai-compat': [
    { label: 'OpenAI — gpt-4o-mini', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { label: 'OpenAI — gpt-4o', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
    {
      label: 'Gemini — 3.5 Flash',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      model: 'gemini-3.5-flash',
    },
  ],
  anthropic: [
    { label: 'Anthropic — Claude Sonnet 5', baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5' },
    { label: 'Anthropic — Claude Haiku 4.5', baseURL: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5' },
    // DeepSeek's live API serves exactly two ids (verified against
    // GET https://api.deepseek.com/v1/models): `deepseek-flash` — the current
    // generation, which DeepSeek calls "Flash 4.1" — and the slow tier
    // `deepseek-v4-pro`, retired 2026-09-14 and now served as 4.1 too. The
    // preset that used to sit here, `deepseek-v4-flash`, is a *legacy alias*
    // DeepSeek keeps alive only for configs already carrying it, so the picker
    // was advertising a previous generation by its dead id. Ids and labels
    // match aegiscodex-dev src/models.js; the base URL is DeepSeek's
    // Anthropic-Messages transport (aegis1 services/nexus_provider/catalog.py
    // DEEPSEEK_DEFAULT_BASE), which is why these two sit under this class and
    // not the OpenAI-compatible one. Both ids are reasoning models: the token
    // budget for them is the Effort rung, never a stated number (they bill
    // hidden chain-of-thought against the same budget as the answer — see
    // budget.js).
    { label: 'DeepSeek — Flash 4.1', baseURL: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash' },
    { label: 'DeepSeek — V4 Pro (retired → 4.1)', baseURL: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro' },
  ],
};
// The in-app AEGIS key is stored in a reserved namespace the main process
// already filters out of settings.list(); never render it as a provider row
// even if a stale store still surfaces it (defect #1).
const RESERVED_PROVIDERS = new Set(['__aegis', 'aegis']);
// Where a user without a key gets one. The class picker defaults to Aegis Cloud
// and the catalog is key-gated, so this is the first thing a new install needs;
// it lives here rather than inline so the Model hint and any future "connect"
// affordance cannot drift to two different pages.
const GET_AEGIS_KEY_URL = 'https://aegiscloud.org';

let pendingEl = null;
let pendingSessionId = null;
// The active thread's session id + prior turns. Both used to reset only on
// "New Chat" / opening a different session — NOT on every send() — so the
// model actually sees what was said earlier in the same open conversation
// instead of starting from a blank slate on every message (the root cause
// of "the model doesn't remember anything I just said").
let currentSessionId = null;
let threadMessages = [];
let classOptions = [];
let modelMeta = new Map(); // model id -> raw model object from listModels() (P2 §6.3 ceiling)

// ------------------------------------------------------- rolling token meter
//
// Tokens are accounted the way the CLI accounts them: as a RUNNING SESSION
// TOTAL, folded turn by turn, not as a per-turn number that resets at the next
// call. The CLI's `recordTurn` (cli/src/app.js) folds every finished turn into
// one `session` object and prints that total in the status bar and in `ctrl+t`;
// this surface printed each turn's count and nothing else, so the only way to
// answer "what has this session spent" was to add the rows up by eye across the
// scrollback. That is the accounting difference between two surfaces running
// the same engine on the same prompt.
//
// Keyed by sessionId rather than held in one global, because the window holds
// several sessions across its life: switching threads must not carry one
// thread's spend into another's meter, and resuming a thread must not start its
// total at zero. `rollMessages` rebuilds a resumed session's total from the
// ledger rows the shared store already keeps.
const rollsBySession = new Map();

/** The rolling tallies for a session — empty, never undefined, when unseen. */
function rollFor(sessionId) {
  const id = sessionId || '';
  if (!rollsBySession.has(id)) rollsBySession.set(id, emptyRoll());
  return rollsBySession.get(id);
}

/**
 * Fold one finished dispatch into its session's rolling total and refresh the
 * meter. Returns the turn's own accounting so the caller can still print the
 * per-turn figure beside the session total (the CLI shows both: the meta row's
 * `1.5k tok` and the status bar's rolling total).
 */
function foldRoll(sessionId, usage, opts = {}) {
  const id = sessionId || '';
  const next = rollTurn(rollFor(id), usage, opts);
  rollsBySession.set(id, next);
  renderRollMeter(id);
  return next;
}

/**
 * Paint the topbar meter. Hidden while a session has accounted for nothing —
 * an unused thread must not display a `0 tok` it never measured — and shown
 * the moment a turn is folded in.
 *
 * `live`, when given, previews the in-flight turn on top of the session's
 * already-folded total — text estimated the same way `foldRoll` estimates a
 * turn the wire never reported on — WITHOUT folding it: the preview roll
 * returned by `rollTurn` here is thrown away every frame and `rollsBySession`
 * is never written to, so the real `foldRoll` at completion still starts from
 * the untouched persisted total and cannot double-count this turn. (`turns`/
 * `calls` are left at their default +1 rather than forced to 0 — `fmtRoll`
 * treats a roll with both at 0 as "nothing counted yet" and blanks the line,
 * which hid the preview entirely.) Before this, the meter held the previous
 * turn's total frozen for the whole reply and only jumped at the end, which
 * read as "the counter is dead while the AI works".
 */
function renderRollMeter(sessionId, live) {
  const el = els.sessionMeter;
  if (!el) return;
  if (currentSessionId !== sessionId) { el.hidden = true; return; }
  let roll = rollsBySession.get(sessionId || '');
  if (live) {
    roll = rollTurn(roll || emptyRoll(), undefined, {
      prompt: live.prompt,
      reply: live.reply,
      // The thinking trace is billed output too — see `estimatedBuckets`. Left
      // out, this preview measured only the visible answer, so on a reasoning
      // model the meter sat on one number for the whole (longest, priciest)
      // phase of the turn and looked dead while the AI was demonstrably working.
      reasoning: live.reasoning,
    });
  }
  const line = roll ? fmtRoll(roll) : '';
  el.textContent = line;
  el.hidden = !line;
  if (line) el.title = 'This session, counted the way the CLI counts it — every turn rolled into one running total';
}

/**
 * The ledger fields one finished turn must carry into the session store, so
 * the rolling total can be REBUILT when the thread is reopened.
 *
 * Without this the rolling meter was a one-window illusion: the store kept
 * `{role, content}` only, so `rollMessages` found no `tokens` on any row this
 * window had written and a reopened thread came back as a stack of
 * unaccounted turns while the CLI — whose `recordExchange` does write `tokens`
 * and `costUsd` into the very same file — came back with its full total. That
 * asymmetry is the accounting difference, not the rendering of it.
 *
 * One authority writes the row: `ledgerRow` in usage.js, which mirrors the
 * CLI's `appendHistory` shape exactly. A turn the wire did not report on is
 * STILL written — as the CLI writes it, an estimate from the turn's own text
 * marked `real: false` — because that is what keeps the live roll and the
 * rebuilt roll the same number. Only a dispatch with neither reported usage
 * nor any text to estimate from writes nothing: a fabricated
 * `{input: 0, output: 0}` row would read as a measured zero forever after,
 * which is the one lie the token meter was built to avoid.
 */
function ledgerFields(usage, model, turn, text) {
  const row = ledgerRow(usage, turn, {
    model,
    costUsd: turn && turn.real && typeof turn.cost === 'number' ? turn.cost : undefined,
    calls: text && text.calls,
    prompt: text && text.prompt,
    reply: text && text.reply,
    reasoning: text && text.reasoning,
  });
  const fields = row ? Object.assign({}, row) : {};
  if (model) fields.model = model;
  return fields;
}

// ---------------------------------------------------------- discovery lane
//
// The chat flow reads vertically: one prompt, one answer, forever. That makes
// the AI's *alternatives* a cost the user has to pay for manually ("ask again,
// differently"). The discovery lane turns that into a first-class part of the
// flow: after every answer the AI is sent down extra paths in parallel, and
// each path streams into its own card on a horizontal track beside the thread
// — the 2nd path, the new genre, the unexpected discovery, read left→right.
//
// Concurrency is what makes this non-trivial: several `models.chat` calls are
// live at once, so every stream owns a derived sessionId and the preload
// listener only accepts chunks tagged with it (main.js `taggedChunk`). Without
// that tag the replies would interleave into a single bubble.
const FLOW_SYSTEM =
  'You are the exploratory half of a chat assistant. The user is reading the ' +
  'main answer elsewhere, so never restate it. Be concrete and brief: one ' +
  'lead line naming the path, then 3-5 tight bullets. Never pad.';

/** The paths the lane offers. `hint` is the whole instruction for that card. */
const FLOW_PATHS = [
  {
    key: 'alternate',
    badge: 'A',
    title: 'Alternative angle',
    hint:
      'Answer the request from a genuinely different angle: another method, ' +
      'school of thought or genre. Name the angle in one line, then 3-5 ' +
      'bullets of how it actually plays out. Do not restate the main answer.',
  },
  {
    key: 'discovery',
    badge: 'B',
    title: 'Unexpected discovery',
    hint:
      'Act as a scout, not an assistant. Surface ONE non-obvious connection, ' +
      'adjacent field or surprise finding the user did not ask for but which ' +
      'reframes the request. One line naming the discovery, then 2-4 bullets ' +
      'on why it matters and how to test it. Flag uncertainty honestly.',
  },
  {
    key: 'genre',
    badge: 'C',
    title: 'New genre',
    hint:
      'Recast the request in an unfamiliar genre or discipline — pick one that ' +
      'fits oddly well (e.g. field biology, contract law, ecology, jazz, ' +
      'logistics, restoration). Name the genre in one line, then 3-5 bullets ' +
      'of what that discipline would do first.',
  },
];

let flowCount = 0;
const activeBranches = new Set();

/** Every in-flight path for the current thread, so New chat can stop them. */
function abortBranches() {
  for (const id of activeBranches) {
    try {
      models.cancel(id);
    } catch {
      /* a dead controller is not an error */
    }
  }
  activeBranches.clear();
}

// ----------------------------------------------------------------- streaming
// Two problems share a root: a running turn owns the transcript. It scrolls
// the view on every chunk and repaints on every chunk, so the user can neither
// read earlier turns nor stay responsive enough to hit "stop". Both are fixed
// by giving the reader a veto over the scroll and batching the paints.
//
// The decisions *and* their DOM listeners live in transcript-view.js (a
// sibling classic script loaded before this one), so the behaviours this path
// exists to guarantee — follow only at the tail, one paint per frame, Escape
// interrupts — are asserted against real code in test/renderer-dom.test.mjs
// instead of only as pure math in stream-policy.js.

/**
 * Set when the user asks the running turn to stop. The abort comes back as a
 * rejected IPC call, which does not preserve `err.name`, so this flag — not an
 * AbortError check — is what distinguishes a stop the user asked for from a
 * genuine failure.
 */
let userStopped = false;

/**
 * Transcript policy, created by init(): the reader's scroll veto, the
 * frame-coalesced painter, and the Escape→stop listener all live in it. Built
 * in init() rather than here because #messages does not exist until the body
 * has parsed.
 */
let transcript = null;

/**
 * Auto-scroll only while the reader is still at the tail — the rule itself is
 * `shouldFollow` in transcript-view.js. Null-safe: a boot that failed early
 * must not turn into a second error on the first paint.
 */
function stickToBottom(opts) {
  if (!transcript) return false;
  return transcript.follow(opts);
}

/** One paint per frame, off the latest cumulative text — see transcript-view.js. */
function rafPainter(paint) {
  // Every caller runs after boot; painting directly is the safe degradation.
  return transcript ? transcript.paint(paint) : paint;
}

/**
 * Stop the turn running right now. The transport already honours the abort all
 * the way down (engine.cancel -> AbortController -> the cloud client's fetch),
 * so this only has to reach it — the button in the bubble and Escape are two
 * doors onto the same call.
 */
function stopPendingTurn() {
  if (!pendingSessionId) return false;
  // Recorded before the abort lands: `send()`'s catch reads it to tell a
  // deliberate stop from a real error.
  userStopped = true;
  try {
    models.cancel(pendingSessionId);
  } catch {
    /* a dead controller is not an error */
  }
  // The abort is not instantaneous. Marking the button is all the feedback that
  // survives the trip: `setBusy(false)` deletes the entire pending bubble on
  // the way out, so anything written into it would vanish a moment later.
  if (pendingEl) {
    const btn = pendingEl.querySelector('.cancel-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'stopping…';
    }
  }
  return true;
}

function exploreEnabled() {
  const box = els.exploreToggle;
  return Boolean(box && box.checked);
}

function autonomousEnabled() {
  const box = els.autonomousToggle;
  return Boolean(box && box.checked);
}

/** Effort/workers only matter (and only show) once autonomous mode is on for
 * the pooled class — same gating as the toggle itself, plus its checked state. */
function updateAutonomousControlsVisibility() {
  if (!els.autonomousControls) return;
  const wrapVisible = els.autonomousToggleWrap && !els.autonomousToggleWrap.hidden;
  els.autonomousControls.hidden = !(wrapVisible && autonomousEnabled());
}

// Which models get their budget from the Effort rung — because they reason
// against their own output limit (DeepSeek counts hidden chain-of-thought
// against the same budget as the answer) or because their wire format requires
// the field at all (Anthropic's Messages API) — is answered in ONE place:
// desktop/renderer/budget.js, loaded before this file, whose
// DEEPSEEK_REASONING_MODEL_RE / REQUIRES_STATED_BUDGET / EFFORT_TOKEN_BUDGET
// globals are read below. test/budget.test.mjs asserts that copy and
// desktop/lib/local/engine.js answer identically, so neither can drift.

/**
 * The model id the budget control has to reason about right now: the typed id
 * for a custom endpoint, the picker's value everywhere else.
 */
function currentBudgetModel() {
  return CUSTOM_CLASSES.has(els.classSelect.value)
    ? els.modelInput.value.trim()
    : els.modelSelect.value;
}

/**
 * The one-line statement of what the current selection means in tokens.
 *
 * Written on every class/model change so the rung is never an invisible
 * decision: "Effort: high" says nothing about the budget it buys, and the whole
 * reason the Max tokens dropdown was removed is that the number it showed was
 * never the number the call ran on. The ladder printed here is the one the
 * request will actually be sized by — the engine's effort rung for a local
 * reasoning model or an Anthropic call, the server's own fan-out ladder for the
 * pooled class — and for the two classes that send no number at all the note
 * says so rather than implying a cap nobody set.
 */
function budgetNote(cls, model) {
  const chosen = effortFor();
  const rung = chosen || 'high';
  const rungText = chosen || 'auto → high';
  if (cls === AUTONOMOUS_CLASS) {
    // aegis1 services/pool_brain.py pass_budgets — the total across the worker
    // fan-out + synthesis pass, which is why it is not the local table.
    const totals = { low: 16384, medium: 32768, high: 65536 };
    return `budget: ${totals[rung].toLocaleString()} tokens from effort (${rungText}), ` +
      'summed across the worker fan-out by the Aegis Cloud pool — no max_tokens is sent.';
  }
  if (DEEPSEEK_REASONING_MODEL_RE.test(String(model || '')) || REQUIRES_STATED_BUDGET.has(cls)) {
    const tokens = EFFORT_TOKEN_BUDGET[rung];
    return `budget: ${tokens.toLocaleString()} tokens from effort (${rungText}) — ` +
      'this model reasons against its own output budget, and the length of the answer ' +
      'is not predictable from the prompt.';
  }
  return `no token cap is sent (effort: ${rungText}) — output length cannot be predicted ` +
    'from the prompt, so this app states no max_tokens and the provider\'s own limit applies.';
}

/**
 * Refresh the budget surface for the selected class + model. There is no
 * control to swap any more (the Max tokens dropdown is gone), so this only
 * restates what the rung buys — but it still has to run on every class and
 * model change, because that note is the only place the number appears.
 */
function updateBudgetControls(cls, model) {
  const resolved = model === undefined ? currentBudgetModel() : model;
  if (els.budgetHint) els.budgetHint.textContent = budgetNote(cls, resolved);
}

/**
 * The effort to send, or undefined for "no rung pinned".
 *
 * Sent for EVERY class and model, not just the pooled one: with no max-tokens
 * control there is nothing else that sizes a call, and `auto` means "no rung
 * pinned" — the engine's high default — rather than the old silent
 * fall-through to the top rung.
 */
function effortFor() {
  const value = els.effortSelect && els.effortSelect.value;
  return value && value !== 'auto' ? value : undefined;
}

// ---------------------------------------------------------------- UI helpers

function setConn(ok, text) {
  els.connDot.classList.toggle('ok', Boolean(ok));
  els.connText.textContent = text;
}

/** Last known key state from aegis.status() — null until status is read, so
 *  the top-up action can say "add a key first" instead of spending a round
 *  trip on a guaranteed 401 (aegis1 login_required). */
let keyConfigured = null;

function renderStatus(s) {
  if (!s) {
    keyConfigured = null;
    setConn(false, 'IPC unavailable');
    return;
  }
  keyConfigured = Boolean(s.keyConfigured);
  els.app.textContent = s.appVersion ? `v${s.appVersion}` : '–';
  els.client.textContent = s.clientVersion || '–';
  els.base.textContent = s.apiBase || '–';
  els.key.textContent = s.keyConfigured ? s.keyMask : 'not set';
  setConn(s.keyConfigured, s.keyConfigured ? 'key configured' : 'no API key');
}

// -------------------------------------------------------------- auto-update
//
// Mirrors the state machine in desktop/main.js createUpdateManager: 'idle' /
// 'disabled' (dev build) / 'checking' / 'up-to-date' render nothing, since
// none of them need the user's attention. `updateDismissedFor` remembers the
// status the user last clicked "Later" on, so the banner stays gone for that
// status (an hourly re-check finding the SAME pending update shouldn't keep
// resurrecting a banner the user already dismissed) while still reappearing
// the moment the status actually advances (e.g. available -> downloaded).
let lastUpdateState = null;
let updateDismissedFor = null;

function renderUpdateBanner(state) {
  if (!els.updateBanner) return;
  lastUpdateState = state;
  const status = state && state.status;
  // 'unavailable' is the npm channel's silent verdict after a background check
  // that failed for a transient reason (no network yet at login, a VPN coming
  // up). It is deliberately not shown: nobody asked, and the app re-checks on
  // its own backoff. An explicit check never resolves this status — the main
  // process reports 'error' when a user asked.
  const silent = !status || status === 'idle' || status === 'disabled' ||
    status === 'checking' || status === 'up-to-date' || status === 'unavailable';
  if (silent || status === updateDismissedFor) {
    els.updateBanner.hidden = true;
    return;
  }

  let text = '';
  let showDownload = false;
  let showRestart = false;
  let showRetry = false;
  const version = state.version ? `v${state.version} ` : '';
  if (status === 'available') {
    // The npm channel cannot install itself, so its banner names the command
    // instead of offering a Download button that would do nothing.
    text = state.command
      ? `Update ${version}available — run: ${state.command}`
      : `Update ${version}available.`;
    showDownload = !!state.canDownload;
  } else if (status === 'downloading') {
    const pct = typeof state.progress === 'number' ? ` (${Math.round(state.progress)}%)` : '';
    text = `Downloading update${pct}…`;
  } else if (status === 'downloaded') {
    text = `Update ${version}downloaded — restart to install.`;
    showRestart = true;
  } else if (status === 'error') {
    // The reason comes from the main process and names what actually happened
    // (a timeout, a 404, an unreadable response) rather than blaming the
    // registry for every failure.
    text = `Update check failed: ${state.error || 'unknown error'}`;
    if (state.transient) text += ' — will retry automatically.';
    showRetry = true;
  } else {
    els.updateBanner.hidden = true;
    return;
  }

  els.updateBannerText.textContent = text;
  els.updateDownloadBtn.hidden = !showDownload;
  els.updateRestartBtn.hidden = !showRestart;
  // `?`-guarded: the markup is optional and an older index.html must not crash
  // the banner on a status it has no button for.
  if (els.updateRetryBtn) els.updateRetryBtn.hidden = !showRetry;
  els.updateBanner.hidden = false;
}

async function loadAccountInfo() {
  try {
    const verify = await aegis.verifyApiKey();
    els.plan.textContent = verify && verify.valid
      ? (verify.plan || 'active')
      : 'invalid key';
  } catch {
    els.plan.textContent = 'unavailable';
  }

  try {
    const bank = await aegis.tokenBankBalance();
    els.balance.textContent = bank && bank.balance_eur != null
      ? `€${bank.balance_eur}`
      : '–';
  } catch {
    els.balance.textContent = 'unavailable';
  }
}

// ---------------------------------------------------------------- billing
//
// The two write actions the Status card needs: "Upgrade plan" (aegis1 POST
// /api/billing/checkout — the subscription whose Stripe price is
// STRIPE_MEMORY_PRICE_ID) and "Top up" (POST /api/token-bank/topup with
// `amount_eur`). Both are created SERVER-side and answer `{ url }` to a
// Stripe-hosted page; that URL is handed to the OS browser through the same
// aegis.openExternal IPC the free-plan cap notices use, so a payment page
// never loads in this window and no card data comes near the renderer.
//
// The main process has already classified the failure (main.js billingResult:
// status + reason + upgrade) because `ipcRenderer.invoke` would strip those
// fields off a thrown error. Everything the user can act on is therefore said
// in the hint line: no API key, the free-plan 402, Stripe unconfigured on the
// server, and any other transport/HTTP failure with the server's own message.

/** Render a `{ ok:false, status, reason, setupRequired, upgrade }` result
 *  (main.js billingResult) into the Status card's hint line. */
function renderBillingError(res, kind) {
  const what = kind === 'topup' ? 'top-up' : 'upgrade';
  if (res.status === 401 || res.status === 403) {
    els.billingHint.textContent =
      `add your AEGIS API key above — a ${what} needs an account`;
    return;
  }
  if (res.upgrade) {
    // The 402 free-plan path, same shape as capNotice()/renderMemoryResults():
    // the subscribe link has to be a real child node — a text assignment would
    // wipe it, and an href left in text is not clickable.
    els.billingHint.textContent = `free plan cap reached — ${what} lifts it. `;
    const a = document.createElement('a');
    a.href = res.upgrade.url || 'https://aegiscloud.org/subscribe';
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = 'See plans →';
    els.billingHint.appendChild(a);
    return;
  }
  if (res.setupRequired) {
    els.billingHint.textContent =
      'checkout is not configured on the server yet (no Stripe price id)';
    return;
  }
  els.billingHint.textContent =
    `${what} failed: ${res.reason || 'the server returned no checkout URL'}`;
}

async function startBilling(kind) {
  const amount = Math.round(Number(els.topupAmount && els.topupAmount.value) || 10);
  const btn = kind === 'topup' ? els.topupBtn : els.upgradePlan;
  if (btn) btn.disabled = true;
  // The bank belongs to the account, so a keyless client cannot top up: say so
  // rather than spending a round trip on a guaranteed 401. (The subscription
  // checkout is public in aegis1 and works without a key.) `keyConfigured` is
  // null until status has been read — then we ask and let the server answer.
  if (kind === 'topup' && keyConfigured === false) {
    if (btn) btn.disabled = false;
    els.billingHint.textContent =
      'add your AEGIS API key above — a top-up is credited to your account';
    return;
  }
  els.billingHint.textContent =
    kind === 'topup' ? `creating a €${amount} top-up…` : 'creating checkout…';
  try {
    const res = kind === 'topup'
      ? await aegis.tokenBankTopup(amount)
      : await aegis.billingCheckout();
    if (!res || res.ok !== true || !res.url) {
      renderBillingError(res || {}, kind);
      return;
    }
    // The URL is live: say what is happening before the browser takes focus.
    els.billingHint.textContent = 'opening checkout…';
    const opened = await aegis.openExternal(res.url);
    if (opened && opened.ok === false) {
      els.billingHint.textContent =
        `could not open the checkout page: ${opened.reason || 'unknown reason'}`;
      return;
    }
    els.billingHint.textContent = kind === 'topup'
      ? `checkout opened in your browser — the bank is credited when Stripe confirms`
      : 'checkout opened in your browser — your plan updates when Stripe confirms';
  } catch (err) {
    els.billingHint.textContent =
      `billing failed: ${err && err.message ? err.message : err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Refresh every key-dependent surface after the in-app key changes. The main
// process already replaced the live client key; this re-reads status (masked
// preview) and repopulates class/model dropdowns + account plan/balance.
async function refreshAfterKeyChange() {
  try {
    renderStatus(await aegis.status());
  } catch {
    renderStatus(null);
  }
  // loadClasses() also re-runs loadModels() for the currently selected class.
  await loadClasses();
  await loadAccountInfo();
}

async function saveApiKey() {
  const key = els.apiKeyInput.value.trim();
  els.apiKeySave.disabled = true;
  els.apiKeyVerify.disabled = true;
  els.apiKeyHint.textContent = 'saving…';
  try {
    const res = await aegis.setApiKey(key);
    // Never retain the raw key in the DOM once saved — show only the masked
    // preview the main process returned.
    els.apiKeyInput.value = '';
    els.apiKeyHint.textContent = key
      ? `saved (${res && res.keyMask ? res.keyMask : 'configured'})`
      : 'key cleared';
    await refreshAfterKeyChange();
  } catch (err) {
    els.apiKeyHint.textContent =
      `save failed: ${err && err.message ? err.message : err}`;
  } finally {
    els.apiKeySave.disabled = false;
    els.apiKeyVerify.disabled = false;
  }
}

async function verifyAegisKey() {
  els.apiKeyVerify.disabled = true;
  els.apiKeyHint.textContent = 'verifying…';
  try {
    const verify = await aegis.verifyApiKey();
    els.apiKeyHint.textContent = verify && verify.valid
      ? `valid (${verify.plan || 'active'})`
      : 'invalid key';
  } catch (err) {
    els.apiKeyHint.textContent =
      `verify failed: ${err && err.message ? err.message : err}`;
  } finally {
    els.apiKeyVerify.disabled = false;
  }
}

// --------------------------------------------------------- quick launcher

/** Render a `{ enabled, shortcut, packaged, active, reason }` status (see
 *  main.js createQuickLauncherDispatch) into the settings card. */
function renderQuickLauncherStatus(status) {
  if (!status) return;
  els.quickLauncherEnabled.checked = Boolean(status.enabled);
  els.quickLauncherShortcut.value = status.shortcut || '';
  els.quickLauncherShortcut.placeholder = status.shortcut || 'CmdOrCtrl+Shift+Space';
  const bits = [];
  if (status.packaged) bits.push('always on in this packaged build');
  bits.push(status.active ? `active — press ${status.shortcut} anywhere` : 'inactive');
  if (status.reason) bits.push(status.reason);
  els.quickLauncherHint.textContent = bits.join(' · ');
}

async function loadQuickLauncherSettings() {
  if (!quickLauncher) return;
  try {
    renderQuickLauncherStatus(await quickLauncher.status());
  } catch (err) {
    els.quickLauncherHint.textContent =
      `status failed: ${err && err.message ? err.message : err}`;
  }
}

async function saveQuickLauncherSettings() {
  if (!quickLauncher) return;
  els.quickLauncherSave.disabled = true;
  els.quickLauncherHint.textContent = 'saving…';
  try {
    renderQuickLauncherStatus(
      await quickLauncher.setConfig({
        enabled: els.quickLauncherEnabled.checked,
        shortcut: els.quickLauncherShortcut.value.trim(),
      })
    );
  } catch (err) {
    els.quickLauncherHint.textContent =
      `save failed: ${err && err.message ? err.message : err}`;
  } finally {
    els.quickLauncherSave.disabled = false;
  }
}

// ------------------------------------------------------ tool approvals
//
// "Confirm before running tools" — the user-facing ON/OFF switch for the
// engine's tool-call approval gate (desktop/lib/local/engine.js
// gatedExecuteTool; persisted by same-named IPC methods on
// createConfirmModeDispatch). ON (the default, and the behaviour every
// existing install has) previews exec/writeFile/editFile and asks before they
// run; OFF runs them straight through, exactly like a tool already allowed for
// the session — no approval card at all. The engine reads the flag per tool
// call, so a flip here applies to the next call in flight, no restart.

/** Paint a `{ enabled }` payload (from aegis.getConfirmMode/setConfirmMode)
 *  into the card, and say plainly what the current state means. */
function renderConfirmMode(status) {
  if (!els.confirmMode || !status) return;
  const enabled = status.enabled !== false;
  els.confirmMode.checked = enabled;
  els.confirmModeHint.textContent = enabled
    ? 'On — exec, writeFile and editFile ask for your approval before they run.'
    : 'Off — the agent runs exec, writeFile and editFile without asking.';
  renderAutoModeChip(enabled);
}

/**
 * Paint the composer's mode strip from the *same* boolean as the Settings
 * switch. "Auto mode" is simply the absence of confirmation, so the chip is
 * the inverse of `confirmMode`; deriving it here — instead of letting the chip
 * keep its own copy — is what stops one click from leaving the two controls
 * disagreeing about what the app is about to do.
 *
 * The caption always names both the current state and the setting that owns
 * it, because "how do I change this?" is the only reason the strip exists.
 *
 * Deliberately does not touch `disabled`: `saveConfirmMode` raises that around
 * the await and must be the one to lower it, or a repaint mid-save would leave
 * the chip permanently unclickable.
 */
function renderAutoModeChip(confirming) {
  if (!els.autoMode) return;
  const auto = !confirming;
  els.autoMode.setAttribute('aria-pressed', auto ? 'true' : 'false');
  els.autoMode.classList.toggle('is-auto', auto);
  if (els.autoModeLabel) {
    els.autoModeLabel.textContent = auto ? 'auto mode' : 'ask before tools';
  }
  if (els.autoModeHint) {
    els.autoModeHint.textContent = auto
      ? 'on — tools run without asking. Click to require approval.'
      : 'off — click for auto mode, or use Settings → Tool approvals.';
  }
}

/** Read the persisted value. Called on boot (the Settings pane is a single
 *  always-visible column, so that is "when Settings opens") and again on every
 *  change via saveConfirmMode below. */
async function loadConfirmMode() {
  if (!els.confirmMode || !aegis.getConfirmMode) return;
  try {
    renderConfirmMode(await aegis.getConfirmMode());
  } catch (err) {
    els.confirmModeHint.textContent =
      `status failed: ${err && err.message ? err.message : err}`;
  }
}

/** Persist a flip of the switch. The card is only repainted from what the
 *  main process actually stored, so a failed write leaves the switch showing
 *  the truth rather than the click. */
async function saveConfirmMode(enabled) {
  if (!els.confirmMode) return;
  els.confirmMode.disabled = true;
  if (els.autoMode) els.autoMode.disabled = true;
  try {
    renderConfirmMode(await aegis.setConfirmMode(enabled));
  } catch (err) {
    els.confirmMode.checked = !enabled;
    els.confirmModeHint.textContent =
      `save failed: ${err && err.message ? err.message : err}`;
    // Repaint the strip from the value that survived, so a failed write does
    // not leave the chip advertising a mode the app never entered.
    renderAutoModeChip(els.confirmMode.checked);
  } finally {
    els.confirmMode.disabled = false;
    if (els.autoMode) els.autoMode.disabled = false;
  }
}

// ------------------------------------------------------ autonomous queue
//
// The desktop half of the local work queue (window.queue -> main.js
// registerQueueIpc -> desktop/lib/local/queue.js + autonomous.js). The card is
// the ONLY trigger: `Run one` and `Drain all` are what call queue.drain() and
// queue.proceed(), and nothing in this file starts a drain by itself — no
// interval, no drain at boot, no drain when the window goes idle. A drain runs a
// whole tool loop on a real model inside the folder in the cwd field, so it
// happens when the user asks and not otherwise.
//
// What the card shows is STATE, not conversation. The worker's frames arrive on
// `queue:progress` (its own channel — see main.js QUEUE_PROGRESS_CHANNEL, and
// why a drain must never ride the chat delta channel) and are collapsed into one
// status line; each task's outcome (done/failed + error) is read back from the
// queue file through queue.list(). A worker's output is never appended to the
// open thread.

/** The last thing the card said; composed with the queue's own counts on every
 *  repaint, so a one-off message ("not a directory: …") is not lost the moment a
 *  state refresh overwrites the line. */
let queueNote = '';
/** Whether THIS window's drain is running, from main's own snapshot — never a
 *  local guess, so a drain that ended (or was locked out) unlatches the buttons. */
let queueDraining = false;

function setQueueNote(text) {
  queueNote = text || '';
  if (els.queueHint) els.queueHint.textContent = queueNote;
}

/** `#3 ✓ task …` — the outcome mark leads, so a failed task is findable. */
function queueStatusMark(status) {
  if (status === 'done') return '✓';
  if (status === 'error') return '✗';
  if (status === 'running') return '…';
  return '·';
}

/** The outcome line under a task: what happened, or why it did not. */
function queueMetaText(item) {
  const bits = [item.status];
  // Which model and which shape, per row. Both are spend facts the card used
  // to hide: an unpinned task runs main.js's defaultModel (a pooled tier), and
  // a task is a single pass unless it was queued with `fanout` — the difference
  // is roughly (workers + 1) full reasoning calls.
  if (item.model) bits.push(item.model);
  bits.push(item.singlePass === false || item.autonomous === true ? 'fan-out' : 'single pass');
  if (item.status === 'error') {
    bits.push(item.error ? String(item.error) : 'failed — no reason recorded');
  } else if (item.status === 'done') {
    const out = item.result && item.result.output ? String(item.result.output) : '';
    const flat = out.replace(/\s+/g, ' ').trim();
    if (flat) bits.push(flat.length > 140 ? `${flat.slice(0, 139)}…` : flat);
    const files = item.result && Array.isArray(item.result.files) ? item.result.files : [];
    if (files.length) bits.push(`touched ${files.length} file${files.length === 1 ? '' : 's'}`);
  } else if (item.status === 'running') {
    bits.push(item.startedAt ? `started ${relTime(item.startedAt)}` : 'working');
  } else {
    if (item.attempts) bits.push(`${item.attempts} attempt${item.attempts === 1 ? '' : 's'}`);
    if (item.created) bits.push(relTime(item.created));
  }
  return bits.join(' · ');
}

/** One row per task: id, outcome mark, task text, outcome line, and only the
 *  actions that mean something for that status (a running task belongs to the
 *  worker — main.js refuses to remove it). */
function queueRow(item) {
  const li = document.createElement('li');
  li.className = 'session-row';
  li.dataset.status = item.status;

  const title = document.createElement('span');
  title.className = 'session-title';
  const text = String(item.task || '').replace(/\s+/g, ' ').trim();
  title.textContent = `#${item.id} ${queueStatusMark(item.status)} ${text.length > 90 ? `${text.slice(0, 89)}…` : text}`;
  li.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'session-meta';
  meta.textContent = queueMetaText(item);
  li.appendChild(meta);

  if (item.status === 'done' || item.status === 'error') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ghost-btn';
    retry.textContent = 'Retry';
    retry.title = 'Put this task back in line and run it again';
    retry.addEventListener('click', () => queueTaskAction('retry', item.id));
    li.appendChild(retry);
  }
  if (item.status !== 'running') {
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'ghost-btn';
    drop.textContent = 'Remove';
    drop.addEventListener('click', () => queueTaskAction('remove', item.id));
    li.appendChild(drop);
  }
  return li;
}

/** Paint a queue.list()/drain()/proceed() answer: the list, what is running and
 *  how many are pending, and the running/stopping state of this window. */
function renderQueueState(state) {
  if (!els.queueList || !state || typeof state !== 'object') return;
  queueDraining = Boolean(state.draining);

  // The cwd field is a convenience, never an override: it is prefilled from the
  // main process's working directory only while the user has not typed one.
  if (els.queueCwd && !els.queueCwd.value) els.queueCwd.value = state.defaultCwd || '';

  if (els.queueEnqueue) els.queueEnqueue.disabled = queueDraining;
  if (els.queueDrain) els.queueDrain.disabled = queueDraining;
  if (els.queueProceed) els.queueProceed.disabled = queueDraining;
  if (els.queueStop) els.queueStop.hidden = !queueDraining;

  const items = Array.isArray(state.items) ? state.items : [];
  els.queueList.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'queue is empty';
    els.queueList.appendChild(li);
  } else {
    for (const item of items) els.queueList.appendChild(queueRow(item));
  }

  const bits = [];
  if (state.running) bits.push(`running #${state.running.id}`);
  else if (queueDraining) bits.push('draining…');
  bits.push(`${state.pending || 0} pending`);
  // What the queue can spend on at all: Aegis Cloud, and which tier an
  // unpinned task lands on (main.js snapshot().defaultModel resolves it the
  // same way the worker does, so the card cannot disagree with the bill).
  if (state.defaultModel) bits.push(`Aegis Cloud · ${state.defaultModel}`);
  if (queueDraining && state.stopping) bits.push('stopping after this task');
  if (els.queueHint) {
    els.queueHint.textContent = [queueNote, bits.join(' · ')].filter(Boolean).join(' · ');
  }
}

/** Read the queue (a list, never a drain) — the card's paint on boot and after
 *  every action. */
async function loadQueueState() {
  if (!queueApi || !els.queueList) return null;
  try {
    const state = await queueApi.list();
    renderQueueState(state);
    return state;
  } catch (err) {
    setQueueNote(`queue list failed: ${err && err.message ? err.message : err}`);
    return null;
  }
}

/** Queue the textarea's contents against the cwd field's directory. `commit` is
 *  stored on the TASK, so it applies to that task alone however it is later run. */
async function enqueueQueueTask() {
  if (!queueApi || !els.queueTask) return;
  const task = els.queueTask.value.trim();
  if (!task) {
    setQueueNote('type a task first');
    return;
  }
  if (els.queueEnqueue) els.queueEnqueue.disabled = true;
  setQueueNote('queueing…');
  try {
    const res = await queueApi.enqueue({
      task,
      cwd: els.queueCwd ? els.queueCwd.value.trim() : '',
      commit: els.queueCommit ? els.queueCommit.checked : false,
    });
    if (res && res.ok) {
      els.queueTask.value = '';
      setQueueNote(`queued #${res.item.id}`);
    } else {
      setQueueNote((res && res.reason) || 'enqueue failed');
    }
    renderQueueState(res);
  } catch (err) {
    setQueueNote(`enqueue failed: ${err && err.message ? err.message : err}`);
  } finally {
    if (els.queueEnqueue) els.queueEnqueue.disabled = queueDraining;
  }
}

/** One line for what a drain did: how many ran, how many failed (by id), or the
 *  reason it could not run at all (a lock held by another process, no work). */
function queueDrainNote(res) {
  if (!res || typeof res !== 'object') return 'the drain did not answer';
  if (res.locked) {
    const pid = res.holder && res.holder.pid;
    return `another drain is already running${pid ? ` (pid ${pid})` : ''}`;
  }
  if (res.ok === false) return res.reason || 'the drain did not run';
  const ran = Array.isArray(res.ran) ? res.ran : [];
  if (!ran.length) return res.stopped ? 'stopped before the next task' : 'nothing pending';
  const failed = ran.filter((r) => !r.ok);
  const bits = [`ran ${ran.length} — ${ran.length - failed.length} done`];
  if (failed.length) bits.push(`failed #${failed.map((r) => r.id).join(', #')}`);
  if (res.stopped) bits.push('stopped');
  return bits.join(' · ');
}

/** Start a drain. `one` works a single task (the card's "Run one"), `all` keeps
 *  going until the queue is empty or Stop is pressed. Both are the user's click
 *  and nothing else — this is the only place either IPC method is called. */
async function startQueueDrain(mode) {
  if (!queueApi) return;
  queueDraining = true;
  setQueueNote(mode === 'one' ? 'running one task…' : 'draining the queue…');
  if (els.queueDrain) els.queueDrain.disabled = true;
  if (els.queueProceed) els.queueProceed.disabled = true;
  if (els.queueEnqueue) els.queueEnqueue.disabled = true;
  if (els.queueStop) els.queueStop.hidden = false;
  try {
    const res = await (mode === 'one' ? queueApi.drain() : queueApi.proceed());
    setQueueNote(queueDrainNote(res));
    renderQueueState(res);
  } catch (err) {
    // A rejected invoke means main never answered: unlatch the buttons here,
    // since there is no snapshot coming to do it.
    queueDraining = false;
    if (els.queueDrain) els.queueDrain.disabled = false;
    if (els.queueProceed) els.queueProceed.disabled = false;
    if (els.queueEnqueue) els.queueEnqueue.disabled = false;
    if (els.queueStop) els.queueStop.hidden = true;
    setQueueNote(`drain failed: ${err && err.message ? err.message : err}`);
  }
}

/** Stop: cancels the turn in flight and ends the loop, so the next pending task
 *  does not simply start. The drain promise then resolves with the tasks it did
 *  finish, and renderQueueState paints that answer. */
async function stopQueueDrain() {
  if (!queueApi) return;
  if (els.queueStop) els.queueStop.disabled = true;
  setQueueNote('stopping…');
  try {
    const res = await queueApi.stop();
    const cancelled = res && res.cancelled && res.cancelled.ok;
    queueNote = cancelled ? 'stopped the running task' : 'stop requested';
    renderQueueState(res);
  } catch (err) {
    setQueueNote(`stop failed: ${err && err.message ? err.message : err}`);
  } finally {
    if (els.queueStop) els.queueStop.disabled = false;
  }
}

/** Retry or remove one task by id (the two row buttons). Both are single writes
 *  to the queue file, and both repaint from main's answer. */
async function queueTaskAction(name, id) {
  if (!queueApi) return;
  setQueueNote(`${name} #${id}…`);
  try {
    const res = await queueApi[name](id);
    if (res && res.ok === false) setQueueNote(res.reason || `${name} failed`);
    else setQueueNote(`${name === 'retry' ? 're-queued' : 'removed'} #${id}`);
    renderQueueState(res);
  } catch (err) {
    setQueueNote(`${name} failed: ${err && err.message ? err.message : err}`);
  }
}

/** Live drain progress -> one status line. `delta`/`reasoning` frames are
 *  deliberately dropped: they are a worker's own output, and the place for a
 *  task's result is its row (from queue.list()), not the open transcript. */
function renderQueueProgress(event) {
  if (!event || typeof event !== 'object') return;
  const id = event.taskId == null ? '' : `#${event.taskId} `;
  if (event.type === 'start') {
    setQueueNote(`${id}running${event.model ? ` on ${event.model}` : ''}…`);
  } else if (event.type === 'tool' && event.tool) {
    setQueueNote(`${id}${toolActivityLabel(event.tool)}`);
  } else if (event.type === 'finish') {
    setQueueNote(`${id}${event.ok ? 'done' : 'failed'} — refreshing`);
    loadQueueState();
  } else if (event.type === 'recovered') {
    const ids = Array.isArray(event.ids) ? event.ids : [];
    setQueueNote(`recovered ${ids.length} stalled task${ids.length === 1 ? '' : 's'}`);
  } else if (event.type === 'locked') {
    setQueueNote('another drain is already running');
  } else if (event.type === 'queued') {
    setQueueNote(`queued phase ${event.phase}`);
  }
}

/**
 * Land a quick-launcher answer (main.js QUICK_LAUNCHER_PUSH_CHANNEL, see
 * preload.js onQuickLauncherPush) as a real turn in the open thread — same
 * "renderer owns the state, main.js just pings" split every other menu
 * channel in this file uses (onMenuNewChat, onMenuSearch, …). Starts a fresh
 * thread first if none is open yet, exactly like send() does for a first
 * message, then persists both turns via sync.append — the same call send()
 * makes — so the pushed Q&A survives exactly like one typed in this window.
 */
function handleQuickLauncherPush(payload) {
  const prompt = payload && payload.prompt;
  const response = payload && payload.response;
  if (!prompt || !response) return;
  if (!currentSessionId) currentSessionId = newSessionId();
  const sessionId = currentSessionId;
  addMessage('user', prompt);
  addMessage('assistant', response, undefined, sessionId);
  threadMessages.push({ role: 'user', content: prompt });
  threadMessages.push({ role: 'assistant', content: response });
  sync.append(sessionId, { role: 'user', content: prompt }).catch(() => {});
  sync.append(sessionId, { role: 'assistant', content: response }).catch(() => {});
}

// ----------------------------------------------------------------- memory
//
// Two surfaces read the same endpoint:
//   - the sidebar card (last 10, one line each) — the quick peek;
//   - the full inspector overlay (up to 50, every field) — "all memories and
//     their sources" behind a translucent backdrop.
//
// Backend contract (aegis1/app.py:9214 `memory_search`): the response key is
// `entries`, NOT `results` — reading `results` is what kept this card empty
// for every account. `limit` is clamped server-side to 50 with no offset
// (app.py:9243), so the inspector is honestly "the 50 most recent", not an
// unbounded list. The endpoint also runs `_memory_sync_access` and can answer
// HTTP 402 `free_session_limit_reached`, which must render as an upgrade
// prompt — never as an empty list.
//
// Field set per entry (aegis1/app.py:9349 `_memory_row_to_dict`): id,
// timestamp, createdAt (epoch ms), source, role, tags[], content, session,
// importance, summary(bool), topics[], entities[], sentiment, tokenCount,
// embedding[]. There is no `tier` — L0–L3 is the local CLI engine's concept
// (aegiscodex-dev/src/memory.js) and does not exist on the cloud rows, so
// source/role are the real provenance axes here.
//
// `embedding` is dropped on ingest: it is a raw float vector, sometimes
// thousands of numbers, and nothing in this view renders or needs it.

const MEMORY_SIDEBAR_LIMIT = 10;
const MEMORY_INSPECTOR_LIMIT = 50; // server clamp — app.py:9243

/** Inspector state. `entries` is the fetched page; chips filter it in place. */
const memoryView = {
  entries: [],
  query: '',
  source: '',
  role: '',
  error: '',
  upgrade: null,
  loading: false,
};

function overlayOpen() {
  return !!els.memoryOverlay && !els.memoryOverlay.hidden;
}

/** "3m ago" / "2d ago" from epoch ms. Empty string when unknown. */
function relTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const mos = Math.round(days / 30);
  if (mos < 12) return `${mos}mo ago`;
  return `${Math.round(mos / 12)}y ago`;
}

/** Coerce one raw row into the shape the renderers expect. Never trusts the
 *  payload: every field is type-checked so a malformed row degrades to a
 *  readable card instead of throwing mid-render. */
function normalizeMemoryEntry(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== '') : []);
  const asString = (v) => (typeof v === 'string' ? v : '');
  const asNumber = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const content = asString(r.content) || asString(r.text) || asString(r.entry);
  return {
    id: r.id != null ? String(r.id) : '',
    content,
    source: asString(r.source) || '(unknown source)',
    role: asString(r.role),
    tags: asArray(r.tags),
    topics: asArray(r.topics),
    entities: asArray(r.entities),
    session: asString(r.session),
    sentiment: asString(r.sentiment),
    importance: asNumber(r.importance),
    tokenCount: asNumber(r.tokenCount),
    summary: r.summary === true,
    createdAt: asNumber(r.createdAt),
    timestamp: asString(r.timestamp),
  };
}

/** Fetch one page of memory. Returns a discriminated result rather than
 *  throwing, because "needs upgrade" and "failed" render very differently
 *  from "empty" and conflating them is the bug this view exists to fix. */
async function fetchMemory(query, limit) {
  try {
    const data = query
      ? await aegis.memorySearch(query, limit)
      : await aegis.memoryList(limit);
    // The free-plan cap does NOT arrive as a rejection on this path: main.js
    // detects it where `err.status`/`err.data` still exist (ipcRenderer.invoke
    // carries only the message string across the process boundary) and resolves
    // `{ entries: [], upgrade }` instead. Checking the resolved payload first
    // is what makes the upgrade UI reachable at all — the catch below only
    // covers a non-IPC caller that still throws the raw client error.
    // An over-quota account arrives as a SUCCESS with `upgrade` attached (reads
    // are served over quota — main.js quotaFromPayload), so the entries must
    // render alongside the notice. Returning `{entries: []}` here is only right
    // for the 402 path, where there is genuinely nothing to show.
    const raw = data && (data.entries || data.results);
    const entries = Array.isArray(raw) ? raw.map(normalizeMemoryEntry) : [];
    if (data && data.upgrade) {
      return { entries, error: '', upgrade: data.upgrade };
    }
    // `entries` is the real key. Keep the `results` fallback only so an older
    // backend that still sends it degrades to a working list, not an empty one.
    return { entries, error: '', upgrade: null };
  } catch (err) {
    const status = err && err.status;
    const code = err && err.data && err.data.error;
    if (status === 402 || code === 'free_session_limit_reached') {
      return {
        entries: [],
        error: '',
        upgrade: {
          url: (err.data && err.data.upgradeUrl) || 'https://aegiscloud.org/subscribe',
          used: err.data && (err.data.tokensUsed != null ? err.data.tokensUsed : err.data.sessionsUsed),
          limit: err.data && (err.data.tokenLimit != null ? err.data.tokenLimit : err.data.freeSessionLimit),
        },
      };
    }
    return {
      entries: [],
      error: `search failed: ${err && err.message ? err.message : err}`,
      upgrade: null,
    };
  }
}

/** Shared free-plan-cap notice. Every surface that can hit the 402 funnels
 *  through here so the wording and the target stay identical to the
 *  inspector's block. The hint elements are bare <p>s, so the subscribe link
 *  has to be a real child node — a plain text assignment would wipe it, and an
 *  href left in text is not clickable. */
/** Human token count for the sync quota: 10000000 -> "10M", 42800 -> "43k".
 *  The quota is denominated in tokens (aegis1 FREE_SYNC_TOKENS/PRO_SYNC_TOKENS),
 *  which for stored prose is about one per character — rendering the raw
 *  integer ("10000000") tells a user nothing at a glance. */
function formatTokens(n) {
  if (n == null || isNaN(n)) return '?';
  const v = Number(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  return v.toLocaleString('en-US');
}

function capNotice(el, upgrade, prefix, cta) {
  if (!el) return;
  const used = upgrade.used != null ? formatTokens(upgrade.used) : '?';
  const cap = upgrade.limit != null ? formatTokens(upgrade.limit) : '?';
  el.textContent =
    `${prefix || 'sync limit reached'} — ${used} of ${cap} tokens synced. ` +
    'Nothing was lost. ';
  const a = document.createElement('a');
  a.href = upgrade.url || 'https://aegiscloud.org/subscribe';
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.textContent = cta || 'Upgrade to keep saving →';
  el.appendChild(a);
}

/** The cap notice in the memory section's hint line. */
function renderCapHint(upgrade, prefix) {
  capNotice(els.memoryHint, upgrade, prefix);
}

/** Compact sidebar row: content only, with the source as a quiet prefix. */
function renderMemoryResults(entries, error, upgrade) {
  els.memoryResults.innerHTML = '';
  if (upgrade) {
    const li = document.createElement('li');
    li.className = 'empty mem-side-upgrade';
    const a = document.createElement('a');
    a.href = upgrade.url || 'https://aegiscloud.org/subscribe';
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = 'Free plan limit reached — upgrade to read memory →';
    li.appendChild(a);
    els.memoryResults.appendChild(li);
    return;
  }
  if (error) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = error;
    els.memoryResults.appendChild(li);
    return;
  }
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'no memory entries';
    els.memoryResults.appendChild(li);
    return;
  }
  for (const e of list) {
    const li = document.createElement('li');
    const src = document.createElement('span');
    src.className = 'mem-side-src';
    src.textContent = e.source;
    const body = document.createElement('span');
    body.className = 'mem-side-body';
    body.textContent = e.content || '(empty)';
    li.appendChild(src);
    li.appendChild(body);
    els.memoryResults.appendChild(li);
  }
}

async function searchMemory(query) {
  els.memoryHint.textContent = 'searching…';
  const res = await fetchMemory(query, MEMORY_SIDEBAR_LIMIT);
  renderMemoryResults(res.entries, res.error, res.upgrade);
  if (res.upgrade) renderCapHint(res.upgrade, 'cloud memory needs an active plan');
  else els.memoryHint.textContent = res.error || '';
}

// ------------------------------------------------- memory inspector overlay

/** Small coloured label used for source / role / tag / topic / entity. */
function memoryChip(text, cls) {
  const span = document.createElement('span');
  span.className = `mem-chip${cls ? ` ${cls}` : ''}`;
  span.textContent = text;
  return span;
}

/** One expandable card: content plus every provenance field the row carries. */
function memoryCard(e) {
  const li = document.createElement('li');
  li.className = 'mem-card';

  const head = document.createElement('div');
  head.className = 'mem-card-head';
  head.appendChild(memoryChip(e.source, 'src'));
  if (e.role) head.appendChild(memoryChip(e.role, 'role'));
  if (e.importance != null) head.appendChild(memoryChip(`imp ${e.importance}`, 'imp'));
  if (e.sentiment) head.appendChild(memoryChip(e.sentiment, 'sent'));
  if (e.summary) head.appendChild(memoryChip('summary', 'flag'));

  const meta = document.createElement('span');
  meta.className = 'mem-card-meta';
  const bits = [];
  const rel = relTime(e.createdAt);
  if (rel) bits.push(rel);
  else if (e.timestamp) bits.push(e.timestamp);
  if (e.session) bits.push(`session ${e.session}`);
  if (e.tokenCount != null) bits.push(`${e.tokenCount} tok`);
  meta.textContent = bits.join(' · ');
  head.appendChild(meta);
  li.appendChild(head);

  const body = document.createElement('p');
  body.className = 'mem-card-body';
  body.textContent = e.content || '(empty)';
  li.appendChild(body);

  const pills = [...e.tags, ...e.topics, ...e.entities];
  if (pills.length) {
    const row = document.createElement('div');
    row.className = 'mem-card-pills';
    for (const p of pills) row.appendChild(memoryChip(p, 'pill'));
    li.appendChild(row);
  }

  // Expand on click, but never while the user is selecting text to copy.
  body.addEventListener('click', () => {
    if (window.getSelection && String(window.getSelection())) return;
    li.classList.toggle('expanded');
  });
  return li;
}

/** Distinct values of `key` across the fetched page, with counts. */
function memoryFacets(key) {
  const counts = new Map();
  for (const e of memoryView.entries) {
    const v = e[key];
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Case-insensitive match over content plus every metadata field. */
function memoryMatches(e, q) {
  const hay = [
    e.content,
    e.source,
    e.role,
    e.session,
    e.sentiment,
    ...e.tags,
    ...e.topics,
    ...e.entities,
  ].join('\n').toLowerCase();
  return hay.includes(String(q == null ? '' : q).toLowerCase());
}

/** Chip filters (source / role) — click a chip to narrow, again to clear. */
function renderMemoryChips() {
  els.memoryChips.innerHTML = '';
  if (memoryView.upgrade || memoryView.error) return;
  const groups = [
    ['source', 'source', memoryFacets('source')],
    ['role', 'role', memoryFacets('role')],
  ];
  for (const [key, label, facets] of groups) {
    if (facets.length < 2) continue; // a single value is not a useful filter
    const group = document.createElement('div');
    group.className = 'mem-chip-group';
    const lab = document.createElement('span');
    lab.className = 'mem-chip-label';
    lab.textContent = label;
    group.appendChild(lab);
    for (const [value, count] of facets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `mem-chip btn${memoryView[key] === value ? ' on' : ''}`;
      b.textContent = `${value} ${count}`;
      b.addEventListener('click', () => {
        memoryView[key] = memoryView[key] === value ? '' : value;
        renderMemoryOverlay();
      });
      group.appendChild(b);
    }
    els.memoryChips.appendChild(group);
  }
}

/** Repaint the inspector from `memoryView`. Pure — makes no network calls. */
function renderMemoryOverlay() {
  if (!overlayOpen()) return;
  const total = memoryView.entries.length;
  els.memoryList.innerHTML = '';
  renderMemoryChips();

  if (memoryView.loading) {
    els.memoryCount.textContent = 'loading…';
    return;
  }

  if (memoryView.upgrade) {
    els.memoryCount.textContent = '';
    const li = document.createElement('li');
    li.className = 'mem-empty mem-upgrade';
    const h = document.createElement('strong');
    h.textContent = 'Cloud memory is paused on the free plan';
    const p = document.createElement('span');
    const used = memoryView.upgrade.used != null ? formatTokens(memoryView.upgrade.used) : '?';
    const cap = memoryView.upgrade.limit != null ? formatTokens(memoryView.upgrade.limit) : '?';
    p.textContent =
      `This account has used ${used} of ${cap} tokens of synced conversation. ` +
      'Saved memory is still readable — only new saves are paused until there is room again.';
    const a = document.createElement('a');
    a.href = memoryView.upgrade.url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = 'Open subscribe page ↗';
    li.appendChild(h);
    li.appendChild(p);
    li.appendChild(a);
    els.memoryList.appendChild(li);
    return;
  }

  if (memoryView.error) {
    els.memoryCount.textContent = '';
    const li = document.createElement('li');
    li.className = 'mem-empty';
    li.textContent = memoryView.error;
    els.memoryList.appendChild(li);
    return;
  }

  if (!total) {
    els.memoryCount.textContent = '0 entries';
    const li = document.createElement('li');
    li.className = 'mem-empty';
    li.textContent = 'No memory entries yet — save a note below, or import from other AI tools.';
    els.memoryList.appendChild(li);
    return;
  }

  const q = memoryView.query.trim().toLowerCase();
  const shown = memoryView.entries.filter(
    (e) =>
      (!memoryView.source || e.source === memoryView.source) &&
      (!memoryView.role || e.role === memoryView.role) &&
      (!q || memoryMatches(e, q))
  );

  const sources = new Set(memoryView.entries.map((e) => e.source)).size;
  els.memoryCount.textContent =
    `${shown.length} of ${total} shown · ${sources} source${sources === 1 ? '' : 's'}` +
    (total >= MEMORY_INSPECTOR_LIMIT ? ` · newest ${MEMORY_INSPECTOR_LIMIT}` : '');

  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'mem-empty';
    li.textContent = 'Nothing matches those filters.';
    els.memoryList.appendChild(li);
    return;
  }
  for (const e of shown) els.memoryList.appendChild(memoryCard(e));
}

/** Fetch a fresh page into the inspector and repaint. Preserves the filter
 *  text so typing a query does not reset the chips you just clicked. */
async function loadMemoryOverlay(query) {
  memoryView.loading = true;
  memoryView.error = '';
  memoryView.upgrade = null;
  renderMemoryOverlay();
  const res = await fetchMemory(query, MEMORY_INSPECTOR_LIMIT);
  memoryView.entries = res.entries;
  memoryView.error = res.error;
  memoryView.upgrade = res.upgrade;
  memoryView.loading = false;
  renderMemoryOverlay();
}

function openMemoryOverlay() {
  if (!els.memoryOverlay) return;
  els.memoryOverlay.hidden = false;
  document.body.classList.add('memory-open');
  // Start from whatever the sidebar is showing so the two never disagree.
  els.memoryOverlayQuery.value = els.memoryQuery ? els.memoryQuery.value.trim() : '';
  memoryView.query = els.memoryOverlayQuery.value;
  memoryView.source = '';
  memoryView.role = '';
  renderMemoryOverlay();
  loadMemoryOverlay(memoryView.query);
  if (els.memoryOverlayQuery) els.memoryOverlayQuery.focus();
}

function closeMemoryOverlay() {
  if (!els.memoryOverlay) return;
  els.memoryOverlay.hidden = true;
  document.body.classList.remove('memory-open');
  if (els.memoryOpen) els.memoryOpen.focus();
}

/** Textarea the save button should read from — the inspector's when it is up,
 *  otherwise the sidebar's. Keeps both save paths on one code path. */
function activeMemoryEntry() {
  return overlayOpen() && els.memoryOverlayEntry ? els.memoryOverlayEntry : els.memoryEntry;
}

async function importMemory() {
  if (!aegis.memoryImport) return;
  els.memoryImportBtn.disabled = true;
  els.memoryHint.textContent = 'scanning for other AI tool memory…';
  try {
    // Phase 1 — dry run. The scan is read-only against the foreign stores
    // (client/foreign-memory.js never writes to them) and the user already
    // asked for the import by clicking, so this runs unattended: no confirm
    // prompt. The preview text left in the hint is the audit trail of what
    // was found and from where, which is what the dialog used to be for.
    const preview = await aegis.memoryImport({ confirm: false });
    if (!preview || !preview.totals || !preview.totals.entries) {
      els.memoryHint.textContent = preview && preview.summary ? preview.summary : 'nothing found.';
      return;
    }

    const detail = (preview.sources || [])
      .filter((s) => s.present && s.count > 0)
      .map((s) => `${s.label}: ${s.count}`)
      .join(' · ');

    // Phase 2 — the confirmed write, immediately.
    els.memoryHint.textContent = `importing ${preview.totals.entries} entries — ${detail}`;
    const result = await aegis.memoryImport({ confirm: true, limit: 1000 });
    if (result && result.upgrade) {
      // The cap stopped the import part-way. Entries already in the cloud stay
      // there and the rest are still in the foreign stores, so a later scan
      // re-finds them — nothing to retry by hand, just show the plan page.
      renderCapHint(result.upgrade, `import stopped after ${result.saved || 0} entries`);
      await refreshMemoryViews();
      return;
    }
    const queued = result && result.queued ? ` (${result.queued} queued offline)` : '';
    els.memoryHint.textContent = result && result.ok
      ? `imported ${result.saved} entries${queued}.`
      : `import stopped: ${(result && result.reason) || 'unknown error'}`;
    await refreshMemoryViews();
  } catch (err) {
    els.memoryHint.textContent = `import failed: ${err && err.message ? err.message : err}`;
  } finally {
    els.memoryImportBtn.disabled = false;
  }
}

async function saveMemory() {
  const box = activeMemoryEntry();
  if (!box) return;
  const text = box.value.trim();
  if (!text) return;
  els.memorySaveBtn.disabled = true;
  if (els.memoryOverlaySave) els.memoryOverlaySave.disabled = true;
  els.memoryHint.textContent = 'saving…';
  try {
    const result = await aegis.memorySave({ text, source: 'aegis-desktop' });
    if (result && result.upgrade) {
      // Nothing was stored, and it is not queued either (main.js deliberately
      // does not queue a cap — it would flush-fail forever). So keep the text
      // in the box: clearing it here would destroy the note the user just
      // tried to remember, while the hint claimed it was saved.
      renderCapHint(result.upgrade, 'free plan limit reached');
      await refreshMemoryViews();
      return;
    }
    box.value = '';
    els.memoryHint.textContent =
      result && result.queued ? 'saved offline — syncs when AEGIS is reachable.' : 'saved.';
    await refreshMemoryViews();
  } catch (err) {
    els.memoryHint.textContent = `save failed: ${err && err.message ? err.message : err}`;
  } finally {
    els.memorySaveBtn.disabled = false;
    if (els.memoryOverlaySave) els.memoryOverlaySave.disabled = false;
  }
}

/** Re-read both surfaces after a write. The inspector only refetches when it
 *  is actually on screen — a hidden overlay should not spend a request. */
async function refreshMemoryViews() {
  const q = els.memoryQuery ? els.memoryQuery.value.trim() : '';
  await searchMemory(q);
  if (overlayOpen()) await loadMemoryOverlay(memoryView.query);
}

// ------------------------------------------------------------ chat welcome
// The welcome panel is cloned from #welcome-template in index.html rather than
// built with createElement, so its markup lives in exactly one place and
// survives the innerHTML clears in newChat()/openSession().
//
// Pills PREFILL the composer (matching ae-guix native-chat); they never
// auto-send, so a mis-click costs nothing. Wiring is addEventListener rather
// than inline onclick because this renderer runs under CSP `script-src 'self'`,
// which would silently drop inline handlers.

/** Time-aware greeting, recomputed each time the panel is rendered. */
function applyGreeting() {
  const el = document.getElementById('chat-greeting');
  if (!el) return;
  const h = new Date().getHours();
  el.textContent =
    h >= 5 && h < 12
      ? 'Good morning'
      : h >= 12 && h < 17
        ? 'Good afternoon'
        : h >= 17 && h < 22
          ? 'Good evening'
          : 'Working late?';
}

/** Prefill the composer with a starter question, caret at the end. */
function quickAction(text) {
  const inp = els.prompt;
  if (!inp) return;
  inp.value = text;
  inp.focus();
  try {
    inp.setSelectionRange(text.length, text.length);
  } catch (err) {
    /* not supported on every input type; focus alone is enough */
  }
}

/** Clear the transcript and render the welcome panel. */
function renderWelcome() {
  const tpl = document.getElementById('welcome-template');
  if (!tpl) return;
  els.messages.innerHTML = '';
  els.messages.appendChild(tpl.content.cloneNode(true));
  applyGreeting();
  for (const btn of els.messages.querySelectorAll('.chat-quick-pill')) {
    btn.addEventListener('click', () => quickAction(btn.dataset.quick || ''));
  }
}

/** Drop the welcome panel once real transcript content exists. */
function hideWelcome() {
  const w = document.getElementById('chat-welcome');
  if (w) w.remove();
}

// Assistant text is rendered as sanitized markdown (headings, lists, links,
// highlighted fenced code with a copy button — see renderer/markdown.js);
// user text always stays plain via textContent, and this is the only place
// that decides which one a role gets. AegisMarkdown.renderInto() itself
// falls back to textContent if marked/DOMPurify failed to load, so this
// never risks putting raw model output into innerHTML.
function renderMessageBody(bodyEl, role, text) {
  if (role === 'assistant' && window.AegisMarkdown) {
    // Rendered markdown supplies its own block spacing (marked emits real
    // <p>/<pre>/<li> elements); the plain-text `white-space: pre-wrap` on
    // .body/.flow-body would otherwise turn the newlines *between* those
    // tags into extra visible blank lines. md-body opts back to normal flow.
    bodyEl.classList.add('md-body');
    window.AegisMarkdown.renderInto(bodyEl, text);
  } else {
    bodyEl.classList.remove('md-body');
    bodyEl.textContent = text;
  }
}

// `sessionId`, when given for an assistant message, renders a "copy" button
// that puts the message text on the clipboard. `toolLog` (assistant only) is
// the turn's collected `{name, args, ok}` tool calls, rendered above the
// answer text so the reply the user reads is followed by, not replaced by,
// what the model actually did to produce it.
function addMessage(role, text, meta, sessionId, toolLog) {
  hideWelcome();
  const row = document.createElement('div');
  row.className = `msg ${role}`;

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent =
    role === 'user' ? 'You' : role === 'assistant' ? 'AEGIS' : 'System';

  const body = document.createElement('div');
  body.className = 'body';
  renderMessageBody(body, role, text);

  row.appendChild(who);
  if (Array.isArray(toolLog) && toolLog.length) {
    const toolsEl = document.createElement('div');
    toolsEl.className = 'tool-activity';
    for (const t of toolLog) {
      const line = document.createElement('div');
      line.textContent = toolActivityLabel(t);
      toolsEl.appendChild(line);
    }
    row.appendChild(toolsEl);
  }
  row.appendChild(body);

  if (meta) {
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = meta;
    row.appendChild(m);
  }

  if (role === 'assistant' && sessionId) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'copy';
    copyBtn.addEventListener('click', () => copyMessage(text, copyBtn));
    row.appendChild(copyBtn);
  }

  els.messages.appendChild(row);
  // Follows only when the reader is still at the tail — see stickToBottom.
  // A discrete new message must not drag the view away from someone reading
  // history; the send path forces the follow explicitly instead.
  stickToBottom();
  return row;
}

/** Copy one message's text to the clipboard, with brief button feedback. */
async function copyMessage(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) btn.textContent = 'copied!';
  } catch (err) {
    if (btn) btn.textContent = 'copy failed';
  } finally {
    if (btn) setTimeout(() => { btn.textContent = 'copy'; }, 1500);
  }
}

/**
 * Build one card of the lane. Each card is a self-contained stream slot: its
 * own `.flow-body`, its own state chip and its own cancel button. The card is
 * inserted into the track *before* the trailing "+ another path" button so the
 * track always ends with the affordance that extends it.
 */
function flowCard(path, track, spec) {
  const card = document.createElement('article');
  card.className = 'flow-card pending';
  card.dataset.path = path.key;

  const head = document.createElement('div');
  head.className = 'flow-head';

  const badge = document.createElement('span');
  badge.className = 'flow-badge';
  badge.textContent = path.badge;

  const title = document.createElement('span');
  title.className = 'flow-title';
  title.textContent = path.title;

  const state = document.createElement('span');
  state.className = 'flow-state';
  state.textContent = 'queued';

  head.appendChild(badge);
  head.appendChild(title);
  head.appendChild(state);

  const body = document.createElement('div');
  body.className = 'flow-body';
  body.textContent = '…';

  const meta = document.createElement('div');
  meta.className = 'flow-meta';

  const abort = document.createElement('button');
  abort.type = 'button';
  abort.className = 'ghost-btn flow-abort';
  abort.textContent = 'stop';
  abort.addEventListener('click', () => {
    if (card.dataset.session) models.cancel(card.dataset.session);
    state.textContent = 'stopped';
    card.classList.remove('pending');
    card.classList.add('stopped');
    abort.remove();
  });

  card.appendChild(head);
  card.appendChild(body);
  card.appendChild(meta);
  card.appendChild(abort);

  const addBtn = track.querySelector('.flow-add');
  if (addBtn) track.insertBefore(card, addBtn);
  else track.appendChild(card);

  spawnPath(card, { ...spec, path });
  return card;
}

/**
 * Run one path: a streaming `models.chat` on a derived sessionId, rendered
 * into the card it owns. Fire-and-forget — the caller never awaits, so N paths
 * stream simultaneously while the vertical thread stays responsive.
 */
async function spawnPath(card, spec) {
  const id = `${spec.parentSessionId}::flow${++flowCount}`;
  card.dataset.session = id;
  activeBranches.add(id);

  const body = card.querySelector('.flow-body');
  const state = card.querySelector('.flow-state');
  const meta = card.querySelector('.flow-meta');

  let streamed = '';
  const onDelta = (chunk) => {
    if (chunk && chunk.approval) {
      if (card.classList.contains('pending')) {
        card.classList.remove('pending');
        state.textContent = 'needs approval';
      }
      renderApprovalCard(card, chunk.approval, '.flow-body');
      return;
    }
    if (chunk && chunk.tool) {
      if (card.classList.contains('pending')) {
        card.classList.remove('pending');
        state.textContent = 'streaming…';
      }
      // `phase: 'run'` is the frame that opens the CLI's live row before the
      // tool executes. This line is retrospective by design (see
      // toolActivityLabel), so acting on the run frame too would print every
      // tool twice — once when it starts, once when it finishes.
      if (chunk.tool.phase === 'run') { captureDiffPreview(chunk.tool); return; }
      appendToolActivity(card, chunk.tool, 'flow-tools', '.flow-body');
      return;
    }
    const delta =
      chunk && (typeof chunk.delta === 'string' ? chunk.delta : chunk.content);
    if (!delta) return;
    if (card.classList.contains('pending')) {
      card.classList.remove('pending');
      state.textContent = 'streaming…';
    }
    streamed += delta;
    body.textContent = streamed;
    // Follow the newest text sideways only while this card is the one being
    // read — horizontal auto-scroll that fights the user is worse than none.
    if (trackOf(card) && isTrailing(card)) {
      card.scrollIntoView({ block: 'nearest', inline: 'end' });
    }
  };

  try {
    const data = await models.chat(
      {
        class: spec.cls,
        // The path instruction rides in the system prompt so the transcript
        // stays the user's own words; the echoed request follows it because
        // not every provider honours `system` (Ollama, some compat gateways).
        system: `${FLOW_SYSTEM}\n\n${spec.path.hint}`,
        prompt: `Original request:\n${spec.prompt}\n\n${spec.path.hint}`,
        model: spec.model,
        maxTokens: Math.min(spec.maxTokens || 1024, 1024),
        // A single-shot summariser: one lead line and 3-5 bullets, no tools.
        // Without this the engine puts the agent loop (and its tool schemas)
        // behind a 1024-token budget, and a turn that comes back with neither
        // text nor a tool call would trigger the empty-turn recovery — an
        // extra dispatch this lane has no gathered context to justify.
        tools: false,
        // `singlePass` is what makes that promise true on the pooled class.
        // The engine derives the pooled brain flag as
        // `singlePass ? false : autonomous ? true : undefined`, and this lane
        // set neither: on a `nexus-brain*` id the flag was `undefined`, so the
        // model id's own default decided — which is the fan-out. A card that
        // was meant to be one cheap 1024-token pass could therefore bill a
        // workers + synthesis dispatch, twice per turn. Explicit `false` =
        // one provider call, always.
        singlePass: true,
        sessionId: id,
      },
      onDelta
    );

    const choice = (data && data.choices && data.choices[0]) || {};
    const text =
      (choice.message && choice.message.content) || streamed || '(no path found)';
    renderMessageBody(body, 'assistant', text);
    card.classList.remove('pending');
    card.classList.add('done');
    state.textContent = 'done';

    const bits = [spec.path.title];
    if (data && data.model) bits.push(data.model);
    else if (spec.model) bits.push(spec.model);
    // A lane card is a dispatch the same way a turn is, and it was the
    // un-costed half of the 3x story: it reported tokens with no charge beside
    // them, so the extra calls were the least visible thing on the screen.
    const flow = turnAccounting(data && data.usage, spec.model, {
      costUsd: data && typeof data.costUsd === 'number' ? data.costUsd : undefined,
    });
    if (flow.tokens != null) bits.push(`${flow.tokens} tokens`);
    if (flow.cost != null) bits.push(fmtCost(flow.cost, flow.real));
    // …and roll it into the session, which is the half that was missing. The
    // card shows this ONE dispatch; a session total that skipped it would be
    // the lane's calls — the extra ones this feature's cost story is made of —
    // being the only calls on screen that never get counted. `turns: 0`
    // because a discovery path is not a turn the user asked for: it
    // contributes tokens and calls, and leaves the turn count to real
    // exchanges.
    const roll = foldRoll(spec.parentSessionId, data && data.usage, {
      model: spec.model,
      costUsd: data && typeof data.costUsd === 'number' ? data.costUsd : undefined,
      calls: data && data.calls,
      turns: 0,
      // The dispatch's own prompt and stream, for the same reason as the turn
      // site: a path that reports no usage is estimated from its own text and
      // counted, instead of leaving the lane's calls out of the session total.
      prompt: `Original request:\n${spec.prompt}\n\n${spec.path.hint}`,
      reply: text,
    });
    const rollLine = fmtRoll(roll);
    if (rollLine) bits.push(`session: ${rollLine}`);
    meta.textContent = bits.join(' · ');
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    card.classList.remove('pending');
    card.classList.add('stopped');
    state.textContent = 'stopped';
    body.textContent = streamed || `Path unavailable: ${message}`;
    meta.textContent = spec.path.title;
  } finally {
    activeBranches.delete(id);
    const abort = card.querySelector('.flow-abort');
    if (abort) abort.remove();
  }
}

function trackOf(card) {
  return card.parentElement;
}

/** True when nothing but the "+ another path" button follows this card. */
function isTrailing(card) {
  const next = card.nextElementSibling;
  return !next || next.classList.contains('flow-add');
}

/**
 * The lane itself: a horizontal track appended under the vertical thread.
 * `spec` carries the class/model/budget the user already chose, so a path is
 * generated by the same provider as the answer it sits beside.
 */
function addFlowLane(spec) {
  const lane = document.createElement('div');
  lane.className = 'chatflow';

  const rail = document.createElement('div');
  rail.className = 'flow-rail';
  const label = document.createElement('span');
  label.className = 'flow-rail-label';
  label.textContent = 'discovery lane';
  const hint = document.createElement('span');
  hint.className = 'flow-rail-hint';
  hint.textContent = 'alternatives from the AI — scroll →';
  rail.appendChild(label);
  rail.appendChild(hint);

  const track = document.createElement('div');
  track.className = 'flow-track';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ghost-btn flow-add';
  addBtn.textContent = '+ another path';
  addBtn.addEventListener('click', () => {
    // Cycle the presets so repeated clicks keep discovering new genres.
    const path = FLOW_PATHS[flowCount % FLOW_PATHS.length];
    flowCard(path, track, spec);
  });
  track.appendChild(addBtn);

  lane.appendChild(rail);
  lane.appendChild(track);
  els.messages.appendChild(lane);

  for (const path of FLOW_PATHS.slice(0, 2)) flowCard(path, track, spec);
  return lane;
}

/**
 * The element a streaming turn paints into, recreated if it is missing.
 *
 * `setBusy(false)` removes the row and nulls it, and a late chunk can still
 * land after that (a stray delta from a superseded turn, or the tail of a
 * stream that resolved while the next one was arming). Every handler below
 * used to read `if (pendingEl) { … }` and silently drop the chunk when it was
 * null. For text that is cosmetic. For an `{ approval }` chunk it is not: the
 * engine is blocked on a promise that only `models.respondApproval` can
 * settle, so a dropped card left the tool round waiting on a decision the user
 * was never shown — an unanswerable hang that only ended at the turn timeout.
 * Recreating the row costs one empty bubble and makes the chunk undroppable.
 */
function ensurePendingRow() {
  if (pendingEl) return pendingEl;
  pendingEl = addMessage('assistant', '');
  pendingEl.classList.remove('pending');
  return pendingEl;
}

function setBusy(busy, { cancellable } = {}) {
  els.send.disabled = busy;
  els.prompt.disabled = busy;
  if (busy) {
    pendingEl = addMessage('assistant', '');
    pendingEl.classList.add('pending');
    const dots = document.createElement('span');
    dots.className = 'typing-dots';
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
    pendingEl.querySelector('.body').appendChild(dots);
    if (cancellable) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'cancel-btn';
      cancelBtn.textContent = 'cancel';
      // One path for both doors: the button and Escape must produce identical
      // feedback, including the salvage `send()` performs.
      cancelBtn.addEventListener('click', () => stopPendingTurn());
      pendingEl.appendChild(cancelBtn);
    }
  } else if (pendingEl) {
    pendingEl.remove();
    pendingEl = null;
  }
}

/**
 * Longest argument shown on a tool-activity line before it is elided. The
 * container is `white-space: nowrap` with a column flex parent, so an
 * unbounded `command` used to widen the row and shove the transcript
 * horizontally on a long pipeline.
 */
const TOOL_LABEL_MAX = 72;

/**
 * Host tool names whose calls render as a collapsible diff block instead of a
 * bare line. The engine's own spellings (`Edit`/`Write`/`MultiEdit`) are
 * included so a frame from a newer engine renders the same rather than falling
 * back to a plain row.
 */
const EDIT_TOOL_NAMES = new Set(['editFile', 'writeFile', 'Edit', 'Write', 'MultiEdit']);

/**
 * Diff previews captured on a tool's `phase: 'run'` frame, keyed by tool id.
 * The run frame fires strictly before the executor writes, which is the only
 * moment a `writeFile`'s pre-edit contents can still be read — so the preview
 * is built there and replayed when the matching `done` frame arrives.
 */
const toolPreviews = new Map();

/**
 * The pre-edit read a `writeFile`/`Write` preview needs. The renderer runs
 * sandboxed (main.js sets contextIsolation + sandbox, so there is no
 * `node:fs`), so the read goes over the preload bridge's synchronous
 * `readTextFile`. Main confines the path to the session cwd it is handed, so
 * `cwd` must travel with the call — without it main has nothing to contain
 * against and refuses, which degrades the write to a create-style diff (all
 * additions). `editFile` carries its own old_string and needs no read, so it
 * always renders a full diff regardless.
 */
function hostReadFile(file, cwd) {
  try {
    const bridge = typeof window !== 'undefined' ? window.aegis : null;
    if (bridge && typeof bridge.readTextFile === 'function') {
      return bridge.readTextFile(file, cwd);
    }
  } catch {
    // A bridge that throws must not break the render path.
  }
  return undefined;
}

/** Build and stash the diff preview for an edit tool when its run frame arrives. */
function captureDiffPreview(tool) {
  if (!tool || !EDIT_TOOL_NAMES.has(tool.name) || tool.id == null) return;
  // editPreview calls readFile(file) with no cwd, so bind the frame's cwd here.
  const cwd = tool.cwd;
  const readFile = (file) => hostReadFile(file, cwd);
  const preview = editPreview(tool.name, tool.args, { cwd, readFile });
  if (preview) toolPreviews.set(tool.id, preview);
}

/**
 * One display line for a completed tool call (`onDelta`'s `{ tool: {name,
 * args, ok} }` chunk — see desktop/lib/local/engine.js). Fires after the tool
 * already ran, so this is a retrospective log line, not a live spinner.
 */
function toolActivityLabel(tool) {
  const { name, args, ok } = tool || {};
  const mark = ok === false ? '✗' : '✓';
  const a = args || {};
  if (name === 'task') {
    const kind = a.subagent_type && a.subagent_type !== 'general' ? a.subagent_type : 'general';
    return `→ task ▸ ${a.description || 'subagent'} (${kind}) ${mark}`;
  }
  // The command *is* the answer to "what is it doing?", so it leads the line
  // behind an arrow and is what the eye lands on. `file_path` (Read/Edit/
  // Write) and `command` (exec) are the two that matter; the rest are
  // fallbacks for the remaining tool schemas. Collapse newlines first — a
  // multi-line command would otherwise push the log line to two rows and
  // `white-space: nowrap` (see .tool-activity) would clip the second.
  const raw = a.file_path || a.path || a.command || a.pattern || a.query || a.description || '';
  const flat = String(raw).replace(/\s+/g, ' ').trim();
  const shown = flat.length > TOOL_LABEL_MAX ? `${flat.slice(0, TOOL_LABEL_MAX - 1)}…` : flat;
  return `→ ${name}${shown ? ` ${shown}` : ''} ${mark}`;
}

/**
 * Append one tool-activity line to `row`, creating the container on first use.
 * An edit tool whose preview was captured on its run frame renders as a
 * collapsible diff block in place of the bare line; every other tool keeps the
 * plain `→ name path ✓` row.
 */
function appendToolActivity(row, tool, containerClass, beforeSelector) {
  if (!row) return;
  let toolsEl = row.querySelector(`.${containerClass}`);
  if (!toolsEl) {
    toolsEl = document.createElement('div');
    toolsEl.className = containerClass;
    const before = beforeSelector ? row.querySelector(beforeSelector) : null;
    if (before) row.insertBefore(toolsEl, before);
    else row.appendChild(toolsEl);
  }
  const preview = tool && tool.id != null ? toolPreviews.get(tool.id) : null;
  if (preview) {
    toolPreviews.delete(tool.id); // one-shot: a stale id must not replay on a retry
    const block = renderDiffBlock(preview, document);
    if (block) {
      toolsEl.appendChild(block);
      return toolsEl;
    }
  }
  const line = document.createElement('div');
  line.textContent = toolActivityLabel(tool);
  toolsEl.appendChild(line);
  return toolsEl;
}

/**
 * Lazily create a message row's extended-reasoning block and return it.
 *
 * Only pooled brain turns emit `reasoning` deltas (the "work autonomously"
 * fan-out's worker findings), so this block exists for AEGIS Cloud autonomous
 * turns and nowhere else. It sits ABOVE `.body` — deliberation first, then the
 * answer the synthesis pass writes — and is transient UI: it is never pushed
 * into the thread history, so it cannot leak back into the model's context.
 */
function ensureReasoningEl(row) {
  let el = row.querySelector('.reasoning');
  if (!el) {
    el = document.createElement('div');
    el.className = 'reasoning';
    const body = row.querySelector('.body');
    if (body) row.insertBefore(el, body);
    else row.appendChild(el);
  }
  return el;
}

/** The one-line summary shown above an approval card's diff (or alone, for
 *  exec, which has none). */
function approvalSummary(tool, args) {
  const a = args || {};
  if (tool === 'exec') return a.description ? `${a.command} — ${a.description}` : a.command || '';
  return a.file_path || '';
}

/**
 * Render one +/- colored line of a unified diff. `@@` hunk headers and the
 * `---`/`+++` file headers get their own class; everything else falls back
 * to a plain context line.
 */
function diffLineClass(line) {
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-file';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return 'diff-ctx';
}

/**
 * Render one tool-call approval card (`onDelta`'s `{ approval: {id, tool,
 * args, diff} }` chunk — see desktop/lib/local/engine.js requestApproval)
 * into `row`, before it runs. The three buttons resolve the main process's
 * pending promise via models.respondApproval; the card disables itself the
 * instant one is clicked so a double-click can't send two decisions for the
 * same id.
 */
function renderApprovalCard(row, approval, beforeSelector) {
  if (!row || !approval) return;

  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.approvalId = approval.id;

  const title = document.createElement('div');
  title.className = 'approval-title';
  title.textContent = `${approval.tool} wants to run — review before it executes`;
  card.appendChild(title);

  const summary = approvalSummary(approval.tool, approval.args);
  if (summary) {
    const summaryEl = document.createElement('div');
    summaryEl.className = 'approval-summary';
    summaryEl.textContent = summary;
    card.appendChild(summaryEl);
  }

  if (approval.diff) {
    const diffEl = document.createElement('pre');
    diffEl.className = 'approval-diff';
    for (const line of approval.diff.split('\n')) {
      const lineEl = document.createElement('div');
      lineEl.className = diffLineClass(line);
      lineEl.textContent = line;
      diffEl.appendChild(lineEl);
    }
    card.appendChild(diffEl);
  }

  const actions = document.createElement('div');
  actions.className = 'approval-actions';

  const decide = (decision) => {
    for (const btn of actions.querySelectorAll('button')) btn.disabled = true;
    card.classList.add('resolved');
    const tag = document.createElement('div');
    tag.className = 'approval-decision';
    tag.textContent =
      decision === 'deny' ? 'Denied' : decision === 'session' ? 'Allowed for this session' : 'Allowed once';
    card.appendChild(tag);
    models.respondApproval(approval.id, decision);
  };

  const mkButton = (label, cls, decision) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `approval-btn ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', () => decide(decision));
    return btn;
  };

  actions.appendChild(mkButton('Allow once', 'allow', 'once'));
  actions.appendChild(mkButton('Allow for this session', 'allow-session', 'session'));
  actions.appendChild(mkButton('Deny', 'deny', 'deny'));
  card.appendChild(actions);

  let slot = row.querySelector('.approval-slot');
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'approval-slot';
    const before = beforeSelector ? row.querySelector(beforeSelector) : null;
    if (before) row.insertBefore(slot, before);
    else row.appendChild(slot);
  }
  slot.appendChild(card);
  return card;
}

function classLabel(cls) {
  const found = classOptions.find((c) => c.class === cls);
  return found ? found.label : cls;
}

function newSessionId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ------------------------------------------------------------- model classes

async function loadClasses() {
  try {
    classOptions = (await models.listClasses()) || [];
  } catch (err) {
    classOptions = [];
    els.modelHint.textContent =
      `listClasses failed: ${err && err.message ? err.message : err}`;
  }

  els.classSelect.innerHTML = '';
  for (const c of classOptions) {
    const opt = document.createElement('option');
    opt.value = c.class;
    opt.textContent = c.configured
      ? c.label
      : `${c.label} (not configured)`;
    els.classSelect.appendChild(opt);
  }

  const saved = localStorage.getItem(CLASS_KEY);
  if (saved && classOptions.some((c) => c.class === saved)) {
    els.classSelect.value = saved;
  }
  await loadModels(els.classSelect.value);
}

async function loadModels(cls) {
  // "Work autonomously" only makes sense for the pooled AEGIS Cloud class —
  // hide it for Ollama/custom endpoints rather than showing a checkbox that
  // would silently do nothing.
  if (els.autonomousToggleWrap) {
    els.autonomousToggleWrap.hidden = cls !== AUTONOMOUS_CLASS;
  }
  updateAutonomousControlsVisibility();
  updateBudgetControls(cls);

  const custom = CUSTOM_CLASSES.has(cls);
  els.modelSelect.hidden = custom;
  els.modelSelect.disabled = custom;
  els.modelInput.hidden = !custom;
  els.modelInput.disabled = !custom;
  els.modelPreset.hidden = true;
  els.modelHint.textContent = '';

  if (custom) {
    modelMeta = new Map();
    let cfg = { baseURL: '', configured: false, keyMask: null };
    try {
      const settings = (await models.settings.get()) || [];
      cfg = (Array.isArray(settings) && settings.find((s) => s.provider === cls)) || cfg;
    } catch {
      /* settings unavailable — leave hint below */
    }
    // The engine lists no models for a custom endpoint: the only usable id is
    // one the user types (it used to offer the base URL as an id, which POSTed
    // `model: "<url>"` and 400'd upstream). `needsModelId` is what turns this
    // into an explicit "type a model id" prompt rather than an empty picker.
    let needsModelId = true;
    try {
      const data = await models.listModels(cls);
      if (data && typeof data.needsModelId === 'boolean') needsModelId = data.needsModelId;
      if (data && typeof data.baseURL === 'string' && data.baseURL) {
        cfg = { ...cfg, baseURL: data.baseURL };
      }
      const list = Array.isArray(data && data.models) ? data.models : [];
      if (list.length) {
        // A custom class that does enumerate models (a future provider) still
        // gets a picker; the typed input is only for the unlistable case.
        needsModelId = false;
        els.modelSelect.hidden = false;
        els.modelSelect.disabled = false;
        els.modelInput.hidden = true;
        els.modelInput.disabled = true;
        els.modelSelect.innerHTML = '';
        for (const m of list) {
          modelMeta.set(m.id, m);
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.label || m.id;
          els.modelSelect.appendChild(opt);
        }
      }
    } catch {
      /* engine unavailable — fall back to settings + the typed input */
    }
    // Quick-fill presets only make sense while the id is still hand-typed —
    // a class that starts enumerating real models (needsModelId false) gets
    // a proper picker above instead, so the preset list would be redundant.
    const presets = needsModelId ? CUSTOM_MODEL_PRESETS[cls] || [] : [];
    els.modelPreset.hidden = presets.length === 0;
    if (presets.length) {
      els.modelPreset.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'quick pick…';
      placeholder.disabled = true;
      placeholder.selected = true;
      els.modelPreset.appendChild(placeholder);
      for (const preset of presets) {
        const opt = document.createElement('option');
        opt.value = preset.model;
        opt.textContent = preset.label;
        opt.title = preset.baseURL;
        els.modelPreset.appendChild(opt);
      }
    }
    els.modelInput.placeholder = needsModelId
      ? MODEL_ID_PLACEHOLDER[cls] || 'type a model id'
      : 'model id';
    els.modelHint.textContent = cfg.baseURL
      ? `endpoint: ${cfg.baseURL} · key: ${cfg.configured ? cfg.keyMask : 'not set'}` +
        (needsModelId ? ' · type a model id above' : '')
      : 'Set base URL + key in Provider settings, then type a model id.';
    return;
  }

  els.modelSelect.innerHTML = '';
  modelMeta = new Map();
  if (cls === 'aegis') {
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'server default (auto)';
    els.modelSelect.appendChild(auto);
  }

  try {
    const data = await models.listModels(cls);
    const list = Array.isArray(data && data.models) ? data.models : [];
    // No key on the default class: the engine reports the missing credential as
    // a state instead of letting the catalog call 401 (see engine.listModels).
    // The hint is where a user finds out they can connect at all — a raw
    // "listModels failed" told them only that something was broken.
    const needsKey = Boolean(data && data.needsKey);
    for (const m of list) {
      modelMeta.set(m.id, m);
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      els.modelSelect.appendChild(opt);
    }
    let hint;
    if (needsKey) {
      hint = null; // carries a link, built below
    } else if (!list.length) {
      hint = cls === 'ollama' ? 'Ollama not running or no models pulled.' : 'No models listed.';
    } else if (cls === 'byok' && data && data.needsAegisKey &&
               data.fee && data.fee.require_balance) {
      // Only when the SERVER says it enforces this (fee.require_balance). This
      // desktop cannot know that on its own: with the flag off, an
      // unattributed turn is served by design and only its fee goes
      // uncollected, so refusing or warning here would contradict the server
      // and send the user to a screen they do not need. Checked BEFORE
      // needsProviderKey because when the server does enforce, the account key
      // is the blocker and the provider key is not yet the question.
      hint = `${list.length} model${list.length === 1 ? '' : 's'} available — ` +
        'this server requires an AEGIS account key: the BYOK handling fee is billed there.';
    } else if (cls === 'byok' && data && data.needsProviderKey) {
      // Unlike the pooled 'aegis' class, byok still shows every model here —
      // the catalog answers with no key at all — but none of them are
      // usable until a provider key is saved in Provider settings below.
      hint = `${list.length} model${list.length === 1 ? '' : 's'} available — ` +
        'add a provider key in Provider settings below to use one.';
    } else if (cls === 'byok' && data && data.needsAegisKey &&
               data.fee && !data.fee.disabled) {
      // Not a refusal — the server serves unattributed turns and logs the fee
      // as uncollected — but the user is paying a handling fee and should know
      // which account it lands on, or that it currently lands on none.
      hint = `${list.length} model${list.length === 1 ? '' : 's'} available — ` +
        'connect an AEGIS account key above so the BYOK handling fee is billed to you.';
    } else {
      hint = `${list.length} model${list.length === 1 ? '' : 's'} available.`;
    }
    // Display-only: what this model says its own output limit is. It sizes no
    // request — budgetFor() answers that from the Effort rung.
    const ceiling = maxTokensCeiling(modelMeta.get(els.modelSelect.value));
    if (needsKey) {
      // The hint elements are bare <p>s, so the link has to be a real child
      // node — a text assignment would wipe it (same shape as capNotice).
      els.modelHint.textContent =
        'Connect Aegis Cloud to load its models: paste your AEGIS API key in the Status card above (';
      const a = document.createElement('a');
      a.href = GET_AEGIS_KEY_URL;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = 'free key at aegiscloud.org';
      els.modelHint.appendChild(a);
      els.modelHint.appendChild(document.createTextNode('), then Save.'));
      return;
    }
    els.modelHint.textContent =
      ceiling < FLAT_CEILING ? `${hint} · max output: ${ceiling.toLocaleString()}` : hint;
  } catch (err) {
    modelMeta = new Map();
    els.modelHint.textContent =
      `listModels failed: ${err && err.message ? err.message : err}`;
  }
}

/**
 * Quick-fill a Model-card preset: sets the typed model id, and fills the
 * matching Provider-settings base URL field IF it's currently empty. An
 * already-configured base URL is left alone (never silently overwritten) —
 * if it doesn't match what the preset expects, the hint says so instead, so
 * the user's own custom endpoint can't be clobbered by a stray click.
 */
function applyCustomPreset(cls, modelId) {
  const preset = (CUSTOM_MODEL_PRESETS[cls] || []).find((p) => p.model === modelId);
  if (!preset) return;
  els.modelInput.value = preset.model;
  // The id just changed, so the budget note may have to as well: DeepSeek —
  // Flash 4.1 is sized by the Effort rung (budget.js), which is a different
  // statement than the one for a plain OpenAI-compatible id.
  updateBudgetControls(cls);

  const row = els.settingsList.querySelector(`.setting-row[data-provider="${cls}"]`);
  const baseInput = row && row.querySelector('.setting-base');
  if (!baseInput) return;
  const current = baseInput.value.trim();
  if (!current) {
    baseInput.value = preset.baseURL;
    els.modelHint.textContent = `filled in — click Save in Provider settings below to store the ${preset.label} endpoint.`;
  } else if (current !== preset.baseURL) {
    els.modelHint.textContent =
      `${preset.label} needs base URL ${preset.baseURL} — Provider settings below has ${current}. Update it there too.`;
  }
}

// -------------------------------------------------------------- settings pane

/**
 * One provider-settings row: name, an optional base-URL field, a key input,
 * a status label and Save/Remove buttons wired to the generic
 * `models.settings.*` surface. Shared by the two custom endpoints (which
 * need a base URL) and the byok providers (which do not — the server
 * dictates the endpoint; only the key is theirs to set).
 */
function buildSettingRow({ provider, name, cfg, showBaseURL, onSave, onRemove }) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  // Targeted by applyCustomPreset() so picking a Model-card preset can
  // quick-fill the matching base URL here without a full loadSettings()
  // round trip.
  row.dataset.provider = provider;

  const label = document.createElement('div');
  label.className = 'setting-name';
  label.textContent = name;
  row.appendChild(label);

  let baseInput = null;
  if (showBaseURL) {
    baseInput = document.createElement('input');
    baseInput.type = 'text';
    baseInput.className = 'setting-input setting-base';
    baseInput.placeholder = 'base URL';
    baseInput.value = cfg.baseURL || '';
    row.appendChild(baseInput);
  }

  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.className = 'setting-input';
  keyInput.placeholder = cfg.configured
    ? `key ${cfg.keyMask} (blank = keep)`
    : 'API key';
  row.appendChild(keyInput);

  const status = document.createElement('div');
  status.className = 'setting-status';
  status.textContent = cfg.configured ? `configured (${cfg.keyMask})` : 'no key';
  row.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'setting-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'ghost-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => onSave(baseInput ? baseInput.value.trim() : '', keyInput.value));
  actions.appendChild(saveBtn);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'ghost-btn danger';
  removeBtn.textContent = 'Remove';
  removeBtn.disabled = !cfg.configured;
  removeBtn.addEventListener('click', onRemove);
  actions.appendChild(removeBtn);

  row.appendChild(actions);
  return row;
}

async function loadSettings() {
  els.settingsList.innerHTML = '';
  let settings = [];
  try {
    settings = (await models.settings.get()) || [];
  } catch {
    /* leave empty */
  }
  if (Array.isArray(settings)) {
    settings = settings.filter((s) => s && !RESERVED_PROVIDERS.has(s.provider));
  }

  const providers = [
    { provider: 'openai-compat', name: 'OpenAI-compatible' },
    { provider: 'anthropic', name: 'Anthropic-compatible' },
  ];

  for (const { provider, name } of providers) {
    const cfg = settings.find((s) => s.provider === provider) || {
      provider,
      baseURL: '',
      configured: false,
      keyMask: null,
    };
    els.settingsList.appendChild(buildSettingRow({
      provider, name, cfg, showBaseURL: true,
      onSave: (baseURL, key) => saveSetting(provider, baseURL, key),
      onRemove: () => removeSetting(provider),
    }));
  }

  // byok: one row per provider the server's catalog names (GET
  // /api/v1/byok/providers via the engine's listModels('byok')), not a fixed
  // pair like the two custom endpoints above — the catalog is the source of
  // truth so a provider added server-side shows up here with no client
  // release. No base-URL field: byok always talks to AEGIS's own relay
  // (/api/v1/byok/chat/completions), which is what attaches the AEGIS key
  // and makes the call billable — the provider key typed here authenticates
  // to the UPSTREAM provider only.
  try {
    const byokData = await models.listModels('byok');
    const byokProviders = Array.isArray(byokData && byokData.providers) ? byokData.providers : [];
    for (const p of byokProviders) {
      if (!p || !p.id) continue;
      const provider = `byok:${p.id}`;
      const local = settings.find((s) => s.provider === provider) || {
        provider, baseURL: '', configured: false, keyMask: null,
      };
      els.settingsList.appendChild(buildSettingRow({
        provider, name: `BYOK: ${p.label || p.id}`, cfg: local, showBaseURL: false,
        onSave: (_baseURL, key) => saveSetting(provider, '', key),
        onRemove: () => removeSetting(provider),
      }));
    }
    // What AEGIS charges for relaying the turn, stated outright. The figure is
    // the server's own (`fee` on GET /api/v1/byok/providers); nothing is shown
    // when it publishes none, because a hardcoded client-side fee is one that
    // can drift from the ledger that actually bills. Until this line existed
    // the only place the fee was ever disclosed was the CLI's `/class byok`
    // output — a desktop user's per-turn cost figure was the vendor's rate with
    // no mention that AEGIS also collects.
    const fee = byokData && byokData.fee;
    if (fee && !fee.disabled &&
        (Number(fee.in_usd_per_1k) > 0 || Number(fee.out_usd_per_1k) > 0)) {
      const note = document.createElement('div');
      note.className = 'setting-row';
      note.id = 'byok-fee-note';
      const text = document.createElement('div');
      text.className = 'setting-name';
      const per1k = (n) => `${Number(n).toFixed(4)}`;
      text.textContent =
        `BYOK handling fee: ${per1k(fee.in_usd_per_1k)} / 1k in, ` +
        `${per1k(fee.out_usd_per_1k)} / 1k out — billed to your AEGIS account ` +
        'on top of your own provider bill.';
      note.appendChild(text);
      els.settingsList.appendChild(note);
    }
  } catch {
    /* catalog unreachable (offline, server down) — the two custom rows above still work */
  }
}

async function saveSetting(provider, baseURL, key) {
  els.settingsHint.textContent = 'saving…';
  try {
    const cfg = { baseURL };
    if (key) cfg.key = key;
    await models.settings.set(provider, cfg);
    els.settingsHint.textContent = 'saved.';
    await loadSettings();
    await loadModels(els.classSelect.value);
  } catch (err) {
    els.settingsHint.textContent =
      `save failed: ${err && err.message ? err.message : err}`;
  }
}

async function removeSetting(provider) {
  els.settingsHint.textContent = 'removing…';
  try {
    await models.settings.remove(provider);
    els.settingsHint.textContent = 'removed.';
    await loadSettings();
    await loadModels(els.classSelect.value);
  } catch (err) {
    els.settingsHint.textContent =
      `remove failed: ${err && err.message ? err.message : err}`;
  }
}

// -------------------------------------------------------------- sessions pane

async function loadSessions() {
  els.sessionsList.innerHTML = '';
  els.sessionsHint.textContent = '';
  let sessions = [];
  try {
    const data = await sync.listSessions();
    sessions = (data && data.sessions) || [];
  } catch (err) {
    els.sessionsHint.textContent =
      `list failed: ${err && err.message ? err.message : err}`;
    return;
  }

  if (!sessions.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'no sessions yet';
    els.sessionsList.appendChild(li);
    return;
  }

  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'session-row';
    li.tabIndex = 0;

    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = (s && s.title) || (s && s.id) || 'untitled';
    li.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'session-meta';
    const count = (s && Array.isArray(s.messages) && s.messages.length) || 0;
    const when = (s && s.updatedAt)
      ? new Date(s.updatedAt).toLocaleTimeString()
      : '';
    meta.textContent =
      `${count} msg${count === 1 ? '' : 's'}${when ? ' · ' + when : ''}`;
    li.appendChild(meta);

    li.addEventListener('click', () => openSession(s.id));
    els.sessionsList.appendChild(li);
  }
}

function renderSyncStatus(status) {
  if (!els.syncStatus) return;
  if (!status) {
    els.syncStatus.textContent = '';
    return;
  }
  const bits = [status.cloud ? 'cloud sync on' : 'cloud sync off (no key)', `${status.pending} pending`];
  if (status.lastSyncAt) {
    bits.push(`last synced ${new Date(status.lastSyncAt).toLocaleTimeString()}`);
  }
  // The heartbeat retry's last failure (main.js createHeartbeatRetry). It is
  // fire-and-forget, so this is the only place its reason is visible instead of
  // being swallowed by an empty catch.
  if (status.retry && status.retry.lastError) {
    bits.push(`last sync attempt failed: ${status.retry.lastError}`);
  }
  els.syncStatus.textContent = bits.join(' · ');
}

async function refreshSyncStatus() {
  try {
    renderSyncStatus(await sync.status());
  } catch {
    renderSyncStatus(null);
  }
}

/** Explicit "Sync now" — push pending sessions, then pull remote ones.
 *  Offline-first: sync.push()/sync.pull() resolve `{ ok:false, reason }`
 *  rather than throwing, so this only hits the catch on an unexpected error. */
/**
 * Persisting memory after a turn: ask main to push what just finished.
 *
 * Deliberately unawaited — the answer is already on screen and in the local
 * session store, so cloud memory is strictly extra and the composer must come
 * back the moment the answer lands, not after a round trip. The decision to
 * push at all is main's (lib/sync/persist-gate.js reads the `__memoryPersist`
 * preference off disk and returns `{ skipped: true }` when it is off); this is
 * a request, not a gate, which is why no preference is read here.
 *
 * It cannot throw — createAutoPush resolves on every failure — but the
 * `.catch` stays: an unhandled rejection in the renderer is how a background
 * convenience turns into a fatal.
 */
function autoPersistTurn() {
  if (typeof sync.auto !== 'function') return;
  sync
    .auto()
    .then((result) => {
      // Same notice as syncNow(): the cap is the one sync outcome the user
      // must see rather than have silently absorbed.
      if (result && result.upgrade) {
        capNotice(
          els.sessionsHint,
          result.upgrade,
          'queued memory is waiting on the free-plan cap',
          'Upgrade to sync it →'
        );
      }
    })
    .catch(() => {
      /* persistence is non-fatal */
    });
}

async function syncNow() {
  els.syncNow.disabled = true;
  els.sessionsHint.textContent = 'syncing…';
  try {
    const pushResult = await sync.push();
    const pullResult = await sync.pull();
    if (pushResult.upgrade || pullResult.upgrade) {
      // The queued memory-save flush hit the free-plan cap. main.js stops the
      // flush at that point rather than reporting a clean "synced" while every
      // entry silently stays queued — point at the plan page instead.
      capNotice(
        els.sessionsHint,
        pushResult.upgrade || pullResult.upgrade,
        'queued memory is waiting on the free-plan cap',
        'Upgrade to sync it →'
      );
    } else if (!pushResult.ok && !pullResult.ok) {
      els.sessionsHint.textContent =
        `sync failed: ${pushResult.reason || pullResult.reason || 'unknown error'}`;
    } else {
      els.sessionsHint.textContent =
        `synced (pushed ${pushResult.pushed || 0}, pulled ${pullResult.merged || 0})`;
    }
  } catch (err) {
    els.sessionsHint.textContent = `sync failed: ${err && err.message ? err.message : err}`;
  } finally {
    els.syncNow.disabled = false;
    await refreshSyncStatus();
    await loadSessions();
  }
}

function openSession(id) {
  sync.open(id)
    .then((s) => {
      if (!s) {
        els.sessionsHint.textContent = 'session not found';
        return;
      }
      els.messages.innerHTML = '';
      const msgs = Array.isArray(s.messages) ? s.messages : [];
      if (!msgs.length) renderWelcome();
      for (const m of msgs) {
        const role =
          m.role === 'assistant' ? 'assistant'
            : m.role === 'system' ? 'system'
              : 'user';
        addMessage(role, m.content || m.text || '', undefined, role === 'assistant' ? s.id : undefined);
      }
      // Resuming a past conversation must resume its context too, not just
      // its on-screen transcript — continuing it as sessionId reuses the same
      // id and threadMessages carries the prior turns into the next send().
      currentSessionId = s.id;
      // A resumed thread resumes its spend too. The shared store's ledger rows
      // carry `tokens`/`costUsd` (client/session-store.js recordExchange writes
      // exactly the shape rollMessages reads), so the rolling total is rebuilt
      // from what was really recorded rather than restarting at zero — the
      // CLI's aggregateSessionUsage, which sums history.jsonl for the same
      // reason. A row this window wrote before ledgerFields existed carries no
      // `tokens` and folds as unaccounted, which is stated rather than guessed.
      rollsBySession.set(s.id, rollMessages(msgs));
      renderRollMeter(s.id);
      threadMessages = msgs
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content || m.text || '' }));
      els.sessionsHint.textContent = `opened ${s.id.slice(0, 8)}…`;
    })
    .catch((err) => {
      els.sessionsHint.textContent =
        `open failed: ${err && err.message ? err.message : err}`;
    });
}

/**
 * Export the open thread to a user-picked file — Markdown or JSON, both
 * serialized in main.js from the same lib/sync/sessions.js record `sync.*`
 * already uses as the source of truth. One code path for all three entry
 * points: the sidebar's Export button and both File-menu items (see boot()
 * wiring below) call this with the format they want.
 */
function exportSession(format) {
  const id = currentSessionId;
  if (!id) {
    els.sessionsHint.textContent = 'no open session to export';
    return;
  }
  aegis.exportSession(id, format)
    .then((result) => {
      if (result && result.ok) {
        els.sessionsHint.textContent = `exported to ${result.filePath}`;
      } else if (!result || !result.canceled) {
        els.sessionsHint.textContent =
          `export failed: ${(result && result.reason) || 'unknown error'}`;
      }
    })
    .catch((err) => {
      els.sessionsHint.textContent =
        `export failed: ${err && err.message ? err.message : err}`;
    });
}

function newChat() {
  abortBranches();
  // A fresh thread must never inherit the outgoing one's "allow for this
  // session" tool grants (desktop/lib/local/engine.js sessionAllowlists is
  // keyed by this exact id) — best-effort, never blocks starting the chat.
  if (currentSessionId) {
    models.clearApprovals(currentSessionId).catch(() => {});
  }
  renderWelcome();
  els.sessionsHint.textContent = '';
  pendingEl = null;
  pendingSessionId = null;
  currentSessionId = null;
  threadMessages = [];
  flowCount = 0;
  // A fresh thread opens with an empty meter. The outgoing session's roll is
  // left in the map (reopening it rebuilds from the store anyway), but the
  // topbar must not keep showing the thread the user just left — `sessionId`
  // nulls out here and the new id is minted on the first send, so nothing is
  // hidden that will not reappear with this thread's own number.
  renderRollMeter(null);
}

/**
 * Route a resolved aegis:// link (main.js DEEP_LINK_CHANNEL, see
 * preload.js onDeepLink) into the UI: `open` jumps straight to the named
 * session; `new` starts a fresh thread with the prompt prefilled in the
 * composer — prefilled, not auto-sent, so the user still confirms before
 * anything reaches a model.
 */
function handleDeepLink(parsed) {
  if (!parsed) return;
  if (parsed.action === 'open' && parsed.sessionId) {
    openSession(parsed.sessionId);
    return;
  }
  if (parsed.action === 'new') {
    newChat();
    if (parsed.prompt) {
      els.prompt.value = parsed.prompt;
      els.prompt.focus();
    }
  }
}

// ------------------------------------------------------------------ actions

async function send() {
  const prompt = els.prompt.value.trim();
  if (!prompt || els.send.disabled) return;

  const cls = els.classSelect.value;
  const model = CUSTOM_CLASSES.has(cls)
    ? els.modelInput.value.trim()
    : els.modelSelect.value;
  // A custom endpoint has no default model, and a blank id reaches the
  // provider as `model: undefined` (defect B). Ask for it instead of sending.
  if (CUSTOM_CLASSES.has(cls) && !model) {
    els.modelHint.textContent =
      MODEL_ID_PLACEHOLDER[cls] || 'type a model id before sending.';
    els.modelInput.focus();
    return;
  }

  els.prompt.value = '';
  // Clear the stop flag a previous turn may have left set, so a stale `true`
  // can never make an unrelated failure look like a deliberate stop.
  userStopped = false;
  addMessage('user', prompt);

  // What this request travels with, resolved from ONE authority by budgetFor:
  // the Effort rung for a model that reasons against its own output budget (or
  // a class that requires the field), and no `max_tokens` at all otherwise.
  // Nothing here guesses an answer's length — the old dropdown asked the user
  // to, and the guess was wrong in both directions: aegis1 sizes the pooled
  // class from `effort` itself and reads a body max_tokens as a ceiling *over*
  // its ladder (services/pool_brain.py pass_budgets), while a DeepSeek
  // reasoning model bills hidden chain-of-thought against this same budget, so
  // the 4k default was spent before the first visible token.
  const autonomous = cls === AUTONOMOUS_CLASS && autonomousEnabled();
  // Sent whether or not the fan-out is ticked: the fan-out is enabled by the
  // model id the pooled class sends, so a turn that never entered autonomous
  // mode still ran pooled and had no way to say how big it should be — and a
  // DeepSeek reasoning model needs it to size its CoT. `undefined` = "auto" =
  // the server (or the engine's rung default) infers it.
  const effort = effortFor();
  const maxTokens = budgetFor(cls, model, undefined, effort);
  const workers = autonomous ? parseInt(els.autonomousWorkers.value, 10) || undefined : undefined;
  // Reuse the open thread's session id (minted once, on its first message)
  // instead of a fresh one per send — a new id every turn is what made both
  // the local `messages` history below and the cloud class's server-side
  // session memory reset on every single message.
  if (!currentSessionId) currentSessionId = newSessionId();
  const sessionId = currentSessionId;
  pendingSessionId = sessionId;

  // Snapshot prior turns for the model — the new prompt travels separately
  // as `prompt` and providers.js appends it after `messages` on the wire.
  const historyForModel = threadMessages.slice();
  threadMessages.push({ role: 'user', content: prompt });

  setBusy(true, { cancellable: true });
  // Sending is an explicit act, so it always returns the view to the tail.
  // This is the single moment the auto-scroll overrides the reader's scroll.
  stickToBottom({ force: true });

  // Persist the user turn locally (best-effort — never blocks chat).
  try {
    await sync.append(sessionId, { role: 'user', content: prompt });
  } catch {
    /* persistence is non-fatal */
  }

  let streamedText = '';
  let reasoningText = '';
  const toolLog = [];

  // Text arrives in dozens of small chunks per second; painting each one is
  // what made the window feel locked up. One paint per frame, off the latest
  // cumulative text.
  const paintStream = rafPainter(() => {
    if (!pendingEl) return;
    pendingEl.classList.remove('pending');
    if (reasoningText) {
      const rEl = ensureReasoningEl(pendingEl);
      if (rEl.textContent !== reasoningText) rEl.textContent = reasoningText;
    }
    const bodyEl = pendingEl.querySelector('.body');
    if (bodyEl && bodyEl.textContent !== streamedText) bodyEl.textContent = streamedText;
    // Live estimate so the topbar meter keeps moving while the reply streams
    // in, instead of sitting frozen on the previous turn's total until this
    // one resolves — see renderRollMeter's `live` param.
    renderRollMeter(sessionId, { prompt, reply: streamedText, reasoning: reasoningText });
    stickToBottom();
  });

  const onDelta = (chunk) => {
    // Extended-reasoning trace from a pooled brain turn: the fan-out's worker
    // findings, streamed before the synthesis pass writes the answer. Shown so
    // "work autonomously" doesn't look idle for the whole worker phase.
    if (chunk && typeof chunk.reasoning === 'string' && chunk.reasoning) {
      reasoningText += chunk.reasoning;
      paintStream();
      return;
    }
    if (chunk && chunk.approval) {
      const row = ensurePendingRow();
      row.classList.remove('pending');
      renderApprovalCard(row, chunk.approval, '.body');
      // Forced on purpose: the turn is blocked until this is answered, so
      // the card has to be brought into view even if the reader scrolled up.
      stickToBottom({ force: true });
      return;
    }
    if (chunk && chunk.tool) {
      // See the flow-stream handler above: the run frame is the CLI's live
      // row. Ignored here, and ignored *before* `toolLog.push` — a run frame
      // counted as a completed tool would inflate the turn summary's tool
      // count for a call that hasn't run yet.
      if (chunk.tool.phase === 'run') { captureDiffPreview(chunk.tool); return; }
      toolLog.push(chunk.tool);
      const row = ensurePendingRow();
      row.classList.remove('pending');
      appendToolActivity(row, chunk.tool, 'tool-activity', '.body');
      stickToBottom();
      return;
    }
    const delta =
      chunk && (typeof chunk.delta === 'string' ? chunk.delta : chunk.content);
    if (!delta) return;
    streamedText += delta;
    paintStream();
  };

  try {
    // All four classes route through the model: surface (the main process
    // decides transport — cloud client, ollama, or a direct provider).
    const data = await models.chat(
      { class: cls, prompt, model, maxTokens, sessionId, autonomous, effort, workers, messages: historyForModel },
      onDelta
    );

    const choice = (data && data.choices && data.choices[0]) || {};
    const text =
      (choice.message && choice.message.content) ||
      streamedText ||
      '(empty response)';
    threadMessages.push({ role: 'assistant', content: text });
    const bits = [];
    if (data && data.model) bits.push(`model: ${data.model}`);
    else if (model) bits.push(`model: ${model}`);
    bits.push(classLabel(cls));
    if (autonomous) bits.push(`autonomous (${effort || 'auto'}, ${workers || 'auto'}w)`);
    // The budget rung is worth showing even without the fan-out: on the pooled
    // class it is what sized the call, and a user cannot tell a 16k turn from a
    // 64k one by looking at the answer.
    else if (effort) bits.push(`effort: ${effort}`);
    // Tokens AND what they cost, on the CLI's rule: a pooled turn's settled
    // charge (`costUsd`) is reported verbatim, and only a turn without one is
    // priced from the local rate table and marked an estimate. Printing tokens
    // alone left this surface with no comparable meter at all — the desktop
    // and the CLI run the same engine, so a gap between them had to be
    // measured on the same prompt, and one side was not measuring.
    const turn = turnAccounting(data && data.usage, model, {
      costUsd: data && typeof data.costUsd === 'number' ? data.costUsd : undefined,
    });
    if (turn.tokens != null) bits.push(`tokens: ${turn.tokens}`);
    // A turn the wire did not report on still gets a figure — the same text
    // estimate that goes into the session total, marked `~` so an inferred
    // count is never read as a reported one. Printing nothing here while the
    // session total moved was the other half of "the counter looks dead".
    else {
      const est = estimatedBuckets(prompt, text, text === reasoningText ? '' : reasoningText);
      if (est) bits.push(`~${est.input + est.output} tokens`);
    }
    if (turn.cost != null) bits.push(fmtCost(turn.cost, turn.real));
    // …and on the byok class, whose money that figure is. The relay never
    // returns a settled charge (nothing on that route emits one), so this is
    // always the rate table's estimate of the caller's OWN provider bill — and
    // AEGIS additionally collects a handling fee on the same turn, which this
    // response cannot price. One bit, and the number stops reading as the whole
    // cost of a BYOK turn.
    if (cls === 'byok' && turn.cost != null) {
      bits.push('your provider bill (est.) + AEGIS handling fee');
    }
    // …AND the running session total beside it, which is the number the CLI
    // prints. The per-turn figure answers "what did that call cost"; only the
    // rolling one answers "what has this conversation cost", and it was the
    // missing half. Folded here rather than only on the meter so a turn that
    // reported no usage still counts as a turn (rollTurn counts before it
    // tests the count) instead of vanishing from the session.
    const roll = foldRoll(sessionId, data && data.usage, {
      model,
      costUsd: data && typeof data.costUsd === 'number' ? data.costUsd : undefined,
      calls: data && data.calls,
      // The turn's own text, used ONLY when the wire reported no usage — so
      // such a turn is estimated and counted rather than dropped. This is the
      // CLI's `appendHistory` rule and the reason the total moves every turn.
      prompt,
      reply: text,
      // The thinking trace is billed output and is not part of `text`, so it is
      // counted here too — guarded, because the same string must never be
      // estimated twice if a turn ever collapses the two into one.
      reasoning: text === reasoningText ? '' : reasoningText,
    });
    const rollLine = fmtRoll(roll);
    if (rollLine) bits.push(`session: ${rollLine}`);
    addMessage('assistant', text, bits.join(' · ') || undefined, sessionId, toolLog);

    try {
      await sync.append(sessionId, {
        role: 'assistant',
        content: text,
        // The turn's ledger fields, so this window's spend survives the window
        // — see ledgerFields. This is what makes the rolling meter the same
        // quantity after a reopen as it was before one.
        ...ledgerFields(data && data.usage, model, turn, {
          prompt,
          reply: text,
          // The thinking trace is billed output and is not part of `text`; it
          // has to persist too, or reopening the window rebuilds a roll short
          // by the longest part of the turn.
          reasoning: text === reasoningText ? '' : reasoningText,
          calls: data && data.calls,
        }),
      });
      await sync.save({ id: sessionId, title: prompt.slice(0, 60) });
    } catch {
      /* persistence is non-fatal */
    }

    // Persisting memory: the finished turn goes to the cloud on its own now.
    autoPersistTurn();

    // The AI's second path: not awaited — the lane streams beside the thread
    // while the composer goes straight back to the user (chat flow D2.2).
    if (exploreEnabled() && text !== '(empty response)') {
      addFlowLane({ prompt, cls, model, maxTokens, parentSessionId: sessionId });
    }
  } catch (err) {
    // A stop is not a failure. The transport rethrows on abort — the SSE read
    // rejects and the loop re-raises — so the naive path here would discard
    // everything already streamed and answer with a red "aborted" error,
    // destroying the partial reply at the exact moment the user asked to keep
    // it. Salvage the partial turn and label it honestly instead.
    if (isCancellation(err, { userStopped })) {
      const text = streamedText || reasoningText || '(stopped before any output)';
      threadMessages.push({ role: 'assistant', content: text });
      // A stopped turn is a real exchange and the CLI records one: its
      // `appendHistory` writes a `status: 'stopped'` entry for every stopped
      // turn, and `aggregateSessionUsage` sums it like any other. The desktop
      // wrote `{role, content}` and folded nothing, so an Escape mid-answer
      // left the session total standing still on a turn the provider had
      // already billed. Folded here like any other turn; with no wire usage
      // on this path the figure is the text estimate, marked `est` — and
      // never a fabricated zero.
      const turn = turnAccounting(undefined, model, {});
      const roll = foldRoll(sessionId, undefined, {
        model,
        prompt,
        reply: text,
        reasoning: text === reasoningText ? '' : reasoningText,
      });
      const stopBits = ['stopped by you'];
      if (turn.tokens != null) stopBits.push(`tokens: ${turn.tokens}`);
      else {
        const est = estimatedBuckets(prompt, text, text === reasoningText ? '' : reasoningText);
        if (est) stopBits.push(`~${est.input + est.output} tokens`);
      }
      const stopRollLine = fmtRoll(roll);
      if (stopRollLine) stopBits.push(`session: ${stopRollLine}`);
      addMessage('assistant', text, stopBits.join(' · '), sessionId, toolLog);
      try {
        await sync.append(sessionId, {
          role: 'assistant',
          content: text,
          ...ledgerFields(undefined, model, turn, {
            prompt,
            reply: text,
            reasoning: text === reasoningText ? '' : reasoningText,
          }),
        });
      } catch {
        /* persistence is non-fatal */
      }
      // A stopped turn is persisted too, and on purpose: this is the case a
      // round-horizon stop produces (the model was cut off mid-work), and the
      // partial transcript is exactly what the next turn needs restored.
      autoPersistTurn();
    } else {
      addMessage(
        'assistant',
        `Error: ${err && err.message ? err.message : err}`,
        'request failed'
      );
    }
  } finally {
    setBusy(false);
    pendingSessionId = null;
    loadSessions();
  }
}

// ------------------------------------------------------------ scroll lift

/**
 * Toggle `body.is-scrolled` while any scrolling pane is off its top edge, so
 * the topbar can lift off the content sliding under it (see the "scroll lift"
 * section in style.css).
 *
 * This only *chooses the panes*: the listener, the per-frame coalescing and the
 * class toggle are `attachScrollLift()` in transcript-view.js, the one owner of
 * `scroll` listeners (see the guard at 5b in test/renderer-wiring.test.mjs). A
 * second registration here would be a second definition of "how far down the
 * reader is", which is how such flags silently stop agreeing.
 *
 * The panes are found by the classes that give them `overflow-y: auto` rather
 * than through `els`: `.side` and `.memory-scroll` have no element ids to
 * register, and those three classes are exactly the set the stylesheet names.
 * The `requestFrame` wrapper (not the bare global) keeps the receiver —
 * `requestAnimationFrame` throws when called detached from `window`.
 */
function installScrollLift() {
  attachScrollLift({
    panes: document.querySelectorAll('.messages, .side, .memory-scroll'),
    target: document.body,
    requestFrame: (fn) => window.requestAnimationFrame(fn),
  });
}

// --------------------------------------------------------------------- boot

/**
 * Wire the host-facing surfaces: any listeners to the preload API and to the
 * local element handles that need to exist for the rest of the app to respond.
 */
async function init() {
  try {
    renderStatus(await aegis.status());
  } catch {
    renderStatus(null);
  }

  // There is no max-tokens control to restore: it asked the user to state an
  // answer's length before the answer existed, so it is gone (see budget.js).

  // Work-autonomously is opt-in per machine, remembered across restarts;
  // only ever sent when the active class is AEGIS Cloud (see AUTONOMOUS_CLASS).
  const savedAutonomous = localStorage.getItem(AUTONOMOUS_KEY);
  if (savedAutonomous === 'on') els.autonomousToggle.checked = true;
  els.autonomousToggle.addEventListener('change', () => {
    localStorage.setItem(AUTONOMOUS_KEY, els.autonomousToggle.checked ? 'on' : 'off');
    updateAutonomousControlsVisibility();
  });

  // The one budget control: which rung sizes the call, or "auto" to let the
  // server infer it from the ask (aegis1 services/pool_brain.py
  // parse_brain_request). Applies to EVERY class now — with the max-tokens
  // dropdown gone there is nothing else that sizes a call — so it is no longer
  // stored under the autonomous-mode namespace; an install predating the rename
  // is read from the old key once, and a stored rung this build's list no
  // longer offers falls through to the markup's default rather than assigning
  // an option that does not exist.
  const savedEffort = localStorage.getItem(EFFORT_KEY) || localStorage.getItem(LEGACY_EFFORT_KEY);
  if (savedEffort && Array.from(els.effortSelect.options).some((o) => o.value === savedEffort)) {
    els.effortSelect.value = savedEffort;
  }
  els.effortSelect.addEventListener('change', () => {
    localStorage.setItem(EFFORT_KEY, els.effortSelect.value);
    updateBudgetControls(els.classSelect.value);
  });
  // A typed model id changes what the rung buys (a DeepSeek reasoning id is
  // sized by it, a plain OpenAI-compatible one sends no cap at all), so the
  // note has to follow the keystrokes rather than wait for a class change.
  els.modelInput.addEventListener('input', () => updateBudgetControls(els.classSelect.value));
  // Worker count for the fan-out. Left empty by default on purpose: an empty
  // field is what tells the server to size the fan-out from the ask
  // (parse_brain_request's auto path) instead of the old client-side default of
  // 3, which made every turn a 4-pass fan-out.
  const savedWorkers = localStorage.getItem(AUTONOMOUS_WORKERS_KEY);
  if (savedWorkers) els.autonomousWorkers.value = savedWorkers;
  els.autonomousWorkers.addEventListener('change', () => {
    localStorage.setItem(AUTONOMOUS_WORKERS_KEY, els.autonomousWorkers.value);
  });
  updateAutonomousControlsVisibility();

  // The discovery lane is opt-in, remembered across restarts.
  //
  // This used to read `savedExplore === 'off'` against a checkbox that shipped
  // `checked` in index.html, i.e. the opposite of the comment above it: a fresh
  // install (no `aegis.explore` key, and nothing had ever written one) landed
  // with the lane ON and billed two extra model calls after every single turn —
  // ~3× the tokens of a plain reply, silently, because the lane is
  // fire-and-forget and never looks slow. Only an explicit 'on' turns it on
  // now; every other state, including "never asked", means off.
  const savedExplore = localStorage.getItem(EXPLORE_KEY);
  els.exploreToggle.checked = savedExplore === 'on';
  els.exploreToggle.addEventListener('change', () => {
    localStorage.setItem(EXPLORE_KEY, els.exploreToggle.checked ? 'on' : 'off');
    if (!els.exploreToggle.checked) abortBranches();
  });

  els.classSelect.addEventListener('change', () => {
    localStorage.setItem(CLASS_KEY, els.classSelect.value);
    // Apply the budget-control choice immediately rather than waiting for the
    // model list: loadModels() is async, and until it resolves the previous
    // class's control would still be on screen — showing a token cap on a
    // pooled turn, or hiding the effort rung it runs on.
    updateBudgetControls(els.classSelect.value);
    loadModels(els.classSelect.value);
  });

  els.modelSelect.addEventListener('change', () => {
    // Display-only (see budget.js): the model's own advertised output limit,
    // which is never the number this app puts on a request.
    const ceiling = maxTokensCeiling(modelMeta.get(els.modelSelect.value));
    const base = els.modelHint.textContent.replace(/ · max output: [\d,]+$/, '');
    els.modelHint.textContent =
      ceiling < FLAT_CEILING ? `${base} · max output: ${ceiling.toLocaleString()}` : base;
    updateBudgetControls(els.classSelect.value);
  });

  els.modelPreset.addEventListener('change', () => {
    applyCustomPreset(els.classSelect.value, els.modelPreset.value);
  });

  els.newChat.addEventListener('click', newChat);
  // Native File > New Chat (Cmd/Ctrl+N) and View > Search (Cmd/Ctrl+K) —
  // main.js's application menu has no renderer state of its own, so it just
  // pings these channels (see preload.js onMenuNewChat/onMenuSearch).
  if (aegis.onMenuNewChat) aegis.onMenuNewChat(newChat);
  if (aegis.onMenuSearch) aegis.onMenuSearch(openMemoryOverlay);
  // File > Save as… / Export Session… — same "menu pings, renderer acts"
  // pattern as New Chat/Search above; both call exportSession() with the
  // format the menu label promised (see main.js buildAppMenu).
  if (aegis.onMenuExportMarkdown) aegis.onMenuExportMarkdown(() => exportSession('markdown'));
  if (aegis.onMenuExportJson) aegis.onMenuExportJson(() => exportSession('json'));
  // aegis:// deep link (main.js sendDeepLinkToWindow) — delivered once the
  // window has finished loading, so registering it here at boot is in time
  // for both a cold-launch link and one that arrives while running.
  if (aegis.onDeepLink) aegis.onDeepLink(handleDeepLink);
  // Quick launcher "add to chat" push (main.js pushQuickLauncherResult) —
  // same ping/act split as the channels above.
  if (aegis.onQuickLauncherPush) aegis.onQuickLauncherPush(handleQuickLauncherPush);
  els.sessionsRefresh.addEventListener('click', loadSessions);
  els.syncNow.addEventListener('click', syncNow);
  els.sessionsExport.addEventListener('click', () => exportSession('markdown'));

  els.apiKeySave.addEventListener('click', saveApiKey);
  els.apiKeyVerify.addEventListener('click', verifyAegisKey);
  els.apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveApiKey();
    }
  });

  // Billing actions in the Status card — see startBilling()/renderBillingError().
  els.upgradePlan.addEventListener('click', () => startBilling('upgrade'));
  els.topupBtn.addEventListener('click', () => startBilling('topup'));

  // Depth on the chrome while the panes are scrolled (see style.css).
  installScrollLift();

  els.quickLauncherSave.addEventListener('click', saveQuickLauncherSettings);
  els.quickLauncherShortcut.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveQuickLauncherSettings();
    }
  });

  // Tool-approval switch: persist on change (no Save button), repainting from
  // what the main process stored — see saveConfirmMode.
  if (els.confirmMode) {
    els.confirmMode.addEventListener('change', () => saveConfirmMode(els.confirmMode.checked));
  }

  // The composer chip drives the same switch. It reads the *painted* checkbox
  // (not a cached flag) so the chip and the Settings card can never drift, and
  // it goes through saveConfirmMode so both are repainted from what main
  // actually stored.
  if (els.autoMode) {
    els.autoMode.addEventListener('click', () => {
      if (els.confirmMode) saveConfirmMode(!els.confirmMode.checked);
    });
  }

  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });

  els.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });

  els.memorySearchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    searchMemory(els.memoryQuery.value.trim());
  });

  els.memorySaveBtn.addEventListener('click', saveMemory);
  els.memoryImportBtn.addEventListener('click', importMemory);

  // Memory inspector. `?`-guarded: the overlay markup is optional, and a
  // missing node must degrade to the plain sidebar card, not a boot crash.
  if (els.memoryOpen) els.memoryOpen.addEventListener('click', openMemoryOverlay);
  if (els.memoryClose) els.memoryClose.addEventListener('click', closeMemoryOverlay);
  if (els.memoryBackdrop) els.memoryBackdrop.addEventListener('click', closeMemoryOverlay);
  if (els.memoryOverlaySave) els.memoryOverlaySave.addEventListener('click', saveMemory);
  if (els.memoryFilters) {
    els.memoryFilters.addEventListener('submit', (e) => {
      e.preventDefault();
      memoryView.query = els.memoryOverlayQuery.value.trim();
      loadMemoryOverlay(memoryView.query);
    });
  }
  if (els.memoryFiltersClear) {
    els.memoryFiltersClear.addEventListener('click', () => {
      els.memoryOverlayQuery.value = '';
      memoryView.query = '';
      memoryView.source = '';
      memoryView.role = '';
      renderMemoryOverlay();
    });
  }
  // ── the autonomous queue card ────────────────────────────────────────────
  // The queue half of this file (window.queue -> main.js registerQueueIpc ->
  // desktop/lib/local/queue.js + autonomous.js) shipped with every handler
  // written and none of them reachable: no listener on the four buttons, no
  // paint at boot, no subscriber to the drain's progress channel. So the card
  // was dead markup — a Queue / Run one / Drain all / Stop row that did
  // nothing and a task list that never filled, while the module comments above
  // described the behaviour as if it were live. This block is the missing
  // wiring, and deliberately nothing more.
  //
  // Draining stays a click, exactly as the queue section above promises:
  // nothing here starts a drain. There is no interval, no drain-on-idle and no
  // drain at boot — the one call made here is loadQueueState(), which asks
  // main for queue.list() and paints it.
  //
  // The `queueApi` guard is the preload-less case (a preload predating the
  // queue surface has no `window.queue` at all): binding `undefined.list` would
  // throw at boot and take every binding after this point down with it, so an
  // old preload degrades to dead markup instead.
  if (queueApi) {
    if (els.queueEnqueue) els.queueEnqueue.addEventListener('click', enqueueQueueTask);
    // `Run one` and `Drain all` are the two buttons the header of the queue
    // section names as the only triggers of a drain; Stop cancels the turn in
    // flight and the loop (via main), it never starts one.
    if (els.queueDrain) els.queueDrain.addEventListener('click', () => startQueueDrain('one'));
    if (els.queueProceed) els.queueProceed.addEventListener('click', () => startQueueDrain('all'));
    if (els.queueStop) els.queueStop.addEventListener('click', stopQueueDrain);
    // A worker's frames are a status line, never transcript entries (that
    // separation is main.js's own progress channel, not aegis:chatDelta).
    if (typeof queueApi.onProgress === 'function') queueApi.onProgress(renderQueueProgress);
    // Paint the card once, from state that already exists on disk. A list, not a
    // drain: queueing a task in another window (or from the CLI) and opening
    // this one must show that task, and must not run it.
    await loadQueueState();
  }

  // The transcript's scroll/paint/Escape policy. Both listeners are registered
  // inside transcript-view.js so the behaviours they enforce are the ones
  // test/renderer-dom.test.mjs drives: the passive `scroll` listener is the
  // reader's veto over the streaming auto-scroll (without it the transcript
  // stays pinned to the tail no matter how far up you read while a model is
  // working), and the `keydown` listener is Escape-as-interrupt (the keyboard
  // twin of the cancel button, for the window that is too busy to aim at it).
  transcript = createTranscriptView({
    messages: els.messages,
    requestFrame: (fn) => requestAnimationFrame(fn),
  });
  transcript.attachScrollVeto();
  // Read-only diagnostic surface for the headless smoke run
  // (test/electron-smoke.mjs). Everything in this file lives inside the IIFE,
  // so an injected script cannot otherwise see the scroll veto — the Phase 9
  // harness read `transcript.isScrolledUp()` directly and silently got `null`,
  // which made its veto assertion unfalsifiable. Exposes state only: no
  // setters, nothing that can drive the UI. Frozen so a stray write in a test
  // cannot fake a passing run.
  window.__aegisSmoke = Object.freeze({
    isScrolledUp: () => transcript.isScrolledUp(),
    metrics: () => transcript.metrics(),
  });
  bindEscapeInterrupt({
    doc: document,
    // The memory overlay wins: while it is open, Escape closes it rather than
    // reaching past it to cancel a turn the user may not be looking at.
    isOverlayOpen: overlayOpen,
    onOverlayEscape: closeMemoryOverlay,
    hasPendingTurn: () => !!pendingSessionId,
    stopTurn: stopPendingTurn,
  });

  // Auto-update banner: `?`-guarded like the memory inspector above, since
  // the markup is optional and a missing node must never crash boot.
  if (els.updateBanner && aegis.onUpdateStatus) {
    aegis.onUpdateStatus(renderUpdateBanner);
    aegis.updateStatus().then(renderUpdateBanner).catch(() => {});

    els.updateDownloadBtn.addEventListener('click', () => {
      els.updateDownloadBtn.disabled = true;
      aegis.downloadUpdate().finally(() => {
        els.updateDownloadBtn.disabled = false;
      });
    });

    // The only place quitAndInstallUpdate is ever called — an explicit user
    // click. Nothing in this app restarts itself without that.
    els.updateRestartBtn.addEventListener('click', () => {
      aegis.quitAndInstallUpdate();
    });

    // A failed check used to have no affordance at all: the only way back was
    // the app menu, which nobody who just read "Update check failed" would
    // think to open. Retry re-checks explicitly, which also means the main
    // process will report a further failure instead of swallowing it.
    if (els.updateRetryBtn && aegis.checkForUpdates) {
      els.updateRetryBtn.addEventListener('click', () => {
        els.updateRetryBtn.disabled = true;
        Promise.resolve(aegis.checkForUpdates())
          .then(renderUpdateBanner)
          .catch(() => {})
          .finally(() => {
            els.updateRetryBtn.disabled = false;
          });
      });
    }

    els.updateLaterBtn.addEventListener('click', () => {
      updateDismissedFor = lastUpdateState && lastUpdateState.status;
      els.updateBanner.hidden = true;
    });
  }

  // First paint: show the welcome panel unless a session already rendered rows.
  if (!els.messages.querySelector('.msg, .chatflow')) renderWelcome();

  await loadClasses();
  await loadSettings();
  await loadQuickLauncherSettings();
  await loadConfirmMode();
  await loadSessions();
  await refreshSyncStatus();
  loadAccountInfo();
  searchMemory('');
}

// Boot only after the DOM is parsed so every control this script queries
// actually exists. If the script is already running post-DOM this is a no-op;
// if it was loaded early (e.g. <head> without defer) this prevents the
// null-element boot crash that left Save/Verify unbound and dropdowns empty.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
