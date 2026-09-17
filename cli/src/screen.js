'use strict';

/**
 * Terminal plumbing: cell-accurate width maths, the span/line render model,
 * wrapping, and the ephemeral "live" region the CLI redraws while a call is in
 * flight.
 *
 * The render model is aegiscodex-dev's: a line is an array of spans
 * `{ t: text, s: style-prefix, w: cell-width }`, built with `span()`, measured
 * with `lineWidth()`, padded/truncated with `padLine()`, and painted with
 * `paint()`. Two width functions exist because they have different callers:
 * `w()` returns the display width of a *plain string* (the linear transcript
 * and the string renderers in render.js use it), while `padLine()` does the
 * per-codepoint maths for a span line (the overlays use it).
 *
 * Design note — this CLI is a LINEAR transcript, not a full-screen alt-buffer
 * TUI (which is what Claude Code and aegiscodex-dev are). Finished turns are
 * written once to scrollback, so output stays selectable, pipeable and
 * scrollback-searchable; only the one live status/spinner line is redrawn. The
 * main session loop deliberately does NOT enter the alternate screen — `--print`
 * and piped runs must keep working. The alt-screen / mouse / bracketed-paste
 * helpers below exist only so the overlay renderers (overlays.js) and any future
 * modal can paint and restore cleanly; they are never called on the transcript
 * path. Keeping the two concerns in one module (rather than two) is the same
 * split the reference uses.
 */

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

const { caps, cellWidth } = require('./caps.js');

// Real terminal cell width (wcwidth-style) comes from `caps.js`, which is the
// one place the table lives: a platform that draws a rune two cells wide that
// wcwidth does not know about (`AEGIS_WIDE_RUNES=✦`) has to shift *every* width
// decision at once, and a second copy of the table here is exactly how the
// transcript pads to one width while the overlay pads to another.
const cwidth = (ch) => cellWidth(ch);

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

/** Display width of a string in terminal cells. ANSI escapes are transparent
 *  (so a styled line measures the same as its visible text) — kept from the
 *  previous revision so callers measuring render output stay correct. */
function w(s) {
  let n = 0;
  for (const ch of stripAnsi(s)) n += cwidth(ch);
  return n;
}

/** Truncate a plain string to `width` cells without cutting a wide/combining
 *  codepoint. */
function clip(s, width) {
  if (w(s) <= width) return s;
  let out = '';
  let used = 0;
  for (const ch of String(s)) {
    const cw = cwidth(ch);
    if (used + cw > width) break;
    out += ch;
    used += cw;
  }
  return out;
}

/** Pad (or clip) a plain string to exactly `width` cells. */
function pad(s, width) {
  const t = clip(s, width);
  return t + ' '.repeat(Math.max(0, width - w(t)));
}

/** Right-align a plain string inside `width`. */
function padStart(s, width) {
  const t = clip(s, width);
  return ' '.repeat(Math.max(0, width - w(t))) + t;
}

// ── the span/line render model ──────────────────────────────────────────────

/** A styled text run. Shape { t, s, w } is the contract with overlays.js and
 *  markdown.js. */
function span(style, t) {
  return { t, s: style, w: w(t) };
}

/** Total display width of a span line. */
const lineWidth = (line) => line.reduce((a, sp) => a + sp.w, 0);

/**
 * Pad / truncate a span line to an exact cell width. Truncation is visual only
 * (a trailing style reset may be dropped) — the terminal clips whole glyphs, and
 * a 2-cell glyph is never split mid-width.
 */
function padLine(line, width) {
  let cur = 0;
  const out = [];
  for (const sp of line) {
    if (cur >= width) break;
    let t = sp.t;
    let tw = sp.w;
    if (cur + tw > width) {
      // Truncate by whole code points that fit in the remaining cells — a
      // codepoint slice (keep chars) would split a 2-cell glyph mid-width.
      const room = width - cur;
      let piece = '';
      let used = 0;
      for (const ch of [...t]) {
        const cw = w(ch);
        if (used + cw > room) break;
        piece += ch;
        used += cw;
      }
      t = piece;
      tw = used;
    }
    out.push({ t, s: sp.s, w: tw });
    cur += tw;
  }
  if (cur < width) out.push(span('', ' '.repeat(width - cur)));
  return out;
}

/** Term size, clamped so a zero-column report (CI, redirected stdout) still
 *  yields a paintable frame. Resolved through `caps.js` so `AEGIS_WIDTH` and
 *  `--width` reach every caller — the overlays used to read
 *  `process.stdout.columns` directly, which is 0 on a redirected run and left
 *  the frame 80 columns wide while the transcript had already been told
 *  otherwise. */
