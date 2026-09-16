'use strict';

/**
 * Design tokens — the aegiscodex-dev design system, adopted wholesale.
 *
 * Every value below is copied verbatim from `aegiscodex-dev/src/theme.js`, which
 * extracted them from the live ANSI stream of Claude Code: gold 255,193,7 ·
 * coral 215,119,87 · lavender 177,185,249 · blue 120,160,250 · green 78,186,101
 * · red 220,90,90 · gray 153,153,153 · dim 80,80,80.
 *
 * `test/cli-conformance.test.mjs` pins these to aegiscodex-dev's source, so the
 * CLI cannot drift away from the design it is meant to match. (The previous
 * revision of this file was the inverse: a violet/cyan "Signal" palette with a
 * test asserting divergence. That theme is gone.)
 *
 * Zero dependencies: SGR escapes are hand-built, like the rest of this repo.
 */

// The stencil is the mark's single source of truth for its own runes — this
// file resolves `star` through it rather than restating the platform rule.
// `art.js` requires nothing, so this import cannot cycle.
const { STAR, stencilGlyph } = require('./art.js');

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

/** The dark palette. Role names match aegiscodex-dev exactly. */
const C = {
  gold: RGB(255, 193, 7), // header line, accents, welcome frame
  coral: RGB(215, 119, 87), // "Welcome to ..." title
  lavender: RGB(177, 185, 249), // selection cursor ❯, links, focused option
  blue: RGB(120, 160, 250), // selected palette row
  green: RGB(78, 186, 101), // checkmarks, success, diff additions
  red: RGB(220, 90, 90), // diff removals, errors
  gray: RGB(153, 153, 153), // secondary text, menu numbers, hints
  dim: RGB(80, 80, 80), // ╌ divider lines
  white: RGB(255, 255, 255), // primary text, spinner glyphs
  black: RGB(30, 30, 30), // code-block background
  darkBg: RGB(20, 20, 20), // theme card background
};

/** Light-theme approximations, true to the dark palette's hue mapping. */
const LIGHT = {
  gold: RGB(180, 130, 0),
  coral: RGB(190, 100, 70),
  lavender: RGB(120, 130, 220),
  blue: RGB(70, 110, 220),
  green: RGB(60, 150, 80),
  red: RGB(200, 60, 60),
  gray: RGB(110, 110, 110),
  dim: RGB(170, 170, 170),
  white: RGB(40, 40, 40),
  black: RGB(245, 245, 245),
  darkBg: RGB(255, 255, 255),
};

/**
 * Glyphs, copied from aegiscodex-dev's `GLYPH` including its platform passes.
 * A few of these are missing from non-Linux terminal fonts (⎿ U+23BF, ⏸ U+23F8)
 * or render as double-width emoji (✦ U+2726, ✻/✢/✽/✶), which breaks row
 * alignment exactly like the welcome art — those platforms get single-width
 * stand-ins instead.
 *
 * `star` is NOT restated here: it is resolved through `art.js`'s stencil, the
 * single source of truth for the mark's runes. This file used to carry its own
 * `'✦' → '*'` rule on win32/darwin, which is precisely how the star could stay
 * wide on one platform while the art got stencilled on another — the mark and
 * the glyph table would then disagree about the same character. Every other
 * entry below is a *text* glyph (cursor, hook, spinner frames) that no art row
 * contains, so it keeps its own definition.
 */
function glyphsFor(platform = process.platform) {
  const base = {
    cursor: '❯', // menu selection marker, prompt prefix
    check: '✔', // selected / completed
    divider: '╌', // menu separators
    bullet: '·', // inline separators
    hint: '❯', // "Try ..." suggestion marker
    pause: '⏸', // bottom status line (manual mode)
    star: stencilGlyph(STAR, platform), // own-session marker, decorations
    rightarrow: '→', // the manual ⇄ auto mode switch, advertised on the status line
    pointer: '▸', // tips list bullets
    hook: '⎿', // inline command / tip rows (tool commands, usage hints)
    block: '●', // streaming cursor / assistant answer marker
    bloom: '✻', // "done" spinner glyph (✻ Brewed for 2s)
    spin: ['✢', '·', '✻', '*', '✽', '✶'], // working spinner
    ellipse: '…',
  };
  if (platform === 'win32') {
    return {
      ...base,
      pause: '❚❚', // ⏸ U+23F8 missing from many Windows fonts
      hook: '_|', // ⎿ U+23BF almost never present in Windows fonts
      bloom: '*', // ✻ U+273B
      spin: ['|', '/', '-', '\\', '*', '-'],
    };
  }
  if (platform === 'darwin') {
    return {
      ...base,
      pause: '❚❚', // ⏸ has an emoji presentation on Apple fonts
      hook: '_|', // ⎿ U+23BF not in Apple monospace fonts
    };
  }
  return base;
}

