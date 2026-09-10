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

const aegis = window.aegis;
const models = window.models;
const sync = window.sync;
const $ = (id) => document.getElementById(id);

if (!aegis || !models) {
  document.body.textContent =
    'This page must run inside the AEGIS Electron host (window.aegis/window.models missing).';
  throw new Error('window.aegis/window.models unavailable — not running under Electron');
}

const els = {
  connDot: $('conn-dot'),
  connText: $('conn-text'),
  app: $('st-app'),
  client: $('st-client'),
  base: $('st-base'),
  key: $('st-key'),
  plan: $('st-plan'),
  balance: $('st-balance'),
  apiKeyInput: $('api-key-input'),
  apiKeySave: $('api-key-save'),
  apiKeyVerify: $('api-key-verify'),
  apiKeyHint: $('api-key-hint'),
  classSelect: $('class-select'),
  modelSelect: $('model-select'),
  modelInput: $('model-input'),
  maxTokens: $('max-tokens'),
  modelHint: $('model-hint'),
  settingsList: $('settings-list'),
  settingsHint: $('settings-hint'),
  sessionsRefresh: $('sessions-refresh'),
  sessionsList: $('sessions-list'),
  sessionsHint: $('sessions-hint'),
  syncNow: $('sync-now'),
  syncStatus: $('sync-status'),
  newChat: $('new-chat'),
  memorySearchForm: $('memory-search-form'),
  memoryQuery: $('memory-query'),
  memoryResults: $('memory-results'),
  memoryEntry: $('memory-entry'),
  memorySaveBtn: $('memory-save-btn'),
  memoryHint: $('memory-hint'),
  messages: $('messages'),
  composer: $('composer'),
  prompt: $('prompt'),
  send: $('send'),
};

const CLASS_KEY = 'aegis.class';
const MAX_TOKENS_KEY = 'aegis.maxTokens';
const CUSTOM_CLASSES = new Set(['openai-compat', 'anthropic']);

let pendingEl = null;
let pendingSessionId = null;
let classOptions = [];
let modelMeta = new Map(); // model id -> raw model object from listModels() (P2 §6.3 ceiling)

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
    els.balance.textContent = bank && bank.balance != null
      ? String(bank.balance)
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

// `sessionId`, when given for an assistant message, renders a "remember"
// button (plan P3 §7 memory-follows-user from any model class — Ollama,
// custom OpenAI/Anthropic included, not just Aegis Cloud).
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
    const rememberBtn = document.createElement('button');
    rememberBtn.type = 'button';
    rememberBtn.className = 'remember-btn';
    rememberBtn.textContent = 'remember';
    rememberBtn.addEventListener('click', () =>
      rememberMessage(text, sessionId, rememberBtn)
    );
    row.appendChild(rememberBtn);
  }

  els.messages.appendChild(row);
  els.messages.scrollTop = els.messages.scrollHeight;
  return row;
}

/**
 * "Remember" affordance: pins one assistant message to AEGIS cloud memory
 * from *any* model class, mirroring the MCP saver shape (source + session)
 * so it's found by `memorySearch` from another machine. `aegis:memorySave`
 * (desktop/main.js) queues the entry locally instead of throwing when no key
 * is configured, so the no-key path here just reports "queued" — it never
 * surfaces as an error.
 */
async function rememberMessage(text, sessionId, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'remembering…';
  }
  try {
    const result = await aegis.memorySave({
      text,
      source: 'aegis-desktop',
      session: sessionId,
    });
    if (btn) {
      btn.textContent = result && result.queued ? 'queued (offline)' : 'remembered';
    }
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'remember';
    }
    els.memoryHint.textContent =
      `remember failed: ${err && err.message ? err.message : err}`;
  }
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
    for (const m of list) {
      modelMeta.set(m.id, m);
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      els.modelSelect.appendChild(opt);
    }
    let hint;
    if (!list.length) {
      hint =
        cls === 'byok'
          ? 'No BYOK provider keys stored — set one via aegis_byok_set first.'
          : cls === 'ollama'
            ? 'Ollama not running or no models pulled.'
            : 'No models listed.';
    } else {
      hint = `${list.length} model${list.length === 1 ? '' : 's'} available.`;
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
  els.messages.innerHTML = '';
  els.sessionsHint.textContent = '';
  pendingEl = null;
  pendingSessionId = null;
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

init();
