'use strict';

/**
 * Design tokens — the aegiscodex-dev design system, adopted wholesale, and
 * resolved through the terminal's capabilities (`caps.js`) rather than the
 * platform the process happens to run on.
 *
 * Every colour value below is copied verbatim from `aegiscodex-dev/src/theme.js`,
 * which extracted them from the live ANSI stream of Claude Code: gold 255,193,7
 * · coral 215,119,87 · lavender 177,185,249 · blue 120,160,250 · green 78,186,101
 * · red 220,90,90 · gray 153,153,153 · dim 80,80,80. `test/cli-conformance.test.mjs`
 * pins them to aegiscodex-dev's source and reads them back out of a truecolor
 * SGR prefix, so the design cannot drift.
 *
 * What DOES change per terminal is how those triples reach the screen:
 *
 *   · `RGB()`/`BG()` go through `caps.rgb()/caps.bg()`, which emit 24-bit SGR,
 *     the 256-colour cube, the 16 ANSI slots, or nothing at all — decided by the
 *     terminal, not by us. On a legacy Windows console or `TERM=linux` the UI
 *     now paints in colours that console can actually show, instead of emitting
 *     truecolor escapes it renders as literal text or dithers unpredictably.
 *   · `glyphsFor()` is a function of the resolved capabilities, so PowerShell in
 *     Windows Terminal gets the same ❯ ⎿ ✻ ✦ set as zsh, and only a terminal
 *     that genuinely cannot draw them (legacy console, `TERM=dumb`, a non-UTF-8
 *     locale, `AEGIS_ART=ascii`) gets the ASCII stand-ins.
 *
 * Both are re-materialised when the capabilities change (`onCapsChange`), so
 * `aegiscode --ascii`, `--no-color` and the `/terminal` command take effect on
 * the palette and glyph table of a *running* session — the exported objects are
 * mutated in place rather than replaced, because renderers hold references to
 * them (`const { C } = require('./theme.js')`).
 *
 * Zero dependencies: SGR escapes are hand-built, like the rest of this repo.
 */

const { caps, detect, onCapsChange, rgb, bg } = require('./caps.js');

// The stencil is the mark's single source of truth for its own runes — this
// file resolves `star` through it rather than restating the platform rule.
// `art.js` requires only `caps.js`, so this import cannot cycle.
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

/** Truecolour foreground SGR (or the best the terminal can do — see caps.js). */
const RGB = (r, g, b) => rgb(r, g, b);
/** Truecolour background SGR (or the best the terminal can do). */
const BG = (r, g, b) => bg(r, g, b);

// ── the palettes ─────────────────────────────────────────────────────────────
// Built by functions and written into stable objects: `Object.assign` on every
// capability change keeps the key set identical (the conformance guard pins
// `Object.keys(C)`) while the escapes follow the new depth.

/** The dark palette. Role names match aegiscodex-dev exactly. */
const C = {};
/** Light-theme approximations, true to the dark palette's hue mapping. */
const LIGHT = {};
/** The colourblind-friendly dark/light variants. */
const CB_DARK = {};
const CB_LIGHT = {};
/** The 16-colour ANSI-only variants. */
const ANSI_DARK = {};
const ANSI_LIGHT = {};

