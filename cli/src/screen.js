'use strict';

/**
 * Terminal plumbing: cell-accurate width maths, wrapping, and the ephemeral
 * "live" region the CLI redraws while a call is in flight.
 *
 * Design note — this CLI is a LINEAR transcript, not a full-screen alt-buffer
 * TUI (which is what Claude Code and aegiscodex-dev are). Finished turns are
 * written once to scrollback, so output stays selectable, pipeable and
 * scrollback-searchable; only the one live status/spinner line is redrawn. That
 * is a deliberate product difference, and it is also why there is no alt-screen
 * or mouse handling here.
 */

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Combining marks and variation selectors occupy no cell. */
const RE_ZERO = /[\u0300-\u036f\ufe00-\ufe0f\u200b-\u200f]/;
/** Wide (CJK/fullwidth/emoji) ranges occupy two cells. */
const RE_WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]|[\u{1f000}-\u{1f2ff}]/u;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

/** Display width of a string in terminal cells. */
function w(s) {
  let n = 0;
  for (const ch of stripAnsi(s)) {
    if (RE_ZERO.test(ch)) continue;
    n += RE_WIDE.test(ch) ? 2 : 1;
  }
  return n;
}

/** Truncate to `width` cells without cutting a wide/combining codepoint. */
function clip(s, width) {
  if (w(s) <= width) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const cw = RE_ZERO.test(ch) ? 0 : RE_WIDE.test(ch) ? 2 : 1;
    if (used + cw > width) break;
    out += ch;
    used += cw;
  }
  return out;
}

/** Pad (or clip) to exactly `width` cells. */
function pad(s, width) {
  const t = clip(s, width);
  return t + ' '.repeat(Math.max(0, width - w(t)));
}

/** Right-align inside `width`. */
function padStart(s, width) {
  const t = clip(s, width);
  return ' '.repeat(Math.max(0, width - w(t))) + t;
}

/**
 * Word-wrap one logical line to `width` cells, preserving words and never
 * breaking mid-word unless the word alone exceeds the width.
 */
function wrapLine(line, width, indent = '') {
  const limit = Math.max(8, width);
  if (w(line) <= limit) return [line];
  const words = line.split(' ');
  const out = [];
  let cur = '';
  for (const word of words) {
    const piece = cur ? `${cur} ${word}` : word;
    if (w(piece) <= limit) {
      cur = piece;
      continue;
    }
    if (cur) out.push(cur);
    if (w(word) <= limit) {
      cur = word;
      continue;
    }
    // A single token longer than the line: hard-split on cells.
    let rest = word;
    while (w(rest) > limit) {
      const head = clip(rest, limit);
      out.push(head);
      rest = rest.slice(head.length);
    }
    cur = rest;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

/** Wrap a block of text (honours existing newlines), applying `indent` to
 *  continuation lines only when `hang` is true. */
function wrapBlock(text, width, indent = '', hang = false) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    if (raw === '') {
      lines.push('');
      continue;
    }
    const parts = wrapLine(raw, width - w(indent));
    parts.forEach((p, i) => lines.push(i === 0 || !hang ? indent + p : indent + p));
  }
  return lines;
}

// --- cursor / screen control ------------------------------------------------

const ESC = {
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearToEnd: '\x1b[0K',
  clearLine: '\x1b[2K',
  clearScreen: '\x1b[2J\x1b[H',
  up: (n) => (n > 0 ? `\x1b[${n}A` : ''),
  down: (n) => (n > 0 ? `\x1b[${n}B` : ''),
  col: (n) => `\x1b[${n}G`,
};

function termWidth(fallback = 80) {
  return Math.max(20, (process.stdout && process.stdout.columns) || fallback);
}

/**
 * A block of lines at the bottom of the transcript that can be redrawn in
 * place. Every write goes through here, so the escape arithmetic lives in one
 * place: `update()` erases the previous block, prints the new one, and keeps
 * the cursor below it.
 */
class LiveRegion {
  constructor(out = process.stdout) {
    this.out = out;
    this.rows = 0;
    this.active = false;
  }

  update(lines) {
    const body = lines.map((l) => l + ESC.clearToEnd).join('\n');
    if (!this.active) {
      this.out.write(body);
      this.active = true;
    } else {
      // Back to the first row of the old block, rewrite, clear the tail.
      this.out.write(ESC.col(1) + ESC.up(this.rows) + body + '\n' + ESC.col(1) + ESC.up(1));
    }
    this.rows = lines.length;
  }

  /** Erase the block and return the cursor to its start, so the caller can
   *  print the durable version of the same content. */
  clear() {
    if (!this.active) return;
    this.out.write(ESC.col(1) + ESC.clearLine);
    for (let i = 1; i < this.rows; i++) this.out.write(`\n${ESC.clearLine}`);
    this.out.write(ESC.up(this.rows - 1) + ESC.col(1));
    this.rows = 0;
    this.active = false;
  }
}

module.exports = {
  w,
  clip,
  pad,
  padStart,
  stripAnsi,
  wrapLine,
  wrapBlock,
  EC: ESC,
  LiveRegion,
  termWidth,
};
