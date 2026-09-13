'use strict';

/**
 * Headless Electron smoke driver — PLAN Phase 9 (P3.6).
 *
 * This is the *main process* of a throwaway Electron run. It requires the real
 * `desktop/main.js` (so the genuine host boots: real window, real preload, real
 * IPC, real LocalEngine, real renderer app.js) and then drives a streamed turn
 * in the real renderer over a **stubbed transport**: the wrapper that spawns
 * this file (`test/electron-smoke.mjs`) runs a loopback HTTP SSE server and
 * points the shared client at it via `AEGIS_API_BASE`. Nothing here reaches a
 * provider, needs a real key, or opens a socket off 127.0.0.1.
 *
 * Never run this directly — it refuses to start unless AEGIS_SMOKE=1 and
 * AEGIS_API_BASE is a loopback origin, so a stray invocation can never turn
 * into live provider spend.
 *
 * What it proves, in the DOM of the real app (not a mock of it):
 *   1. scrolling up mid-stream holds the reader's position (the follow-the-tail
 *      veto is wired to the real scroll listener);
 *   2. Escape stops a running turn (renderer keydown -> models.cancel -> engine
 *      AbortController -> the in-flight fetch on the stubbed transport);
 *   3. the partial answer is salvaged and labelled `stopped by you` instead of
 *      being destroyed, and no further chunks land after the stop.
 *
 * Evidence leaves on stdout as one `SMOKE_EVIDENCE {json}` line; the wrapper
 * asserts on it (and on what its own stub server saw) and owns the exit code
 * the CI job reads. Any failed check here exits non-zero too.
 */

const { app, BrowserWindow } = require('electron');