function buildDark() {
  return {
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
}

function buildLight() {
  return {
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
}

function buildCbDark() {
  return {
    ...buildDark(),
    // The red/green pair — the one that carries meaning in diffs and errors —
    // is remapped to the blue/orange axis, which stays distinguishable under
    // deuteranopia and protanopia.
    green: RGB(86, 182, 194),
    red: RGB(255, 146, 43),
    gold: RGB(255, 203, 71),
  };
}

function buildCbLight() {
  return {
    ...buildLight(),
    green: RGB(30, 130, 145),
    red: RGB(200, 100, 20),
    gold: RGB(150, 110, 0),
  };
}

// 16-colour SGR foregrounds. Written as escape strings rather than RGB triples
// because the variant exists precisely to hand the decision to the terminal.
const A = (n) => (caps().color ? `\x1b[${n}m` : '');

function buildAnsiDark() {
  return {
    gold: A(93), coral: A(91), lavender: A(94), blue: A(94), green: A(92),
    red: A(91), gray: A(90), dim: A(90), white: A(97), black: A(40),
    darkBg: caps().color ? '\x1b[48;5;236m' : '',
  };
}

function buildAnsiLight() {
  return {
    gold: A(33), coral: A(31), lavender: A(34), blue: A(34), green: A(32),
    red: A(31), gray: A(90), dim: A(37), white: A(30), black: A(47),
    darkBg: caps().color ? '\x1b[48;5;254m' : '',
  };
}

/**
 * Diff palette for edit blocks in the transcript — Monokai Extended, taken
 * verbatim from the theme picker's preview (also `renderDiffPreview` in
 * `aegiscodex-dev/src/markdown.js`) so the two can never drift apart: dim
 * red/green backgrounds per row, the bright variant for the token that
 * actually changed inside the row, and the monokai syntax colors for the code
 * itself.
 *
 * A SEPARATE export, not keys added to `C`/`LIGHT`: `test/cli-conformance.test.mjs`
 * pins `Object.keys(C)` to exactly the eleven DEV_DARK role names, so a diff
 * entry folded into the palette would fail the conformance guard. This is the
 * same reason `DIFF` is its own object in the engine.
 */
const DIFF = {};
const DIFF_LIGHT = {};

function buildDiff() {
  return {
    delFg: RGB(220, 90, 90),
    delBg: BG(61, 1, 0),
    delHiFg: RGB(248, 248, 242),
    delHiBg: BG(92, 2, 0),
    addFg: RGB(80, 200, 80),
    addBg: BG(2, 40, 0),
    addHiFg: RGB(255, 255, 255),
    addHiBg: BG(4, 71, 0),
    codeFg: RGB(248, 248, 242),
    gutter: RGB(120, 120, 120),
    kw: RGB(102, 217, 239),
    fn: RGB(166, 226, 46),
    str: RGB(230, 219, 116),
    num: RGB(174, 129, 255),
    comment: RGB(117, 113, 94),
  };
}

/**
 * The light-theme diff palette. Monokai's dark backgrounds on a light terminal
 * are unreadable, so the row backgrounds invert to a pale tint and the code
 * keeps its hue mapping from the dark set — the same relationship `LIGHT`
 * already has to `C`.
 */
function buildDiffLight() {
  return {
    delFg: RGB(160, 40, 40),
    delBg: BG(255, 235, 233),
    delHiFg: RGB(90, 0, 0),
    delHiBg: BG(255, 205, 200),
    addFg: RGB(30, 130, 40),
    addBg: BG(232, 250, 232),
    addHiFg: RGB(0, 80, 0),
    addHiBg: BG(195, 240, 195),
    codeFg: RGB(40, 40, 40),
    gutter: RGB(150, 150, 150),
    kw: RGB(0, 120, 160),
    fn: RGB(80, 140, 0),
    str: RGB(150, 110, 0),
    num: RGB(120, 60, 200),
    comment: RGB(140, 140, 130),
  };
}

const THEMES = { dark: C, light: LIGHT };

/**
 * The two extra palette families the reference's theme picker offers.
 *
 * `cb` is the colourblind-friendly variant (see `buildCbDark`). `ansi` uses
 * the terminal's own 16-colour table, for terminals whose truecolour output is
 * remapped anyway — the whole point being that the *terminal* decides, not us.
 */
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
 *
 * The *depth* is deliberately not consulted here: `C` is already built from
 * `RGB()`, which is depth-aware, so a 16-colour console gets a 16-colour dark
 * palette rather than being silently switched to the ANSI picker row — the
 * picker row must keep meaning "use the terminal's own table", not
 * "your terminal is too old".
 */
function themeOf(ctx) {
  if (ctx && typeof ctx.themeIndex === 'number' && ctx.themeIndex >= 3 && ctx.themeIndex <= 6) {
    return themeForIndex(ctx.themeIndex);
  }
  return ctx && ctx.light ? LIGHT : C;
}

/**
 * The diff palette for a context — the exact companion of `themeOf`, so a
 * caller never has to ask "which palette did the rows use?" separately from
 * "which diff colors go with it?". `themeIndex` 3–6 are the four picker rows
 * whose brightness is named by their own `light` flag; anything else falls
 * back to the ctx's `light` flag, exactly as `themeOf` does.
 */
function diffOf(ctx) {
  const light = ctx && typeof ctx.themeIndex === 'number' && ctx.themeIndex >= 3 && ctx.themeIndex <= 6
    ? !!THEME_TABLE[ctx.themeIndex].light
    : !!(ctx && ctx.light);
  return light ? DIFF_LIGHT : DIFF;
}

// ── glyphs ───────────────────────────────────────────────────────────────────

/**
 * The glyph table for a terminal, resolved from its capabilities.
 *
 * A few of the reference's glyphs are missing from some terminal fonts
 * (⎿ U+23BF, ⏸ U+23F8, ✔ U+2714, ▸ U+25B8) or render as double-width emoji
 * (✦ U+2726, ✻/✢/✽/✶), which breaks row alignment exactly like the welcome art.
 * The three capability classes in `caps.js` decide the set:
 *
 *   · `glyphs: 'ascii'`  — no Unicode claim at all: legacy Windows console,
 *     `TERM=dumb`, a non-UTF-8 locale, `AEGIS_ART=ascii`. Every mark becomes a
 *     single-column ASCII stand-in, so the layout is identical but nothing is
 *     mis-rendered by a font that lacks the glyph.
 *   · `face: 'edges'`    — the block palette survives but the quartile edges
 *     and the typographic marks (⎿, ⏸, ✔) do not (Apple fonts, older Windows
 *     fonts). Only those are swapped.
 *   · native             — the reference's own set, on any terminal that can
 *     draw it: Windows Terminal, VS Code, iTerm2, WezTerm, kitty, Ghostty,
 *     Alacritty, GNOME Terminal, xterm, zsh on Linux/macOS.
 *
 * `star` is NOT restated here: it is resolved through `art.js`'s stencil, the
 * single source of truth for the mark's runes, so the glyph table and the art
 * can never disagree about the same character.
 *
 * @param {string|object} [target] a `process.platform` name, or a caps object,
 *   or nothing at all for the live process's resolved capabilities.
 */
function glyphsFor(target = null) {
  const c = !target
    ? caps()
    : typeof target === 'string'
      ? detect(process.env, process.stdout, target)
      : target;
  const ascii = c.glyphs === 'ascii';
  const edges = ascii || c.face === 'edges';

  if (ascii) {
    return {
      cursor: '>', // menu selection marker, prompt prefix
      check: '+', // selected / completed
      divider: '-', // menu separators
      bullet: '.', // inline separators
      hint: '>', // "Try ..." suggestion marker
      pause: '||', // bottom status line (manual mode)
      star: stencilGlyph(STAR, c), // own-session marker, decorations
      rightarrow: '->', // the manual ⇄ auto mode switch
      pointer: '>', // tips list bullets
      hook: '_|', // inline command / tip rows
      block: '*', // streaming cursor / assistant answer marker
      bloom: '*', // "done" spinner glyph (✻ Brewed for 2s)
      spin: ['|', '/', '-', '\\', '*', '-'], // working spinner
      ellipse: '...',
      err: 'x', // failed check
      warn: '!', // warning mark
      rule: '-', // ruled section headers
      ruleHeavy: '=', // the welcome banner's frame rule
    };
  }

  const base = {
    cursor: '❯', // menu selection marker, prompt prefix
    check: '✔', // selected / completed
    divider: '╌', // menu separators
    bullet: '·', // inline separators
    hint: '❯', // "Try ..." suggestion marker
    pause: edges ? '❚❚' : '⏸', // bottom status line (manual mode)
    star: stencilGlyph(STAR, c), // own-session marker, decorations
    rightarrow: '→', // the manual ⇄ auto mode switch, advertised on the status line
    pointer: '▸', // tips list bullets
    hook: edges ? '_|' : '⎿', // inline command / tip rows (tool commands, usage hints)
    block: '●', // streaming cursor / assistant answer marker
    bloom: '✻', // "done" spinner glyph (✻ Brewed for 2s)
    spin: ['✢', '·', '✻', '*', '✽', '✶'], // working spinner
    ellipse: '…',
    err: '✗', // failed check (render.js's notice marks live here too)
    warn: '⚠', // warning mark
    rule: '─', // ruled section headers
    ruleHeavy: '━', // the welcome banner's frame rule
  };

  if (edges) {
    // ⏸ U+23F8 and ⎿ U+23BF are the two the font stacks in this class lack;
    // ✻ U+273B has an emoji presentation on them as well.
    return { ...base, bloom: '*', spin: ['|', '/', '-', '\\', '*', '-'] };
  }
  return base;
}

/** The live glyph table — re-materialised whenever the capabilities change. */
const GLYPH = glyphsFor();

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

// ── materialisation ──────────────────────────────────────────────────────────

/**
 * Rebuild every palette and the glyph table for the current capabilities.
 * Mutates in place: renderers, screens and panels capture these objects at
 * require time, and swapping the object would leave them drawing the previous
 * terminal's colours after `--ascii` or `/terminal`.
 */
function rematerialize() {
  Object.assign(C, buildDark());
  Object.assign(LIGHT, buildLight());
  Object.assign(CB_DARK, buildCbDark());
  Object.assign(CB_LIGHT, buildCbLight());
  Object.assign(ANSI_DARK, buildAnsiDark());
  Object.assign(ANSI_LIGHT, buildAnsiLight());
  Object.assign(DIFF, buildDiff());
  Object.assign(DIFF_LIGHT, buildDiffLight());
  Object.assign(GLYPH, glyphsFor());
}

rematerialize();
onCapsChange(rematerialize);

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
  DIFF,
  DIFF_LIGHT,
  diffOf,
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
  rematerialize,
};
