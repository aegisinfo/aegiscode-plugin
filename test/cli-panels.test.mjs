#!/usr/bin/env node
/**
 * The terminal CLI's panel builders, driven directly (no TTY, no child
 * process).
 *
 * What it pins: every slash-command panel is a pure function returning an array
 * of span lines — a missing field is omitted rather than rendered as
 * `undefined`/`NaN`/`[object Object]`, and the money panels bill in euro
 * (€4dp below a cent, the reason the CLI exists) and never in dollars. Each
 * builder is also called with empty/undefined data to hold the defensive
 * contract the handlers rely on.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, '..', 'cli');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const panels = require(join(cliDir, 'src', 'panels.js'));

const ctx = { light: false };

// ── a minimal-but-plausible session state ───────────────────────────────────
const state = {
  version: '0.1.0',
  model: 'nexus-brain',
  effort: 'high',
  thinking: true,
  theme: 'dark',
  themeIndex: 0,
  vim: false,
  stream: true,
  cwd: '/home/neo/project',
  home: '/home/neo',
  sessionId: 'sess_abc123',
  base: 'https://aegiscloud.org',
  keyMask: 'aegis_••••abcd',
  online: true,
  turns: 3,
  calls: 5,
  startedAt: Date.now(),
  tokens: { input: 1250, output: 312, total: 1562 },
  costEur: 0.0007,
  balance: 3.5,
  plan: 'free',
  account: 'me@example.com',
  permissions: { mode: 'default', rules: { allow: ['Bash(npm run *)'], deny: [], ask: [] } },
  models: [{ id: 'nexus-brain', name: 'Nexus Brain', model: 'nexus-brain' }],
  commands: [{ name: 'help', aliases: ['?'], desc: 'Show help', args: '', category: 'support' }],
  transcript: [{ role: 'user', text: 'hi' }],
  sessions: [{ summary: 'a session', own: true, working: true }],
  memory: {
    total: 1514,
    sessions: 96,
    tiers: { L0: 10, L1: 5, L2: 2, L3: 1 },
    roles: { user: 100, assistant: 90 },
    withEmbeddings: 900,
    embeddingsEnabled: true,
    embeddingModels: { 'text-embed-3': 900 },
    stale: 12,
  },
  lastRecap: null,
  backend: 'pooled',
  url: 'https://aegisintel.up.railway.app/api/v1',
};

// A capability report in `caps.describe()`'s shape. The real one comes from
// `caps.js`; the panels only ever read it, which is what keeps `/terminal`,
// `/status` and `aegiscode --terminal` from drifting into three reports.
const CAPS_ROWS = [
  ['platform', 'linux'],
  ['terminal', 'xterm-256color'],
  ['locale', 'en_GB.UTF-8'],
  ['mark', 'unicode'],
  ['star', 'native'],
  ['color', 'truecolor'],
  ['control', 'ansi'],
  ['size', '100x30 (stdout.columns)'],
  ['eol', '\\n'],
  ['why', 'TERM=xterm-256color; COLORTERM=truecolor'],
];

// ── panel output shape ──────────────────────────────────────────────────────
function validate(name, lines) {
  assert(Array.isArray(lines), `${name} returns an array`);
  let text = '';
  for (const line of lines) {
    assert(Array.isArray(line), `${name}: every line is an array of spans`);
    for (const sp of line) {
      assert(sp && typeof sp === 'object', `${name}: every span is an object`);
      assert(typeof sp.t === 'string', `${name}: span.t is a string (got ${typeof sp.t})`);
      assert(typeof sp.w === 'number' && Number.isFinite(sp.w), `${name}: span.w is a finite number`);
      text += sp.t;
    }
    text += '\n';
  }
  assert(!text.includes('undefined'), `${name}: output must never contain "undefined"`);
  assert(!text.includes('NaN'), `${name}: output must never contain "NaN"`);
  assert(!text.includes('[object Object]'), `${name}: output must never contain "[object Object]"`);
  return text;
}

const flat = (lines) => validate('inline', lines);

// ── every exported builder is a function ────────────────────────────────────
const BUILDER_NAMES = [
  'buildHelp', 'buildStatus', 'buildCost', 'buildContext', 'buildTokens', 'buildAgents',
  'buildPermissions', 'buildModelList', 'buildRewindList', 'buildOnboarding',
  'buildShellCompletion', 'buildTerminalSetup', 'buildTerminalCaps', 'buildPRs', 'buildBenchmark', 'buildWaifu',
  'buildAegisStatus', 'buildAegisRecall', 'buildAegisMulti', 'buildBilling', 'buildMemory',
  'buildMemoryTiers', 'buildRouter', 'buildYolo', 'buildSkills', 'buildMcp',
  'buildHooksStatus', 'buildHooksList', 'buildTroubleshooting', 'buildReleaseNotes',
  'renderSessionsOverlay',
  // pure reference helpers with no missing capability
  'buildAegisPrint', 'buildSkillDetail', 'buildMemoryEmbeddings',
  // honest stubs
  'buildDoctor', 'buildBuildPanel',
];
for (const name of BUILDER_NAMES) {
  assert(typeof panels[name] === 'function', `panels.${name} is exported as a function`);
}
for (const [name, val] of Object.entries(panels)) {
  assert(typeof val === 'function', `every export is a function (panels.${name} is ${typeof val})`);
}

// ── the calls: a plausible state, and an all-empty defensive call ───────────
const NOW = Date.now();
const CALLS = {
  buildHelp: [[state.commands], []],
  buildStatus: [[state], []],
  buildCost: [[state], []],
  buildContext: [[state], []],
  buildTokens: [[state], []],
  buildAgents: [[state], []],
  buildPermissions: [[{ allow: ['A'], deny: [], ask: [], defaultMode: 'ask', _path: '/x' }, 'ask'], []],
  buildModelList: [['nexus-brain', [{ id: 'nexus-brain', name: 'Nexus Brain', model: 'nexus-brain' }]], []],
  buildRewindList: [[[{ idx: 0, depth: 2, words: 10, ts: NOW }, { idx: 1, depth: 4, words: 22, ts: NOW - 65000 }]], []],
  buildOnboarding: [[state], []],
  buildShellCompletion: [[state], []],
  buildTerminalSetup: [[state], []],
  // The rows `caps.describe()` produces, handed in so this builder stays pure.
  buildTerminalCaps: [[CAPS_ROWS], [[]]],
  buildPRs: [['123 fix a thing\n124 another', ], [undefined]],
  buildBenchmark: [[[['render', 3], ['parse', 1]]], []],
  buildWaifu: [[ctx], [undefined]],
  buildAegisStatus: [[state], []],
  buildAegisRecall: [[[{ content: 'a note', timestamp: new Date().toISOString(), source: 'aegis', tags: ['x'] }]], []],
  buildAegisMulti: [['do a thing'], [undefined]],
  buildBilling: [[state], []],
  buildMemory: [[state], []],
  buildMemoryTiers: [[state], []],
  buildRouter: [[{ autoRouter: { enabled: true, tiers: { simple: 'nexus-fast' } } }], []],
  buildYolo: [[state], []],
  buildSkills: [[[{ source: 'user', name: 'x', namespace: 'ns', description: 'd' }], ['/home/neo/.aegiscode/skills']], []],
  buildMcp: [[[{ name: 'srv', command: 'node', args: ['x.js'] }], ['~/.aegiscode/mcp.json']], []],
  buildHooksStatus: [[{ enabled: true, hooks: 2, events: ['PreToolUse'], byEvent: { PreToolUse: 2 }, fromPaths: ['~/.aegiscode/settings.json'] }], []],
  buildHooksList: [[{ hooks: { PreToolUse: [{ name: 'x', matcher: { tools: 'Bash' }, hooks: [{}] }] } }], []],
  buildTroubleshooting: [[state], []],
  buildReleaseNotes: [[state], []],
  renderSessionsOverlay: [[state, 80, 24], []],
  buildAegisPrint: [['Council', { result: 'an answer', model: 'nexus-brain', provider: 'aegis' }], []],
  buildSkillDetail: [[{ name: 'x', namespace: 'ns', description: 'd', path: '/x/SKILL.md', content: 'a\nb\nc' }], []],
  buildMemoryEmbeddings: [[{ engine: 'text-embed-3', model: 'm', dim: 384, mode: 'auto' }, { total: 10, withEmbeddings: 8, embeddingModels: { m: 8 }, stale: 1 }], []],
  buildDoctor: [[state], []],
  buildBuildPanel: [[{ plan: { appName: 'demo' }, reports: [{}, {}], synthesis: 'ok', totalMs: 4200, errorCount: 0 }], []],
};

for (const name of BUILDER_NAMES) {
  const [goodArgs, emptyArgs] = CALLS[name];
  const withCtx = [...goodArgs, ctx];
  const lines = panels[name](...withCtx);
  validate(name, lines);

  // Light theme must not break the builders that take a ctx.
  if (name !== 'renderSessionsOverlay') {
    validate(`${name} (light)`, panels[name](...goodArgs, { light: true }));
  }

  // The defensive contract: undefined for every data argument still yields a
  // valid panel (no throw, no undefined/NaN/[object Object]).
  const minimal = emptyArgs.length ? emptyArgs : goodArgs.map(() => undefined);
  validate(`${name} (empty)`, panels[name](...minimal, ctx));
}

// ── euro money formatting: the 4dp rule is the fix the CLI must not lose ────
assert(typeof panels.fmtEur === 'function', 'fmtEur is exported');
eq(panels.fmtEur(0.0007), '€0.0007', 'sub-cent spend keeps 4dp');
eq(panels.fmtEur(1.234), '€1.23', 'cent-sized amounts keep 2dp');
eq(panels.fmtEur(5), '€5.00', 'cash-sized amounts keep 2dp');
assert(!panels.fmtEur(NaN).includes('NaN'), 'a non-finite amount never renders NaN');
assert(typeof panels.fmtTokens === 'function', 'fmtTokens is exported');
eq(panels.fmtTokens(1562), '1,562', 'tokens are grouped');
eq(panels.fmtTokens(0), '0', 'zero tokens render as 0');

// ── cost + tokens bill in euro, never dollars ───────────────────────────────
for (const name of ['buildCost', 'buildTokens']) {
  const text = flat(panels[name](state, ctx));
  assert(text.includes('€'), `${name} shows the euro sign`);
  assert(!text.includes('$'), `${name} never shows a dollar sign`);
}

// ── the help panel renders a command with its category ─────────────────────
const helpText = flat(panels.buildHelp(state.commands, ctx));
assert(helpText.includes('/help'), 'buildHelp lists the command name');
assert(helpText.includes('Show help'), 'buildHelp lists the command description');
assert(helpText.includes('Support'), 'buildHelp shows the category label');
const helpUnavail = flat(panels.buildHelp([{ name: 'doctor', desc: 'Run checks', category: 'support', unavailable: true }], ctx));
assert(helpUnavail.includes('(unavailable)'), 'buildHelp flags unavailable commands');

// ── the stubs are honest, two-line panels ──────────────────────────────────
for (const name of ['buildDoctor', 'buildBuildPanel']) {
  const s = panels[name](state, ctx);
  eq(s.length, 2, `${name} is a two-line panel`);
  assert(flat(s).includes('not available in aegiscode'), `${name} says why it is absent`);
}

// ── an overlay line is padLine-safe at the terminal width ──────────────────
const screen = require(join(cliDir, 'src', 'screen.js'));
for (const line of panels.renderSessionsOverlay(state, 80, 24, ctx)) {
  const padded = screen.padLine(line, 80);
  eq(screen.lineWidth(padded), 80, 'a sessions-overlay line pads to exactly the terminal width');
}

console.log('CLI panels test passed');
console.log(`  builders: ${BUILDER_NAMES.length} called (plausible + empty), all span-line arrays`);
console.log('  money: €4dp below a cent, €2dp above, no $ in /cost or /tokens');
console.log('  defensive: no undefined / NaN / [object Object] in any panel');
