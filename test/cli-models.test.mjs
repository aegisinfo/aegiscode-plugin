#!/usr/bin/env node
/**
 * The AEGIS Cloud model catalog — the ids a user can pin.
 *
 * This host runs on the pool, so the pinnable ids are the *server's*; the only
 * job here is to fetch and shape them. It shipped without that job done:
 * `commands.js` calls `c.loadModels()` inside a `try {} catch {}`, `c.loadModels`
 * was never defined on either command context, and `buildState()` hardcoded
 * `models: []` — so `/model` and the alt+p chord reported "no pinnable models
 * advertised" on a healthy account, always. The three assertions that catch it
 * are `loadModels` exists, the picker receives the catalog, and the default
 * config carries no phantom pin.
 *
 * Style matches the other CLI tests: createRequire, a local assert() that throws
 * `ASSERT FAILED: ...`, no test framework, no network (the client is injected).
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

// ── this file must not touch the developer's real ~/.aegiscode ───────────────
//
// The host now reads and writes persistent state in the data dir (session
// history, the saved credential, the sync ledger), and these tests drive real
// turns through the real dispatcher — so without this each run appended the
// test's own exchanges to the developer's live session history.
const __testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-models-'));
process.env.AEGISCODE_HOME = __testHome;
process.on('exit', () => { try { fs.rmSync(__testHome, { recursive: true, force: true }); } catch {} });

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');

const models = require(join(root, 'cli', 'src', 'models.js'));
const deps = require(join(root, 'cli', 'src', 'deps.js'));
const { createApp } = require(join(root, 'cli', 'src', 'app.js'));
const { updateConfig } = require(join(root, 'cli', 'src', 'config.js'));

// The live `/api/v1/models` payload, fetched 2026-09-14 (aegiscloud.org, 200):
// per-provider ids plus the pooled-brain tiers, each non-canonical tier marked
// hidden + alias_of exactly as the server sends it.
const LIVE_CATALOG = [
  { id: 'anthropic', capabilities: ['chat'] },
  { id: 'anthropic-haiku', capabilities: ['chat'] },
  { id: 'deepseek', capabilities: ['chat', 'reasoning'] },
  { id: 'grok', capabilities: ['chat'] },
  { id: 'openai', capabilities: ['chat'] },
  { id: 'openai-gpt4o-mini', capabilities: ['chat'] },
  { id: 'nexus-brain', hidden: false },
  { id: 'aegis-brain', hidden: true, alias_of: 'nexus-brain' },
  { id: 'nexus-brain-smart', hidden: true, alias_of: 'nexus-brain' },
  { id: 'aegis-brain-smart', hidden: true, alias_of: 'nexus-brain' },
  { id: 'nexus-brain-neo', hidden: true, alias_of: 'nexus-brain' },
  { id: 'aegis-brain-neo', hidden: true, alias_of: 'nexus-brain' },
];

// ── 1. normalisation: the payload's own shape, nothing invented ─────────────
{
  const cat = models.normalizeModelCatalog({ models: LIVE_CATALOG });
  eq(cat.length, 12, 'every advertised id survives normalisation');
  assert(cat.every((m) => typeof m.id === 'string' && m.id), 'every entry has an id');
  assert(cat.every((m) => typeof m.label === 'string' && m.label.length), 'every entry has a display label');
  const brain = cat.find((m) => m.id === 'nexus-brain');
  eq(brain.aliasOf, null, 'the canonical brain tier is not an alias');
  // The note must state what pinning the tier COSTS — several billed provider
  // calls per turn, not one — but not a frozen worker count. That count is
  // sized per request (aegis1 estimate_workers clamps min(size-of-ask,
  // EFFORT_MAX_WORKERS[effort])), so "3 workers" was true only for a medium
  // rung on a medium ask, and pinning it in a label states a number the
  // endpoint can contradict. Assert the shape and its governor instead.
  assert(
    /fan-out/.test(brain.note) && /effort/.test(brain.note),
    `the brain tier's note states its cost shape — a multi-call fan-out sized by effort, never a frozen worker count (got ${JSON.stringify(brain.note)})`
  );
  const alias = cat.find((m) => m.id === 'aegis-brain');
  eq(alias.aliasOf, 'nexus-brain', 'an alias tier records what it aliases');
  assert(alias.note.includes('nexus-brain'), `the alias note names the canonical id (got ${JSON.stringify(alias.note)})`);
  eq(models.normalizeModelCatalog([]).length, 0, 'an empty payload yields an empty catalog');
  eq(models.normalizeModelCatalog(null).length, 0, 'a missing payload yields an empty catalog (never throws)');
  eq(models.normalizeModelCatalog([{ nope: 1 }, '', null, { id: '   ' }]).length, 0, 'junk entries are dropped, not rendered as blank rows');
  eq(models.normalizeModelCatalog(['plain-string'])[0].id, 'plain-string', 'a bare string id is accepted');
  eq(models.normalizeModelCatalog([{ id: 'a' }, { id: 'a' }]).length, 1, 'a duplicated id appears once');
}

// ── 2. the picker set: distinct models, aliases folded away ─────────────────
{
  const cat = models.normalizeModelCatalog({ models: LIVE_CATALOG });
  const sel = models.pickerEntries(cat);
  eq(sel.length, 7, 'the five alias spellings of the brain are folded into one entry');
  assert(!sel.some((m) => m.aliasOf), 'no alias duplicate is offered to the user');
  assert(sel.some((m) => m.id === 'nexus-brain'), 'the canonical brain tier is offered');
  for (const id of ['anthropic', 'deepseek', 'grok', 'openai', 'openai-gpt4o-mini', 'anthropic-haiku']) {
    assert(sel.some((m) => m.id === id), `provider id ${id} stays selectable (a CLI may pin a provider explicitly)`);
  }
  // A catalog that is nothing but aliases is still offered — an empty picker
  // tells the user there are no models when the server just named them oddly.
  const onlyAliases = models.normalizeModelCatalog({ models: [{ id: 'x', alias_of: 'y' }] });
  eq(models.pickerEntries(onlyAliases).length, 1, 'an alias-only catalog is offered rather than emptied');
  eq(models.pickerEntries([]).length, 0, 'no catalog, nothing to offer');
}

// ── 3. the catalog is reachable from the command context ────────────────────
//
// The regression: `/model` awaited `c.loadModels()`, which did not exist. The
// TypeError was swallowed by the wrapper's `catch {}`, so the command printed
// "nothing advertised" and returned — a healthy account, an empty picker.
function captureApp(client) {
  const written = [];
  const out = { isTTY: false, write: (s) => { written.push(s); return true; } };
  const app = createApp({
    client,
    tools: deps.createTools(client),
    out,
    err: { write: () => true },
    stream: true,
    width: () => 80,
  });
  return { app, text: () => stripAnsi(written.join('')), written };
}

function stubClient(catalog) {
  return {
    apiBase: 'https://aegiscloud.org',
    apiKey: 'aegis_test_key',
    listModels: async () => ({ models: catalog }),
  };
}

{
  const { app, text } = captureApp(stubClient(LIVE_CATALOG));
  const c = app.makeCommandContext();
  eq(typeof c.loadModels, 'function', '/model\'s c.loadModels() exists on the command context (it did not)');
  await c.loadModels();
  const state = app.buildState();
  assert(Array.isArray(state.models) && state.models.length === 7, `state().models carries the selectable catalog (got ${state.models.length})`);
  assert(state.models.some((m) => m.id === 'deepseek'), 'the catalog reached the command context');

  // End to end through the real dispatcher: `/model` must print the picker.
  await app.handleLine('/model');
  const t = text();
  assert(t.includes('Select model'), `\`/model\` opens the picker (got ${JSON.stringify(t.slice(0, 200))})`);
  assert(t.includes('nexus-brain'), '/model lists the pooled brain');
  assert(t.includes('deepseek'), '/model lists the provider ids');
  assert(!t.includes('aegis-brain-neo'), '/model does not list alias duplicates');
  assert(!t.includes('No pinnable models'), '/model no longer claims nothing is advertised');
}

// ── 4. /model <id> warns about an id the platform does not advertise ───────
//
// Verified live 2026-09-14: POSTing `{"model":"deepseek/…"}` returns HTTP 200
// with `"model": "deepseek"` — the pool substitutes its own default and reports
// no error, so a bad pin is a silent fallback (and the spend is attributed to
// the model that was pinned).
{
  const { app, text } = captureApp(stubClient(LIVE_CATALOG));
  await app.handleLine('/model provider/model-typo');
  const t = text();
  assert(t.includes('provider/model-typo'), 'the affected id is named');
  assert(/not in the AEGIS Cloud catalog/.test(t), `the mismatch is stated plainly (got ${JSON.stringify(t)})`);
  eq(app.ctx.model, 'provider/model-typo', 'the pin is still applied — the catalog warning never refuses a pin');

  const good = captureApp(stubClient(LIVE_CATALOG));
  await good.app.handleLine('/model deepseek');
  assert(!/not in the AEGIS Cloud catalog/.test(good.text()), 'a real catalog id draws no warning');
}

// ── 5. an unreachable catalog says why (key vs offline) ────────────────────
{
  const noKey = {
    apiBase: 'https://aegiscloud.org',
    apiKey: '',
    listModels: async () => { throw new Error('No API key'); },
  };
  const { app, text } = captureApp(noKey);
  await app.handleLine('/model');
  const t = text();
  assert(/API key/.test(t), `a keyless client is told the key is what is missing (got ${JSON.stringify(t)})`);
  assert(/aegiscloud\.org/.test(t), 'and where to get one');
  assert(!app.buildState().models.length, 'and the picker stays empty rather than inventing ids');
}

// ── 6. the default config carries no phantom model pin ─────────────────────
//
// `model: 'sonnet'` shipped as DEFAULT_CONFIG's model. Onboarding persists the
// merged config on first run, so every user who completed the trust check got
// `"model": "sonnet"` written to disk — and AEGIS Cloud does not advertise
// `sonnet` (the live catalog is anthropic, anthropic-haiku, deepseek, grok,
// openai, openai-gpt4o-mini, nexus-brain). The pool answered anyway, from its
// own default, so the pin looked honoured while a different model ran.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-models-'));
  const prevHome = process.env.AEGISCODE_HOME;
  process.env.AEGISCODE_HOME = dir;
  try {
    // Exactly what onboarding's save() does on a fresh install.
    updateConfig({ themeIndex: 1, light: false });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    eq(written.model, null, 'onboarding writes no model pin (model: null)');
    eq(written.currentModelId, null, 'and no mirrored currentModelId');

    // A pin the platform DOES advertise is kept, untouched.
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: 'deepseek', themeIndex: 1 }));
    const kept = captureApp(stubClient(LIVE_CATALOG));
    kept.app.restorePrefs();
    eq(kept.app.ctx.model, 'deepseek', 'a stored pin is restored');
    eq(await kept.app.validatePinnedModel(), null, 'a real catalog id is not cleared');
    eq(kept.app.ctx.model, 'deepseek', 'and it survives validation');

    // A stored phantom (the shipped default, and the `provider/model` spelling
    // a user types by hand) is cleared, persisted, and reported.
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: 'sonnet', themeIndex: 1 }));
    const { app, text } = captureApp(stubClient(LIVE_CATALOG));
    app.restorePrefs();
    eq(app.ctx.model, 'sonnet', 'the stored phantom is restored first (so the user is told about it)');
    eq(await app.validatePinnedModel(), 'sonnet', 'validatePinnedModel reports the id it cleared');
    eq(app.ctx.model, null, 'the phantom pin is cleared');
    assert(/not advertised by AEGIS Cloud/.test(text()), `and the user is told why (got ${JSON.stringify(text())})`);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    eq(after.model, null, 'the clear is persisted, so it does not come back next launch');
    eq(after.currentModelId, null, 'including the mirrored field');

    // Offline: a catalog that cannot be read clears nothing (a transient
    // failure must not silently drop a user's pin).
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: 'sonnet', themeIndex: 1 }));
    const offline = captureApp({
      apiBase: 'https://aegiscloud.org',
      apiKey: 'aegis_test_key',
      listModels: async () => { throw new Error('offline'); },
    });
    offline.app.restorePrefs();
    eq(await offline.app.validatePinnedModel(), null, 'an unreadable catalog validates nothing');
    eq(offline.app.ctx.model, 'sonnet', 'and leaves the pin alone');
  } finally {
    if (prevHome === undefined) delete process.env.AEGISCODE_HOME;
    else process.env.AEGISCODE_HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('cli-models: all assertions passed');
