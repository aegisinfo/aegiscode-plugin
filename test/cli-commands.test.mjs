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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
//
// The gate reads the *resolved* credential (env → credentials.json →
// config.json), not the environment alone, so this must point the data dir at
// an empty one: otherwise a developer with a stored key — or the legacy
// `aegiscloud.api_key` an older AEGIS CLI leaves in ~/.aegiscode/config.json —
// would silently make the "hidden" half of this test pass for the wrong reason.
const gateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-gate-'));
const originalKey = process.env.AEGIS_API_KEY;
const originalHome = process.env.AEGISCODE_HOME;
process.env.AEGISCODE_HOME = gateHome;
process.env.AEGIS_API_KEY = 'aegis_test_key';
const visWithKey = visibleCommands();
delete process.env.AEGIS_API_KEY;
const visWithoutKey = visibleCommands();
if (originalKey !== undefined) process.env.AEGIS_API_KEY = originalKey;
if (originalHome === undefined) delete process.env.AEGISCODE_HOME;
else process.env.AEGISCODE_HOME = originalHome;

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
// /login used to be `unavailable` with /byok-set as its alternative — which
// sent the user to a *provider*-key command with their AEGIS key. It is now the
// in-band way to store that key, and /logout removes it.
const login = parseLine('/login');
eq(login.kind, 'command', '/login is a real command');
eq(login.command.name, 'login', 'and it resolves to the login entry');
eq(typeof login.command.handler, 'function', 'with a handler, not an unavailable reason');
const logout = parseLine('/logout');
eq(logout.kind, 'command', '/logout is a real command');
eq(typeof logout.command.handler, 'function', 'with a handler');
eq(parseLine('/nope').kind, 'unknown', 'an unknown command is unknown');
eq(parseLine('/nope').name, 'nope', 'the unknown name is reported');

// ── Defect A: /compact and /recap forward the second callModel argument ──────
//
// summarize.js invokes callModel(prompt, { model, signal }) — the second
// argument carries the AbortSignal the chatflow's withWorking supplied. If the
// handler drops it, `c.ask(prompt)` never sees the signal and Esc cannot abort
// the running provider call. Pre-fix, `opts` is undefined here.
for (const name of ['compact', 'recap']) {
  const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
  let recorded;
  const pushed = [];
  const stub = {
    ctx: { model: 'test-model' },
    sessionId: 's-test',
    transcript: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'world' }],
    push: (row) => pushed.push(row),
    note: (t) => pushed.push({ role: 'note', text: t }),
    panel: (lines) => pushed.push({ role: 'panel', lines }),
    render: () => {},
    withWorking: async (fn) => fn(signal),
    ask: async (prompt, opts) => { recorded = opts; return { text: 'summary' }; },
    saveConfig: () => {},
  };
  await findCommand(name).handler(stub, { _rest: '' });
  assert(recorded, `/${name} calls c.ask`);
  assert(recorded.signal === signal, `/${name} forwards the abort signal object the handler was given`);
  assert(recorded.model === 'test-model', `/${name} forwards the model through to c.ask`);
}

