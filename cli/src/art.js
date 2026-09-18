'use strict';

const { caps, detect, cells, padCells } = require('./caps.js');

/**
 * Resolve a stencil target — nothing at all, a `process.platform` name, or a
 * whole caps object — to the capabilities that decide the pass.
 *
 * A platform *name* is still accepted because it is the shape a test wants when
 * it is asking "what would the mark look like on that host?"; it is resolved
 * through the same `detect()` the live process uses, so a platform string is a
 * convenience alias for a capability probe, never a second decision path.
 */
function capsOf(target) {
  if (!target) return caps();
  if (typeof target === 'string') return detect(process.env, process.stdout, target);
  return target;
}

/**
 * Welcome art — the ÆGIS wordmark, adopted verbatim from `aegiscodex-`.
 *
 * This is the mark the rest of the family already draws: the wordmark block in
 * `aegiscodex-/src/ui/components/layout/WelcomeMessage.tsx`, which is kept in
 * sync with `aegiscodex-/assets/demo.svg`, the canonical rendering. The CLI now
 * shows the same welcome screen as the desktop host instead of its own art.
 *
 * It REPLACES the earlier Claude-binary composition (feather plume, top hat,
 * ▐▛███▜▌ face, crescent moon, diving whale). That mark was three blocks joined
 * side by side, which is why this file carried a stacking path, a `✦` star pass
 * and a two-ink split; a single 13-cell block needs none of them, so the banner
 * draws it in one ink — gold — exactly as `theme.colors.primary` inks it in the
 * desktop, and the wide/narrow branch in both consumers now always takes the
 * wide path.
 *
 * Every row is the same display width with no trailing blank, so `center()` and
 * `padCells()` stay exact. `test/cli-conformance.test.mjs` pins these rows to
 * the literals they were lifted from, so the mark cannot drift from aegiscodex-.
 *
 * Which stencil pass is applied is decided by the terminal's capabilities, not
 * by `process.platform` — see the portability section below and `caps.js`.
 */

// The ÆGIS wordmark: 3 rows × 13 cells, uniform. Row 1 is the cap line, row 2
// carries the Æ crossbar (╦) and the G/S shoulders, row 3 the baseline.
//
// Deliberately not named after the old spaced `'A E G I S'` string: that
// export was removed and `cli-conformance.test.mjs` fails the build if its name
// reappears in this file's exports. The guard is about that string, not this
// block, so the block takes a name of its own rather than the guard being
// loosened to accommodate it.
const WELCOME_MARK = [
  '╔═╗╔═╗╔═╗╦╔═╗',
  '╠═╣║╣ ║ ╦║╚═╗',
  '╩ ╩╚═╝╚═╝╩╚═╝',
];

/** The welcome mark: the wordmark, with nothing drawn beside it. */
const WELCOME_ART = WELCOME_MARK;

/**
 * There is no stacked variant any more: the mark is 13 cells, so it fits any
 * terminal that can draw the banner's own frame. Kept as an alias rather than
 * deleted because `welcomeArtFor()` and the capability matrix enumerate both
 * names, and a second constant that happens to equal the first is cheaper than
 * a branch in two consumers.
 */
const WELCOME_ART_STACKED = WELCOME_MARK;

/** Welcome copy, in aegiscode-dev's frame: coral title over the mark. */
const WELCOME_TITLE = 'Welcome to AEGIS Code';
const WELCOME_BACK = 'Welcome back!';
// One owner for the tagline: `render.js` joins it into the banner's version
// line and `screens.js` centres it on the welcome screen. It used to be written
// out twice — once here, once inline in `screens.js` — so a copy change landed
// in one place and left the other stale.
const TAGLINE = 'Your intent, AI automated.';
// For terminals too narrow for the full line. `centered()` clips rather than
// wraps, and a truncated tagline reads as a rendering fault, so this is a real
// fallback and not a stylistic variant.
const TAGLINE_SHORT = 'Your intent, automated.';

