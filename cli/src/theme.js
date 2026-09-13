'use strict';

/**
 * AEGIS terminal theme — "Signal".
 *
 * This CLI is deliberately NOT a Claude Code look-alike. The palette below is
 * the whole point of the file: violet/cyan on ink, not the warm gold/coral
 * scheme every Claude Code derivative ships. `test/cli-identity.test.mjs` pins
 * that divergence — it fails if any of Claude Code's exact RGB triples, or its
 * prompt/spinner glyphs, reappear here.
 *
 * Zero dependencies: SGR escapes are hand-built, like the rest of this repo.
 */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const UNDER = '\x1b[4m';
const BOLD_OFF = '\x1b[22m';
const ITALIC_OFF = '\x1b[23m';
const UNDER_OFF = '\x1b[24m';
const RESET_FG = '\x1b[39m';
const RESET_BG = '\x1b[49m';

const RGB = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const BG = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;

/**
 * Dark theme (default). Every value is a truecolor triple; the palette leans
 * cool, and `ink`/`panel` are blue-black rather than neutral grey so the
 * transcript reads as a different product at a glance.
 */
const SIGNAL = {
  plasma: [124, 92, 255], // brand accent — sigil, prompts, active states
  beam: [34, 211, 238], // secondary — structure, model ids, code
  pulse: [52, 211, 153], // success
  alert: [251, 113, 133], // warning
  fault: [255, 99, 99], // error
  muted: [148, 163, 184], // secondary text
  dim: [71, 85, 105], // rails, rules, disabled
  text: [226, 232, 240], // body
  ink: [10, 12, 18], // deepest background (status bar, inverse)
  panel: [22, 25, 34], // raised surface (banner box)
};

/** Light theme — same roles, daylight values. Never a Claude Code palette. */
const SIGNAL_LIGHT = {
  plasma: [79, 55, 200],
  beam: [8, 122, 145],
  pulse: [5, 122, 85],
  alert: [190, 55, 90],
  fault: [185, 28, 28],
  muted: [71, 85, 105],
  dim: [148, 163, 184],
  text: [15, 23, 42],
  ink: [248, 250, 252],
  panel: [241, 245, 249],
};

/**
 * Glyphs. Chosen to share no character with Claude Code's prompt (`❯`),
 * spinner (`✢ · ✻ * ✽ ✶`), block cursor (`●`), hook (`⎿`) or quote bar (`▎`).
 */
const GLYPH = {
  prompt: '»', // input prompt
  sigil: '⬢', // AEGIS mark / assistant turns
  rail: '┃', // heavy vertical gutter, both transcript roles
  railEnd: '┣', // gutter corner where a turn's meta line attaches
  spend: '∅', // money readout
  ok: '✓',
  err: '✗',
  warn: '!',
  bullet: '∙', // U+2219, not Claude's U+00B7
  pointer: '▶', // selected row
  divider: '─',
  rule: '━',
  spin: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂'],
  box: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' }, // heavy, not rounded
};

/** Verbs for the working line — plain, no Claude Code whimsy. */
const VERBS = [
  'Consulting',
  'Routing',
  'Pooling',
  'Reasoning',
  'Drafting',
  'Checking',
  'Settling',
];

const THEMES = { dark: SIGNAL, light: SIGNAL_LIGHT };

/** The palette object for a context, per the rule that colours are always
 *  derived from one of the two theme objects — never typed inline. */
function themeOf(ctx) {
  return ctx && ctx.light ? SIGNAL_LIGHT : SIGNAL;
}

module.exports = {
  RGB,
  BG,
  RESET,
  BOLD,
  DIM,
  ITALIC,
  UNDER,
  BOLD_OFF,
  ITALIC_OFF,
  UNDER_OFF,
  RESET_FG,
  RESET_BG,
  SIGNAL,
  SIGNAL_LIGHT,
  THEMES,
  GLYPH,
  VERBS,
  themeOf,
};
