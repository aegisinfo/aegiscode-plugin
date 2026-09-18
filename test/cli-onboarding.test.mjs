#!/usr/bin/env node
/**
 * Onboarding — the pre-session phase the CLI did not have.
 *
 * What this pins, and why:
 *
 *  · that a genuine first run walks trust check → theme picker → welcome and
 *    *persists* the choice, so the picker is never shown again. Re-showing it
 *    every launch is not a cosmetic bug: it wipes the screen and greets a
 *    returning user with "Let's get started." as if they had never run before;
 *  · that declining the trust check **aborts** rather than continuing into a
 *    session that can read, edit and execute files in the folder the user just
 *    refused to vouch for;
 *  · that `--continue` skips onboarding entirely (the reference's behaviour);
 *  · the exact copy of all three screens, because a trust dialog that does not
 *    say what will be done to the folder is worse than no dialog.
 *
 * The screens are driven **for real** through the key stream for one test, and
 * the sequence is driven through an injected `ui` for the rest — the first
 * proves the thing actually runs in a terminal, the second proves the ordering
 * and the persistence, and neither needs a pty.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, '..', 'cli');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) =>
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const has = (haystack, needle, msg) =>
  assert(String(haystack).includes(needle), `${msg} — missing ${JSON.stringify(needle)}`);

// A throwaway data dir, before anything reads config, so configExists() and the
// persisted themeIndex are this test's and not the developer's.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-onboard-'));
process.env.AEGISCODE_HOME = HOME;

const screens = require(join(cliDir, 'src', 'screens.js'));
const art = require(join(cliDir, 'src', 'art.js'));
const theme = require(join(cliDir, 'src', 'theme.js'));
const screen = require(join(cliDir, 'src', 'screen.js'));
const events = require(join(cliDir, 'src', 'events.js'));
const config = require(join(cliDir, 'src', 'config.js'));

const text = (lines) =>
  (Array.isArray(lines) ? lines : [lines])
    .map((l) => (Array.isArray(l) ? l.map((sp) => sp.t).join('') : String(l)))
    .join('\n');
const plain = (lines) => screen.stripAnsi(text(lines));

// ── the trust check ─────────────────────────────────────────────────────────

{
  const lines = plain(screens.trustLines({}, 100, 0, '/home/neo/proj'));
  has(lines, 'Accessing workspace:', 'the trust screen names what it is accessing');
  has(lines, '/home/neo/proj', 'and the exact folder');
  has(lines, 'Quick safety check', 'and asks the safety question');
  has(lines, 'read, edit, and execute files here', 'and discloses what it may do');
  has(lines, 'Yes, I trust this folder', 'and offers the trust option');
  has(lines, 'No, exit', 'and the exit option');
  has(lines, 'Esc to cancel', 'and states the cancel key');

  // The active row is the one carrying the ❯ cursor — selecting "No, exit" must
  // visibly move it, or the user cannot tell which option Enter will take.
  const sel0 = text(screens.trustLines({}, 100, 0, '/x')).split('\n');
  const sel1 = text(screens.trustLines({}, 100, 1, '/x')).split('\n');
  const cursorRow = (rows) => rows.findIndex((r) => r.includes(theme.GLYPH.cursor));
  const r0 = cursorRow(sel0);
  const r1 = cursorRow(sel1);
  assert(r0 !== -1 && r1 !== -1, 'the trust screen draws a selection cursor');
  assert(r0 !== r1, `the cursor moves with the selection (both rows were ${r0})`);
  has(sel0[r0], 'Yes, I trust this folder', 'and marks the trust row at sel=0');
  has(sel1[r1], 'No, exit', 'and the exit row at sel=1');
}

// ── the theme picker ────────────────────────────────────────────────────────

{
  eq(theme.THEME_TABLE.length, 7, 'the picker offers the reference\'s 7 rows');
  const lines = plain(screens.themePickerLines({ light: false, themeIndex: 1 }, 100, 40, 1));
  has(lines, "Let's get started.", 'the picker greets');
  has(lines, 'run /theme', 'and says how to change it later');
  for (const row of theme.THEME_TABLE) has(lines, row.name, `the picker lists ${row.name}`);
  has(lines, '(colorblind-friendly)', 'including the colourblind variant');
  has(lines, '(ANSI colors only)', 'including the ANSI-only variant');
  has(lines, 'Syntax theme: Monokai Extended', 'and the syntax-theme line');

  // Selecting a row must move the check mark, not just the cursor.
  const at0 = text(screens.themePickerLines({}, 100, 40, 0));
  const at6 = text(screens.themePickerLines({}, 100, 40, 6));
  const checkedRow = (s) => s.split('\n').findIndex((r) => r.includes(theme.GLYPH.check));
  assert(checkedRow(at0) !== -1, 'a check mark is drawn for the selection');
  assert(checkedRow(at0) !== checkedRow(at6), 'and it follows the selection');
}

// ── applyTheme: the row decides the palette, not just the label ─────────────

{
  const ctx = {};
  eq(screens.applyTheme(ctx, 2), 2, 'applyTheme returns the index');
  eq(ctx.light, true, 'row 2 (Light mode) is a light theme');
  eq(theme.themeOf(ctx), theme.LIGHT, 'and resolves to the light palette');
  screens.applyTheme(ctx, 3);
  eq(ctx.light, false, 'row 3 (colorblind dark) is a dark theme');
  eq(theme.themeOf(ctx), theme.CB_DARK, 'and resolves to the colourblind palette');
  screens.applyTheme(ctx, 5);
  eq(theme.themeOf(ctx), theme.ANSI_DARK, 'row 5 resolves to the ANSI palette');
  // Out of range must not throw.
  screens.applyTheme(ctx, 99);
  eq(ctx.light, false, 'an out-of-range index falls back to the dark row');
}

// ── the welcome screen ──────────────────────────────────────────────────────

{
  const first = plain(screens.welcomeLines({ light: false }, 100, 44, true));
  has(first, 'Welcome to AEGIS Code', 'a first run is greeted as such');
  has(first, 'Tips for getting started', 'the tips box is drawn');
  has(first, "What's new", "the what's-new box is drawn");
  has(first, 'Run /init', 'with real tips');
  has(first, 'Press / for commands', 'including the palette');
  has(first, 'write a test for <filepath>', 'and the footer hint');
  has(first, '━', 'and the gold header rule');

  const back = plain(screens.welcomeLines({ light: false }, 100, 44, false));
  has(back, 'Welcome back!', 'a returning run is greeted as such');
  assert(!back.includes('Welcome to AEGIS Code'), 'and not as a first run');

  // The tagline, and the narrow fallback that keeps it from being clipped.
  // `centered()` clips rather than wraps, so the threshold is load-bearing: the
  // full line at 100 cols, the short one when the terminal is too narrow for
  // it. Both are asserted against the constants, not against literal prose, so
  // a copy change in art.js flows through here instead of failing a stale
  // expectation.
  const { TAGLINE, TAGLINE_SHORT } = art;
  has(first, TAGLINE, 'the welcome screen shows the tagline');
  assert(!first.includes('Cloud brain in your shell'), 'and not the retired copy');
  const narrow = plain(screens.welcomeLines({ light: false }, screen.w(TAGLINE) - 1, 44, false));
  has(narrow, TAGLINE_SHORT, 'a terminal too narrow for the tagline gets the short copy');
  assert(!narrow.includes(TAGLINE), 'and never a clipped full line');
  // The threshold is derived from the string's width, so widening the copy must
  // move the breakpoint with it rather than start silently truncating.
  const justFits = plain(screens.welcomeLines({ light: false }, screen.w(TAGLINE) + 4, 44, false));
  has(justFits, TAGLINE, 'one cell wider than the breakpoint, the full line is back');

  // Every row must fit the terminal, or the frame wraps and the boxes shear.
  for (const cols of [80, 100, 120, 44]) {
    for (const l of screens.welcomeLines({ light: false }, cols, 44, true)) {
      const width = l.reduce((a, sp) => a + sp.w, 0);
      assert(width <= cols, `welcome row fits ${cols} cols (row was ${width})`);
    }
  }

  // ── the `What's new` box is the patch note, held to the package ──────────
  // It sat four minor versions stale — topping out at v6.3.0 while the package
  // shipped 6.7.3 — because nothing tied it to anything. These assertions are
  // that tie, and each one catches a different way the box can lie.
  {
    const pkg = require(join(cliDir, 'package.json'));
    const commands = require(join(cliDir, 'src', 'commands.js'));
    const news = plain(screens.welcomeLines({ light: false }, 100, 44, true));

    has(news, `What's new in v${pkg.version}`,
      "the what's-new header names the build the user is actually running");

    // Never claim news from a release that has not shipped — that is the one
    // direction a changelog can lie that a reader cannot detect.
    const [maj, min] = pkg.version.split('.').map(Number);
    const named = [...news.matchAll(/v(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const ahead = named.filter(([a, b]) => a > maj || (a === maj && b > min));
    eq(ahead.length, 0,
      `the patch note claims no release newer than v${pkg.version} (saw ${JSON.stringify(ahead)})`);
    // And it must actually reach the current minor: the box is allowed to
    // trail by a patch, never by a minor — a minor means the copy needs a look.
    assert(named.some(([a, b]) => a === maj && b === min),
      `the patch note names the current release line v${maj}.${min}`);

    // Every command the box advertises has to exist. A rename left the prose
    // pointing at a route the user cannot take, and a welcome screen is the
    // worst place to be told about a command that is not there.
    const advertised = [...news.matchAll(/\/([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
    assert(advertised.length >= 2, `the patch note advertises its commands (saw ${advertised.length})`);
    for (const name of advertised) {
      assert(commands.findCommand(name), `the patch note advertises /${name}, and the registry has it`);
    }

    // The row budget is load-bearing. At 80×24 the screen fills rows-1 exactly,
    // so a ninth row in WHATS_NEW pushes the footer hint off the bottom of the
    // commonest terminal there is — and `boxes()` receives an `avail` it never
    // reads, so nothing else would stop it.
    eq(screens.welcomeLines({ light: false }, 80, 24, true).length, 23,
      'the welcome screen still fills an 80x24 terminal without overflowing');
  }
}

// ── the sequence, with the screens injected ─────────────────────────────────

{
  const order = [];
  const saved = [];
  const ui = {
    showTrustCheck: async () => {
      order.push('trust');
      return true;
    },
    showThemePicker: async (ctx) => {
      order.push('picker');
      screens.applyTheme(ctx, 4);
      return ctx.themeIndex;
    },
    showWelcome: async (_ctx, firstRun) => {
      order.push(`welcome:${firstRun}`);
      return { exit: false };
    },
  };

  // First run: all three, in the reference's order, and the choice persisted.
  const ctx1 = { themeIndex: 1, light: false };
  const r1 = await screens.runOnboarding(ctx1, { seen: () => false, save: (p) => saved.push(p), ui });
  eq(order.join(','), 'trust,picker,welcome:true', 'first run walks trust → picker → welcome');
  eq(r1.ok, true, 'first run continues into the session');
  eq(r1.firstRun, true, 'and reports itself as a first run');
  eq(ctx1.themeIndex, 4, 'the picked row lands on the context');
  eq(saved.length, 1, 'and is persisted exactly once');
  eq(saved[0].themeIndex, 4, 'persisting the row index');
  eq(saved[0].light, true, 'and its light/dark flag');

  // Returning run: welcome only. The picker must NOT reappear.
  order.length = 0;
  const ctx2 = { themeIndex: 4, light: true };
  const r2 = await screens.runOnboarding(ctx2, { seen: () => true, save: () => {}, ui });
  eq(order.join(','), 'welcome:false', 'a returning run goes straight to "Welcome back!"');
  eq(r2.ok, true, 'and continues into the session');
  eq(r2.firstRun, false, 'reporting a returning run');

  // Declining trust must abort before the picker and before any session.
  order.length = 0;
  const saved2 = [];
  const declined = {
    ...ui,
    showTrustCheck: async () => {
      order.push('trust');
      return false;
    },
  };
  const r3 = await screens.runOnboarding({ themeIndex: 1, light: false }, {
    seen: () => false,
    save: (p) => saved2.push(p),
    ui: declined,
  });
  eq(order.join(','), 'trust', 'a declined trust check stops there');
  eq(r3.ok, false, 'and reports that the session must not start');
  eq(saved2.length, 0, 'and persists nothing');

  // ctrl+c on the welcome screen is a request to leave, not to enter.
  const exiting = { ...ui, showWelcome: async () => ({ exit: true }) };
  order.length = 0;
  const r4 = await screens.runOnboarding({ themeIndex: 1, light: false }, {
    seen: () => true,
    save: () => {},
    ui: exiting,
  });
  eq(r4.ok, false, 'ctrl+c on the welcome screen does not start a session');

  // --continue skips onboarding entirely.
  order.length = 0;
  const r5 = await screens.runOnboarding({ themeIndex: 1, light: false }, {
    continue: true,
    seen: () => false,
    save: () => {},
    ui,
  });
  eq(order.length, 0, '--continue shows no onboarding screens at all');
  eq(r5.ok, true, '--continue still starts the session');
}

// ── the screens, driven for real through the key stream ─────────────────────

function fakeStdin() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.setRawMode = () => {};
  s.setEncoding = () => {};
  s.resume = () => {};
  s.pause = () => {};
  return s;
}

{
  const stdin = fakeStdin();
  const captured = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 44, configurable: true, writable: true });

  try {
    events.attachKeyStream(stdin);
    // First run, with a real config dir that is currently empty — so the flow
    // this exercises is the genuine one, `configExists()` included.
    assert(!config.configExists(), 'the temp home starts with no config');
    const ctx = { themeIndex: 1, light: false };
    const p = screens.runOnboarding(ctx, {});
    // Trust: Enter on the highlighted "Yes, I trust this folder".
    stdin.emit('data', '\r');
    await tick();
    // Theme picker: it opens on the current row (index 1, "Dark mode"), so one
    // arrow down lands on row 2, "Light mode", then Enter commits it.
    stdin.emit('data', '\x1b[B');
    await tick();
    stdin.emit('data', '\r');
    await tick();
    // Welcome: Enter to continue.
    stdin.emit('data', '\r');
    const res = await p;

    eq(res.ok, true, 'the real key-driven onboarding completes');
    const painted = captured.join('');
    has(screen.stripAnsi(painted), 'Yes, I trust this folder', 'the trust screen was really painted');
    has(screen.stripAnsi(painted), "Let's get started.", 'so was the theme picker');
    has(screen.stripAnsi(painted), 'Tips for getting started', 'so was the welcome screen');
    eq(config.configExists(), true, 'and the run left a config file behind');

    const saved = config.loadConfig();
    eq(saved.themeIndex, 2, 'persisting the row the arrow keys selected');
    eq(saved.light, true, 'with its light flag');

    // Second launch: the picker must not come back.
    captured.length = 0;
    const again = screens.runOnboarding({ themeIndex: 2, light: true }, {});
    stdin.emit('data', '\r');
    const res2 = await again;
    eq(res2.firstRun, false, 'the second launch is a returning run');
    const painted2 = screen.stripAnsi(captured.join(''));
    has(painted2, 'Welcome back!', 'and is greeted as a returning user');
    assert(!painted2.includes("Let's get started."), 'and is NOT shown the theme picker again');
  } finally {
    events.resetKeyStream();
    process.stdout.write = realWrite;
  }
}

function tick() {
  return new Promise((r) => setTimeout(r, 5));
}

// ── wired up, not dead code ─────────────────────────────────────────────────
//
// Everything above tests `screens.js` in isolation, so every assertion would
// still pass if nothing ever *called* it — which is exactly the bug this work
// fixed: the CLI shipped a command palette, an `appendHistory`, a
// `snapshotCheckpoint` and a `configExists()` that were all fully implemented
// and never invoked. Assert the wiring at the source level, the way
// cli-conformance.test.mjs does for the design tokens.
{
  const read = (p) => fs.readFileSync(path.join(cliDir, 'src', p), 'utf8');
  const app = read('app.js');
  const flow = read('chatflow.js');
  const cmd = read('commands.js');

  has(app, "require('./screens.js')", 'app.js imports the onboarding screens');
  has(app, 'screens.runOnboarding(', 'and actually runs them');
  has(app, 'restorePrefs()', 'and restores persisted preferences on launch');
  has(app, 'persistTurn(', 'and has a persist hook');
  has(app, 'appendHistory(', 'which writes the history row');
  has(app, 'snapshotCheckpoint(', 'and snapshots a /rewind checkpoint');

  // The chatflow is the only place that sees a prompt and its reply together,
  // so if it does not call the hook the two callers above never fire for TUI
  // turns — the persistence would work in `-p` mode and nowhere else.
  has(flow, 'host.persistTurn(', 'the chatflow persists turns too');
  has(flow, "type: 'palette'", 'the palette can actually be opened');

  // Every silent consumer of history.jsonl, which was never written.
  const hist = read('history.js');
  has(hist, 'function appendHistory', 'the history writer exists');
  has(cmd, "require('./screens.js')", 'commands.js shares the theme table');
  has(cmd, 'screens.applyTheme(', 'so /theme dark|light picks a real row, not index 0');
}

// ── the tagline has exactly one owner ───────────────────────────────────────
//
// The drift this pins was structural, not textual: the string was written out
// twice — once as a rule in `art.js`, once inline in `screens.js` — so changing
// one left the other shipping the old sentence, and every existing assertion
// still passed because none of them looked at the copy. Asserting the two
// *rendered* lines agree (above) catches a stale copy today; asserting the
// literal exists in exactly one source file is what stops the second copy being
// reintroduced tomorrow, which is the failure mode that actually recurred.
{
  const files = fs.readdirSync(path.join(cliDir, 'src')).filter((f) => f.endsWith('.js'));
  const owners = files
    .filter((f) => fs.readFileSync(path.join(cliDir, 'src', f), 'utf8').includes(art.TAGLINE))
    .sort();
  eq(owners.join(','), 'art.js', 'the tagline literal lives in exactly one source file');

  const shortOwners = files
    .filter((f) => fs.readFileSync(path.join(cliDir, 'src', f), 'utf8').includes(art.TAGLINE_SHORT))
    .sort();
  eq(shortOwners.join(','), 'art.js', 'and so does the short copy');

  // The consumers must go through the constant. A literal here would be the
  // duplicate again, just spelled slightly differently.
  const screensSrc = fs.readFileSync(path.join(cliDir, 'src', 'screens.js'), 'utf8');
  const renderSrc = fs.readFileSync(path.join(cliDir, 'src', 'render.js'), 'utf8');
  has(screensSrc, 'TAGLINE_SHORT', 'screens.js takes the short copy from the constant');
  has(renderSrc, 'TAGLINE', 'render.js takes the tagline from the constant');
  // The breakpoint must be derived from the copy's own width. A hardcoded column
  // count is the same class of bug: it survives the copy change and starts
  // clipping silently, and `centered()` clips rather than wraps.
  has(
    screensSrc,
    'cols >= w(TAGLINE) + 4',
    'the narrow/wide breakpoint is derived from the tagline width, not hardcoded',
  );
}

// ── restorePrefs: the second-launch path ────────────────────────────────────
//
// A first launch has no config, so this branch never runs and nothing looks
// wrong. It is only reached on the *second* launch, which is exactly how a
// wrong-module read (`screens.THEME_TABLE` instead of `theme.THEME_TABLE`)
// shipped as a startup crash that the first-run test could not see.
{
  const { createApp } = require(join(cliDir, 'src', 'app.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-prefs-'));
  const prevHome = process.env.AEGISCODE_HOME;
  process.env.AEGISCODE_HOME = dir;
  try {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ themeIndex: 4, light: true, model: 'pinned-model', effort: 'low', vim: true })
    );

    const app = createApp({});
    app.restorePrefs();
    eq(app.ctx.themeIndex, 4, 'restorePrefs restores the stored theme row');
    eq(app.ctx.light, true, 'and its light flag');
    eq(app.ctx.model, 'pinned-model', 'and the pinned model');
    eq(app.ctx.effort, 'low', 'and the effort level');
    eq(app.ctx.vim, true, 'and vim mode');
    // The whole point of the row: the colourblind palette must be selected, not
    // merely the label remembered.
    eq(theme.themeOf(app.ctx), theme.CB_LIGHT, 'and the stored row picks the real palette');

    // An explicit CLI flag outranks the stored value.
    const flagged = createApp({ model: 'flag-model', light: false });
    flagged.restorePrefs();
    eq(flagged.ctx.model, 'flag-model', 'an explicit -m outranks the stored model');

    // A programmatic (injected-readline) caller gets a deterministic context.
    const embedded = createApp({ readline: {} });
    embedded.restorePrefs();
    eq(embedded.ctx.model, null, 'an embedded readline is not given stored preferences');

    // No config → no opinion. Defaults must not be applied as if chosen.
    fs.rmSync(path.join(dir, 'config.json'));
    const fresh = createApp({});
    fresh.restorePrefs();
    eq(fresh.ctx.model, null, 'a fresh install is not pinned to a default model');
  } finally {
    process.env.AEGISCODE_HOME = prevHome;
  }
}

console.log('cli-onboarding: all assertions passed');
