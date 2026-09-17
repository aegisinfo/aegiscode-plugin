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
 * Welcome art — the aegiscodex-dev mark, adopted wholesale.
 *
 * The composition is copied from `aegiscodex-dev/src/art.js`, which took the
 * glyph rows from the shipped Claude Code binary: a feather plume (░), a top hat
 * (█ ▓ ▒), the spark face (▐▛███▜▌ / ▝▜█████▛▘ / ▘▘ ▝▝), plus a crescent moon and
 * a diving whale for the second brain. Side-by-side when the terminal is wide
 * enough, stacked when it isn't.
 *
 * Every row of a block is the same display width, so `center()` and
 * `joinSideBySide()` stay exact. `test/cli-conformance.test.mjs` asserts both
 * that property and that these rows still match aegiscodex-dev's source, so the
 * mark can't drift.
 *
 * Which pass is applied is decided by the terminal's capabilities, not by
 * `process.platform` — see the portability section below and `caps.js`.
 */

// The mascot face — exact glyphs from the binary (msS template).
const FACE = [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝'];

// Top hat + feather plume, composed from the extracted row glyphs.
const HAT = [
  '  ✦         ░░░░░░░░░░      ✦',
  '           ░░░░░░░░░░░░░░░░',
  '                 █████▓▓░',
  '                 ███▓░',
  '                 ███▓░',
  '                 ███▓░',
  '               ░▓▓███▓▓░',
  '          ▒▒░░▒▒     ▒ ▒▒',
];

// Plume + hat + face: the left half of the welcome mark.
const MASCOT_ART = [
  '        ✦               █████▓▓░',
  '             ✦        ███▓░     ░░',
  '         ░░░░         ███▓░',
  '       ░░░░░░░░       ███▓░',
  '     ░░░░░░░░░░░░     ███▓░',
  '              ██▓░░      ▓',
  '              ░▓▓███▓▓░',
  ...FACE,
];

// Crescent moon in a starry night sky — lit rim (▓) with a faint earthshine
// body (░). Rows are equal code-point length (13).
const MOON = [
  '  ✦   ▓▓▓  ✦ ',
  '    ▓▓▓▓▓   ✦',
  '  ▓▓▓▓▓▓▓▓▓ ✦',
  '  ▓▓▓▓▓▓▓░░░ ',
  '  ▓▓▓▓░░░░░░ ',
  '    ░░░░░░   ',
  '  ✦   ·   ·  ',
];

// The diving whale: spout (░), eye (██) on the rounded head, body (▒) sweeping
// right to a small forked fluke (▓), water line (░) beneath. Rows are equal
// code-point length (18).
const WHALE = [
  '   ✦   ░ ░ ░      ',
  '    ✦ ░░░░░       ',
  '     ▒▒▒▒▒▒▒▒▒▒▒▒ ',
  '    ▒▒▒▒▒▒▒▒▒▒▒▒▒ ',
  '  ██▒▒▒▒▒▒▒▒▒▒▒▒▓▓',
  '  ██▒▒▒▒▒▒▒▒▒▒▒▒▓ ',
  '   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒ ',
  '    ░░░░░░░░░░░░  ',
];

// Moon above the whale — the right half of the mark, 2-col gutter. The moon is
// padded with a trailing blank row so joinSideBySide keeps both blocks aligned.
const MOON_WHALE = joinSideBySide([...MOON, ''], WHALE, 2);

/** Full welcome mark: mascot + (moon + whale) side by side, bottom-aligned. */
const WELCOME_ART = joinSideBySide(MASCOT_ART, MOON_WHALE, 2);

/** Narrow-terminal fallback: mascot stacked above (moon + whale). */
const WELCOME_ART_STACKED = stackVertical(MASCOT_ART, MOON_WHALE, 1);

/** Welcome copy, in aegiscode-dev's frame: coral title over the mark. */
const WELCOME_TITLE = 'Welcome to AEGIS Code';
const WELCOME_BACK = 'Welcome back!';
const TAGLINE = 'Cloud brain in your shell.';

// ── Terminal portability ─────────────────────────────────────────────────────
// The block-glyph palette and ✦ stars are single-width on most terminals, but
// not everywhere: a legacy Windows console font lacks the U+259B..U+259F face
// edges and mangles █▓▒░ entirely; Terminal.app has no quartile edges and
// renders ✦ through the two-cell emoji fallback. Each pass swaps offending code
// points 1:1 (same character count per row) so the width maths stays exact and
// the mark keeps its shape.
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

/** The quartile/quadrant face edges — the runes Apple and older Windows fonts lack. */
const EDGE_RUNES = ['▐', '▛', '▜', '▌', '▝', '▘'];

/** Full ASCII pass: the block palette, the face edges, the star, the mid-dot. */
const ASCII_STENCIL = new Map([
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

/** The mark that fits the current terminal: side-by-side when there's room. */
function welcomeArtFor(cols) {
  const wide = portability(WELCOME_ART);
  const stacked = portability(WELCOME_ART_STACKED);
  const W = Math.max(...wide.map(cells));
  return cols >= W + 4 ? wide : stacked;
}

/**
 * Split the mark into its two halves so each can carry its own theme ink.
 *
 * Rows are padded to a whole-cell width with `padCells()`, not `padEnd()`: a
 * terminal that draws a rune two cells wide (`AEGIS_WIDE_RUNES=✦`, or a font
 * that falls back to an emoji glyph) would otherwise be padded by *code point*
 * and every row after it would drift one cell to the right of the one above.
 *
 * @returns {{rows: Array<[string,string]>, width: number, gutter: number}}
 */
function welcomeArtParts(cols) {
  const mascot = portability(MASCOT_ART);
  const moonWhale = portability(MOON_WHALE);
  const L = Math.max(...mascot.map(cells));
  const R = Math.max(...moonWhale.map(cells));
  const wide = cols >= L + R + 2 + 4;
  const gutter = wide ? 2 : 1;
  if (wide) {
    // The right half carries the moon *and* the whale. Using WHALE alone here —
    // which the reference does, because it only wants the per-mascot ink split —
    // would silently drop the crescent from the welcome screen this CLI renders.
    const n = Math.max(mascot.length, moonWhale.length);
    const rows = [];
    for (let i = 0; i < n; i++) {
      // Same bottom-align rule as joinSideBySide — subtract the offset.
      const li = i - (n - mascot.length);
      const ri = i - (n - moonWhale.length);
      rows.push([padCells(mascot[li] ?? '', L), padCells(moonWhale[ri] ?? '', R)]);
    }
    return { rows, width: L + gutter + R, gutter };
  }
  const w = Math.max(L, R);
  const centerBlock = (rows) => rows.map((r) => ' '.repeat(Math.max(0, Math.floor((w - cells(r)) / 2))) + r);
  return {
    rows: [
      ...centerBlock(mascot).map((c) => [c, '']),
      ['', ''],
      ...centerBlock(moonWhale).map((r) => ['', r]),
    ],
    width: w,
    gutter,
  };
}

/** Stack two art blocks vertically, each centred, separated by `gap` rows. */
function stackVertical(top, bottom, gap = 1) {
  const w = Math.max(...[...top, ...bottom].map(cells));
  const centerBlock = (rows) =>
    rows.map((r) => ' '.repeat(Math.max(0, Math.floor((w - cells(r)) / 2))) + r);
  return [...centerBlock(top), ...Array(gap).fill(''), ...centerBlock(bottom)];
}

/** Join two art stacks row-aligned (bottom-aligned by default). */
function joinSideBySide(left, right, gutter = 2, align = 'bottom') {
  const L = Math.max(...left.map(cells));
  const R = Math.max(...right.map(cells));
  const n = Math.max(left.length, right.length);
  return Array.from({ length: n }, (_, i) => {
    // Bottom-align puts each block's LAST row on the output's last row, so a
    // shorter block starts lower and its index runs *behind* the output index.
    // Adding the offset instead of subtracting it pushed the shorter block off
    // the bottom edge and silently dropped its top rows: the moon+whale half,
    // two rows shorter than the mascot, lost its spout and its top star and
    // hung two rows below the baseline.
    const li = align === 'bottom' ? i - (n - left.length) : i;
    const ri = align === 'bottom' ? i - (n - right.length) : i;
    const l = padCells(left[li] ?? '', L);
    const r = padCells(right[ri] ?? '', R);
    return l + ' '.repeat(gutter) + r;
  });
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
  FACE,
  HAT,
  MASCOT_ART,
  MOON,
  WHALE,
  MOON_WHALE,
  WELCOME_ART,
  WELCOME_ART_STACKED,
  WELCOME_TITLE,
  WELCOME_BACK,
  TAGLINE,
  STAR,
  EDGE_RUNES,
  PASSES,
  STENCILS,
  stencilFor,
  stencilGlyph,
  portability,
  portabilityFor,
  welcomeArtFor,
  welcomeArtParts,
  stackVertical,
  joinSideBySide,
  center,
  padBoth,
};