// ── Defect C: /model loads the list first and never opens an empty picker ────
{
  let loads = 0;
  let stateReadAfterLoad = false;
  const pushed = [];
  const opened = [];
  const stub = {
    ctx: { model: null },
    transcript: [],
    push: (row) => pushed.push(row),
    note: (t) => pushed.push({ role: 'note', text: t }),
    panel: (lines) => pushed.push({ role: 'panel', lines }),
    render: () => {},
    openOverlay: (o) => opened.push(o),
    loadModels: async () => { loads++; },
    state: () => { stateReadAfterLoad = loads > 0; return { models: [] }; },
  };
  await findCommand('model').handler(stub, { _rest: '' });
  assert(loads >= 1, '/model with no argument calls c.loadModels()');
  assert(stateReadAfterLoad, '/model reads state().models only after loadModels() has run');
  assert(!opened.some((o) => o && o.type === 'model'), '/model never opens an empty model picker');
  // An empty list is explained, and the explanation names the fix: "no models
  // advertised" read as "the platform has none" rather than "this client could
  // not ask". This stub has no key, so the key is what it must point at.
  assert(
    pushed.some((r) => r.role === 'note' && /No API key set/.test(r.text || '') && /aegiscloud\.org/.test(r.text || '')),
    '/model says an unreadable catalog needs a key, and where to get one'
  );
}
{
  // Same empty list, but the client HAS a key: the honest reason is then the
  // request itself (offline / refused), not the credential.
  const pushed = [];
  const stub = {
    ctx: { model: null },
    push: (row) => pushed.push(row),
    render: () => {},
    loadModels: async () => {},
    state: () => ({ models: [], online: true }),
  };
  await findCommand('model').handler(stub, { _rest: '' });
  assert(
    pushed.some((r) => r.role === 'note' && /Could not read the model catalog/.test(r.text || '')),
    '/model distinguishes an unreachable catalog from a missing key'
  );
}
{
  let loads = 0;
  const pushed = [];
  const stub = {
    ctx: { model: null },
    push: (row) => pushed.push(row),
    render: () => {},
    loadModels: async () => { loads++; },
    state: () => ({ models: [] }),
  };
  await findCommand('model').handler(stub, { sub: 'list', _rest: 'list' });
  assert(loads >= 1, '/model list calls c.loadModels() before building the panel');
}

