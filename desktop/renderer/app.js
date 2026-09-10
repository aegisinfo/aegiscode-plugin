'use strict';

/**
 * AEGIS Desktop renderer — thin UI only.
 *
 * Talks exclusively to the surfaces exposed by preload.js (contextBridge):
 *   - window.aegis.*   cloud status / memory / account (back-compat surface)
 *   - window.models.*  4-class provider layer (Aegis Cloud, BYOK, Ollama,
 *                      custom OpenAI-/Anthropic-compatible) — the chat path
 *   - window.sync.*    local session persistence + cloud push/pull (P3 §7)
 *
 * No engine/routing logic lives here; the model class is the user's explicit
 * selection, routed in the main process. If this file grows engine logic it is
 * wrong.
 *
 * `maxTokensCeiling`/`FLAT_CEILING` come from max-tokens.js, a sibling
 * classic script loaded before this one (see index.html) so the per-model
 * ceiling math stays unit-testable without window.aegis/window.models.
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
  connDot: 'conn-dot',
  connText: 'conn-text',
  app: 'st-app',
  client: 'st-client',
  base: 'st-base',
  key: 'st-key',
  plan: 'st-plan',
  balance: 'st-balance',
  apiKeyInput: 'api-key-input',
  apiKeySave: 'api-key-save',
  apiKeyVerify: 'api-key-verify',
  apiKeyHint: 'api-key-hint',
  classSelect: 'class-select',
  modelSelect: 'model-select',
  modelInput: 'model-input',
  maxTokens: 'max-tokens',
  modelHint: 'model-hint',
  settingsList: 'settings-list',
  settingsHint: 'settings-hint',
  sessionsRefresh: 'sessions-refresh',
  sessionsList: 'sessions-list',
  sessionsHint: 'sessions-hint',
  syncNow: 'sync-now',
  syncStatus: 'sync-status',
  newChat: 'new-chat',
  memorySearchForm: 'memory-search-form',
  memoryQuery: 'memory-query',
  memoryResults: 'memory-results',
  memoryEntry: 'memory-entry',
  memorySaveBtn: 'memory-save-btn',
  memoryHint: 'memory-hint',
  messages: 'messages',
  composer: 'composer',
  prompt: 'prompt',
  send: 'send',
  exploreToggle: 'explore-toggle',
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
const MAX_TOKENS_KEY = 'aegis.maxTokens';
const EXPLORE_KEY = 'aegis.explore';
const CUSTOM_CLASSES = new Set(['openai-compat', 'anthropic']);
// The in-app AEGIS key is stored in a reserved namespace the main process
// already filters out of settings.list(); never render it as a provider row
// even if a stale store still surfaces it (defect #1).
const RESERVED_PROVIDERS = new Set(['__aegis', 'aegis']);

let pendingEl = null;
let pendingSessionId = null;
let classOptions = [];
let modelMeta = new Map(); // model id -> raw model object from listModels() (P2 §6.3 ceiling)

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

function exploreEnabled() {
  const box = els.exploreToggle;
  return Boolean(box && box.checked);
}

// ---------------------------------------------------------------- UI helpers

function setConn(ok, text) {
  els.connDot.classList.toggle('ok', Boolean(ok));
  els.connText.textContent = text;
}

function renderStatus(s) {
  if (!s) {
    setConn(false, 'IPC unavailable');
    return;
  }
  els.app.textContent = s.appVersion ? `v${s.appVersion}` : '–';
  els.client.textContent = s.clientVersion || '–';
  els.base.textContent = s.apiBase || '–';
  els.key.textContent = s.keyConfigured ? s.keyMask : 'not set';
  setConn(s.keyConfigured, s.keyConfigured ? 'key configured' : 'no API key');
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

function renderMemoryResults(results) {
  els.memoryResults.innerHTML = '';
  const list = Array.isArray(results) ? results : [];
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'no memory entries';
    els.memoryResults.appendChild(li);
    return;
  }
  for (const r of list) {
    const li = document.createElement('li');
    li.textContent =
      (r && (r.text || r.entry || r.content)) || JSON.stringify(r);
    els.memoryResults.appendChild(li);
  }
}

async function searchMemory(query) {
  els.memoryHint.textContent = 'searching…';
  try {
    const data = query
      ? await aegis.memorySearch(query, 10)
      : await aegis.memoryList(10);
    renderMemoryResults(data && data.results);
    els.memoryHint.textContent = '';
  } catch (err) {
    els.memoryHint.textContent = `search failed: ${err && err.message ? err.message : err}`;
  }
}

async function saveMemory() {
  const text = els.memoryEntry.value.trim();
  if (!text) return;
  els.memorySaveBtn.disabled = true;
  els.memoryHint.textContent = 'saving…';
  try {
    await aegis.memorySave({ text, source: 'aegis-desktop' });
    els.memoryEntry.value = '';
    els.memoryHint.textContent = 'saved.';
    await searchMemory(els.memoryQuery.value.trim());
  } catch (err) {
    els.memoryHint.textContent = `save failed: ${err && err.message ? err.message : err}`;
  } finally {
    els.memorySaveBtn.disabled = false;
  }
}

// `sessionId`, when given for an assistant message, renders a "copy" button
// that puts the message text on the clipboard.
function addMessage(role, text, meta, sessionId) {
  const row = document.createElement('div');
  row.className = `msg ${role}`;

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent =
    role === 'user' ? 'You' : role === 'assistant' ? 'AEGIS' : 'System';

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text;

  row.appendChild(who);
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
  els.messages.scrollTop = els.messages.scrollHeight;
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
        sessionId: id,
      },
      onDelta
    );

    const choice = (data && data.choices && data.choices[0]) || {};
    const text =
      (choice.message && choice.message.content) || streamed || '(no path found)';
    body.textContent = text;
    card.classList.remove('pending');
    card.classList.add('done');
    state.textContent = 'done';

    const bits = [spec.path.title];
    if (data && data.model) bits.push(data.model);
    else if (spec.model) bits.push(spec.model);
    if (data && data.usage && data.usage.total_tokens != null) {
      bits.push(`${data.usage.total_tokens} tokens`);
    }
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

function setBusy(busy, { cancellable } = {}) {
  els.send.disabled = busy;
  els.prompt.disabled = busy;
  if (busy) {
    pendingEl = addMessage('assistant', '…');
    pendingEl.classList.add('pending');
    if (cancellable) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'cancel-btn';
      cancelBtn.textContent = 'cancel';
      cancelBtn.addEventListener('click', () => {
        if (pendingSessionId) models.cancel(pendingSessionId);
      });
      pendingEl.appendChild(cancelBtn);
    }
  } else if (pendingEl) {
    pendingEl.remove();
    pendingEl = null;
  }
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

// Disable max-tokens options above the selected model's ceiling and clamp the
// current selection down if it no longer fits; falls back to the flat 64k
// ceiling (all options enabled) when no per-model metadata is known.
function applyMaxTokensClamp(modelId) {
  const meta = modelId ? modelMeta.get(modelId) : null;
  const ceiling = maxTokensCeiling(meta);
  for (const opt of els.maxTokens.options) {
    opt.disabled = Number(opt.value) > ceiling;
  }
  if (Number(els.maxTokens.value) > ceiling) {
    const enabled = Array.from(els.maxTokens.options).filter((o) => !o.disabled);
    const fallback = enabled[enabled.length - 1];
    if (fallback) {
      els.maxTokens.value = fallback.value;
      localStorage.setItem(MAX_TOKENS_KEY, els.maxTokens.value);
    }
  }
  return ceiling;
}

async function loadModels(cls) {
  const custom = CUSTOM_CLASSES.has(cls);
  els.modelSelect.hidden = custom;
  els.modelSelect.disabled = custom;
  els.modelInput.hidden = !custom;
  els.modelInput.disabled = !custom;
  els.modelHint.textContent = '';

  if (custom) {
    modelMeta = new Map();
    applyMaxTokensClamp(null);
    let cfg = { baseURL: '', configured: false, keyMask: null };
    try {
      const settings = (await models.settings.get()) || [];
      cfg = (Array.isArray(settings) && settings.find((s) => s.provider === cls)) || cfg;
    } catch {
      /* settings unavailable — leave hint below */
    }
    els.modelHint.textContent = cfg.baseURL
      ? `endpoint: ${cfg.baseURL} · key: ${cfg.configured ? cfg.keyMask : 'not set'}`
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
    // Keyed provider names travel alongside the BYOK model list for labelling
    // only — they are never options (defect #4).
    const providers =
      cls === 'byok' && Array.isArray(data && data.providers) ? data.providers : [];
    for (const m of list) {
      modelMeta.set(m.id, m);
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      els.modelSelect.appendChild(opt);
    }
    let hint;
    if (!list.length) {
      if (cls === 'byok') {
        hint = providers.length
          ? `No models listed for BYOK key${providers.length === 1 ? '' : 's'}: ${providers.join(', ')}.`
          : 'No BYOK provider keys stored — set one via aegis_byok_set first.';
      } else if (cls === 'ollama') {
        hint = 'Ollama not running or no models pulled.';
      } else {
        hint = 'No models listed.';
      }
    } else {
      hint = `${list.length} model${list.length === 1 ? '' : 's'} available.`;
      if (providers.length) hint += ` · BYOK keys: ${providers.join(', ')}`;
    }
    const ceiling = applyMaxTokensClamp(els.modelSelect.value);
    els.modelHint.textContent =
      ceiling < FLAT_CEILING ? `${hint} · max output: ${ceiling.toLocaleString()}` : hint;
  } catch (err) {
    modelMeta = new Map();
    applyMaxTokensClamp(null);
    els.modelHint.textContent =
      `listModels failed: ${err && err.message ? err.message : err}`;
  }
}

