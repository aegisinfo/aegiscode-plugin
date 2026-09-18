#!/usr/bin/env node
/**
 * The conformance guard for the terminal host.
 *
 * `cli/` is the `aegiscode` CLI, and it is meant to look like its sibling
 * project `aegiscodex-dev`: the same gold/coral/lavender palette, the same `❯`
 * prompt, the same `✻` spinner, the same `⎿` hook rows, the same extracted
 * welcome art, the same working and completion verbs. This test pins that, so
 * the two cannot drift apart.
 *
 * The expected values are INLINED rather than read from the sibling checkout. A
 * guard that only runs when `/home/neo/aegiscodex-dev` happens to exist is not a
 * guard — CI has this repo and nothing else — so each block below carries the
 * literals it was extracted from.
 *
 * It also asserts the inverse: that the tokens the CLI ships are actually
 * consumed by the renderers and the overlays. A theme file nobody reads would
 * pass a palette comparison trivially.
 *
 * This file replaces `cli-identity.test.mjs`, which asserted the *opposite*
 * (divergence from Claude Code, via a "Signal" violet/cyan palette). That is no
 * longer the product's direction.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, '..', 'cli');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const read = (rel) => readFileSync(join(cliDir, rel), 'utf8');

const theme = require(join(cliDir, 'src', 'theme.js'));
const art = require(join(cliDir, 'src', 'art.js'));
const rend = require(join(cliDir, 'src', 'render.js'));

/** Pull [r,g,b] back out of a truecolor SGR prefix. */
function rgbOf(sgr) {
  const m = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(String(sgr));
  assert(m, `expected a 38;2 truecolor prefix, got ${JSON.stringify(sgr)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const sources = {
  theme: read(join('src', 'theme.js')),
  art: read(join('src', 'art.js')),
  render: read(join('src', 'render.js')),
  overlays: read(join('src', 'overlays.js')),
  app: read(join('src', 'app.js')),
};

/** Display width, matching the CLI's own cell maths for the glyphs used here. */
const cellWidth = (s) => [...String(s)].length;

// ── 1. The dark palette, exactly as aegiscodex-dev defines it ────────────────
// aegiscodex-dev/src/theme.js — extracted from the live ANSI stream of
// Claude Code: gold 255,193,7 · coral 215,119,87 · lavender 177,185,249.
const DEV_DARK = {
  gold: [255, 193, 7],
  coral: [215, 119, 87],
  lavender: [177, 185, 249],
  blue: [120, 160, 250],
  green: [78, 186, 101],
  red: [220, 90, 90],
  gray: [153, 153, 153],
  dim: [80, 80, 80],
  white: [255, 255, 255],
  black: [30, 30, 30],
  darkBg: [20, 20, 20],
};

const DEV_LIGHT = {
  gold: [180, 130, 0],
  coral: [190, 100, 70],
  lavender: [120, 130, 220],
  blue: [70, 110, 220],
  green: [60, 150, 80],
  red: [200, 60, 60],
  gray: [110, 110, 110],
  dim: [170, 170, 170],
  white: [40, 40, 40],
  black: [245, 245, 245],
  darkBg: [255, 255, 255],
};

assert(same(Object.keys(theme.C).sort(), Object.keys(DEV_DARK).sort()),
  `palette roles must match aegiscodex-dev (got ${Object.keys(theme.C).sort().join(',')})`);
for (const [role, expected] of Object.entries(DEV_DARK)) {
  assert(same(rgbOf(theme.C[role]), expected),
    `C.${role} must be ${expected} (#${expected.join(',')}), got ${rgbOf(theme.C[role])}`);
}
assert(same(Object.keys(theme.LIGHT).sort(), Object.keys(theme.C).sort()),
  'the light palette must define the same roles as the dark one');
for (const [role, expected] of Object.entries(DEV_LIGHT)) {
  assert(same(rgbOf(theme.LIGHT[role]), expected),
    `LIGHT.${role} must be ${expected}, got ${rgbOf(theme.LIGHT[role])}`);
}
assert(theme.themeOf({ light: true }) === theme.LIGHT, 'themeOf must select the light palette');
assert(theme.themeOf({}) === theme.C, 'themeOf must default to the dark palette');

// ── 2. The glyph set ─────────────────────────────────────────────────────────
// Platform passes replace a few of these (see theme.js); accept either spelling
// on the ones that vary, and require the exact value on the ones that do not.
const oneOf = (value, options, name) =>
  assert(options.includes(value), `${name} must be one of ${JSON.stringify(options)}, got ${JSON.stringify(value)}`);

assert(theme.GLYPH.cursor === '❯', `GLYPH.cursor must be ❯, got ${theme.GLYPH.cursor}`);
assert(theme.GLYPH.hint === '❯', 'GLYPH.hint must be the ❯ suggestion marker');
assert(theme.GLYPH.check === '✔', `GLYPH.check must be ✔, got ${theme.GLYPH.check}`);
assert(theme.GLYPH.block === '●', `GLYPH.block must be ●, got ${theme.GLYPH.block}`);
assert(theme.GLYPH.divider === '╌', `GLYPH.divider must be ╌, got ${theme.GLYPH.divider}`);
assert(theme.GLYPH.bullet === '·', `GLYPH.bullet must be ·, got ${theme.GLYPH.bullet}`);
assert(theme.GLYPH.pointer === '▸', `GLYPH.pointer must be ▸, got ${theme.GLYPH.pointer}`);
assert(theme.GLYPH.ellipse === '…', 'GLYPH.ellipse must be the … character');
assert(theme.GLYPH.rightarrow === '→', 'GLYPH.rightarrow must be →');
oneOf(theme.GLYPH.hook, ['⎿', '_|'], 'GLYPH.hook'); // ⎿ absent from some fonts
oneOf(theme.GLYPH.bloom, ['✻', '*'], 'GLYPH.bloom'); // ✻ U+273B
oneOf(theme.GLYPH.star, ['✦', '*'], 'GLYPH.star'); // ✦ renders wide on Apple fonts
oneOf(theme.GLYPH.pause, ['⏸', '❚❚'], 'GLYPH.pause'); // ⏸ U+23F8

// The spinner is the loudest part of the fingerprint: ✢ · ✻ * ✽ ✶ where the
// font can draw them, an ASCII set where it cannot. The axis is the glyph
// class, NOT `process.platform` — PowerShell inside Windows Terminal draws the
// reference set, and a `win32` process over SSH draws whatever the far end can
// show. Keying this on the platform was the bug; keying it on the class is the
// guard.
assert(theme.GLYPH.spin.length === 6, `the spinner must have 6 frames, got ${theme.GLYPH.spin.length}`);
const REFERENCE_SPIN = ['✢', '·', '✻', '*', '✽', '✶'];
const ASCII_SPIN = ['|', '/', '-', '\\', '*', '-'];
assert(same(theme.glyphsFor({ glyphs: 'ascii' }).spin, ASCII_SPIN),
  'an ASCII glyph class must get the ASCII spinner frames');
assert(same(theme.glyphsFor({ glyphs: 'unicode', face: 'native' }).spin, REFERENCE_SPIN),
  'a native-unicode glyph class must get the reference spinner frames');
// …and the live table must agree with the class it resolved, whatever host
// this guard happens to run on. This is what the old `win32` branch was
// reaching for, stated on the right axis.
assert(same(theme.GLYPH.spin, theme.glyphsFor(require(join(cliDir, 'src', 'caps.js')).caps()).spin),
  'the live spinner must match the spinner for the live glyph class');

// ── 3. Working and completion verbs ──────────────────────────────────────────
assert(same(theme.VERBS, [
  'Incubating', 'Tempering', 'Determining', 'Beboppin\'', 'Julienning',
  'Inferring', 'Simmering', 'Twisting', 'Fermenting', 'Fiddle-faddling',
  'Orbiting', 'Prestidigitating',
]), 'the working verbs must match the capture-backed table');
assert(same(theme.DONE_VERBS, ['Churned', 'Worked']),
  'the completion verbs must be Churned (chat) and Worked (tools used)');

// ── 4. The welcome art ───────────────────────────────────────────────────────
// The mark is the ÆGIS wordmark, adopted verbatim from the sibling project's
// `src/ui/components/layout/WelcomeMessage.tsx` (which `assets/demo.svg`, the
// canonical rendering, is kept in sync with). It REPLACED the Claude-binary
// composition — mascot face, crescent moon, diving whale — so the literals
// below are the guard that the CLI and the desktop keep drawing one welcome
// screen. An earlier revision composed the right half from WHALE alone and
// silently dropped the moon from the banner; inlining the whole mark here is
// what makes that class of drift fail the build instead of shipping.
const MARK = [
  '╔═╗╔═╗╔═╗╦╔═╗',
  '╠═╣║╣ ║ ╦║╚═╗',
  '╩ ╩╚═╝╚═╝╩╚═╝',
];
assert(same(art.WELCOME_MARK, MARK),
  `the welcome mark must match the aegiscodex- wordmark, got ${JSON.stringify(art.WELCOME_MARK)}`);
assert(same(art.WELCOME_ART, MARK), 'WELCOME_ART must BE the wordmark, not a composition built from it');
assert(same(art.WELCOME_ART_STACKED, MARK),
  'WELCOME_ART_STACKED must still resolve to the mark — the capability matrix enumerates both names');
// 3 rows x 13 cells. The size is load-bearing: the banner centres the mark with
// it, and the desktop draws it at this size.
assert(MARK.length === 3, `the mark must be 3 rows, got ${MARK.length}`);
assert(MARK.every((r) => cellWidth(r) === 13),
  `every mark row must be 13 cells, got ${MARK.map(cellWidth).join('/')}`);

// The old composition must be GONE, not merely unreferenced: a lingering export
// keeps the dead art reachable from any consumer and from the next reader.
for (const dead of ['FACE', 'MOON', 'WHALE', 'MOON_WHALE', 'MASCOT_ART']) {
  assert(art[dead] === undefined, `art.${dead} must no longer be exported (the mark is the wordmark now)`);
}

// Every row of the mark must be the same width, or centring drifts.
const uniform = (rows, name) => {
  const widths = new Set(rows.map(cellWidth));
  assert(widths.size === 1, `${name}: every row must be the same width, got ${[...widths].join('/')}`);
};
uniform(art.WELCOME_ART, 'WELCOME_ART');
uniform(art.WELCOME_ART_STACKED, 'WELCOME_ART_STACKED');
uniform(art.center(art.WELCOME_ART_STACKED, 13), 'center(WELCOME_ART_STACKED)');

// The wordmark is drawn in box runes, so a stencil edit that dropped ╔ or ╦
// would erase the product name rather than mis-shade it.
assert(art.WELCOME_ART.some((r) => r.includes('╔═╗')), 'the mark must carry the Æ cap runes');
assert(art.WELCOME_ART.some((r) => r.includes('╦')), 'the mark must carry the Æ crossbar');

// welcomeArtParts() is what the banner actually draws, so it must carry the mark.
const parts = art.welcomeArtParts();
uniform(parts.rows.map(([l, r]) => l + ' '.repeat(parts.gutter) + r), 'welcomeArtParts rows');
const leftHalf = parts.rows.map(([l]) => l).join('\n');
const rightHalf = parts.rows.map(([, r]) => r).join('');
assert(leftHalf.includes('╔═╗'), 'the left half of the banner mark must carry the wordmark');
// The right half is empty by design — the mark is drawn in ONE ink (gold), the
// same `theme.colors.primary` the desktop uses. Asserted rather than assumed so
// that a future two-tone mark has to come here and update `width` with it.
assert(rightHalf === '', `the mark draws nothing in its right half, got ${JSON.stringify(rightHalf)}`);
assert(parts.width === cellWidth(parts.rows[0][0]) + parts.gutter + cellWidth(parts.rows[0][1]),
  'welcomeArtParts width must equal left + gutter + right');
assert(parts.width === 13, `the mark must report 13 cells, got ${parts.width}`);
// The width argument went with the wide/narrow split — 13 cells fits anywhere
// the banner's own frame fits. Passing one anyway must not change the answer,
// or a call site that still passes `cols` would keep looking correct while the
// branch quietly came back.
assert(same(art.welcomeArtParts(24), parts),
  'welcomeArtParts must ignore a width argument: there is no narrow mark any more');

// center() keeps every row aligned and actually offsets the art.
const centered = art.center(art.WELCOME_ART, 100);
uniform(centered, 'center() output');
assert(centered[0].startsWith(' ') && centered[0].endsWith(' '), 'center() must pad on both sides');

// portability() is a stable, width-preserving pass on this platform.
const ported = art.portability(art.WELCOME_ART);
assert(ported.length === art.WELCOME_ART.length, 'portability() must not change the row count');
assert(ported.every((r, i) => cellWidth(r) === cellWidth(art.WELCOME_ART[i])),
  'portability() must not change any row width (the stencils swap 1:1)');

// ── 5. …and all of it is actually wired up ───────────────────────────────────
assert(sources.render.includes('WELCOME_TITLE'), 'the banner must print the welcome title');
assert(sources.render.includes('welcomeArtParts'), 'the banner must draw the shared welcome mark');
assert(sources.render.includes('GLYPH.cursor'), 'the transcript must use the ❯ cursor');
assert(sources.render.includes('GLYPH.hook'), 'meta/tool rows must use the ⎿ hook');
assert(sources.render.includes('GLYPH.block'), 'the assistant turn must use the ● block marker');
assert(sources.render.includes('GLYPH.bloom'), 'the completion line must use the ✻ bloom glyph');
assert(sources.render.includes('VERBS'), 'the working line must draw a verb from the shared table');
// The art must be inked per shade, not left monochrome — the shade→token map is
// what makes the mascot gold and the whale blue/lavender.
// Asserted BEHAVIOURALLY. The map is now *derived* through art.stencilGlyph, so
// the runes it must key on are the stencilled ones, not the raw ones. Grepping
// render.js for the literal '✦' would fail the instant that derivation moves
// into a loop — the ink would be right and the guard would be lying.
assert(sources.render.includes('stencilGlyph'),
  'the art ink map must be derived through art.stencilGlyph, not raw runes');
// Assert the END-TO-END property, per CAPABILITY CLASS. The old version of this
// block re-required the modules under a faked `process.platform` and called it
// per-platform coverage. It was not: the pass is resolved from the environment,
// so all three faked platforms resolved the same native-unicode class and the
// loop asserted one thing three times while printing `ok` for `darwin` and
// `win32`. The classes below are the ones that actually ship — a Windows
// Terminal / zsh host, a font stack with no box-drawing, and a legacy console.
{
  const INK = { blue: '\x1b[34m', lavender: '\x1b[35m', dim: '\x1b[2m', white: '\x1b[37m', gold: '\x1b[33m' };
  // The mark is now drawn in ONE ink, so `tintWhale` no longer sees it, and the
  // old version of this block — "the whale half must ink every rune it draws" —
  // would pass vacuously on an empty half. What is still worth guarding is the
  // bug that block was written for: the ink map must be keyed by the rune the
  // terminal ACTUALLY RENDERS. A raw-rune table matched nothing once the row had
  // been stencilled, and the two-tone half went uncoloured on win32/darwin while
  // looking perfect on Linux. So the shades are stencilled first, then offered.
  const capsMod = require(join(cliDir, 'src', 'caps.js'));
  const realCaps = capsMod.caps();
  const CLASSES = [
    ['native', { glyphs: 'unicode', face: 'native', star: 'native' }], // zsh, Windows Terminal
    ['edges', { glyphs: 'unicode', face: 'edges', star: 'native' }], // no box-drawing in the font
    ['ascii', { glyphs: 'ascii', face: 'edges', star: 'narrow' }], // legacy console
  ];
  // The runes the ink map names, paired with the ink it names for them.
  //
  // Deliberately NOT asserted as a rune-level round trip: the ASCII pass maps
  // both ░ and · onto '.', so two shades become one rune and a "did you ink the
  // rune you drew" test would be asking a question with no answer. The property
  // that survives the collision is the one worth pinning — every rune that is
  // drawn comes out of tintWhale in a span, in order, and carrying the style the
  // table named for the shade it came from.
  const SHADES = [
    ['▓', INK.blue], ['▒', INK.lavender], ['░', INK.dim],
    ['█', INK.white], [art.STAR, INK.gold], ['·', INK.dim],
  ];
  try {
    for (const [name, patch] of CLASSES) {
      capsMod.setCaps(patch);
      const drawn = SHADES.map(([rune]) => art.stencilGlyph(rune)).join('');
      const spans = rend.tintWhale(drawn, INK);
      assert(spans.map((s) => s.t).join('') === drawn,
        `the ${name} ink map must emit every rune it is given, got ${spans.map((s) => s.t).join('')}`);
      assert(spans.every((s) => s.s), `no rune may fall through ${name} uncoloured`);
      assert(same(spans.map((s) => s.s), SHADES.map(([, ink]) => ink)),
        `the ${name} ink map must key the runes AS DRAWN (${drawn}), in the table's order`);
    }
  } finally {
    capsMod.setCaps(realCaps);
    capsMod.resetCaps();
  }
}

assert(sources.overlays.includes('GLYPH.cursor'), 'the command palette must use the ❯ cursor');
assert(sources.overlays.includes('C.lavender'), 'the palette must select in lavender');
assert(sources.overlays.includes('C.blue'), 'the selected palette row must read blue');

assert(sources.app.includes("require('./theme.js')"), 'the app must consume the theme module');
assert(sources.app.includes("require('./render.js')"), 'the app must consume the renderers');

// ── 6. The removed palette cannot come back by accident ──────────────────────
// The old "Signal" theme renamed every role. A stale reference to one of those
// names is a runtime crash (`fg(t, undefined)`), so fail the build instead.
const OLD_TOKENS = ['plasma', 'beam', 'pulse', 'fault', 'muted', 'SIGNAL'];
for (const [name, src] of Object.entries(sources)) {
  if (name === 'theme') continue; // theme.js names them in prose when explaining the change
  for (const tok of OLD_TOKENS) {
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    assert(!new RegExp(`\\b${tok}\\b`).test(code),
      `cli/src/${name}.js still references the removed token "${tok}"`);
  }
}
for (const gone of ['SIGNAL', 'SIGNAL_LIGHT']) {
  assert(theme[gone] === undefined, `theme.${gone} must no longer be exported`);
}
assert(!sources.art.includes('WORDMARK') || !/module\.exports[\s\S]*\bWORDMARK\b/.test(sources.art),
  'the removed spaced wordmark must not linger in art.js exports');

// ── 7. Every glyph the code references is actually defined ───────────────────
// The theme was renamed wholesale in this port, and two call sites were left
// pointing at glyphs that no longer existed (`GLYPH.prompt`, `GLYPH.spend`).
// They printed the literal text "undefined" into the interactive prompt and the
// one-shot meta line. A reference to a glyph outside the set is always a bug, so
// it is asserted here rather than discovered in a screenshot.
const stripCode = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

const glyphKeys = new Set(Object.keys(theme.GLYPH));
const cliFiles = [];
for (const d of ['src', 'bin']) {
  for (const f of readdirSync(join(cliDir, d))) {
    if (f.endsWith('.js')) cliFiles.push(join(d, f));
  }
}
let glyphRefs = 0;
for (const rel of cliFiles) {
  for (const m of stripCode(read(rel)).matchAll(/GLYPH\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    glyphRefs++;
    assert(glyphKeys.has(m[1]),
      `cli/${rel} references GLYPH.${m[1]}, which theme.js does not define`);
  }
}
assert(glyphRefs > 0, 'no GLYPH references were scanned — the check is not running');

// The prompt and the one-shot meta line must use the shared mark, not a
// hardcoded character: that is exactly what drifted.
assert(stripCode(sources.app).includes('GLYPH.cursor'), 'the input prompt must use the shared ❯ glyph');
assert(stripCode(sources.app).includes('GLYPH.hook'), 'the one-shot meta line must use the shared ⎿ hook');

console.log('CLI conformance test passed');
console.log(`  palette: ${Object.keys(theme.C).length} roles, every RGB identical to aegiscodex-dev`);
console.log(`  glyphs:  cursor ${theme.GLYPH.cursor} · hook ${theme.GLYPH.hook} · bloom ${theme.GLYPH.bloom} · ${theme.GLYPH.spin.length}-frame spin`);
console.log(`  art:     the aegiscodex- wordmark — ${MARK.length} rows × ${cellWidth(MARK[0])} cells, one gold ink`);
console.log(`  verbs:   ${theme.VERBS.length} working verbs, ${theme.DONE_VERBS.join('/')} on completion`);
