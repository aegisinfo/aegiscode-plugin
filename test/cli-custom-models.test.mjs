#!/usr/bin/env node
/**
 * The named custom-model catalog — the `custom` class the CLI grew next to
 * BYOK, i.e. the aegiscodex-dev `/model add <id> <name> <model> <baseURL>
 * [apiKey]` concept ported into this host.
 *
 * What this file exists to pin, in order of how expensive each one is to get
 * wrong:
 *
 *  1. A custom turn reaches the DIRECT transport. The CLI used to inject a
 *     throwing stub as `providers.openaiCompatible`/`anthropicMessages`
 *     ("unsupported in this build"), so the class could not have worked at all;
 *     the engine now injects the desktop's real module. The engine assertion
 *     below drives a real turn and asserts on the wire request, so it fails on
 *     that stub rather than on a shape.
 *  2. It reaches the USER'S endpoint, not ours. Both the hosted route concerns
 *     this lane has to be free of are asserted negatively: the aegis client is
 *     never called (no pooled route => no margin) and the URL is the entry's
 *     base URL (never aegiscloud.org => no handling fee).
 *  3. The key is stored where secrets belong. `config.json` is not 0600 and
 *     participates in cloud sync, so `customModels` must carry metadata only —
 *     the key goes to the settings store under `custom:<id>`. Asserted by
 *     reading the config file off disk after an add, the same way the
 *     shared-key tests do.
 *
 * Style matches the other CLI tests: createRequire, a local assert() that
 * throws `ASSERT FAILED: ...`, no test framework. The only network is stubbed
 * global fetch (there is none), and the real ~/.aegiscode is never touched.
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
// The catalog reads/writes config.json and the 0600 key store, and the engine
// assertion below runs a real turn (which appends session state), so redirect
// the data dir before anything is required.
const __testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-custom-'));
process.env.AEGISCODE_HOME = __testHome;
process.on('exit', () => { try { fs.rmSync(__testHome, { recursive: true, force: true }); } catch {} });

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const custom = require(join(root, 'cli', 'src', 'custommodels.js'));
const { loadConfig } = require(join(root, 'cli', 'src', 'config.js'));
const { createSettingsStore } = require(join(root, 'cli', 'src', 'deps.js'));
const { createEngine, HOST_CLASSES } = require(join(root, 'cli', 'src', 'engine.js'));

const settings = createSettingsStore({ dir: __testHome });

// Runtime-built key so the CI secret scanner stays quiet — never a literal.
const KEY = `sk-${'y'.repeat(24)}`;

// ---- the class is offered, so /class custom cannot be refused --------------
assert(HOST_CLASSES.includes('custom'), 'custom is a host class (a class the CLI can actually run)');

// ---- wire inference: the one thing that cannot be guessed at call time -----
{
  // Anthropic's Messages API is a different wire (x-api-key, /v1/messages, a
  // top-level system field), so it is recognised from the host; everything else
  // — OpenAI, Groq, DeepSeek, together, openrouter, a local llama.cpp — speaks
  // the OpenAI shape.
  eq(custom.inferWire('https://api.anthropic.com'), 'anthropic', 'anthropic.com infers the Messages API');
  eq(custom.inferWire('https://api.anthropic.com/v1'), 'anthropic', 'a path does not change the inference');
  eq(custom.inferWire('https://API.ANTHROPIC.COM'), 'anthropic', 'and the host match is case-insensitive');
  eq(custom.inferWire('https://api.openai.com/v1'), 'openai', 'OpenAI infers the OpenAI-compatible wire');
  eq(custom.inferWire('https://notanthropic.com'), 'openai', 'a look-alike domain is NOT anthropic');
  eq(custom.inferWire('http://127.0.0.1:8080/v1'), 'openai', 'a local endpoint infers OpenAI-compatible');
  eq(custom.inferWire(''), 'openai', 'and an unparseable URL never infers anthropic');
}

// ---- validation: every refusal is a one-line reason, never a throw ---------
{
  const bad = [
    [{}, /id is required/],
    [{ id: 'a b', model: 'm', baseURL: 'https://x.test' }, /no spaces/],
    [{ id: 'a:b', model: 'm', baseURL: 'https://x.test' }, /":" is the byok separator/],
    [{ id: 'ok', baseURL: 'https://x.test' }, /model string is required/],
    [{ id: 'ok', model: 'm' }, /must start with http/],
    [{ id: 'ok', model: 'm', baseURL: 'x.test' }, /must start with http/],
    [{ id: 'ok', model: 'm', baseURL: 'https://x.test', wire: 'grpc' }, /wire must be one of/],
  ];
  for (const [fields, re] of bad) {
    const res = custom.normalizeEntry(fields);
    assert(res.error && re.test(res.error), `refused: ${JSON.stringify(fields)} (got ${JSON.stringify(res)})`);
    assert(!res.entry, 'a refused entry is never also returned');
  }

  // The id rule is load-bearing rather than cosmetic: a ":" id would collide
  // with the `provider:model` shape byok parses, and a whitespace id could not
  // be typed back into `/model <id>`.
  const ok = custom.normalizeEntry({ id: 'local', model: 'qwen3:32b', baseURL: 'http://127.0.0.1:8080/v1' });
  eq(ok.entry.id, 'local', 'a clean id is kept');
  eq(ok.entry.name, 'local', 'and the name falls back to the id');
  eq(ok.entry.wire, 'openai', 'with the wire inferred');
  const named = custom.normalizeEntry({ id: 'z', name: ' Z.ai ', model: ' glm-4 ', baseURL: ' https://api.z.ai/v1 ' });
  eq(named.entry.name, 'Z.ai', 'a given name is trimmed and kept');
  eq(named.entry.model, 'glm-4', 'the model string is trimmed');
  eq(named.entry.baseURL, 'https://api.z.ai/v1', 'and so is the base URL');
  eq(custom.normalizeEntry({ id: 'a', model: 'claude-sonnet-5', baseURL: 'https://api.anthropic.com', wire: 'OPENAI' }).entry.wire,
    'openai', 'a stated wire wins over inference, and is lower-cased');
}

// ---- add / replace / remove, and the split storage --------------------------
{
  const added = custom.addCustom({ id: 'zai', name: 'Z.ai', model: 'glm-4', baseURL: 'https://api.z.ai/v1', key: KEY }, settings);
  assert(added.entry, `the entry is added (got ${JSON.stringify(added)})`);

  const rows = custom.listCustomModels(settings);
  eq(rows.length, 1, 'the catalog lists one row');
  eq(rows[0].id, 'zai', 'under the id given');
  eq(rows[0].label, 'Z.ai', 'labelled with the name');
  eq(rows[0].configured, true, 'and marked configured once a key is stored');
  assert(/glm-4/.test(rows[0].note) && /api\.z\.ai/.test(rows[0].note), `the note names the model and host (got ${rows[0].note})`);

  // config.json is NOT 0600 and participates in cloud sync, so the key must not
  // be in it. Read the file the store actually wrote, not the in-memory copy.
  const raw = JSON.parse(fs.readFileSync(path.join(__testHome, 'config.json'), 'utf8'));
  eq(raw.customModels.length, 1, 'config.json carries the catalog metadata');
  const serialised = JSON.stringify(raw);
  assert(!serialised.includes(KEY), 'and NEVER the API key');
  eq(raw.customModels[0].key, undefined, 'the entry has no key field at all');
  eq(settings.rawKey(custom.customNamespace('zai')), KEY, 'the key lives in the settings store under custom:<id>');

  // Re-adding an id REPLACES rather than appending: /model add doubles as the
  // edit path, so fixing a typo'd base URL must not leave a dead second row.
  custom.addCustom({ id: 'zai', name: 'Z.ai', model: 'glm-4.6', baseURL: 'https://api.z.ai/v1' }, settings);
  const replaced = custom.listCustomModels(settings);
  eq(replaced.length, 1, 're-adding the same id does not duplicate it');
  eq(custom.getCustom('zai').model, 'glm-4.6', 'and the metadata is the new one');
  eq(settings.rawKey(custom.customNamespace('zai')), KEY, 'a re-add with no key given leaves the stored key alone');

  // A second entry, so removal has to be selective.
  custom.addCustom({ id: 'local', model: 'qwen3:32b', baseURL: 'http://127.0.0.1:8080/v1' }, settings);
  eq(custom.listCustomModels(settings).length, 2, 'two entries coexist');
  eq(custom.hasKey(settings, 'local'), false, 'a keyless entry reports itself unconfigured');

  eq(custom.removeCustom('zai', settings).removed, true, 'remove reports what it did');
  eq(custom.listCustomModels(settings).map((r) => r.id).join(','), 'local', 'and drops exactly that entry');
  eq(settings.rawKey(custom.customNamespace('zai')), null, 'forgetting the entry forgets its key too');
  eq(custom.removeCustom('nope', settings).removed, false, 'removing an unknown id reports nothing removed');

  // /model key can set and clear a key without touching the metadata.
  custom.setCustomKey('local', KEY, settings);
  eq(custom.hasKey(settings, 'local'), true, 'a key can be added after the fact');
  custom.setCustomKey('local', null, settings);
  eq(custom.hasKey(settings, 'local'), false, 'and cleared again');
}

// ---- resolveCustom: the catalog entry becomes a dispatch -------------------
{
  custom.addCustom({ id: 'claude-direct', model: 'claude-sonnet-5', baseURL: 'https://api.anthropic.com', key: KEY }, settings);
  const a = custom.resolveCustom('claude-direct', settings);
  eq(a.wireClass, 'anthropic', 'an anthropic-wire entry maps to the anthropic transport class');
  eq(a.baseURL, 'https://api.anthropic.com', 'the base URL is the entry\'s');
  eq(a.model, 'claude-sonnet-5', 'and so is the model string');
  eq(a.key, KEY, 'with the key read live from the store');
  eq(custom.resolveCustom('does-not-exist', settings), null, 'an unknown id resolves to null (the caller refuses loudly)');

  custom.addCustom({ id: 'zai', model: 'glm-4', baseURL: 'https://api.z.ai/v1' }, settings);
  eq(custom.resolveCustom('zai', settings).wireClass, 'openai-compat', 'an openai-wire entry maps to the openai-compat class');
  eq(custom.resolveCustom('zai', settings).key, null, 'and a keyless entry resolves with no key');
}

// ---- the end-to-end claim: a custom turn is called DIRECTLY ----------------
//
// The two things this lane exists for are negatives — no pooled route (no
// margin) and no aegiscloud.org (no handling fee) — so both are asserted as
// such: the aegis client must not be touched, and the URL must be the entry's.
// On the code before this work the transport was a throwing stub, so the turn
// could not complete at all: this block is what fails first on a regression.
{
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: (opts && opts.headers) || {}, body: opts && opts.body ? String(opts.body) : '' });
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello from your own endpoint' } }] })}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    let pooledCalls = 0;
    const client = {
      apiKey: 'aegis_test_key',
      async chatCompletion() { pooledCalls += 1; throw new Error('the pooled route must not be used on the custom class'); },
      async listModels() { pooledCalls += 1; return []; },
    };

    custom.addCustom({ id: 'mine', name: 'Mine', model: 'glm-4.6', baseURL: 'https://api.z.ai/v1', key: KEY }, settings);
    const engine = createEngine({ client, getClass: () => 'custom', settings });

    const classes = await engine.listClasses();
    const customClass = classes.find((c) => c.class === 'custom');
    assert(customClass, 'listClasses offers the custom class');
    eq(customClass.configured, true, 'and reports it configured when the catalog is not empty');

    const listed = engine.listModels('custom');
    const rows = listed && listed.models ? listed.models : listed;
    eq(rows.length >= 1, true, 'listModels(custom) enumerates the catalog so the picker can show it');
    assert(rows.some((r) => r.id === 'mine'), 'including the entry just added');

    await engine.chat({ model: 'mine', prompt: 'hi' }, () => {});

    eq(seen.length, 1, 'the turn made exactly one provider request');
    // The entry's base URL was stored versioned ("…/v1") and the transport
    // normalises to exactly one version segment — so a user who types the base
    // URL with or without /v1 gets the same, working request rather than the
    // `/v1/v1/chat/completions` a naive join would build.
    eq(seen[0].url, 'https://api.z.ai/v1/chat/completions', 'it went to the entry\'s base URL (never aegiscloud.org)');
    assert(!/aegiscloud\.org/.test(seen[0].url), 'and never to ours — no handling fee on this lane');
    eq(seen[0].headers.Authorization, `Bearer ${KEY}`, 'authenticated with the stored key');
    eq(seen[0].headers['x-api-key'], undefined, 'on the OpenAI wire, not the Anthropic one');
    assert(seen[0].body.includes('glm-4.6'), `the entry's model string is what goes on the wire (got ${seen[0].body})`);
    assert(!seen[0].body.includes('mine'), 'the catalog id is a local alias and is not sent upstream');
    eq(pooledCalls, 0, 'and the pooled route was never touched — so there is no margin on this lane');

    // A pin that is not in the catalog is refused in-process with a reason,
    // rather than shipping `model: undefined` to the user's endpoint.
    let refused = null;
    try { await engine.chat({ model: 'ghost', prompt: 'hi' }, () => {}); } catch (e) { refused = e; }
    assert(refused, 'a turn pinned to an unknown custom id is refused');
    assert(/\/model add/.test(refused.message), `and the message says how to fix it (got ${refused.message})`);
    eq(seen.length, 1, 'nothing reached the wire');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---- an anthropic-wire entry needs a key, and says so ----------------------
// The Messages API rejects a keyless request, so the failure is stated here in
// the host's words instead of surfacing as a 401 from the provider.
{
  custom.addCustom({ id: 'no-key-claude', model: 'claude-sonnet-5', baseURL: 'https://api.anthropic.com' }, settings);
  const client = { apiKey: 'aegis_test_key', async chatCompletion() { throw new Error('unused'); } };
  const engine = createEngine({ client, getClass: () => 'custom', settings });
  let refused = null;
  try { await engine.chat({ model: 'no-key-claude', prompt: 'hi' }, () => {}); } catch (e) { refused = e; }
  assert(refused, 'a keyless anthropic-wire custom model is refused');
  assert(/\/model key no-key-claude/.test(refused.message), `and the message names the exact fix (got ${refused.message})`);
}

// The catalog survives a reload (it is config.json, not session state).
assert(loadConfig().customModels.length >= 3, 'every entry added above is persisted to config.json');

console.log('cli custom-models: all assertions passed');
