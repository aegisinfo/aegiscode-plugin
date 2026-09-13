#!/usr/bin/env node
/**
 * The slash-command table — the vocabulary and shape of every command, driven
 * directly (no TTY, no child process, no network).
 *
 * What it pins: that each entry carries the metadata the palette/_help/overlays
 * read (`name`, `desc`, `category`, `hint`, `aliases`), that exactly one of
 * `handler`/`tool`/`unavailable` backs it, that no name or alias is registered
 * twice (the module throws on load if it is), that the reference vocabulary is
 * actually present by name, and that every tool-backed command names a real
 * registry tool. Style matches test/cli-render.test.mjs: createRequire, a local
 * assert() that throws `ASSERT FAILED: ...`, no test framework.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Loading the module is itself the duplicate-name guard: a second registration
// of any name or alias throws at require time.
const commands = require(join(root, 'cli', 'src', 'commands.js'));
const { CATEGORIES, categoryLabel, EFFORT_LEVELS, COMMANDS, allCommands, visibleCommands, findCommand, canonicalName, parseLine } = commands;
const deps = require(join(root, 'cli', 'src', 'deps.js'));

// ── the entry shape ─────────────────────────────────────────────────────────
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
assert(CATEGORY_IDS.has('session') && CATEGORY_IDS.has('aegis') && CATEGORY_IDS.has('custom'), 'the reference category ids are present');
eq(categoryLabel('session'), 'Session & context', 'categoryLabel maps an id to its label');
assert(Array.isArray(EFFORT_LEVELS) && EFFORT_LEVELS.includes('high'), 'EFFORT_LEVELS lists the effort levels');

assert(Array.isArray(COMMANDS) && COMMANDS.length > 0, 'COMMANDS is a non-empty array (tests iterate it)');

for (const c of COMMANDS) {
  assert(typeof c.name === 'string' && c.name.length > 0, `every command has a name (got ${JSON.stringify(c.name)})`);
  assert(typeof c.desc === 'string' && c.desc.length > 0, `/${c.name} has a one-line desc`);
  assert(CATEGORY_IDS.has(c.category), `/${c.name} has a category in CATEGORIES (got ${JSON.stringify(c.category)})`);
  if (c.hint !== undefined) assert(typeof c.hint === 'string', `/${c.name} hint is a string`);
  if (c.aliases !== undefined) {
    assert(Array.isArray(c.aliases), `/${c.name} aliases is an array`);
  }
  if (c.args !== undefined) {
    assert(Array.isArray(c.args) && c.args.every((a) => typeof a === 'string'), `/${c.name} args is an array of positional names`);
  }

  // Exactly one of handler / tool (or the generic /tool escape hatch) / unavailable.
  const hasHandler = typeof c.handler === 'function';
  const hasTool = typeof c.tool === 'string' || c.generic === true;
  const hasUnavail = typeof c.unavailable === 'string' && c.unavailable.length > 0;
  eq(
    [hasHandler, hasTool, hasUnavail].filter(Boolean).length,
    1,
    `/${c.name} has exactly one of handler / tool(+/tool) / unavailable`
  );
  if (hasHandler) assert(!c.tool, `/${c.name} never has both a handler and a tool`);
  if (c.unavailable) assert(typeof c.alt !== 'string' || c.alt.startsWith('/'), `/${c.name} alt names a slash command`);
}

// ── no name or alias registered twice ───────────────────────────────────────
const seen = new Set();
for (const c of COMMANDS) {
  for (const n of [c.name, ...(c.aliases || [])]) {
    assert(!seen.has(n), `name/alias /${n} is only registered once`);
    seen.add(n);
  }
}

// ── findCommand / canonicalName resolve names and aliases ───────────────────
for (const c of COMMANDS) {
  assert(findCommand(c.name) === c, `findCommand('${c.name}') resolves to its entry`);
  eq(canonicalName(c.name), c.name, `canonicalName('${c.name}') is itself`);
  assert(findCommand(c.name.toUpperCase()) === c, `findCommand is case-insensitive for '${c.name}'`);
  for (const a of c.aliases || []) {
    assert(findCommand(a) === c, `findCommand('${a}') resolves to /${c.name}`);
    eq(canonicalName(a), c.name, `canonicalName('${a}') is /${c.name}`);
  }
}
assert(findCommand('definitely-not-a-command') === null, 'an unknown name resolves to null');

// ── visibleCommands excludes hidden entries; allCommands includes them ──────
const HIDDEN = COMMANDS.filter((c) => c.hidden);
assert(HIDDEN.length > 0, 'at least one command is gated by a `hidden` predicate');
const all = allCommands();
const vis = visibleCommands();
assert(all.length >= COMMANDS.length, 'allCommands includes every entry');
eq(all.length, COMMANDS.length, 'allCommands returns exactly the registered entries');

// Toggle the cloud gate so the hidden predicate is exercised both ways.
const originalKey = process.env.AEGIS_API_KEY;
process.env.AEGIS_API_KEY = 'aegis_test_key';
const visWithKey = visibleCommands();
delete process.env.AEGIS_API_KEY;
const visWithoutKey = visibleCommands();
if (originalKey !== undefined) process.env.AEGIS_API_KEY = originalKey;

assert(visWithKey.some((c) => c.name === 'aegis-council'), 'with a key the gated /aegis-council is visible');
assert(!visWithoutKey.some((c) => c.name === 'aegis-council'), 'with no key the gated /aegis-council is hidden');
for (const c of COMMANDS) {
  if (!c.hidden) continue;
  assert(!visibleCommands().some((v) => v.name === c.name) || c.hidden() === false, `hidden /${c.name} is excluded from visibleCommands`);
}
assert(vis.length <= all.length, 'visibleCommands is a (non-strict) subset of allCommands');

// ── the reference vocabulary is present by name ─────────────────────────────
// Hardcoded so a silent drop of any one fails the build.
const REFERENCE_NAMES = [
  'run', 'schedule', 'build', 'cd', 'copy', 'clear', 'compact', 'cost', 'context',
  'effort', 'exit', 'export', 'help', 'init', 'login', 'logout', 'model', 'radio',
  'recap', 'resume', 'rewind', 'agents', 'status', 'teleport', 'theme', 'version',
  'doctor', 'vim', 'permissions', 'hooks', 'credentials', 'troubleshooting',
  'feedback', 'bug', 'issue', 'onboarding', 'prs', 'review', 'benchmark', 'waifu',
  'new', 'tokens', 'skills', 'thinking', 'mcp', 'memory', 'confirm', 'yolo',
  'multiyolo', 'router', 'multi', 'research', 'debate', 'billing', 'cloud', 'gmail',
  'clone',
];
eq(REFERENCE_NAMES.length, 57, 'the reference list is the expected 57 names');
for (const name of REFERENCE_NAMES) {
  assert(findCommand(name), `the reference command /${name} is present`);
}
for (const name of ['aegis-status', 'aegis-ask', 'aegis-recall', 'aegis-remember', 'aegis-council', 'aegis-print', 'aegis-multi']) {
  assert(findCommand(name), `the ÆGIS command /${name} is present`);
}
for (const name of ['byok', 'byok-set', 'byok-rm', 'models', 'tool', 'aegis-import']) {
  assert(findCommand(name), `the cloud-only command /${name} is present`);
}
assert(COMMANDS.length >= 60, `the table has at least 60 entries (got ${COMMANDS.length})`);

// ── every tool-backed command names a real registry tool ────────────────────
const toolNames = new Set(deps.createTools({}).toolList().map((t) => t.name));
for (const c of COMMANDS) {
  if (!c.tool) continue;
  assert(toolNames.has(c.tool), `/${c.name} points at a real tool (${c.tool})`);
}

// ── parseLine keeps its contract ────────────────────────────────────────────
eq(parseLine('\n').kind, 'empty', 'a blank line is empty');
eq(parseLine('hi').kind, 'prompt', 'plain text is a prompt');
eq(parseLine('  hi  ').kind, 'prompt', 'a trimmed prompt is a prompt');
const ask = parseLine('/ask hi');
eq(ask.kind, 'command', '/ask hi is a command');
eq(ask.arg, 'hi', 'the argument is split off');
eq(parseLine('/model').kind, 'command', '/model is a command');
const quit = parseLine('/quit');
eq(quit.kind, 'command', '/quit resolves');
eq(quit.command.name, 'exit', '/quit resolves to the exit entry');
const unavail = parseLine('/login');
eq(unavail.kind, 'unavailable', '/login is unavailable');
assert(typeof unavail.command.unavailable === 'string' && unavail.command.unavailable.length > 0, 'the unavailable entry carries a reason');
eq(parseLine('/nope').kind, 'unknown', 'an unknown command is unknown');
eq(parseLine('/nope').name, 'nope', 'the unknown name is reported');

console.log('CLI commands test passed');
console.log(`  commands: ${COMMANDS.length} entries (${all.length} listed, ${vis.length} visible with this env)`);
console.log(`  categories: ${CATEGORIES.length} · effort levels: ${EFFORT_LEVELS.join('/')}`);
console.log(`  gate: ${HIDDEN.length} hidden entries toggled by AEGIS_API_KEY`);
