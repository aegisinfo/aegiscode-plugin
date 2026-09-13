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
assert(theme.GLYPH.leftarrow === '←', 'GLYPH.leftarrow must be ←');
oneOf(theme.GLYPH.hook, ['⎿', '_|'], 'GLYPH.hook'); // ⎿ absent from some fonts
oneOf(theme.GLYPH.bloom, ['✻', '*'], 'GLYPH.bloom'); // ✻ U+273B
oneOf(theme.GLYPH.star, ['✦', '*'], 'GLYPH.star'); // ✦ renders wide on Apple fonts
oneOf(theme.GLYPH.pause, ['⏸', '❚❚'], 'GLYPH.pause'); // ⏸ U+23F8

// The spinner is the loudest part of the fingerprint: ✢ · ✻ * ✽ ✶ on Linux,
// an ASCII set on Windows fonts.
assert(theme.GLYPH.spin.length === 6, `the spinner must have 6 frames, got ${theme.GLYPH.spin.length}`);
if (process.platform === 'win32') {
  assert(same(theme.GLYPH.spin, ['|', '/', '-', '\\', '*', '-']), 'the Windows spinner frames must match');
} else {
  assert(same(theme.GLYPH.spin, ['✢', '·', '✻', '*', '✽', '✶']), 'the spinner frames must match the reference');
}

// ── 3. Working and completion verbs ──────────────────────────────────────────
assert(same(theme.VERBS, [
  'Incubating', 'Tempering', 'Determining', 'Beboppin\'', 'Julienning',
  'Inferring', 'Simmering', 'Twisting', 'Fermenting', 'Fiddle-faddling',
  'Orbiting', 'Prestidigitating',
]), 'the working verbs must match the capture-backed table');
assert(same(theme.DONE_VERBS, ['Churned', 'Worked']),
  'the completion verbs must be Churned (chat) and Worked (tools used)');

// ── 4. The welcome art ───────────────────────────────────────────────────────
// The mascot face, verbatim from the binary (msS template) and from
// aegiscodex-dev/src/art.js.
assert(same(art.FACE, [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝']),
  `the mascot face rows must match the extracted art, got ${JSON.stringify(art.FACE)}`);
assert(art.MOON.length === 7, `MOON must be 7 rows, got ${art.MOON.length}`);
assert(art.WHALE.length === 8, `WHALE must be 8 rows, got ${art.WHALE.length}`);
assert(art.MOON.some((r) => r.includes('▓▓▓')), 'the moon must be drawn with the lit-rim shade');
assert(art.WHALE.some((r) => r.includes('██')), 'the whale must carry its eye');

// Every row of a composition must be the same width, or centring drifts.
const uniform = (rows, name) => {
  const widths = new Set(rows.map(cellWidth));
  assert(widths.size === 1, `${name}: every row must be the same width, got ${[...widths].join('/')}`);
};
uniform(art.WELCOME_ART, 'WELCOME_ART');
uniform(art.MOON_WHALE, 'MOON_WHALE');
// stackVertical() centres each row without right-filling (as the reference
// does), so the stacked mark is only uniform once center() pads it to a width.
const stackedMax = Math.max(...art.WELCOME_ART_STACKED.map(cellWidth));
uniform(art.center(art.WELCOME_ART_STACKED, stackedMax), 'center(WELCOME_ART_STACKED)');
assert(art.WELCOME_ART_STACKED.some((r) => r.includes('▐▛███▜▌')), 'the stacked mark must keep the mascot');
assert(art.WELCOME_ART_STACKED.some((r) => r.includes('▒▒▒')), 'the stacked mark must keep the whale');

// The wide mark is the mascot + (moon + whale). The crescent must actually be
// there: an earlier revision of welcomeArtParts() composed the right half from
// WHALE alone and silently dropped the moon from the banner.
const wide = art.WELCOME_ART;
assert(wide.some((r) => r.includes('▓▓▓')), 'the wide welcome mark must include the crescent moon');
assert(wide.some((r) => r.includes('▒▒▒')), 'the wide welcome mark must include the whale body');
assert(wide.some((r) => r.includes('▐▛███▜▌')), 'the wide welcome mark must include the mascot face');

// welcomeArtParts() is what the banner actually draws, so it must carry the
// moon too — this is the regression guard for the bug above.
const parts = art.welcomeArtParts(120);
uniform(parts.rows.map(([l, r]) => l + ' '.repeat(parts.gutter) + r), 'welcomeArtParts rows');
const rightHalf = parts.rows.map(([, r]) => r).join('\n');
const leftHalf = parts.rows.map(([l]) => l).join('\n');
assert(rightHalf.includes('▓▓▓'), 'the right half of the banner mark must contain the moon');
assert(rightHalf.includes('▒▒▒'), 'the right half of the banner mark must contain the whale');
assert(leftHalf.includes('▐▛███▜▌'), 'the left half of the banner mark must contain the mascot');
assert(parts.width === cellWidth(parts.rows[0][0]) + parts.gutter + cellWidth(parts.rows[0][1]),
  'welcomeArtParts width must equal left + gutter + right');
const narrow = art.welcomeArtParts(24);
assert(narrow.rows.some(([l]) => l.includes('▐▛███▜▌')), 'the narrow mark must still contain the mascot');

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
for (const shade of ['▓', '▒', '░', '█', '✦']) {
  assert(sources.render.includes(`'${shade}'`), `the art ink map must handle the ${shade} shade`);
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
console.log(`  art:     mascot + crescent + whale — wide ${cellWidth(wide[0])} cells, moon present in both halves' routing`);
console.log(`  verbs:   ${theme.VERBS.length} working verbs, ${theme.DONE_VERBS.join('/')} on completion`);
