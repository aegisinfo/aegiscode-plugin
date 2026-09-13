'use strict';

/**
 * AEGIS Quick Launcher renderer — a one-shot prompt over window.models.chat
 * (the same LocalEngine transport the main window's chat uses), with the
 * agent loop's tool calling turned off (`tools: false`): a small always-
 * on-top popup is the wrong place for a tool-approval card to pop up in.
 *
 * Same contextIsolation/sandbox posture as renderer/app.js — talks only to
 * window.models / window.quickLauncher, both whitelisted by preload.js.
 */

(function () {
  if (!window.models || !window.quickLauncher) {
    document.body.textContent =
      'This page must run inside the AEGIS Electron host (window.models/window.quickLauncher missing).';
    throw new Error('window.models/window.quickLauncher unavailable — not running under Electron');
  }

  const models = window.models;
  const quickLauncher = window.quickLauncher;

  const CLASS = 'aegis';
  const MODEL_KEY = 'quick-launcher-model';
  const IDLE_HINT = 'Enter to ask · Esc to close';

  const els = {
    form: document.getElementById('ql-form'),
    prompt: document.getElementById('ql-prompt'),
    response: document.getElementById('ql-response'),
    modelLabel: document.getElementById('ql-model-label'),
    modelSelect: document.getElementById('ql-model-select'),
    stopBtn: document.getElementById('ql-stop'),
    pushBtn: document.getElementById('ql-push'),
    status: document.getElementById('ql-status'),
  };

  let busy = false;
  let sessionId = null;
  let lastPrompt = '';
  let lastResponse = '';
  let hasResult = false;

  function setStatus(text) {
    els.status.textContent = text;
  }

  function setBusy(next) {
    busy = next;
    els.stopBtn.hidden = !next;
    els.prompt.disabled = next;
  }

  /** Populate the model picker for the fixed 'aegis' class. Degrades to a
   *  plain label (no picker) when there is no key configured or the catalog
   *  call fails — the launcher still opens, it just can't send anything. */
  async function loadModel() {
    try {
      const classes = (await models.listClasses()) || [];
      const aegisClass = classes.find((c) => c.class === CLASS);
      if (!aegisClass || !aegisClass.configured) {
        els.modelLabel.textContent = 'Aegis Cloud — no key configured';
        els.modelSelect.hidden = true;
        return;
      }
      const data = await models.listModels(CLASS);
      const list = (data && data.models) || [];
      els.modelSelect.innerHTML = '';
      for (const m of list) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        els.modelSelect.appendChild(opt);
      }
      const saved = localStorage.getItem(MODEL_KEY);
      if (saved && list.some((m) => m.id === saved)) {
        els.modelSelect.value = saved;
      }
      els.modelSelect.hidden = list.length <= 1;
      els.modelLabel.textContent = 'Aegis Cloud';
    } catch {
      els.modelLabel.textContent = 'Aegis Cloud — unavailable';
      els.modelSelect.hidden = true;
    }
  }

  els.modelSelect.addEventListener('change', () => {
    localStorage.setItem(MODEL_KEY, els.modelSelect.value);
  });

  async function ask(prompt) {
    if (!prompt || busy) return;
    hasResult = false;
    els.pushBtn.hidden = true;
    els.response.textContent = '';
    setBusy(true);
    setStatus('thinking…');
    sessionId = `quick-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let text = '';
    try {
      const res = await models.chat(
        {
          class: CLASS,
          model: els.modelSelect.value || undefined,
          prompt,
          tools: false,
          sessionId,
        },
        (chunk) => {
          if (chunk && typeof chunk.delta === 'string' && chunk.delta) {
            text += chunk.delta;
            els.response.textContent = text;
            els.response.scrollTop = els.response.scrollHeight;
          }
        }
      );
      const msg = res && res.choices && res.choices[0] && res.choices[0].message;
      const finalText = text || (msg && msg.content) || '';
      els.response.textContent = finalText;
      lastPrompt = prompt;
      lastResponse = finalText;
      hasResult = Boolean(finalText);
      els.pushBtn.hidden = !hasResult;
      setStatus(hasResult ? '⌘/Ctrl+⏎ to add this to the main chat' : 'no answer');
    } catch (err) {
      els.response.textContent = `Error: ${err && err.message ? err.message : err}`;
      setStatus('failed');
    } finally {
      setBusy(false);
      sessionId = null;
    }
  }

  function stop() {
    if (sessionId) models.cancel(sessionId).catch(() => {});
  }

  function pushToMain() {
    if (!hasResult) return;
    quickLauncher
      .pushToMain({
        prompt: lastPrompt,
        response: lastResponse,
        model: els.modelSelect.value || null,
      })
      .catch(() => {});
  }

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    ask(els.prompt.value.trim());
  });

  els.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      pushToMain();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask(els.prompt.value.trim());
    }
  });

  els.stopBtn.addEventListener('click', stop);
  els.pushBtn.addEventListener('click', pushToMain);

  // The window is shown/hidden, not reloaded, on every shortcut press (see
  // main.js toggleQuickLauncher) — so each time it regains focus is a fresh
  // "session" from the user's point of view and should start clean, unless a
  // stream from the previous session is still running in the background.
  window.addEventListener('focus', () => {
    if (busy) {
      els.prompt.focus();
      return;
    }
    els.prompt.value = '';
    els.response.textContent = '';
    els.pushBtn.hidden = true;
    hasResult = false;
    setStatus(IDLE_HINT);
    els.prompt.focus();
  });

  loadModel();
  els.prompt.focus();
})();
