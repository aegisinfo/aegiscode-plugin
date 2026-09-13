'use strict';

/**
 * AEGIS brand art.
 *
 * A hexagonal shield with a signal core — the mark that replaces the mascot
 * art every Claude Code derivative (including this repo's sibling project
 * aegiscodex-dev) ships. Same job, different iconography on purpose:
 * `test/cli-identity.test.mjs` asserts Claude Code's own art never appears here.
 *
 * Every row is the same display width (9 cells) so it can be centred or stacked
 * without drift; `tests` assert that rather than trusting it.
 */

const SIGIL = [
  ' ▄▄▄▄▄▄▄ ',
  '▟███████▙',
  '▜███▀███▛',
  ' ▜█████▛ ',
  '  ▜███▛  ',
  '   ▜▛    ',
];

/** Cell offsets (row, col) of the core, painted in the secondary colour. */
const CORE = [{ row: 2, col: 4 }];

const WORDMARK = 'A E G I S';
const TAGLINE = 'Cloud brain in your shell.';

/**
 * Left-pad every row of `art` so it sits centred inside `width`.
 * @returns {string[]}
 */
function center(art, width) {
  const w = art.reduce((m, r) => Math.max(m, [...r].length), 0);
  const pad = Math.max(0, Math.floor((width - w) / 2));
  return art.map((r) => ' '.repeat(pad) + r);
}

module.exports = { SIGIL, CORE, WORDMARK, TAGLINE, center, SIGIL_WIDTH: 9 };