// ── Terminal portability ─────────────────────────────────────────────────────
// The wordmark is drawn with U+2550 box-drawing runes. Those are single-width on
// most terminals, but not everywhere: a legacy Windows console font has no
// box-drawing block at all, Terminal.app's fallback font renders the quarters
// (▐▛▜▌▝▘) wrong and ✦ through the two-cell emoji fallback. Each pass swaps
// offending code points 1:1 (same character count per row) so the width maths
// stays exact and the mark keeps its shape.
//
// The pass is keyed on the terminal's CAPABILITIES (`caps.js`), never on
// `process.platform`. That distinction is the whole point: PowerShell inside
// Windows Terminal draws this mark exactly as zsh does, and it used to be
// handed the hyphen-and-hash ASCII version purely because the *process* was
// win32. The three passes below compose — a Windows VT host needs the star
// narrow but keeps the native block palette, which no single platform-keyed
// table could express.
//
// This table is the ONE stencil source of truth for the product. `theme.js`
// resolves `GLYPH.star` through `stencilGlyph(STAR, caps)` rather than carrying
// its own `'✦' → '*'` rule, and `render.js` builds the mark's tint map by
// stencilling its runes — both had a private copy of the same decision, which
// is how a stencil edit here could leave the star wide on macOS or the whale
// untinted on Windows. `test/cli-terminal-caps.test.mjs` pins all of it.
const STAR = '✦';

/** The quartile/quadrant face edges. The wordmark no longer draws them, but the
 *  `face` capability still resolves through this list, so the pass stays. */
const EDGE_RUNES = ['▐', '▛', '▜', '▌', '▝', '▘'];

/**
 * The box-drawing runes the wordmark is made of. A legacy console has none of
 * them, and without a mapping the mark would be drawn in a font that has no
 * glyphs for it — boxes of tofu where the product name should be.
 *
 * Every corner, tee and cross becomes `+` (the classic ASCII box) and the two
 * straight strokes keep their meaning as `-` and `|`, so the stencilled mark is
 * still legible as ÆGIS rather than as a row of plusses. Ten runes, ten 1:1
 * swaps: the mark stays 13 cells wide and 3 rows tall on every terminal.
 */
const BOX_RUNES = ['╔', '╗', '╚', '╝', '╠', '╣', '╦', '╩', '║', '═'];
const BOX_STENCIL = new Map([
  ...['╔', '╗', '╚', '╝', '╠', '╣', '╦', '╩'].map((c) => [c, '+']),
  ['═', '-'],
  ['║', '|'],
]);

/** Full ASCII pass: the wordmark's box runes, the block palette, the face
 *  edges, the star, the mid-dot. */
const ASCII_STENCIL = new Map([
  ...BOX_STENCIL,
  ['█', '#'],
  ['▓', '@'],
  ['▒', '='],
  ['░', '.'],
  ...EDGE_RUNES.map((c) => [c, '#']),
  [STAR, '*'],
  ['·', '.'],
]);

/** Unicode pass for fonts that carry █▓▒░ but not the face edges (Apple, old Consolas). */
const EDGE_STENCIL = new Map(EDGE_RUNES.map((c) => [c, '#']));

/** ✦ alone: a font that falls back to a *two-cell* emoji glyph for it. */
const STAR_STENCIL = new Map([[STAR, '*']]);

/**
 * The named passes. They compose rather than being picked one-of-three: a
 * Windows VT host takes `star` only (native palette, narrow star) and
 * Terminal.app takes `edges` + `star`.
 */
const STENCILS = { ascii: ASCII_STENCIL, edges: EDGE_STENCIL, star: STAR_STENCIL };

/**
 * The capability classes this mark has a pass for, and the one that needs none.
 * Kept as a name list so a caller (and the test) can enumerate the matrix
 * without restating the pass table.
 */
const PASSES = ['native', 'star', 'edges', 'ascii'];