const GLYPH = glyphsFor(process.platform);

/** Working-line verbs, verbatim from the capture-backed table. */
const VERBS = [
  'Incubating',
  'Tempering',
  'Determining',
  'Beboppin\'',
  'Julienning',
  'Inferring',
  'Simmering',
  'Twisting',
  'Fermenting',
  'Fiddle-faddling',
  'Orbiting',
  'Prestidigitating',
];

/** Completion verbs: "✻ Churned for 3s" after a chat turn, "✻ Worked for 3s"
 *  after one that used tools. */
const DONE_VERBS = ['Churned', 'Worked'];

const THEMES = { dark: C, light: LIGHT };

/**
 * The two extra palette families the reference's theme picker offers.
 *
 * `cb` is the colourblind-friendly variant: the red/green pair (the one that
 * carries meaning in diffs and errors) is remapped to the blue/orange axis so
 * the two remain distinguishable under deuteranopia and protanopia. `ansi` uses
 * the terminal's own 16-colour table, for terminals whose truecolour output is
 * remapped anyway — the whole point being that the *terminal* decides, not us.
 */
const CB_DARK = { ...C, green: RGB(86, 182, 194), red: RGB(255, 146, 43), gold: RGB(255, 203, 71) };
const CB_LIGHT = { ...LIGHT, green: RGB(30, 130, 145), red: RGB(200, 100, 20), gold: RGB(150, 110, 0) };

// 16-colour SGR foregrounds. Written as escape strings rather than RGB triples
// because the variant exists precisely to hand the decision to the terminal.
const A = (n) => `\x1b[${n}m`;
const ANSI_DARK = {
  gold: A(93), coral: A(91), lavender: A(94), blue: A(94), green: A(92),
  red: A(91), gray: A(90), dim: A(90), white: A(97), black: A(40),
  darkBg: '\x1b[48;5;236m',
};
const ANSI_LIGHT = {
  gold: A(33), coral: A(31), lavender: A(34), blue: A(34), green: A(32),
  red: A(31), gray: A(90), dim: A(37), white: A(30), black: A(47),
  darkBg: '\x1b[48;5;254m',
};

/**
 * The theme picker's table, copied from `aegiscodex-dev/src/screens.js` THEMES
 * (names and notes verbatim). `light` is the flag the reference sets on commit
 * (`ctx.light = sel === 2 || sel === 4 || sel === 6`); `palette` is what this
 * client resolves the row to, since it has no terminal-background probe and so
 * resolves "Auto" to the dark palette.
 */
const THEME_TABLE = [
  { name: 'Auto', note: '(match terminal)', light: false, palette: C },
  { name: 'Dark mode', note: '', light: false, palette: C },
  { name: 'Light mode', note: '', light: true, palette: LIGHT },
  { name: 'Dark mode', note: '(colorblind-friendly)', light: false, palette: CB_DARK },
  { name: 'Light mode', note: '(colorblind-friendly)', light: true, palette: CB_LIGHT },
  { name: 'Dark mode', note: '(ANSI colors only)', light: false, palette: ANSI_DARK },
  { name: 'Light mode', note: '(ANSI colors only)', light: true, palette: ANSI_LIGHT },
];

/** The palette object for a theme-picker row index (out-of-range → dark). */
function themeForIndex(i) {
  const row = THEME_TABLE[i];
  return row ? row.palette : C;
}

/**
 * The palette object for a context. Colours are always derived from one of the
 * theme objects — never typed inline.
 *
 * The light flag alone decides for the three default-brightness rows (indices
 * 0–2), which keeps `themeOf({light:true}) === LIGHT` and `themeOf({}) === C`
 * exactly as before. The colourblind and ANSI families are only consulted when
 * `themeIndex` actually names one of them (3–6), so an app that seeds
 * `themeIndex` to 0/1 for light/dark is unaffected.
 */
function themeOf(ctx) {
  if (ctx && typeof ctx.themeIndex === 'number' && ctx.themeIndex >= 3 && ctx.themeIndex <= 6) {
    return themeForIndex(ctx.themeIndex);
  }
  return ctx && ctx.light ? LIGHT : C;
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
  C,
  LIGHT,
  CB_DARK,
  CB_LIGHT,
  ANSI_DARK,
  ANSI_LIGHT,
  THEMES,
  THEME_TABLE,
  themeForIndex,
  GLYPH,
  glyphsFor,
  VERBS,
  DONE_VERBS,
  themeOf,
};