const getSize = () => {
  const c = caps();
  return { cols: c.cols, rows: c.rows };
};

// ── wrapping (plain strings; the string renderers use these) ─────────────────

/**
 * Word-wrap one logical plain line to `width` cells, preserving words and never
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

/** Wrap a block of plain text (honours existing newlines), applying `indent`. */
function wrapBlock(text, width, indent = '', hang = false) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    if (raw === '') {
      lines.push('');
      continue;
    }
    const parts = wrapLine(raw, width - w(indent));
    parts.forEach((p) => lines.push(indent + p));
  }
  return lines;
}

// ── cursor / screen control ─────────────────────────────────────────────────

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

const hideCursor = () => process.stdout.write('\x1b[?25l');
const showCursor = () => process.stdout.write('\x1b[?25h');
const moveTo = (row, col) => process.stdout.write(`\x1b[${row};${col}H`);

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

// Alternate screen buffer. Not used by the transcript (see the module note);
// available to overlays that need to paint and then restore the pre-launch
// terminal exactly. Guarded so paired enter/leave stay balanced.
let inAlt = false;
function enterAltScreen() {
  if (inAlt) return;
  inAlt = true;
  process.stdout.write('\x1b[?1049h');
}
function leaveAltScreen() {
  if (!inAlt) return;
  inAlt = false;
  process.stdout.write('\x1b[?1049l');
}
const isAltScreen = () => inAlt;

// Bracketed paste (DEC 2004): a paste arrives as one \x1b[200~ … \x1b[201~
// chunk instead of a burst of keystrokes.
const enableBracketedPaste = () => process.stdout.write('\x1b[?2004h');
const disableBracketedPaste = () => process.stdout.write('\x1b[?2004l');

// Mouse button-event tracking (DECSET 1000) + SGR coordinates (1006). Only the
// alt-screen/overlay path turns these on; disabled on exit so the shell we
// return to isn't left forwarding raw wheel bytes as input.
const enableMouseTracking = () => process.stdout.write('\x1b[?1000h\x1b[?1006h');
const disableMouseTracking = () => process.stdout.write('\x1b[?1000l\x1b[?1006l');

/**
 * Paint span lines top-aligned and clear the rest of the frame. Used by the
 * overlay renderers; the transcript path never calls it (it stays linear).
 */
function paint(lines) {
  const { rows, cols } = getSize();
  let out = '\x1b[H';
  for (let i = 0; i < rows; i++) {
    // Reset at the top of every row: span styles are colour codes, and a colour
    // code does NOT clear bold/italic/dim. Without this a row that ends inside a
    // BOLD segment whose "off" span got dropped by padding would leak the
    // attribute into every later row of the frame.
    out += '\x1b[0m';
    const line = lines[i];
    if (line) {
      const pl = padLine(line, cols);
      for (const sp of pl) out += sp.s + sp.t;
      out += '\x1b[0K';
    } else {
      out += '\x1b[0K';
    }
    if (i < rows - 1) out += '\n';
  }
  out += '\x1b[0m';
  process.stdout.write(out);
}

/** Repaint from `startRow` down, leaving rows above it untouched. */
function paintFrom(lines, startRow) {
  const { rows, cols } = getSize();
  let out = '';
  for (let i = 0; i < rows - startRow; i++) {
    const line = lines[startRow + i];
    if (i > 0) out += '\n';
    out += '\x1b[0K';
    out += '\x1b[0m';
    if (line) {
      const pl = padLine(line, cols);
      for (const sp of pl) out += sp.s + sp.t;
    }
  }
  out += '\x1b[0m';
  process.stdout.write(out);
}

function termWidth(fallback = 80) {
  const { cols } = getSize();
  return cols > 0 ? cols : Math.max(20, fallback);
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
  // plain-string width helpers (kept for the string renderers + app/bin)
  w,
  clip,
  pad,
  padStart,
  stripAnsi,
  wrapLine,
  wrapBlock,
  // span/line render model (from aegiscodex-dev)
  span,
  lineWidth,
  padLine,
  paint,
  paintFrom,
  getSize,
  // cursor / screen / input helpers (overlay path)
  EC: ESC,
  hideCursor,
  showCursor,
  moveTo,
  clearScreen,
  enterAltScreen,
  leaveAltScreen,
  isAltScreen,
  enableBracketedPaste,
  disableBracketedPaste,
  enableMouseTracking,
  disableMouseTracking,
  // the live region + sizing (app/bin)
  LiveRegion,
  termWidth,
};