/**
 * The stencil for a terminal, or `null` when its runes need no pass.
 *
 * `glyphs: 'ascii'` is the full pass and subsumes the others — a terminal with
 * no block glyphs certainly has no quartile edges and no ✦ either, so it must
 * not be handed a partial map that leaves ░▒▓◧ on screen.
 *
 * @param {string|object|null} [target] a caps object, a `process.platform` name,
 *   or nothing for the live process's resolved capabilities.
 * @returns {Map<string,string>|null}
 */
function stencilFor(target = null) {
  const c = capsOf(target);
  if (c.glyphs === 'ascii') return ASCII_STENCIL;
  const pass = new Map();
  if (c.face === 'edges') for (const [k, v] of EDGE_STENCIL) pass.set(k, v);
  if (c.star === 'narrow') for (const [k, v] of STAR_STENCIL) pass.set(k, v);
  return pass.size ? pass : null;
}

/**
 * One rune as the terminal renders it — the identity when it is native.
 * Exported so `theme.js`'s glyph table and `render.js`'s tint map are derived
 * from the stencil instead of restating it.
 * @param {string} ch
 * @param {string|object} [target] a caps object, a platform name, or nothing
 */
function stencilGlyph(ch, target = null) {
  const s = stencilFor(target);
  return (s && s.get(ch)) || ch;
}

/** One pass over an art block, for an explicit target (caps object or platform). */
function portabilityFor(rows, target = null) {
  const s = stencilFor(target);
  if (!s) return rows;
  return rows.map((r) => [...r].map((ch) => s.get(ch) ?? ch).join(''));
}

/**
 * The mark as the terminal running this process will render it.
 *
 * Deliberately NOT memoised: `aegiscode --ascii` and `/terminal ascii` re-resolve
 * the capabilities mid-session, and a cached mark would keep drawing the
 * previous terminal's runes until the process restarted.
 */
function portability(rows) {
  return portabilityFor(rows, null);
}

/** The welcome mark, as this terminal will render it. */
function welcomeArtFor() {
  return portability(WELCOME_ART);
}

/**
 * The mark, ready for the banner: one row per output row, each as a
 * `[left, right]` pair so the two consumers' ink split keeps working.
 *
 * The right half is always empty now. The pair shape is kept because
 * `render.js`'s `artRow()` is built around it — `left` is painted gold, `right`
 * per-shade — and collapsing it would mean a second, cosmetic signature for the
 * same data. A future two-tone mark drops straight back into the right slot.
 *
 * The width argument the consumers used to pass is gone with the wide/narrow
 * split: 13 cells fits everywhere the banner itself fits, so there is nothing
 * left for the terminal's column count to decide.
 *
 * @returns {{rows: Array<[string,string]>, width: number, gutter: number}}
 */
function welcomeArtParts() {
  const rows = portability(WELCOME_MARK);
  return {
    rows: rows.map((r) => [r, '']),
    width: Math.max(...rows.map(cells)),
    gutter: 0,
  };
}

/** Centre every row of an art block inside `width` (left pad + right fill). */
function center(rows, width) {
  return rows.map((r) => {
    const pad = Math.max(0, Math.floor((width - cells(r)) / 2));
    return ' '.repeat(pad) + padCells(r, width - pad);
  });
}

/** Centre each row against the block's own max width (no trailing fill). */
function padBoth(rows, width) {
  const w = Math.max(...rows.map(cells));
  return rows.map((r) => {
    const pad = Math.floor((width - w) / 2);
    return ' '.repeat(Math.max(0, pad)) + r;
  });
}

module.exports = {
  WELCOME_MARK,
  WELCOME_ART,
  WELCOME_ART_STACKED,
  WELCOME_TITLE,
  WELCOME_BACK,
  TAGLINE,
  TAGLINE_SHORT,
  STAR,
  EDGE_RUNES,
  BOX_RUNES,
  PASSES,
  STENCILS,
  stencilFor,
  stencilGlyph,
  portability,
  portabilityFor,
  welcomeArtFor,
  welcomeArtParts,
  center,
  padBoth,
};