// ── Defect B: /run binds the dev-server job to the session ──────────────────
//
// runDevServer spawns a real child, so this drives it in a throwaway cwd whose
// dev script just sleeps for a minute, asserts openStream was handed the job
// (and that the stray unresolved tool row is gone), then stops the job in a
// finally. A temp AEGISCODE_HOME keeps any config write off the real home.
{
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-run-'));
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'run-fixture', scripts: { dev: 'node -e "setTimeout(()=>{},60000)"' } })
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-runhome-'));
  const prevCwd = process.cwd();
  const prevHome = process.env.AEGISCODE_HOME;
  process.env.AEGISCODE_HOME = home;
  const opened = [];
  const closed = [];
  const pushed = [];
  let job = null;
  const stub = {
    ctx: { model: null, cwd: tmp },
    sessionId: 'run-test',
    transcript: [],
    push: (row) => pushed.push(row),
    note: (t) => pushed.push({ role: 'note', text: t }),
    panel: (lines) => pushed.push({ role: 'panel', lines }),
    render: () => {},
    openOverlay: () => {},
    closeOverlay: () => {},
    askInput: async () => null,
    withWorking: async (fn) => fn(new AbortController().signal),
    runPrompt: async () => {},
    ask: async () => ({ text: '' }),
    runTool: async () => '',
    refreshSpend: async () => null,
    state: () => ({ models: [] }),
    loadModels: async () => {},
    setInput: () => {},
    exit: () => {},
    client: {},
    TOOLS: {},
    openStream: (j) => { opened.push(j); job = j; },
    closeStream: (j) => { closed.push(j); },
    saveConfig: () => {},
    showThemePicker: () => {},
  };
  try {
    process.chdir(tmp);
    await findCommand('run').handler(stub, { _rest: '' });
    assert(opened.length === 1, '/run calls openStream exactly once');
    assert(job && job === opened[0], '/run hands the spawned job to openStream');
    assert(job.label === 'npm run dev', 'the job carries the command as its label for the status line');
    assert(
      typeof job.stop === 'function' && job.done && typeof job.done.then === 'function',
      'the job exposes stop() and a done promise'
    );
    assert(!pushed.some((r) => r.role === 'tool'), '/run leaves no unresolved {role:"tool"} row behind');
    job.stop();
    await Promise.race([job.done, new Promise((r) => setTimeout(r, 8000))]);
    assert(closed.includes(job), '/run calls closeStream(job) once the job exits');
  } finally {
    try { if (job && typeof job.stop === 'function') job.stop(); } catch {}
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.AEGISCODE_HOME;
    else process.env.AEGISCODE_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ── /init <file> cannot write outside the working directory ─────────────────
{
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-init-'));
  const prevCwd = process.cwd();
  const prevHome = process.env.AEGISCODE_HOME;
  process.env.AEGISCODE_HOME = tmp;
  const pushed = [];
  const stub = {
    ctx: { cwd: tmp },
    transcript: [],
    push: (row) => pushed.push(row),
    note: (t) => pushed.push({ role: 'note', text: t }),
    panel: (lines) => pushed.push({ role: 'panel', lines }),
    render: () => {},
    saveConfig: () => {},
  };
  try {
    process.chdir(tmp);
    await findCommand('init').handler(stub, { file: '../../escape', _rest: '../../escape' });
    const escaped = path.resolve(tmp, '../../escape');
    assert(!fs.existsSync(escaped), '/init refuses the escaping path and writes nothing');
    assert(!fs.readdirSync(tmp).includes('escape'), '/init leaves no escape file inside the project either');
    assert(
      pushed.some((r) => r.role === 'note' && /outside/.test(r.text || '')),
      '/init notes the refusal honestly'
    );
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.AEGISCODE_HOME;
    else process.env.AEGISCODE_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── every handler runs against the frozen context without throwing ──────────
//
// A handler that throws on its normal path is a command the user cannot use,
// and the only way to notice before shipping is to call it. Each one gets the
// same stub `c` the chatflow provides, an empty arg set, and a temp
// AEGISCODE_HOME so nothing writes to a real config or session store. Argless
// invocation is deliberate: it is the state a user lands in by typing the bare
// command, which is exactly where an unguarded `args.x.y` blows up.
{
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-cmdsmoke-'));
  const prevHome = process.env.AEGISCODE_HOME;
  process.env.AEGISCODE_HOME = home;

  const failures = [];
  const ran = [];
  for (const c of COMMANDS) {
    if (typeof c.handler !== 'function') continue;
    if (c.unavailable) continue;
    const pushed = [];
    const ctx = {
      model: null,
      // The class the next turn runs on. 'aegis' is the real default (app.js
      // commandCtx), so a handler that branches on it takes the same branch
      // here as it does on a fresh install.
      modelClass: 'aegis',
      effort: 'high',
      thinking: false,
      themeIndex: 1,
      light: false,
      vim: false,
      stream: true,
      cwd: home,
      sessionId: 'smoke',
      lastRecap: null,
    };
    const stub = {
      ctx,
      sessionId: 'smoke',
      transcript: [],
      push: (row) => pushed.push(row),
      note: (t) => pushed.push({ role: 'note', text: t }),
      panel: (lines) => pushed.push({ role: 'panel', lines }),
      render: () => {},
      openOverlay: () => {},
      closeOverlay: () => {},
      askInput: async () => null,
      withWorking: async (fn) => fn(new AbortController().signal),
      runPrompt: async () => {},
      ask: async () => ({ text: '', usage: null, model: null, ms: 0, interrupted: false }),
      runTool: async () => '',
      refreshSpend: async () => null,
      state: () => ({ version: '0.0.0', cwd: home, home, tokens: {}, permissions: { mode: 'ask', rules: {} } }),
      loadModels: async () => {},
      // The class surface (app.js's makeCommandContext). /class, /models and
      // /byok-key read all of these, so the stub must carry them for the same
      // reason it carries keyStatus: a handler run with no arguments has to be
      // able to reach everything the real context offers.
      listModelsFor: async () => [],
      switchClass: (cls) => ({ ok: true, class: cls, prev: 'aegis', cleared: null }),
      classLabel: (cls) => String(cls || ''),
      classes: () => [],
      // The provider-key store: an in-memory stand-in for the real
      // desktop/lib/settings.js rows, so /byok-key and /byok-rm-key exercise
      // their own logic instead of throwing on a missing store.
      settings: () => ({
        rows: {},
        set(provider, { key } = {}) { this.rows[provider] = { key }; return { provider, configured: Boolean(key) }; },
        get(provider) { return { provider, configured: Boolean(this.rows[provider]) }; },
        rawKey(provider) { return (this.rows[provider] && this.rows[provider].key) || null; },
        remove(provider) { delete this.rows[provider]; },
      }),
      byokNamespace: (p) => `byok:${p}`,
      openStream: () => {},
      closeStream: () => {},
      setInput: () => {},
      exit: () => {},
      client: { apiBase: 'http://stub', apiKey: 'k', setApiKey: () => '' },
      TOOLS: {},
      saveConfig: () => {},
      showThemePicker: () => {},
      // The credential + cloud-sync surface (app.js's makeCommandContext): a
      // handler called with no arguments must still run, so the stub mirrors
      // the real context rather than the subset an older build happened to use.
      keyStatus: () => ({ configured: false, key: '', source: 'none', path: '/stub/credentials.json', fileMode: null, memoryToken: false, legacyPlaintext: false }),
      setApiKey: async () => ({ ok: true, key: 'k', path: '/stub/credentials.json' }),
      forgetApiKey: () => ({ cleared: true, path: '/stub/credentials.json' }),
      readSecret: async () => '',
      cloudsync: require(join(root, 'cli', 'src', 'cloudsync.js')),
      cloudSyncEnabled: () => false,
      setCloudSync: () => {},
    };
    try {
      // `args` is the keyed positional object a real dispatch builds.
      await c.handler(stub, { _rest: '' });
      ran.push(c.name);
    } catch (e) {
      failures.push(`/${c.name}: ${(e && e.message) || e}`);
    }
  }

  if (prevHome === undefined) delete process.env.AEGISCODE_HOME;
  else process.env.AEGISCODE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });

  assert(
    failures.length === 0,
    `every handler runs with no arguments (${failures.length} threw):\n    ${failures.join('\n    ')}`
  );
  assert(ran.length >= 50, `the smoke actually exercised the handlers (ran ${ran.length})`);
  console.log(`  handlers: ${ran.length} ran with no arguments, none threw`);

  // Running every handler must not touch the working tree. /export and /init
  // wrote to `process.cwd()` instead of the command context's cwd, so this very
  // smoke test was dropping `aegiscodex-export-*.md` and `AEGIS.md` into the
  // repository root on every run — and, worse, writing into the directory the
  // user had just left with /cd.
  const strays = fs
    .readdirSync(process.cwd())
    .filter((n) => n === 'AEGIS.md' || /^aegiscodex-export-/.test(n));
  assert(
    strays.length === 0,
    `the command smoke test must not write into the working directory (found ${strays.join(', ')})`
  );
}

// ── /terminal: the mid-session capability switch ──────────────────────────────
//
// The handler is reachable from the palette and its no-arg path is covered by
// the smoke test above, but that path only *reports*. The branches that mutate
// session state — and the pin semantics that decide whether a live resize keeps
// working — were unexercised, which is how the handler shipped calling a
// `panels.buildTerminalCaps` that did not exist. `caps.js` is a process-wide
// singleton, so every mutation here is restored in the `finally`.
{
  const cap = require(join(root, 'cli', 'src', 'caps.js'));
  const cmd = findCommand('terminal');
  assert(cmd, '/terminal is registered');
  assert(cmd.aliases.includes('tty'), '/terminal has the `tty` alias the palette advertises');

  // The report is rendered as `[span, span]` lines; flatten to plain text so the
  // assertion reads like the panel a user sees rather than a span graph.
  const textOf = (row) => String((row && row.text) || (row && row.t) || row || '')
    .replace(/\x1b\[[0-9;]*m/g, '');

  const drive = async (args) => {
    const pushed = [];
    const stub = {
      ctx: {}, transcript: [],
      push: (r) => pushed.push(r),
      note: (t) => pushed.push({ role: 'note', text: t }),
      panel: (lines) => pushed.push({ role: 'panel', lines }),
      render: () => {},
    };
    const ret = await cmd.handler(stub, args);
    const panelRow = pushed.find((r) => r.role === 'panel');
    const panelText = panelRow ? panelRow.lines.flat().map(textOf).join('\n') : '';
    const notes = pushed.filter((r) => r.role === 'note').map((r) => r.text).join('\n');
    return { ret, pushed, panelText, notes };
  };

  const before = { ...cap.caps() };
  try {
    // 1. Status reports without mutating. This is the path the smoke test takes,
    //    pinned here so the report itself is asserted, not just "did not throw".
    {
      const { ret, panelText } = await drive({ mode: 'status' });
      eq(ret, true, '/terminal status returns true');
      assert(/Terminal capabilities/.test(panelText), '/terminal status renders the capability panel');
      assert(/mark|Mark/.test(panelText) && /star|Star/.test(panelText),
        '/terminal status lists the mark and star axes (found no such row)');
      assert(/\/terminal ascii/.test(panelText), '/terminal status names its own override syntax');
      assert(/--ascii/.test(panelText), '/terminal status points at the launch flags');
      eq(cap.caps().pinned, false, '/terminal status does not pin the frame');
      eq(cap.caps().glyphs, before.glyphs, '/terminal status leaves the mark unchanged');
    }

    // 2. `ascii` downgrades every glyph axis together — the mark, the edges face
    //    and the star — because stencilling only one of them is the exact
    //    PowerShell/zsh divergence this layer exists to remove.
    {
      await drive({ mode: 'ascii' });
      const c = cap.caps();
      eq(c.glyphs, 'ascii', '/terminal ascii sets the glyph class to ascii');
      eq(c.face, 'edges', '/terminal ascii stencils the block-edges face');
      eq(c.star, 'narrow', '/terminal ascii narrows the star');
      eq(c.pinned, false, '/terminal ascii must NOT pin the frame — a live resize still wins');
    }

    // 3. `unicode` is the inverse, and must restore all three axes.
    {
      await drive({ mode: 'unicode' });
      const c = cap.caps();
      eq(c.glyphs, 'unicode', '/terminal unicode restores the native mark');
      eq(c.face, 'native', '/terminal unicode restores the native face');
      eq(c.star, 'native', '/terminal unicode restores the native star');
    }

    // 4. The star is independently switchable — it is the one rune Windows fonts
    //    lack, so it needs an escape hatch that does not also stencil the art.
    {
      await drive({ mode: 'star', mode2: 'narrow' });
      const c = cap.caps();
      eq(c.star, 'narrow', '/terminal star narrow narrows only the star');
      eq(c.glyphs, 'unicode', '/terminal star narrow leaves the mark alone');
      const bad = await drive({ mode: 'star', mode2: 'wide' });
      assert(/Usage/.test(bad.notes), '/terminal star rejects an unknown width with usage, not a throw');
    }

    // 5. `width` is the one branch that deliberately pins: an explicit column
    //    count must survive a resize, or the pinned width would be undone by the
    //    very SIGWINCH it exists to ignore.
    {
      await drive({ mode: 'width', mode2: '100' });
      const c = cap.caps();
      eq(c.cols, 100, '/terminal width 100 applies the column count');
      eq(c.pinned, true, '/terminal width pins the frame so a resize cannot undo it');
      const { panelText } = await drive({ mode: 'status' });
      assert(/pinned/i.test(panelText), '/terminal status warns that the width is pinned');
      const bad = await drive({ mode: 'width', mode2: 'abc' });
      assert(/Usage/.test(bad.notes), '/terminal width rejects a non-number with usage, not NaN');
      eq(cap.caps().cols, 100, '/terminal width abc leaves the pinned width untouched');
    }

    // 6. `auto` means "re-probe", not "restore the launch flags" — so it must
    //    clear the pin and return every axis to what the environment resolves.
    {
      await drive({ mode: 'auto' });
      const c = cap.caps();
      eq(c.pinned, false, '/terminal auto clears the width pin');
      eq(c.glyphs, before.glyphs, '/terminal auto re-probes the mark from the environment');
      eq(c.depth, before.depth, '/terminal auto re-probes the colour depth');
    }

    // 7. An unknown subcommand explains itself instead of silently doing nothing.
    {
      const { ret, notes } = await drive({ mode: 'nonsense' });
      eq(ret, true, '/terminal with an unknown subcommand still returns true (no dispatch fallthrough)');
      assert(/Usage: \/terminal/.test(notes), '/terminal names its usage on an unknown subcommand');
    }

    console.log('  /terminal: 7 branches driven, axes + pin semantics held');
  } finally {
    // caps.js is a singleton shared with every later test in this process.
    cap.resetCaps();
    eq(cap.caps().pinned, false, 'the /terminal test restores the unpinned default');
  }
}

// ── /byok: every panel line is a span array, never a plain string ──────────
//
// Regression pin: byokProviderLines() used to build each row with
// `` `  ${span(...)}${label}  ${state}` `` — template-literal interpolation
// stringifies a span object to "[object Object]" instead of keeping it as
// one, so the line handed to panel() was a plain string. screen.js's
// padLine()/paint() only understand a line as an *array* of `{t, s, w}`
// spans: fed a string, `for (const sp of line)` walks it character by
// character, each fake "span" comes out `{t: undefined, w: undefined}`, and
// paint()'s `out += sp.s + sp.t` prints the literal text "NaN" once per
// character — reproduced live via a real pty (`tools/cli-screenshot.py`'s
// harness) before the fix, where /byok rendered a wall of "NaN" instead of
// the provider list. The no-argument smoke test above never caught this
// because its stub client has no `byokProviders()`, so /byok took the
// `aegis_byok_status` tool fallback and never reached byokProviderLines() at
// all — this test supplies the catalog so the real path runs.
{
  const pushed = [];
  const stub = {
    ctx: { modelClass: 'aegis' },
    transcript: [],
    push: (r) => pushed.push(r),
    note: (t) => pushed.push({ role: 'note', text: t }),
    panel: (lines) => pushed.push({ role: 'panel', lines }),
    render: () => {},
    client: {
      byokProviders: async () => ({
        providers: [
          { id: 'openai', label: 'OpenAI', configured: false, models: ['gpt-5-mini'], key_prefix: 'sk-', key_url: 'https://platform.openai.com/api-keys' },
          { id: 'grok', label: 'xAI', configured: true, masked: 'xai-***abcd', models: [{ id: 'grok-4.5' }] },
        ],
      }),
    },
  };
  await findCommand('byok').handler(stub, {});
  const panelRow = pushed.find((r) => r.role === 'panel');
  assert(panelRow, '/byok pushes a panel row');
  for (const line of panelRow.lines) {
    assert(
      Array.isArray(line) || line === '',
      `every /byok panel line is a span array or an empty spacer, not a plain string (got ${JSON.stringify(line)})`
    );
    if (Array.isArray(line)) {
      for (const sp of line) {
        assert(sp && typeof sp.t === 'string' && typeof sp.w === 'number', `every span has a string .t and numeric .w (got ${JSON.stringify(sp)})`);
      }
    }
  }
  const rendered = panelRow.lines.filter(Array.isArray).map((l) => l.map((sp) => sp.t).join('')).join('\n');
  assert(!/NaN/.test(rendered), `/byok never renders the literal text "NaN" (got:\n${rendered})`);
  assert(/openai/.test(rendered) && /grok/.test(rendered), '/byok renders the real provider ids');
  assert(/gpt-5-mini/.test(rendered), '/byok renders model ids');
  assert(/sk-/.test(rendered), '/byok renders the key prefix');
  assert(/platform\.openai\.com/.test(rendered), '/byok renders the key url');
  console.log('  /byok: panel lines are span arrays, no NaN, real provider data renders');
}

console.log('CLI commands test passed');
console.log(`  commands: ${COMMANDS.length} entries (${all.length} listed, ${vis.length} visible with this env)`);
console.log(`  categories: ${CATEGORIES.length} · effort levels: ${EFFORT_LEVELS.join('/')}`);
console.log(`  gate: ${HIDDEN.length} hidden entries toggled by AEGIS_API_KEY`);
