'use strict';

/**
 * Raw key decoding for the terminal (raw-mode stdin).
 *
 * Ported from `aegiscodex-dev/src/keys.js` so the aegiscode CLI and the
 * reference client decode the same bytes into the same key names — the
 * chatflow's key handling (history recall, vim motions, Esc-to-interrupt) is
 * only correct if the decoder agrees with it.
 *
 * Two entry points:
 *   decodePlain(c)      one character with no ESC prefix
 *   decodeEscSequence(s) a complete CSI (\x1b[…X) or SS3 (\x1bOX) sequence
 *
 * Both return either `null` (nothing to do) or a key object `{name, ch?}`.
 */

const KEY = Object.freeze({
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',
  ENTER: 'enter',
  TAB: 'tab',
  ESC: 'esc',
  BACKSPACE: 'backspace',
  DELETE: 'delete',
  HOME: 'home',
  END: 'end',
  PAGE_UP: 'pageup',
  PAGE_DOWN: 'pagedown',
  CTRL_C: 'ctrl-c',
  CTRL_D: 'ctrl-d',
  CTRL_L: 'ctrl-l',
  CTRL_R: 'ctrl-r',
  CTRL_U: 'ctrl-u',
  CTRL_A: 'ctrl-a',
  CTRL_E: 'ctrl-e',
  CTRL_K: 'ctrl-k',
  CTRL_W: 'ctrl-w',
  CTRL_T: 'ctrl-t',
  CTRL_N: 'ctrl-n',
  CTRL_P: 'ctrl-p',
  CTRL_O: 'ctrl-o',
  CTRL_LEFT: 'ctrl-left',
  CTRL_RIGHT: 'ctrl-right',
});

/** Decode a bare character (no escape prefix) into a key object. */
function decodePlain(chunk) {
  switch (chunk) {
    case '\r':
    case '\n':
      return { name: KEY.ENTER };
    case '\t':
      return { name: KEY.TAB };
    case '\x03':
      return { name: KEY.CTRL_C };
    case '\x04':
      return { name: KEY.CTRL_D };
    case '\x0c':
      return { name: KEY.CTRL_L };
    case '\x12':
      return { name: KEY.CTRL_R };
    case '\x15':
      return { name: KEY.CTRL_U };
    case '\x01':
      return { name: KEY.CTRL_A };
    case '\x05':
      return { name: KEY.CTRL_E };
    case '\x0b':
      return { name: KEY.CTRL_K };
    case '\x17':
      return { name: KEY.CTRL_W };
    case '\x14':
      return { name: KEY.CTRL_T };
    case '\x0e':
      return { name: KEY.CTRL_N };
    case '\x10':
      return { name: KEY.CTRL_P };
    case '\x0f':
      return { name: KEY.CTRL_O };
    case '\x7f':
    case '\x08':
      return { name: KEY.BACKSPACE };
    default: {
      // Any other control char is meaningless here; printable is a char.
      const code = chunk.charCodeAt(0);
      if (code < 32 || code === 127) return { name: KEY.ESC };
      return { name: 'char', ch: chunk };
    }
  }
}

/** Decode a complete CSI/SS3 escape sequence into a key object (or null). */
function decodeEscSequence(seq) {
  if (seq.startsWith('\x1b[')) {
    const body = seq.slice(2);
    // CSI with modifier params, e.g. 1;5C = ctrl+right.
    const m = body.match(/^([0-9;]*)([A-Za-z~])$/);
    if (m) {
      const params = m[1] ? m[1].split(';') : [];
      const mod = params.length > 1 ? parseInt(params[1], 10) : 0;
      switch (m[2]) {
        case 'A':
          return { name: KEY.UP };
        case 'B':
          return { name: KEY.DOWN };
        case 'C':
          return mod === 5 ? { name: KEY.CTRL_RIGHT } : { name: KEY.RIGHT };
        case 'D':
          return mod === 5 ? { name: KEY.CTRL_LEFT } : { name: KEY.LEFT };
        case 'H':
          return { name: KEY.HOME };
        case 'F':
          return { name: KEY.END };
        case '~': {
          const n = parseInt(params[0] || '0', 10);
          if (n === 3) return { name: KEY.DELETE };
          if (n === 5) return { name: KEY.PAGE_UP };
          if (n === 6) return { name: KEY.PAGE_DOWN };
          if (n === 1 || n === 7) return { name: KEY.HOME };
          if (n === 4 || n === 8) return { name: KEY.END };
          return null;
        }
        default:
          return null;
      }
    }
    return null;
  }
  if (seq.startsWith('\x1bO')) {
    const c = seq[2];
    if (c === 'H') return { name: KEY.HOME };
    if (c === 'F') return { name: KEY.END };
    return null;
  }
  return { name: KEY.ESC };
}

module.exports = { KEY, decodePlain, decodeEscSequence };
