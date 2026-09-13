#!/usr/bin/env node
/**
 * The identity guard for the terminal host.
 *
 * `cli/` exists to be a *different* terminal, not another Claude Code skin. Its
 * sibling project (aegiscodex-dev) is an intentional Claude Code mimic — same
 * gold/coral palette, same `❯` prompt, same `✻` spinner, same extracted mascot
 * art. This test pins that the CLI carries NONE of that fingerprint, and that
 * its own theme contract is complete, so a copy-paste from the mimic cannot
 * silently make the two look alike again.
 *
 * It also asserts the inverse: the palette and glyph set the CLI *does* ship are
 * actually wired up (a theme file nobody reads would pass a "nothing matches
 * Claude" check trivially).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, '..', 'cli');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const theme = require(join(cliDir, 'src', 'theme.js'));
const art = require(join(cliDir, 'src', 'art.js'));

/**
 * Strip comments before scanning for borrowed glyphs. The CLI's own docs name
 * the characters it deliberately avoids (`❯`, `✻`) — that documentation is the
 * point of those comments, so the guard reads code, not prose.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

const sources = {
  theme: stripComments(readFileSync(join(cliDir, 'src', 'theme.js'), 'utf8')),
  art: stripComments(readFileSync(join(cliDir, 'src', 'art.js'), 'utf8')),
  render: stripComments(readFileSync(join(cliDir, 'src', 'render.js'), 'utf8')),
  app: stripComments(readFileSync(join(cliDir, 'src', 'app.js'), 'utf8')),
};
const allSource = Object.values(sources).join('\n');

// ── 1. Claude Code's palette (extracted from the real binary, and mirrored by
//      aegiscodex-dev) must not appear anywhere in this host ──────────────────
const CLAUDE_DARK = [
  [255, 193, 7], // gold
  [215, 119, 87], // coral
  [177, 185, 249], // lavender
  [120, 160, 250], // blue
  [78, 186, 101], // green
  [220, 90, 90], // red
  [153, 153, 153], // gray
  [80, 80, 80], // dim
  [255, 255, 255], // white
  [30, 30, 30], // code bg
  [20, 20, 20], // theme card bg
];
const CLAUDE_LIGHT = [
  [180, 130, 0],
  [190, 100, 70],
  [120, 130, 220],
  [70, 110, 220],
  [60, 150, 80],
  [200, 60, 60],
  [110, 110, 110],
  [170, 170, 170],
  [40, 40, 40],
  [245, 245, 245],
];

for (const palette of [theme.SIGNAL, theme.SIGNAL_LIGHT]) {
  for (const [r, g, b] of palette ? Object.values(palette) : []) {
    const collide = [...CLAUDE_DARK, ...CLAUDE_LIGHT].find(([cr, cg, cb]) => cr === r && cg === g && cb === b);
    assert(!collide, `palette reuses Claude Code's RGB ${collide} — the CLI must not share that palette`);
  }
}

// ── 2. Its glyphs, spinner frames and art must not collide either ────────────
const CLAUDE_GLYPHS = ['❯', '✻', '✢', '✽', '✶', '⟡', '⎿', '▎', '✔', '⏸', '·', '▸', '●', '✦', '←'];
for (const g of CLAUDE_GLYPHS) {
  // '*' is omitted here: it appears in ordinary source (regex, comments). The
  // spinner-frame check below covers it with set semantics instead.
  const where = Object.entries(sources).find(([, src]) => src.includes(g));
  assert(!where, `Claude Code glyph ${JSON.stringify(g)} is present in cli/src/${where ? where[0] : ''}.js`);
}
// The spinner frames are the loudest tell; assert set-disjointness, not just
// per-character absence from the file text.
const claudeSpin = new Set(['✢', '·', '✻', '*', '✽', '✶']);
for (const frame of theme.GLYPH.spin) {
  assert(!claudeSpin.has(frame), `spinner frame ${JSON.stringify(frame)} is a Claude Code spinner frame`);
}

// Claude Code's mascot art and aegiscodex-dev's copy, verbatim.
const CLAUDE_ART = ['▐▛███▜▌', '▝▜█████▛▘', '▘▘ ▝▝'];
for (const row of CLAUDE_ART) {
  assert(!sources.art.includes(row), `Claude Code mascot row ${JSON.stringify(row)} appears in cli/src/art.js`);
  assert(!allSource.includes(row), `Claude Code mascot row ${JSON.stringify(row)} appears in the CLI`);
}
for (const copy of ['Welcome to Aegiscodex', 'Aegiscodex', 'a Claude Code design mimic', 'Monokai Extended']) {
  assert(!allSource.includes(copy), `borrowed copy ${JSON.stringify(copy)} appears in the CLI`);
}

// ── 3. …but the CLI's own identity IS wired up ───────────────────────────────
assert(theme.SIGNAL.plasma && theme.SIGNAL.beam, 'the Signal palette must define plasma + beam');
assert(theme.GLYPH.prompt !== '❯', 'the prompt glyph must not be Claude Code\'s');
assert(theme.GLYPH.prompt.length > 0, 'the CLI must have a prompt glyph');
assert(theme.GLYPH.spin.length >= 8, 'the CLI must ship its own spinner animation');

const darkKeys = Object.keys(theme.SIGNAL).sort().join(',');
const lightKeys = Object.keys(theme.SIGNAL_LIGHT).sort().join(',');
assert(darkKeys === lightKeys, `dark/light palettes must define the same roles (${darkKeys} vs ${lightKeys})`);
assert(theme.themeOf({ light: true }) === theme.SIGNAL_LIGHT, 'themeOf must select the light palette');
assert(theme.themeOf({}) === theme.SIGNAL, 'themeOf must default to the dark palette');

// The separators must not be the rounded frame Claude Code draws.
const box = theme.GLYPH.box;
for (const corner of [box.tl, box.tr, box.bl, box.br]) {
  assert(!'╭╮╰╯'.includes(corner), `box corner ${corner} is Claude Code's rounded frame`);
  assert('┏┓┗┛'.includes(corner), `box corner ${corner} should be the heavy frame this CLI owns`);
}
assert(sources.render.includes('GLYPH.box.tl'), 'the banner must actually draw the heavy frame');
assert(theme.GLYPH.rail === '┃', 'the transcript gutter must be the heavy rail');
assert(sources.render.includes('GLYPH.rail'), 'turns must actually draw the rail');

// Art geometry: every row the same display width, so centring cannot drift.
const widths = new Set(art.SIGIL.map((r) => [...r].length));
assert(widths.size === 1, `every sigil row must be the same width, got ${[...widths].join('/')}`);
assert(art.SIGIL.some((r) => r.includes('█')), 'the sigil should be built from block art');
assert(art.WORDMARK.replace(/\s+/g, '') === 'AEGIS', 'the wordmark must name the product');
const centered = art.center(art.SIGIL, 40);
assert(new Set(centered.map((r) => r.length)).size === 1, 'center() must keep every row aligned');
assert(centered[0].startsWith(' '), 'center() must actually offset the art inside the width');

// The default theme must actually be reachable from the app (not a dead file).
assert(sources.app.includes("require('./theme.js')"), 'the app must consume the theme module');
assert(sources.app.includes("require('./render.js')"), 'the app must consume the renderers');

console.log('CLI identity test passed');
console.log(`  palette: ${Object.keys(theme.SIGNAL).length} roles, 0 shared with Claude Code`);
console.log(`  glyphs:  prompt ${theme.GLYPH.prompt} · rail ${theme.GLYPH.rail} · ${theme.GLYPH.spin.length}-frame spin`);
