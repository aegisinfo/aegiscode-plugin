#!/usr/bin/env node
/**
 * The overlay renderers, ported from aegiscodex-dev/src/commands.js.
 *
 * What it pins: the palette fuzzy-filters its command list and keeps a stable
 * selection with the lavender `❯` cursor on the focused row, the `⎿  Usage: …`
 * hook under it, a width-safe frame, the model/effort pickers marking the
 * current selection, and the resume list's search box. The renderers are pure —
 * they receive the data they draw as arguments.
 *
 * House style: ESM test file, CommonJS module pulled in with createRequire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const screen = require(join(__dirname, '..', 'cli', 'src', 'screen.js'));
const theme = require(join(__dirname, '..', 'cli', 'src', 'theme.js'));
const overlays = require(join(__dirname, '..', 'cli', 'src', 'overlays.js'));

const text = (line) => line.map((sp) => sp.t).join('');
const asText = (lines) => lines.map(text);
const strip = (lines) => lines.map((l) => screen.stripAnsi(text(l)));

const COMMANDS = [
  { name: 'help', aliases: ['?'], args: '', category: 'support', desc: 'Show help' },
  { name: 'model', aliases: ['m'], args: '[id]', category: 'model', desc: 'Switch AI model' },
  { name: 'aegis-recall', aliases: ['recall'], args: '<topic>', category: 'aegis', desc: 'Recall cross-session memory' },
  { name: 'billing', aliases: ['balance'], args: '', category: 'support', desc: 'Show billing info' },
  { name: 'resume', args: '', category: 'session', desc: 'Switch to a previous session', unavailable: true },
];

test('the palette filters by query (fuzzy, aliases included)', () => {
  const all = strip(overlays.renderPalette(COMMANDS, { query: '', sel: 0 }, 80, 24)).join('\n');
  for (const c of COMMANDS) assert.ok(all.includes(c.name), `the empty query lists /${c.name}`);

  const filtered = strip(overlays.renderPalette(COMMANDS, { query: 'rec', sel: 0 }, 80, 24)).join('\n');
  assert.ok(filtered.includes('aegis-recall'), 'a matching command survives the filter');
  assert.ok(!filtered.includes('billing'), 'a non-matching command is dropped');
  assert.ok(!filtered.includes('Show help'), 'and its description with it');
});

test('the palette keeps a stable selection under the ❯ cursor', () => {
  const lines = strip(overlays.renderPalette(COMMANDS, { query: '', sel: 2 }, 80, 24));
  const active = lines.find((l) => l.includes(theme.GLYPH.cursor));
  assert.ok(active, 'a selected row is marked with the ❯ cursor');
  assert.ok(active.includes(COMMANDS[2].name), `the cursor sits on the selected command (got ${JSON.stringify(active)})`);
});

test('the palette renders a ⎿ usage hook for the selected row', () => {
  const lines = strip(overlays.renderPalette(COMMANDS, { query: 'recall', sel: 0 }, 80, 24)).join('\n');
  assert.ok(
    lines.includes(`${theme.GLYPH.hook}  Usage: /aegis-recall <topic>`),
    `the focused command shows its usage hook (got ${JSON.stringify(lines)})`
  );
  // A command with no args/hint renders no hook.
  const noHook = strip(overlays.renderPalette(COMMANDS, { query: 'billing', sel: 0 }, 80, 24)).join('\n');
  assert.ok(!noHook.includes('Usage:'), 'a command with no args renders no usage hook');
});

test('the palette never renders wider than the terminal', () => {
  for (const width of [40, 80, 120]) {
    const lines = overlays.renderPalette(COMMANDS, { query: '', sel: 1 }, width, 24);
    for (const l of lines) assert.ok(screen.lineWidth(l) <= width, `a ${width}-col palette line fits (got ${screen.lineWidth(l)})`);
  }
  // A very long description is truncated, not allowed to overflow.
  const long = [{ name: 'x', args: '', desc: 'y'.repeat(500) }];
  const lines = overlays.renderPalette(long, { query: '', sel: 0 }, 60, 24);
  for (const l of lines) assert.ok(screen.lineWidth(l) <= 60, 'a long description is clipped to width');
});

test('boldMatched bolds the characters that matched the query', () => {
  const segs = overlays.boldMatched('cl', 'clear', theme.C.white);
  const joined = segs.map((s) => s.t).join('');
  assert.equal(joined, 'clear', 'the whole name is still emitted');
  const bolded = segs.filter((s) => s.s.includes(theme.BOLD)).map((s) => s.t).join('');
  assert.equal(bolded, 'cl', 'exactly the matched characters are bold');
});

test('the model picker marks the active row and the current model', () => {
  const models = [
    { id: 'fast', label: 'Fast', note: 'cheapest' },
    { id: 'smart', label: 'Smart', note: 'best' },
  ];
  const lines = strip(overlays.renderModelPicker(models, 1, 80, 24, 'fast'));
  const active = lines.find((l) => l.includes(theme.GLYPH.cursor));
  assert.ok(active && active.includes('Smart'), 'the ❯ cursor marks the selected model');
  const current = lines.find((l) => l.includes(theme.GLYPH.check));
  assert.ok(current && current.includes('Fast'), 'the ✔ mark identifies the pinned model');
});

test('the effort picker marks the active row and the current level', () => {
  // Index 3 is High (Auto is row 0 — the default, which is the absence of a
  // pin rather than a fourth rung).
  const lines = strip(overlays.renderEffortPicker(3, 80, 'Medium'));
  const active = lines.find((l) => l.includes(theme.GLYPH.cursor));
  assert.ok(active && active.includes('High'), 'the ❯ cursor marks the selected effort');
  const current = lines.find((l) => l.includes(theme.GLYPH.check));
  assert.ok(current && current.includes('Medium'), 'the ✔ mark identifies the current effort');
  for (const l of lines) assert.ok(screen.w(l) <= 80, 'the effort picker fits the width');
});

test('the effort picker offers auto and marks it when nothing is pinned', () => {
  const lines = strip(overlays.renderEffortPicker(0, 80, null));
  assert.ok(lines.some((l) => l.includes('Auto')), 'auto is offered — it is the default state');
  const current = lines.find((l) => l.includes(theme.GLYPH.check));
  assert.ok(current && current.includes('Auto'),
    `null is auto, and auto is what a null current marks: ${JSON.stringify(current)}`);
  // The rows are the source of the values a selection stores, so the two can
  // never disagree about which row means what.
  assert.deepEqual(overlays.EFFORT_VALUES, [null, 'low', 'medium', 'high'],
    'the picker order is the value order');
});

test('the resume list shows a search box and the session meta', () => {
  const items = [
    { own: true, summary: 'Fix the banner', cwd: '/home/neo/aegiscode-plugin', time: new Date().toISOString() },
    { own: false, summary: 'Add overlays', cwd: '/home/neo/aegiscodex-dev', time: new Date(Date.now() - 3600_000).toISOString() },
  ];
  const lines = strip(overlays.renderResumeList(items, 0, 80, 24));
  const joined = lines.join('\n');
  assert.ok(joined.includes('⌕ Search…'), 'the resume list has a search box');
  assert.ok(joined.includes('╭') && joined.includes('╮') && joined.includes('╰') && joined.includes('╯'), 'the search box is drawn');
  assert.ok(joined.includes('Fix the banner'), 'the session summary is listed');
  assert.ok(lines.some((l) => l.includes(theme.GLYPH.cursor)), 'the selected session carries the ❯ cursor');
  for (const l of lines) assert.ok(screen.w(l) <= 80, 'the resume list fits the width');
});
