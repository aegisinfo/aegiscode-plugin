'use strict';

/**
 * The global key-event pump.
 *
 * A single stdin 'data' event may carry many keystrokes (pipes batch writes),
 * so each chunk is split into characters and fed through a small state machine
 * that also handles:
 *
 *   · a lone Escape, resolved by a short timeout so it is distinguishable from
 *     the start of an escape sequence;
 *   · bracketed paste (DECSET 2004) and, for terminals that ignore it, a
 *     length/newline heuristic so a multi-line paste does not submit the prompt
 *     line-by-line as it arrives;
 *   · SGR mouse wheel events (DECSET 1000+1006), decoded to `{name:'wheel'}`
 *     instead of being mistaken for Escape (which would abort a working turn).
 *
 * Ported from `aegiscodex-dev/src/events.js`. It is a module-level singleton —
 * one stdin, one queue — which is what lets the session loop, a command
 * handler's `askInput()`, and the mid-turn Esc drain all read keys through the
 * same nextKey() without fighting over the `data` listener.
 */

const { decodeEscSequence, decodePlain, KEY } = require('./keys.js');

const queue = [];
let waiting = [];
let buffer = '';
let seq = '';
let escTimer = null;

// A paste-like chunk accumulates instead of being fed char-by-char; a short
// idle window merges chunks that a pty fragmented across 'data' events.
const PASTE_LARGE = 100;
const PASTE_DEBOUNCE_MS = 30;
let pasteChunks = [];
let pasteTimer = null;

const looksLikePaste = (s) => {
  if (s.length > PASTE_LARGE) return true;
  // A trailing \n or \r\n is the ordinary end of a piped batch, not evidence
  // of a paste; strip one terminator before looking for an embedded newline.
  return /[\n\r]/.test(s.replace(/\r\n$|[\r\n]$/, ''));
};

let attachedStdin = null;
let onData = null;
let suspended = false;

function isKeyStreamSuspended() {
  return suspended;
}

function attachKeyStream(stdin) {
  attachedStdin = stdin;
  onData = (chunk) => pushChars(String(chunk));
  // A non-TTY stdin has no setRawMode at all; guard it so callers degrade
  // instead of throwing "stdin.setRawMode is not a function".
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
}

/** Hand the terminal to a child process: detach the pump and drop half-parsed
 *  state so nothing leaks across the suspension. Pair with resumeKeyStream(). */
function suspendKeyStream() {
  if (!attachedStdin || suspended) return;
  suspended = true;
  attachedStdin.removeListener('data', onData);
  clearTimeout(escTimer);
  seq = '';
  buffer = '';
  clearTimeout(pasteTimer);
  pasteTimer = null;
  pasteChunks = [];
  drainQueue();
  try {
    attachedStdin.setRawMode(false);
  } catch {
    /* not a TTY */
  }
  attachedStdin.pause();
}

function resumeKeyStream() {
  if (!attachedStdin || !suspended) return;
  suspended = false;
  try {
    attachedStdin.setRawMode(true);
  } catch {
    /* not a TTY */
  }
  attachedStdin.resume();
  attachedStdin.setEncoding('utf8');
  attachedStdin.on('data', onData);
}

function flushPaste() {
  const raw = pasteChunks.join('');
  pasteChunks = [];
  pasteTimer = null;
  // Strip any bracketed-paste framing that reached the buffer via a chunk
  // split mid-frame, so literal [200~…[201~ can never leak into the editor.
  const text = raw
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trimEnd();
  if (text) dispatch({ name: 'paste', text });
}

