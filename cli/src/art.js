'use strict';

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
// The block-glyph palette and ✦ stars are single-width on Linux terminals, but
// not everywhere: Windows fonts often lack the U+259B..U+259F face edges and
// mangle █▓▒░ entirely; on macOS ✦ renders as a double-width emoji. Each pass
// swaps offending code points 1:1 (same character count per row) so the width
// maths stays exact and the mark keeps its shape.
const ASCII_STENCIL = new Map([
  ['█', '#'],
  ['▓', '@'],
  ['▒', '='],
  ['░', '.'],
  ['▐', '#'],
  ['▛', '#'],
  ['▜', '#'],
  ['▌', '#'],
  ['▝', '#'],
  ['▘', '#'],
  ['✦', '*'],
  ['·', '.'],
]);

const DARWIN_STENCIL = new Map([
  ['▐', '#'],
  ['▛', '#'],
  ['▜', '#'],
  ['▌', '#'],
  ['▝', '#'],
  ['▘', '#'],
  ['✦', '*'],
]);

/** One platform pass over an art block. */
function portability(rows) {
  if (process.platform === 'win32') {
    return rows.map((r) => [...r].map((ch) => ASCII_STENCIL.get(ch) ?? ch).join(''));
  }
  if (process.platform === 'darwin') {
    return rows.map((r) => [...r].map((ch) => DARWIN_STENCIL.get(ch) ?? ch).join(''));
  }
  return rows;
}

/** The mark that fits the current terminal: side-by-side when there's room. */
function welcomeArtFor(cols) {
  const wide = portability(WELCOME_ART);
  const stacked = portability(WELCOME_ART_STACKED);
  const W = Math.max(...wide.map((r) => [...r].length));
  return cols >= W + 4 ? wide : stacked;
}

/**
 * Split the mark into its two halves so each can carry its own theme ink.
 * @returns {{rows: Array<[string,string]>, width: number, gutter: number}}
 */
function welcomeArtParts(cols) {
  const mascot = portability(MASCOT_ART);
  const moonWhale = portability(MOON_WHALE);
  const L = Math.max(...mascot.map((r) => [...r].length));
  const R = Math.max(...moonWhale.map((r) => [...r].length));
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
      rows.push([(mascot[li] ?? '').padEnd(L), (moonWhale[ri] ?? '').padEnd(R)]);
    }
    return { rows, width: L + gutter + R, gutter };
  }
  const w = Math.max(L, R);
  const centerBlock = (rows) =>
    rows.map((r) => ' '.repeat(Math.max(0, Math.floor((w - [...r].length) / 2))) + r);
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
  const w = Math.max(...[...top, ...bottom].map((r) => [...r].length));
  const centerBlock = (rows) =>
    rows.map((r) => {
      const pad = Math.max(0, Math.floor((w - [...r].length) / 2));
      return ' '.repeat(pad) + r;
    });
  return [...centerBlock(top), ...Array(gap).fill(''), ...centerBlock(bottom)];
}

/** Join two art stacks row-aligned (bottom-aligned by default). */
function joinSideBySide(left, right, gutter = 2, align = 'bottom') {
  const L = Math.max(...left.map((r) => [...r].length));
  const R = Math.max(...right.map((r) => [...r].length));
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
    const l = (left[li] ?? '').padEnd(L);
    const r = (right[ri] ?? '').padEnd(R);
    return l + ' '.repeat(gutter) + r;
  });
}

/** Centre every row of an art block inside `width` (left pad + right fill). */
function center(rows, width) {
  return rows.map((r) => {
    const pad = Math.max(0, Math.floor((width - [...r].length) / 2));
    return ' '.repeat(pad) + r + ' '.repeat(Math.max(0, width - [...r].length - pad));
  });
}

/** Centre each row against the block's own max width (no trailing fill). */
function padBoth(rows, width) {
  const w = Math.max(...rows.map((r) => [...r].length));
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
  portability,
  welcomeArtFor,
  welcomeArtParts,
  stackVertical,
  joinSideBySide,
  center,
  padBoth,
};
