/**
 * AEGIS Online — browser SPA UI logic.
 *
 * Transport + UI only: every network call goes through window.AegisClient
 * (vendor/aegis.js, byte-identical to client/aegis.js). No brain/orchestration
 * logic lives here — see docs/aegis-online-host-plan.md for the boundary.
 *
 * Keys (AEGIS API key, BYOK provider key) live in localStorage on this
 * machine only, per the plan's accepted key-storage model — never logged,
 * never written into the DOM outside a masked preview.
 */
(function () {
  'use strict';

  const LS_API_KEY = 'aegis-online:api-key';
  const LS_BYOK_PROVIDER = 'aegis-online:byok-provider';
  const LS_BYOK_KEY = 'aegis-online:byok-key';
  const LS_MODEL = 'aegis-online:model';
  const LS_MODE = 'aegis-online:mode';

  const $ = (id) => document.getElementById(id);

  const el = {
    connDot: $('conn-dot'),
    connText: $('conn-text'),
    apiKeyInput: $('api-key-input'),
    saveKeyBtn: $('save-key-btn'),
    clearKeyBtn: $('clear-key-btn'),
    accountStatus: $('account-status'),
    balanceRow: $('balance-row'),
    balanceValue: $('balance-value'),
    modelSelect: $('model-select'),
    modeAegisBtn: $('mode-aegis-btn'),
    modeByokBtn: $('mode-byok-btn'),
    byokFields: $('byok-fields'),
    byokProvider: $('byok-provider'),
    byokKeyInput: $('byok-key-input'),
    memoryQuery: $('memory-query'),
    memorySearchBtn: $('memory-search-btn'),
    memoryResults: $('memory-results'),
    syncPushBtn: $('sync-push-btn'),
    syncPullBtn: $('sync-pull-btn'),
    syncSessions: $('sync-sessions'),
    transcript: $('transcript'),
    welcome: $('welcome'),
    composer: $('composer'),
    composerInput: $('composer-input'),
    sendBtn: $('send-btn'),
  };

  // --------------------------------------------------------------- state
  let aegis = null;
  let mode = localStorage.getItem(LS_MODE) === 'byok' ? 'byok' : 'aegis';
  let history = []; // [{role, content}]
  let sessionId = (window.AegisClient && window.AegisClient.randomUUID)
    ? window.AegisClient.randomUUID()
    : String(Date.now());
  let busy = false;

  function makeClient() {
    const apiKey = localStorage.getItem(LS_API_KEY) || '';
    aegis = window.AegisClient.createClient({ apiKey });
    return aegis;
  }

  function setConn(ok, text) {
    el.connDot.classList.toggle('ok', Boolean(ok));
    el.connText.textContent = text;
  }

  function setAccountStatus(text, cls) {
    el.accountStatus.textContent = text;
    el.accountStatus.className = 'account-status' + (cls ? ' ' + cls : '');
  }

  // ------------------------------------------------------------ account
  async function verifyAndLoad() {
    const key = localStorage.getItem(LS_API_KEY) || '';
    if (!key) {
      setAccountStatus('no key saved');
      setConn(false, 'not connected');
      el.balanceRow.classList.add('hidden');
      return;
    }
    setAccountStatus('verifying…');
    try {
      // A 401 (bad key) rejects via parseResponse's thrown Error — verifyApiKey
      // never resolves with `{valid:false}` in practice, only `{valid:true,...}`.
      await aegis.verifyApiKey();
      setAccountStatus('key verified', 'ok');
      setConn(true, 'connected');
      await loadBalance();
      await loadModels();
    } catch (err) {
      setAccountStatus('key rejected: ' + (err && err.message || err), 'err');
      setConn(false, 'not connected');
    }
  }

  async function loadBalance() {
    try {
      const bal = await aegis.tokenBankBalance();
      const micros = bal && (bal.balance_micros ?? bal.balance);
      if (micros == null) {
        el.balanceRow.classList.add('hidden');
        return;
      }
      const eur = Number(micros) / 1_000_000;
      el.balanceValue.textContent = '€' + eur.toFixed(4);
      el.balanceRow.classList.remove('hidden');
    } catch (_) {
      el.balanceRow.classList.add('hidden');
    }
  }

  async function loadModels() {
    try {
      const res = await aegis.listModels();
      const list = (res && (res.data || res.models)) || [];
      const saved = localStorage.getItem(LS_MODEL) || '';
      el.modelSelect.innerHTML = '<option value="">server default</option>';
      for (const m of list) {
        const id = (m && (m.id || m.model)) || '';
        if (!id) continue;
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        el.modelSelect.appendChild(opt);
      }
      if (saved) el.modelSelect.value = saved;
    } catch (_) {
      // model list is a convenience; chat still works with server default
    }
  }

  el.saveKeyBtn.addEventListener('click', async () => {
    const key = el.apiKeyInput.value.trim();
    if (!key) return;
    localStorage.setItem(LS_API_KEY, key);
    el.apiKeyInput.value = '';
    el.apiKeyInput.placeholder = maskKey(key);
    makeClient();
    await verifyAndLoad();
  });

  el.clearKeyBtn.addEventListener('click', () => {
    localStorage.removeItem(LS_API_KEY);
    el.apiKeyInput.value = '';
    el.apiKeyInput.placeholder = 'aegis_...';
    makeClient();
    setAccountStatus('no key saved');
    setConn(false, 'not connected');
    el.balanceRow.classList.add('hidden');
  });

  function maskKey(key) {
    if (key.length <= 8) return '••••••••';
    return key.slice(0, 4) + '…' + key.slice(-4);
  }

  el.modelSelect.addEventListener('change', () => {
    localStorage.setItem(LS_MODEL, el.modelSelect.value || '');
  });

  // --------------------------------------------------------------- mode
  function applyMode() {
    const isByok = mode === 'byok';
    el.modeAegisBtn.classList.toggle('mode-btn-active', !isByok);
    el.modeByokBtn.classList.toggle('mode-btn-active', isByok);
    el.byokFields.classList.toggle('hidden', !isByok);
  }

  el.modeAegisBtn.addEventListener('click', () => {
    mode = 'aegis';
    localStorage.setItem(LS_MODE, mode);
    applyMode();
  });
  el.modeByokBtn.addEventListener('click', () => {
    mode = 'byok';
    localStorage.setItem(LS_MODE, mode);
    applyMode();
  });

  el.byokProvider.addEventListener('change', () => {
    localStorage.setItem(LS_BYOK_PROVIDER, el.byokProvider.value);
  });
  el.byokKeyInput.addEventListener('change', () => {
    const v = el.byokKeyInput.value.trim();
    if (v) localStorage.setItem(LS_BYOK_KEY, v);
  });

  // ------------------------------------------------------------- chat UI
  function hideWelcome() {
    if (el.welcome) el.welcome.remove();
  }

  function addMessage(role, text) {
    hideWelcome();
    const row = document.createElement('div');
    row.className = 'msg msg-' + role;
    row.textContent = text;
    el.transcript.appendChild(row);
    el.transcript.scrollTop = el.transcript.scrollHeight;
    return row;
  }

  function setBusy(v) {
    busy = v;
    el.sendBtn.disabled = v;
    el.composerInput.disabled = v;
  }

  async function sendMessage(text) {
    if (!text.trim() || busy) return;
    addMessage('user', text);
    history.push({ role: 'user', content: text });
    setBusy(true);

    const assistantRow = addMessage('assistant', '');
    let acc = '';

    const onStream = (evt) => {
      const delta = evt && evt.delta;
      if (!delta) return;
      acc += delta;
      assistantRow.textContent = acc;
      el.transcript.scrollTop = el.transcript.scrollHeight;
    };

    try {
      let result;
      if (mode === 'byok') {
        const provider = localStorage.getItem(LS_BYOK_PROVIDER) || el.byokProvider.value || 'openai';
        const providerKey = localStorage.getItem(LS_BYOK_KEY) || el.byokKeyInput.value.trim();
        if (!providerKey) {
          assistantRow.classList.add('msg-error');
          assistantRow.textContent = 'Add a provider API key in BYOK mode first.';
          setBusy(false);
          return;
        }
        result = await aegis.byokChatCompletion({
          provider,
          providerKey,
          messages: history,
          stream: true,
          onStream,
        });
      } else {
        const model = el.modelSelect.value || undefined;
        result = await aegis.chatCompletion({
          messages: history,
          model,
          stream: true,
          onStream,
        });
      }
      const finalText = (result && textOfCompletion(result)) || acc;
      assistantRow.textContent = finalText || '(no response)';
      history.push({ role: 'assistant', content: finalText || acc });
      annotateRemember(assistantRow, finalText || acc);
    } catch (err) {
      assistantRow.classList.add('msg-error');
      assistantRow.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function textOfCompletion(result) {
    const choice = result && result.choices && result.choices[0];
    return choice && choice.message && choice.message.content;
  }

  function annotateRemember(row, text) {
    if (!text) return;
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'remember this';
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        // /api/memory/save silently drops any entry missing `id` or `content`
        // (services side: _upsert_memory_entries' real_entries filter) — both
        // are required, not just `content`.
        const entry = {
          id: (window.AegisClient.randomUUID && window.AegisClient.randomUUID()) || String(Date.now()),
          content: text,
          role: 'assistant',
          source: 'aegis-online',
          timestamp: new Date().toISOString(),
        };
        const res = await aegis.memorySave(entry);
        link.textContent = (res && res.saved) ? 'saved to memory' : 'save skipped (quota?)';
      } catch (_) {
        link.textContent = 'could not save';
      }
    });
    meta.appendChild(link);
    row.appendChild(meta);
  }

  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.composerInput.value;
    el.composerInput.value = '';
    autosize();
    sendMessage(text);
  });

  el.composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el.composer.requestSubmit();
    }
  });

  function autosize() {
    el.composerInput.style.height = 'auto';
    el.composerInput.style.height = Math.min(el.composerInput.scrollHeight, 160) + 'px';
  }
  el.composerInput.addEventListener('input', autosize);

  // ------------------------------------------------------------- memory
  async function searchMemory() {
    const q = el.memoryQuery.value.trim();
    el.memoryResults.innerHTML = '<li class="empty-note">searching…</li>';
    try {
      const res = await aegis.memorySearch(q, 10);
      const entries = (res && res.entries) || [];
      renderMemoryResults(entries);
    } catch (err) {
      el.memoryResults.innerHTML = '<li class="empty-note">' + escapeText('could not search: ' + (err && err.message || err)) + '</li>';
    }
  }

  function renderMemoryResults(entries) {
    el.memoryResults.innerHTML = '';
    if (!entries.length) {
      el.memoryResults.innerHTML = '<li class="empty-note">no matches</li>';
      return;
    }
    for (const e of entries) {
      const li = document.createElement('li');
      li.className = 'memory-item';
      const textEl = document.createElement('span');
      textEl.className = 'memory-item-text';
      textEl.textContent = (e.content || '').slice(0, 240);
      li.appendChild(textEl);
      const meta = document.createElement('span');
      meta.textContent = (e.role || '') + (e.createdAt ? ' · ' + new Date(e.createdAt).toLocaleString() : '');
      li.appendChild(meta);
      el.memoryResults.appendChild(li);
    }
  }

  el.memorySearchBtn.addEventListener('click', searchMemory);
  el.memoryQuery.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchMemory();
    }
  });

  // --------------------------------------------------------- conv. sync
  async function pushSync() {
    if (!history.length) return;
    try {
      await aegis.conversationSyncPush({
        session_id: sessionId,
        title: (history[0] && history[0].content || '').slice(0, 60) || 'AEGIS Online session',
        messages: history,
        source: 'aegis-online',
      });
      el.syncPushBtn.textContent = 'Pushed ✓';
      setTimeout(() => { el.syncPushBtn.textContent = 'Push this chat'; }, 1500);
    } catch (err) {
      el.syncPushBtn.textContent = 'Push failed';
      setTimeout(() => { el.syncPushBtn.textContent = 'Push this chat'; }, 1500);
    }
  }

  async function pullSync() {
    el.syncSessions.innerHTML = '<li class="empty-note">loading…</li>';
    try {
      const res = await aegis.conversationSyncPull();
      const sessions = (res && res.sessions) || [];
      renderSyncSessions(sessions);
    } catch (err) {
      el.syncSessions.innerHTML = '<li class="empty-note">' + escapeText('could not load: ' + (err && err.message || err)) + '</li>';
    }
  }

  function renderSyncSessions(sessions) {
    el.syncSessions.innerHTML = '';
    if (!sessions.length) {
      el.syncSessions.innerHTML = '<li class="empty-note">no synced sessions</li>';
      return;
    }
    for (const s of sessions) {
      const li = document.createElement('li');
      li.className = 'sync-item';
      li.textContent = (s.title || s.session_id || 'session') +
        (s.updated_at ? ' · ' + new Date(s.updated_at).toLocaleString() : '');
      li.addEventListener('click', () => loadSyncedSession(s));
      el.syncSessions.appendChild(li);
    }
  }

  function loadSyncedSession(s) {
    el.transcript.innerHTML = '';
    history = Array.isArray(s.messages) ? s.messages.slice() : [];
    sessionId = s.session_id || sessionId;
    for (const m of history) {
      if (m && (m.role === 'user' || m.role === 'assistant')) {
        addMessage(m.role, m.content || '');
      }
    }
  }

  el.syncPushBtn.addEventListener('click', pushSync);
  el.syncPullBtn.addEventListener('click', pullSync);

  function escapeText(s) {
    return String(s);
  }

  // ------------------------------------------------------------- init
  function init() {
    makeClient();
    const savedKey = localStorage.getItem(LS_API_KEY);
    if (savedKey) el.apiKeyInput.placeholder = maskKey(savedKey);
    const savedProvider = localStorage.getItem(LS_BYOK_PROVIDER);
    if (savedProvider) el.byokProvider.value = savedProvider;
    applyMode();
    if (savedKey) verifyAndLoad();
    else setConn(false, 'not connected');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
