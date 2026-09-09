'use strict';

/**
 * AEGIS Desktop renderer — thin UI only.
 *
 * Talks exclusively to the window.aegis.* surface exposed by preload.js
 * (contextBridge). All transport happens in the main process via the shared
 * client/aegis.js; the engine lives behind aegiscloud.org. If this file ever
 * grows routing/engine logic it is wrong.
 *
 * "Aegis server" mode: send a prompt and let the server auto-route — no
 * model pinned means the server picks its default (no tier ids fabricated
 * client-side; see client/aegis.js chatCompletion).
 * "Local (BYOK)" mode: pin one of the provider models from listModels so the
 * server uses the user's own provider key.
 */

const aegis = window.aegis;
const $ = (id) => document.getElementById(id);

if (!aegis) {
  document.body.textContent =
    'This page must run inside the AEGIS Electron host (window.aegis missing).';
  throw new Error('window.aegis unavailable — not running under Electron');
}

const els = {
  connDot: $('conn-dot'),
  connText: $('conn-text'),
  app: $('st-app'),
  client: $('st-client'),
  base: $('st-base'),
  key: $('st-key'),
  modeToggle: $('mode-toggle'),
  modeLabel: $('mode-label'),
  modelSelect: $('model-select'),
  modelHint: $('model-hint'),
  plan: $('st-plan'),
  balance: $('st-balance'),
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

const COMPUTE_KEY = 'aegis.compute'; // 'server' | 'local'

let pendingEl = null;

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
  els.key.textContent = s.keyConfigured
    ? s.keyMask
    : 'not set — export AEGIS_API_KEY';
  setConn(s.keyConfigured, s.keyConfigured ? 'key configured' : 'no API key');
}

async function loadAccountInfo() {
  try {
    const verify = await aegis.verifyApiKey();
    els.plan.textContent = verify && verify.valid
      ? (verify.plan || 'active')
      : 'invalid key';
  } catch (err) {
    els.plan.textContent = 'unavailable';
  }

  try {
    const bank = await aegis.tokenBankBalance();
    els.balance.textContent = bank && bank.balance != null
      ? String(bank.balance)
      : '–';
  } catch (err) {
    els.balance.textContent = 'unavailable';
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
    await aegis.memorySave({ text });
    els.memoryEntry.value = '';
    els.memoryHint.textContent = 'saved.';
    await searchMemory(els.memoryQuery.value.trim());
  } catch (err) {
    els.memoryHint.textContent = `save failed: ${err && err.message ? err.message : err}`;
  } finally {
    els.memorySaveBtn.disabled = false;
  }
}

function addMessage(role, text, meta) {
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

  els.messages.appendChild(row);
  els.messages.scrollTop = els.messages.scrollHeight;
  return row;
}

function setBusy(busy) {
  els.send.disabled = busy;
  els.prompt.disabled = busy;
  if (busy) {
    pendingEl = addMessage('assistant', '…');
    pendingEl.classList.add('pending');
  } else if (pendingEl) {
    pendingEl.remove();
    pendingEl = null;
  }
}

function setMode(compute) {
  const local = compute === 'local';
  els.modeToggle.checked = local;
  els.modeLabel.textContent = local ? 'Local (BYOK)' : 'Aegis server';
  els.modeLabel.classList.toggle('local', local);
  els.modelSelect.disabled = !local;
  els.modelHint.textContent = local
    ? 'Pin a provider model — the server routes with your BYOK key.'
    : 'Server auto-routes the prompt (no model pinned).';
}

// ------------------------------------------------------------------ actions

async function loadModels() {
  try {
    // Phase D1 exit criterion: a hardcoded listModels call renders a result.
    const data = await aegis.listModels();
    const models = Array.isArray(data && data.models) ? data.models : [];

    els.modelSelect.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'auto-routing (server)';
    els.modelSelect.appendChild(auto);

    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      els.modelSelect.appendChild(opt);
    }

    addMessage(
      'system',
      `listModels OK — ${models.length} pinnable model${
        models.length === 1 ? '' : 's'
      } served.`,
      models.length
        ? `models: ${models.map((m) => m.id).join(', ')}`
        : 'nothing pinnable — use Aegis server auto-routing'
    );
    if (models.length) {
      els.modelHint.textContent =
        'Models below pin a specific provider (BYOK).';
    }
  } catch (err) {
    setConn(false, 'listModels failed');
    addMessage(
      'system',
      `listModels failed: ${err && err.message ? err.message : err}`,
      'is AEGIS_API_KEY set?'
    );
  }
}

async function send() {
  const prompt = els.prompt.value.trim();
  if (!prompt || els.send.disabled) return;

  els.prompt.value = '';
  addMessage('user', prompt);
  setBusy(true);

  const local = els.modeToggle.checked;
  const model = local ? els.modelSelect.value : '';
  const payload = { prompt, maxTokens: 1024 };
  if (local && model) {
    payload.model = model; // pin provider model (BYOK path)
  } else {
    // Legacy server shorthand only — no model id is fabricated; with `model`
    // absent the client omits it entirely and the server picks its default.
    // (P1 §7.4 removes this branch with the mode-toggle gate.)
    payload.mode = 'smart';
  }

  // D2 item 1 — streaming render: preload forwards SSE deltas into the
  // callback as they arrive (aegis:chatDelta push channel from main), and the
  // awaited value resolves with the normalised final result. Chunks paint into
  // the pending assistant bubble live; the resolved text then replaces it
  // verbatim (same content) with model/token meta attached.
  let streamedText = '';
  try {
    const data = await aegis.chatCompletion(payload, (chunk) => {
      const delta =
        chunk && (typeof chunk.delta === 'string' ? chunk.delta : chunk.content);
      if (!delta) return;
      streamedText += delta;
      if (!pendingEl) return;
      pendingEl.classList.remove('pending');
      const bodyEl = pendingEl.querySelector('.body');
      if (bodyEl) bodyEl.textContent = streamedText;
      els.messages.scrollTop = els.messages.scrollHeight;
    });

    const choice = (data && data.choices && data.choices[0]) || {};
    const text =
      (choice.message && choice.message.content) ||
      streamedText ||
      '(empty response)';
    const bits = [];
    if (data && data.model) bits.push(`model: ${data.model}`);
    if (data && data.usage && data.usage.total_tokens != null) {
      bits.push(`tokens: ${data.usage.total_tokens}`);
    }
    addMessage('assistant', text, bits.join(' · ') || undefined);
  } catch (err) {
    addMessage(
      'assistant',
      `Error: ${err && err.message ? err.message : err}`,
      'request failed'
    );
  } finally {
    setBusy(false);
  }
}

// --------------------------------------------------------------------- boot

async function init() {
  try {
    renderStatus(await aegis.status());
  } catch (err) {
    renderStatus(null);
  }

  setMode(localStorage.getItem(COMPUTE_KEY) === 'local' ? 'local' : 'server');

  els.modeToggle.addEventListener('change', () => {
    const next = els.modeToggle.checked ? 'local' : 'server';
    localStorage.setItem(COMPUTE_KEY, next);
    setMode(next);
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

  loadModels();
  loadAccountInfo();
  searchMemory('');
}

init();