// ---------------------------------------------------------------------------
// Safety rails — refuse to boot against anything that is not the local stub.
// ---------------------------------------------------------------------------
const apiBase = process.env.AEGIS_API_BASE || '';
const loopback = /^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase);
if (process.env.AEGIS_SMOKE !== '1' || !loopback) {
  console.error(
    'electron-smoke-main: refusing to run. Needs AEGIS_SMOKE=1 and a loopback ' +
      `AEGIS_API_BASE (got ${JSON.stringify(apiBase)}). Use test/electron-smoke.mjs.`
  );
  process.exit(2);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-dev-shm-usage');

// Boot the REAL host. main.js registers its own app.whenReady() handler and
// creates the window there; ours below runs after it and waits for the window.
require('../main.js');

const checks = [];
const consoleErrors = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) console.error(`SMOKE_FAIL ${name}: ${detail}`);
  return Boolean(ok);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeoutMs = 20000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch (err) {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/** Run a function body inside the REAL renderer's world and return its value. */
function js(win, body) {
  return win.webContents.executeJavaScript(`(function(){${HELPERS}${body}})()`, true);
}

/** Whitespace-insensitive comparison form: markdown rendering rewraps text. */
function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * How the driver finds the turn that is running right now.
 *
 * Not `.pending`: app.js clears that class on the first paint (`paintStream`
 * removes it so the typing dots stop), so mid-stream it is already gone. The
 * cancel button is the real marker — it exists for exactly as long as a
 * cancellable turn is in flight and disappears with the bubble when the turn
 * ends (`setBusy(false)` removes the whole row).
 */
const HELPERS = `
  function liveRow() {
    var rows = document.querySelectorAll('#messages .msg');
    var i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].querySelector('.cancel-btn')) return rows[i];
    }
    return null;
  }
  function liveText() {
    var r = liveRow();
    if (!r) return '';
    var b = r.querySelector('.body');
    return b ? b.textContent : '';
  }
`;

const PREPARE = `
  var out = {};
  var messages = document.getElementById('messages');
  var explore = document.getElementById('explore-toggle');
  // The discovery lane would open its own concurrent streams after the turn;
  // off, so exactly one pending turn exists to interrupt.
  if (explore && explore.checked) {
    explore.checked = false;
    explore.dispatchEvent(new Event('change', { bubbles: true }));
  }
  var sel = document.getElementById('class-select');
  if (sel.value !== 'aegis') {
    sel.value = 'aegis';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  out.cls = sel.value;
  out.explore = explore ? explore.checked : null;
  out.options = Array.prototype.map.call(sel.options, function (o) { return o.value; });
  document.getElementById('prompt').value = 'SMOKE: please stream a long answer.';
  // The real send path: the composer's submit handler, same as clicking Send.
  document.getElementById('composer').requestSubmit();
  out.sendDisabled = document.getElementById('send').disabled;
  return out;
`;

const MEASURE = (label) => `
  var m = document.getElementById('messages');
  var text = liveText();
  var t = (typeof transcript !== 'undefined' && transcript && transcript.isScrolledUp)
    ? transcript.isScrolledUp() : null;
  return {
    label: ${JSON.stringify(label)},
    scrollTop: m.scrollTop,
    scrollHeight: m.scrollHeight,
    clientHeight: m.clientHeight,
    textLen: text.length,
    liveTurn: Boolean(liveRow()),
    scrolledUpFlag: t,
    msgs: document.querySelectorAll('#messages .msg').length
  };
`;

const SCROLL_UP = `
  var m = document.getElementById('messages');
  var moved = false;
  // Exactly what a user reading history produces: a scroll to an earlier
  // offset, announced with a scroll event on the transcript element.
  m.scrollTop = 0;
  m.dispatchEvent(new Event('scroll', { bubbles: false }));
  moved = m.scrollTop === 0;
  return { moved: moved, scrollTop: m.scrollTop, scrollHeight: m.scrollHeight, clientHeight: m.clientHeight };
`;

const ESCAPE = `
  var lenBefore = liveText().length;
  var ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(ev);
  return { textAtEscape: lenBefore, defaultPrevented: ev.defaultPrevented };
`;

const CAPTURE = `
  function bodyOf(row) {
    var b = row.querySelector('.body');
    return b ? b.textContent : '';
  }
  var all = document.querySelectorAll('#messages .msg');
  var rows = Array.prototype.map.call(all, function (r) {
    var meta = r.querySelector('.meta');
    return {
      role: r.className,
      meta: meta ? meta.textContent : '',
      textLength: bodyOf(r).length,
      liveTurn: Boolean(r.querySelector('.cancel-btn'))
    };
  });
  var stopped = null;
  for (var i = 0; i < all.length; i++) {
    var m = all[i].querySelector('.meta');
    if (m && m.textContent.indexOf('stopped by you') !== -1) { stopped = bodyOf(all[i]); break; }
  }
  return {
    rows: rows,
    stoppedText: stopped,
    stoppedLength: stopped ? stopped.length : -1,
    liveTurnsLeft: document.querySelectorAll('#messages .msg .cancel-btn').length,
    errorRows: Array.prototype.filter.call(all, function (r) {
      var m = r.querySelector('.meta');
      return m && /request failed|Error:/i.test(m.textContent + ' ' + bodyOf(r));
    }).length,
    sendDisabled: document.getElementById('send').disabled,
    textLen: liveText().length
  };
`;

/** Last-resort DOM snapshot, so a timeout is diagnosable from CI logs alone. */
const DIAGNOSE = `
  var all = document.querySelectorAll('#messages .msg');
  return {
    rows: Array.prototype.map.call(all, function (r) {
      var b = r.querySelector('.body');
      var meta = r.querySelector('.meta');
      return {
        role: r.className,
        len: b ? b.textContent.length : -1,
        meta: meta ? meta.textContent.slice(0, 80) : ''
      };
    }),
    classOptions: (function () {
      var s = document.getElementById('class-select');
      return s ? Array.prototype.map.call(s.options, function (o) { return o.value; }) : null;
    })(),
    classValue: (document.getElementById('class-select') || {}).value,
    modelValue: (document.getElementById('model-select') || {}).value,
    hint: (document.getElementById('model-hint') || {}).textContent,
    promptValue: (document.getElementById('prompt') || {}).value,
    sendDisabled: (document.getElementById('send') || {}).disabled,
    messagesHTML: document.getElementById('messages').innerHTML.slice(0, 500)
  };
`;

async function main() {
  const win = await waitFor(
    () =>
      BrowserWindow.getAllWindows().find((w) =>
        String(w.webContents.getURL() || '').endsWith('renderer/index.html')
      ),
    'the main window'
  );
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) consoleErrors.push(String(message).slice(0, 300));
    if (process.env.AEGIS_SMOKE_DEBUG === '1') console.error(`renderer: ${message}`);
  });

  // Give the renderer its viewport: the transcript must genuinely overflow the
  // window for "holds position" to mean anything.
  try {
    win.setContentSize(1080, 560);
  } catch {
    /* a resized window is not required — the stream below overflows regardless */
  }

  // renderer boot: init() populates the class picker from models.listClasses().
  await waitFor(
    () =>
      js(
        win,
        "var s=document.getElementById('class-select'); return s && s.options.length > 0 ? s.options.length : 0;"
      ),
    'renderer boot (class picker)'
  );

  const prepared = await js(win, PREPARE);
  check('turn-started', prepared.sendDisabled === true, `sendDisabled=${prepared.sendDisabled}`);
  check('class-is-cloud', prepared.cls === 'aegis', `class=${prepared.cls}`);
  check('discovery-lane-off', prepared.explore === false, `explore=${prepared.explore}`);

  // ── 1. stream until the transcript is long enough to scroll ──────────────
  const streamed = await waitFor(
    () =>
      js(win, 'var n = liveText().length; return n > 3000 ? { len: n } : 0;'),
    'streamed text on the live turn'
  );

  // ── 2. scroll up mid-stream, then hold ───────────────────────────────────
  const scrollUp = await js(win, SCROLL_UP);
  const before = await js(win, MEASURE('before'));
  await sleep(900);
  const held = await js(win, MEASURE('after'));

  const overflowBefore = before.scrollHeight - before.clientHeight;
  check(
    'transcript-overflows',
    overflowBefore > 200,
    `scrollHeight-clientHeight=${overflowBefore} (must be >200 or 'held position' is vacuous)`
  );
  check('scrolled-up-moved', scrollUp.moved === true, `scrollTop=${scrollUp.scrollTop}`);
  check(
    'stream-live-during-hold',
    held.textLen > before.textLen,
    `textLen ${before.textLen} -> ${held.textLen} (no new chunks arrived, so the hold was never challenged)`
  );
  // THE regression this phase guards: an unconditional `scrollTop =
  // scrollHeight` on every chunk re-pins the view and this fails.
  check(
    'position-held-while-streaming',
    held.scrollTop <= before.scrollTop + 48,
    `scrollTop ${before.scrollTop} -> ${held.scrollTop} while ${held.textLen - before.textLen} chars streamed in`
  );
  check(
    'veto-engaged',
    held.scrollHeight - held.scrollTop - held.clientHeight > 48,
    `distance-from-tail=${held.scrollHeight - held.scrollTop - held.clientHeight} (must be off the tail)`
  );
  check(
    'scrolled-up-flag-set',
    held.scrolledUpFlag === true,
    `transcript.isScrolledUp()=${held.scrolledUpFlag} (the real scroll listener must have recorded the scroll)`
  );

  // ── 3. Escape stops the turn ─────────────────────────────────────────────
  const escaped = await js(win, ESCAPE);
  check(
    'escape-consumed',
    escaped.defaultPrevented === true,
    `defaultPrevented=${escaped.defaultPrevented} (Escape must have reached the interrupt handler)`
  );

  const stopped = await waitFor(
    () =>
      js(
        win,
        "return document.querySelector('#messages .msg .meta') && Array.prototype.some.call(document.querySelectorAll('#messages .msg .meta'), function(m){return m.textContent.indexOf('stopped by you')!==-1;}) ? 1 : 0;"
      ),
    'the salvaged "stopped by you" bubble',
    12000
  );
  check('salvage-bubble-present', stopped === 1, 'no bubble labelled "stopped by you" appeared');

  const settledA = await js(win, CAPTURE);
  // If the transport were still live, the transcript would keep growing.
  await sleep(1200);
  const settledB = await js(win, CAPTURE);

  check(
    'partial-text-salvaged',
    settledB.stoppedLength > 200,
    `salvaged text length=${settledB.stoppedLength} (expected the partial answer, not an empty bubble)`
  );
  check(
    'no-error-bubble',
    settledB.errorRows === 0,
    `${settledB.errorRows} row(s) rendered as a failure — a stop must never be reported as an error`
  );
  check(
    'pending-bubble-cleared',
    settledB.pendingLeft === 0,
    `${settledB.pendingLeft} pending bubble(s) still on screen after the stop`
  );
  check(
    'stream-really-stopped',
    settledA.stoppedText === settledB.stoppedText,
    'the salvaged text kept changing after the stop — the transport was still streaming'
  );
  check(
    'send-re-enabled',
    settledB.sendDisabled === false,
    `sendDisabled=${settledB.sendDisabled}`
  );
  check(
    'partial-not-whole',
    escaped.textAtEscape > 0 && settledB.stoppedLength <= escaped.textAtEscape + 8,
    `at Escape ${escaped.textAtEscape} chars, salvaged ${settledB.stoppedLength}`
  );

  return {
    prepared,
    streamedLen: streamed.len,
    scrollUp,
    before,
    held,
    escaped,
    settled: {
      stoppedText: settledB.stoppedText,
      stoppedLength: settledB.stoppedLength,
      rows: settledB.rows,
      errorRows: settledB.errorRows,
      pendingLeft: settledB.pendingLeft,
      sendDisabled: settledB.sendDisabled,
    },
    consoleErrors,
  };
}

let finished = false;

async function run() {
  const watchdog = setTimeout(() => {
    if (finished) return;
    console.error('SMOKE_FAIL watchdog: smoke run exceeded 60s');
    report(false);
  }, 60000);

  let evidence = null;
  let fatal = null;
  try {
    evidence = await main();
  } catch (err) {
    fatal = err && err.message ? err.message : String(err);
    check('driver-completed', false, fatal);
  }
  clearTimeout(watchdog);

  const ok = !fatal && checks.every((c) => c.ok);
  report(ok, evidence, fatal);
}

function report(ok, evidence, fatal) {
  if (finished) return;
  finished = true;
  const payload = {
    ok,
    checks,
    fatal: fatal || null,
    evidence: evidence
      ? {
          ...evidence,
          // The wrapper (which owns the stub server) checks this text against
          // exactly what it streamed: the salvage must be a real prefix.
          settled: {
            ...evidence.settled,
            stoppedText: String(evidence.settled.stoppedText || '').slice(0, 20000),
          },
        }
      : null,
  };
  process.stdout.write(`SMOKE_EVIDENCE ${JSON.stringify(payload)}\n`);
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(run, (err) => {
  check('app-ready', false, err && err.message ? err.message : String(err));
  report(false);
});