function pushChars(s) {
  const framed = s.match(/^\x1b\[200~(.*)\x1b\[201~$/s);
  if (framed) {
    pasteChunks.push(framed[1]);
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(flushPaste, PASTE_DEBOUNCE_MS);
    return;
  }
  if (s.startsWith('\x1b[200~')) {
    pasteChunks.push(s.slice('\x1b[200~'.length));
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(flushPaste, PASTE_DEBOUNCE_MS);
    return;
  }
  if (pasteChunks.length || looksLikePaste(s)) {
    pasteChunks.push(s);
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(flushPaste, PASTE_DEBOUNCE_MS);
    return;
  }
  buffer += s;
  while (buffer.length) {
    const cp = buffer.codePointAt(0);
    const c = String.fromCodePoint(cp);
    const units = c.length;
    if (units > buffer.length) break; // incomplete multi-byte char
    buffer = buffer.slice(units);
    feed(c);
  }
}

function feed(c) {
  if (c === '\x1b') {
    clearTimeout(escTimer);
    escTimer = setTimeout(() => {
      // Nothing followed the ESC within the window → it was a bare Escape.
      if (seq === '\x1b') dispatch({ name: KEY.ESC });
      seq = '';
    }, 60);
    seq = '\x1b';
    return;
  }
  if (seq === '\x1b') {
    // First char after ESC: a CSI (ESC[), an SS3 (ESCO), or an Alt chord.
    if (c === '[' || c === 'O') {
      seq += c;
      return;
    }
    clearTimeout(escTimer);
    seq = '';
    dispatch({ name: 'alt', ch: c });
    return;
  }
  if (seq.startsWith('\x1b[') || seq.startsWith('\x1bO')) {
    seq += c;
    if (/[A-Za-z~]/.test(c)) {
      clearTimeout(escTimer);
      const mouseDir = parseSgrMouse(seq);
      if (mouseDir) {
        seq = '';
        dispatch({ name: 'wheel', dir: mouseDir });
        return;
      }
      const k = decodeEscSequence(seq);
      seq = '';
      if (k) dispatch(k);
    }
    return;
  }
  const key = decodePlain(c);
  if (key) dispatch(key);
}

/**
 * SGR mouse button code → wheel direction. 64 = up, 65 = down; modifier bits
 * are masked off so Shift+wheel still scrolls. Anything else (clicks, drags)
 * returns null, and the caller's CSI decoder ignores it — so stray mouse bytes
 * can neither type into the editor nor abort a turn.
 */
function parseSgrMouse(seq) {
  if (!seq.startsWith('\x1b[<')) return null;
  const body = seq.slice(3).replace(/[Mm]$/, '');
  const code = parseInt(body.split(';')[0], 10);
  if (!Number.isFinite(code)) return null;
  const base = code & ~0b111100;
  if (base === 64) return 'up';
  if (base === 65) return 'down';
  return null;
}

function dispatch(key) {
  if (waiting.length) {
    const w = waiting.shift();
    w(key);
  } else {
    queue.push(key);
  }
}

/** The next key, waiting as long as it takes. */
function nextKey() {
  if (queue.length) return Promise.resolve(queue.shift());
  return new Promise((resolve) => waiting.push(resolve));
}

/**
 * nextKey with an upper bound: resolves null when no key arrives within `ms`.
 * The session loop polls with this while a turn runs — it must never wedge on a
 * key that never comes once the turn settles. The timeout path removes the
 * resolver from the waiting stack, so a late keystroke routes to the queue and
 * the loop's next nextKey() sees it.
 */
function nextKeyTimeout(ms) {
  if (queue.length) return Promise.resolve(queue.shift());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = waiting.indexOf(wrapper);
      if (i !== -1) waiting.splice(i, 1);
      resolve(null);
    }, ms);
    const wrapper = (key) => {
      clearTimeout(timer);
      resolve(key);
    };
    waiting.push(wrapper);
  });
}

/** Put keys back at the FRONT of the queue (typed-ahead replay after a turn). */
function requeueKeys(keys) {
  if (keys && keys.length) queue.unshift(...keys);
}

function drainQueue() {
  queue.length = 0;
}

/** Test seam: forget attached stdin, timers and queued keys. */
function resetKeyStream() {
  clearTimeout(escTimer);
  clearTimeout(pasteTimer);
  escTimer = null;
  pasteTimer = null;
  seq = '';
  buffer = '';
  pasteChunks = [];
  drainQueue();
  waiting = [];
  attachedStdin = null;
  onData = null;
  suspended = false;
}

module.exports = {
  KEY,
  attachKeyStream,
  suspendKeyStream,
  resumeKeyStream,
  isKeyStreamSuspended,
  nextKey,
  nextKeyTimeout,
  requeueKeys,
  drainQueue,
  resetKeyStream,
};