// -------------------------------------------------------------- settings pane

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

    const row = document.createElement('div');
    row.className = 'setting-row';

    const label = document.createElement('div');
    label.className = 'setting-name';
    label.textContent = name;
    row.appendChild(label);

    const baseInput = document.createElement('input');
    baseInput.type = 'text';
    baseInput.className = 'setting-input';
    baseInput.placeholder = 'base URL';
    baseInput.value = cfg.baseURL || '';
    row.appendChild(baseInput);

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
    saveBtn.addEventListener('click', () =>
      saveSetting(provider, baseInput.value.trim(), keyInput.value)
    );
    actions.appendChild(saveBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'ghost-btn danger';
    removeBtn.textContent = 'Remove';
    removeBtn.disabled = !cfg.configured;
    removeBtn.addEventListener('click', () => removeSetting(provider));
    actions.appendChild(removeBtn);

    row.appendChild(actions);
    els.settingsList.appendChild(row);
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
async function syncNow() {
  els.syncNow.disabled = true;
  els.sessionsHint.textContent = 'syncing…';
  try {
    const pushResult = await sync.push();
    const pullResult = await sync.pull();
    if (!pushResult.ok && !pullResult.ok) {
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
      for (const m of msgs) {
        const role =
          m.role === 'assistant' ? 'assistant'
            : m.role === 'system' ? 'system'
              : 'user';
        addMessage(role, m.content || m.text || '', undefined, role === 'assistant' ? s.id : undefined);
      }
      els.sessionsHint.textContent = `opened ${s.id.slice(0, 8)}…`;
    })
    .catch((err) => {
      els.sessionsHint.textContent =
        `open failed: ${err && err.message ? err.message : err}`;
    });
}

function newChat() {
  abortBranches();
  els.messages.innerHTML = '';
  els.sessionsHint.textContent = '';
  pendingEl = null;
  pendingSessionId = null;
  flowCount = 0;
}

// ------------------------------------------------------------------ actions

async function send() {
  const prompt = els.prompt.value.trim();
  if (!prompt || els.send.disabled) return;

  els.prompt.value = '';
  addMessage('user', prompt);

  const cls = els.classSelect.value;
  const model = CUSTOM_CLASSES.has(cls)
    ? els.modelInput.value.trim()
    : els.modelSelect.value;
  const maxTokens = parseInt(els.maxTokens.value, 10) || 4096;
  const sessionId = newSessionId();
  pendingSessionId = sessionId;

  setBusy(true, { cancellable: true });

  // Persist the user turn locally (best-effort — never blocks chat).
  try {
    await sync.append(sessionId, { role: 'user', content: prompt });
  } catch {
    /* persistence is non-fatal */
  }

  let streamedText = '';
  const onDelta = (chunk) => {
    const delta =
      chunk && (typeof chunk.delta === 'string' ? chunk.delta : chunk.content);
    if (!delta) return;
    streamedText += delta;
    if (!pendingEl) return;
    pendingEl.classList.remove('pending');
    const bodyEl = pendingEl.querySelector('.body');
    if (bodyEl) bodyEl.textContent = streamedText;
    els.messages.scrollTop = els.messages.scrollHeight;
  };

  try {
    // All four classes route through the model: surface (the main process
    // decides transport — cloud client, ollama, or a direct provider).
    const data = await models.chat(
      { class: cls, prompt, model, maxTokens, sessionId },
      onDelta
    );

    const choice = (data && data.choices && data.choices[0]) || {};
    const text =
      (choice.message && choice.message.content) ||
      streamedText ||
      '(empty response)';
    const bits = [];
    if (data && data.model) bits.push(`model: ${data.model}`);
    else if (model) bits.push(`model: ${model}`);
    bits.push(classLabel(cls));
    if (data && data.usage && data.usage.total_tokens != null) {
      bits.push(`tokens: ${data.usage.total_tokens}`);
    }
    addMessage('assistant', text, bits.join(' · ') || undefined, sessionId);

    try {
      await sync.append(sessionId, { role: 'assistant', content: text });
      await sync.save({ id: sessionId, title: prompt.slice(0, 60) });
    } catch {
      /* persistence is non-fatal */
    }

    // The AI's second path: not awaited — the lane streams beside the thread
    // while the composer goes straight back to the user (chat flow D2.2).
    if (exploreEnabled() && text !== '(empty response)') {
      addFlowLane({ prompt, cls, model, maxTokens, parentSessionId: sessionId });
    }
  } catch (err) {
    addMessage(
      'assistant',
      `Error: ${err && err.message ? err.message : err}`,
      'request failed'
    );
  } finally {
    setBusy(false);
    pendingSessionId = null;
    loadSessions();
  }
}

// --------------------------------------------------------------------- boot

async function init() {
  try {
    renderStatus(await aegis.status());
  } catch {
    renderStatus(null);
  }

  const savedMax = localStorage.getItem(MAX_TOKENS_KEY);
  if (savedMax) els.maxTokens.value = savedMax;

  els.maxTokens.addEventListener('change', () => {
    localStorage.setItem(MAX_TOKENS_KEY, els.maxTokens.value);
  });

  // The discovery lane is opt-in per machine, remembered across restarts.
  const savedExplore = localStorage.getItem(EXPLORE_KEY);
  if (savedExplore === 'off') els.exploreToggle.checked = false;
  els.exploreToggle.addEventListener('change', () => {
    localStorage.setItem(EXPLORE_KEY, els.exploreToggle.checked ? 'on' : 'off');
    if (!els.exploreToggle.checked) abortBranches();
  });

  els.classSelect.addEventListener('change', () => {
    localStorage.setItem(CLASS_KEY, els.classSelect.value);
    loadModels(els.classSelect.value);
  });

  els.modelSelect.addEventListener('change', () => {
    const ceiling = applyMaxTokensClamp(els.modelSelect.value);
    const base = els.modelHint.textContent.replace(/ · max output: [\d,]+$/, '');
    els.modelHint.textContent =
      ceiling < FLAT_CEILING ? `${base} · max output: ${ceiling.toLocaleString()}` : base;
  });

  els.newChat.addEventListener('click', newChat);
  els.sessionsRefresh.addEventListener('click', loadSessions);
  els.syncNow.addEventListener('click', syncNow);

  els.apiKeySave.addEventListener('click', saveApiKey);
  els.apiKeyVerify.addEventListener('click', verifyAegisKey);
  els.apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveApiKey();
    }
  });

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

  await loadClasses();
  await loadSettings();
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
