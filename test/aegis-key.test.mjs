#!/usr/bin/env node
/**
 * Regression tests for the AEGIS-key wiring review (4 defects):
 *
 *   1. the in-app AEGIS key must live in a reserved namespace, never as a
 *      provider entry the Settings pane can list or remove;
 *   2. engine listClasses() must report custom endpoints as configured:false
 *      until they actually have a base URL (and, for anthropic, a key);
 *   3. providers.anthropicMessages() must omit x-api-key when no key is set;
 *   4. listModels('byok') must return relay model ids, never keyed *provider*
 *      names masquerading as model ids.
 *
 * Also asserts the AEGIS key auth path by class: 'aegis'/'byok' use
 * aegis.apiKey, 'ollama' is keyless, and the direct BYOK classes use their own
 * settings-stored key + base URL — the AEGIS key never leaks into them.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  createSettingsStore,
  AEGIS_KEY_NAMESPACE,
  LEGACY_AEGIS_NAMESPACE,
  isReservedNamespace,
} = require('../desktop/lib/settings.js');
const { createLocalEngine } = require('../desktop/lib/local/engine.js');
const { anthropicMessages } = require('../desktop/lib/local/providers.js');
const { createModelDispatch } = require('../desktop/main.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// Runtime-built secrets so the repo secret scanners stay quiet.
const AEGIS_KEY = `aegis_${'x'.repeat(24)}`;
const PROVIDER_KEY = `sk-${'p'.repeat(24)}`;
const tmp = (n) => mkdtempSync(join(tmpdir(), `aegis-key-${n}-`));

// ---------------------------------------------------------------- defect #1
{
  const dir = tmp('store');
  const store = createSettingsStore({ dir });

  assert(isReservedNamespace(AEGIS_KEY_NAMESPACE), 'AEGIS namespace is reserved');

  store.setAegisKey(AEGIS_KEY);
  store.set('openai-compat', { baseURL: 'https://api.example.com', key: PROVIDER_KEY });

  const list = store.list();
  assert(list.length === 1, `list() shows provider configs only, got ${list.length}`);
  assert(
    !list.some((s) => s.provider === AEGIS_KEY_NAMESPACE),
    'the AEGIS key namespace must never appear in settings.list()'
  );
  assert(!JSON.stringify(list).includes(AEGIS_KEY), 'the AEGIS key never serialises into list()');
  assert(store.aegisKey().configured === true, 'aegisKey() reports the key is set');
  assert(store.aegisRawKey() === AEGIS_KEY, 'aegisRawKey() is the main-process accessor');

  // The provider CRUD surface refuses the reserved namespace outright…
  for (const fn of ['set', 'remove']) {
    let threw = false;
    try {
      if (fn === 'set') store.set(AEGIS_KEY_NAMESPACE, { key: '' });
      else store.remove(AEGIS_KEY_NAMESPACE);
    } catch {
      threw = true;
    }
    assert(threw, `settings.${fn}() must refuse the reserved AEGIS namespace`);
  }
  // …and the legacy 'aegis' pseudo-provider is equally unusable.
  let legacyThrew = false;
  try {
    store.remove(LEGACY_AEGIS_NAMESPACE);
  } catch {
    legacyThrew = true;
  }
  assert(legacyThrew, "settings.remove('aegis') must refuse the legacy namespace");
  assert(store.aegisRawKey() === AEGIS_KEY, 'the AEGIS key survives every remove attempt');

  // Raw key still only readable through the AEGIS accessor.
  assert(store.rawKey('openai-compat') === PROVIDER_KEY, 'provider rawKey unchanged');
}

// --------------------------------------------- defect #1, through the IPC too
{
  const dir = tmp('ipc');
  const store = createSettingsStore({ dir });
  store.setAegisKey(AEGIS_KEY);
  store.set('openai-compat', { baseURL: 'https://api.example.com', key: PROVIDER_KEY });

  const stub = () => ({ model: 'm', choices: [{ message: { content: '' } }] });
  const engine = createLocalEngine({
    aegis: { apiKey: AEGIS_KEY, listModels: async () => ({ models: [] }), byokStatus: async () => ({}), chatCompletion: stub },
    settings: store,
    ollama: { probe: async () => ({ running: false }), listTags: async () => [], chat: stub },
    providers: { openaiCompatible: stub, anthropicMessages: stub },
  });
  const dispatch = createModelDispatch(engine);

  const rows = await dispatch['settings.get']();
  assert(
    rows.every((r) => r.provider !== AEGIS_KEY_NAMESPACE && !isReservedNamespace(r.provider)),
    'model:settings.get must not expose a removable AEGIS entry'
  );
  assert(!JSON.stringify(rows).includes(AEGIS_KEY), 'no AEGIS key over the model: IPC');

  // Even a hand-crafted IPC call naming the reserved namespace cannot delete it.
  let rejected = false;
  try {
    await dispatch['settings.remove']({ provider: AEGIS_KEY_NAMESPACE });
  } catch {
    rejected = true;
  }
  assert(rejected, 'model:settings.remove cannot delete the AEGIS key');
  assert(store.aegisRawKey() === AEGIS_KEY, 'AEGIS key intact after IPC remove attempt');
}

// --------------------------------------------- legacy key migration on boot
{
  const dir = tmp('legacy');
  const legacyStore = createSettingsStore({ dir });
  // Write the pre-fix shape directly (what settings.set('aegis', …) produced).
  legacyStore.setAegisKey(AEGIS_KEY);
  const file = legacyStore.file;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data[LEGACY_AEGIS_NAMESPACE] = data[AEGIS_KEY_NAMESPACE];
  delete data[AEGIS_KEY_NAMESPACE];
  writeFileSync(file, JSON.stringify(data));

  const store = createSettingsStore({ dir });
  assert(
    !store.list().some((s) => s.provider === LEGACY_AEGIS_NAMESPACE),
    "a pre-fix 'aegis' entry is hidden from list() even before migration"
  );
  const res = store.migrateLegacyAegisKey();
  assert(res.migrated === true, 'legacy AEGIS key migrated');
  assert(store.aegisRawKey() === AEGIS_KEY, 'migrated key is readable at the reserved namespace');
  assert(store.migrateLegacyAegisKey().migrated === false, 'migration is idempotent');
}

// ---------------------------------------------------------------- defect #2
{
  const dir = tmp('classes');
  const settings = createSettingsStore({ dir });
  const makeEngine = () =>
    createLocalEngine({
      aegis: { apiKey: '', listModels: async () => ({ models: [] }), byokStatus: async () => ({}) },
      settings,
      ollama: { probe: async () => ({ running: false }), listTags: async () => [] },
      providers: {},
    });

  const byClass = async (engine) => {
    const out = {};
    for (const c of await engine.listClasses()) out[c.class] = c;
    return out;
  };

  // Unconfigured custom endpoints are NOT ready (the `undefined/v1/...` bug).
  let cls = await byClass(makeEngine());
  assert(cls['openai-compat'].configured === false, 'unset openai-compat is not configured');
  assert(cls.anthropic.configured === false, 'unset anthropic is not configured');
  assert(cls.aegis.configured === false, 'aegis without a key is not configured');
  assert(cls.byok.configured === false, 'byok without a key is not configured');
  assert(cls.ollama.configured === false, 'ollama reports the probe result');

  // A base URL alone makes an OpenAI-compatible endpoint usable…
  settings.set('openai-compat', { baseURL: 'https://api.example.com' });
  settings.set('anthropic', { baseURL: 'https://api.example.com' });
  cls = await byClass(makeEngine());
  assert(cls['openai-compat'].configured === true, 'openai-compat with a base URL is configured');
  assert(cls['openai-compat'].baseURL === 'https://api.example.com', 'base URL surfaced');
  assert(cls.anthropic.configured === false, 'anthropic still needs its own key');

  // …while Anthropic needs base URL + key.
  settings.set('anthropic', { key: PROVIDER_KEY });
  cls = await byClass(makeEngine());
  assert(cls.anthropic.configured === true, 'anthropic configured with base URL + key');
  assert(cls.anthropic.keyMask && cls.anthropic.keyMask !== PROVIDER_KEY, 'only a masked preview');

  // A whitespace base URL is not a base URL.
  settings.set('openai-compat', { baseURL: '   ' });
  cls = await byClass(makeEngine());
  assert(cls['openai-compat'].configured === false, 'blank base URL is unconfigured');
}

// ---------------------------------------------------------------- defect #3
{
  let lastFetch = null;
  globalThis.fetch = async (url, opts) => {
    lastFetch = { url, opts };
    return new Response(
      'data: {"type":"message_start","message":{"model":"claude-x"}}\n\n' +
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n' +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  };

  await anthropicMessages({
    baseURL: 'https://proxy.example.com',
    model: 'claude-x',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert(
    !('x-api-key' in lastFetch.opts.headers),
    'no key configured → x-api-key header omitted entirely (not sent blank)'
  );
  assert(
    lastFetch.opts.headers['anthropic-version'] === '2023-06-01',
    'version header still present'
  );

  await anthropicMessages({
    baseURL: 'https://proxy.example.com',
    apiKey: PROVIDER_KEY,
    model: 'claude-x',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert(lastFetch.opts.headers['x-api-key'] === PROVIDER_KEY, 'x-api-key sent when set');
}

// ---------------------------------------------------------------- defect #4
{
  const settings = createSettingsStore({ dir: tmp('byok') });
  const aegisCalls = [];
  const engine = createLocalEngine({
    aegis: {
      apiKey: AEGIS_KEY,
      async byokStatus() {
        return { keys: { openai: { set: true, masked: 'sk-…abcd' }, anthropic: { set: false } } };
      },
      async listModels() {
        aegisCalls.push('listModels');
        return {
          models: [
            { id: 'gpt-4o', provider: 'openai' },
            { id: 'claude-3-5-sonnet', provider: 'anthropic' },
            { id: 'deepseek-v4-pro' },
          ],
        };
      },
    },
    settings,
    ollama: { probe: async () => ({ running: false }), listTags: async () => [] },
    providers: {},
  });

  const data = await engine.listModels('byok');
  assert(aegisCalls.length === 1, 'BYOK models come from the relay model list');
  const ids = data.models.map((m) => m.id);
  assert(ids.includes('gpt-4o'), 'keyed provider models are listed by model id');
  assert(ids.includes('deepseek-v4-pro'), 'untagged relay models are kept');
  assert(!ids.includes('anthropic'), 'an *unkeyed* provider is never offered as a model');
  assert(!ids.includes('openai'), 'a keyed provider name is never offered as a model id');
  assert(
    JSON.stringify(data.providers) === JSON.stringify(['openai']),
    'keyed provider names are reported separately, for labelling'
  );

  // No stored keys → nothing usable, and the names still are not models.
  const noKeys = createLocalEngine({
    aegis: {
      apiKey: AEGIS_KEY,
      byokStatus: async () => ({ keys: {} }),
      listModels: async () => ({ models: [{ id: 'gpt-4o', provider: 'openai' }] }),
    },
    settings,
    ollama: { probe: async () => ({ running: false }), listTags: async () => [] },
    providers: {},
  });
  const empty = await noKeys.listModels('byok');
  assert(empty.models.length === 0 && empty.providers.length === 0, 'no BYOK keys → no models');
}

// ------------------------------------------- AEGIS key auth path by class
{
  const settings = createSettingsStore({ dir: tmp('auth') });
  settings.set('openai-compat', { baseURL: 'https://direct.example.com', key: PROVIDER_KEY });
  settings.set('anthropic', { baseURL: 'https://direct.example.com', key: PROVIDER_KEY });
  settings.setAegisKey(AEGIS_KEY);

  const seen = [];
  const engine = createLocalEngine({
    aegis: {
      apiKey: AEGIS_KEY,
      async listModels() {
        return { models: [] };
      },
      async byokStatus() {
        return {};
      },
      async chatCompletion(args) {
        seen.push(['chatCompletion', args]);
        return { model: args.model, choices: [{ message: { content: '' } }] };
      },
      // 'byok' must never reach this: it is the stateless, unauthenticated
      // /api/v1/byok/chat/completions relay, which needs a per-request
      // providerKey the desktop never has — the desktop's 'byok' class shares
      // aegis.chatCompletion() instead, relying on the server folding in the
      // user's own saved key (services/byok_service.get_user_key_map).
      async byokChatCompletion(args) {
        seen.push(['byokChatCompletion-stateless-relay', args]);
        return { model: args.model, choices: [{ message: { content: '' } }] };
      },
    },
    settings,
    ollama: {
      async probe() {
        return { running: true };
      },
      async listTags() {
        return [];
      },
      async chat(args) {
        seen.push(['ollama', args]);
        return { model: args.model, choices: [{ message: { content: '' } }] };
      },
    },
    providers: {
      async openaiCompatible(args) {
        seen.push(['openai-compat', args]);
        return { model: args.model, choices: [{ message: { content: '' } }] };
      },
      async anthropicMessages(args) {
        seen.push(['anthropic', args]);
        return { model: args.model, choices: [{ message: { content: '' } }] };
      },
    },
  });

  await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm' }, () => {});
  await engine.chat({ class: 'byok', prompt: 'hi', model: 'gpt-4o' }, () => {});
  await engine.chat({ class: 'ollama', prompt: 'hi', model: 'llama3' }, () => {});

  const chatCompletionCalls = seen.filter(([k]) => k === 'chatCompletion');
  assert(
    chatCompletionCalls.length === 2,
    `both 'aegis' and 'byok' route through the shared AEGIS-authenticated chatCompletion, got ${chatCompletionCalls.length}`
  );
  assert(
    !seen.some(([k]) => k === 'byokChatCompletion-stateless-relay'),
    'byok must never hit the stateless unauthenticated relay (it has no providerKey to send)'
  );
  const byName = Object.fromEntries(seen);
  assert(byName.ollama && !('apiKey' in byName.ollama), 'ollama is keyless');
  assert(
    !JSON.stringify([byName.ollama]).includes(AEGIS_KEY),
    'the AEGIS key never reaches the local ollama transport'
  );

  if (!byName['openai-compat'] || !byName.anthropic) {
    const direct = createLocalEngine({
      aegis: { apiKey: AEGIS_KEY },
      settings,
      ollama: { probe: async () => ({ running: true }), listTags: async () => [] },
      providers: {
        async openaiCompatible(args) {
          seen.push(['openai-compat', args]);
          return { model: args.model, choices: [{ message: { content: '' } }] };
        },
        async anthropicMessages(args) {
          seen.push(['anthropic', args]);
          return { model: args.model, choices: [{ message: { content: '' } }] };
        },
      },
    });
    await direct.chat({ class: 'openai-compat', prompt: 'hi', model: 'x' }, () => {});
    await direct.chat({ class: 'anthropic', prompt: 'hi', model: 'x' }, () => {});
  }

  const direct = seen.find((s) => s[0] === 'openai-compat')[1];
  assert(direct.apiKey === PROVIDER_KEY, 'custom OpenAI endpoint uses its own key');
  assert(direct.baseURL === 'https://direct.example.com', 'custom OpenAI endpoint uses its own base URL');
  assert(direct.apiKey !== AEGIS_KEY, 'the AEGIS key is never used for a custom endpoint');
  const anthropicCall = seen.find((s) => s[0] === 'anthropic')[1];
  assert(anthropicCall.apiKey === PROVIDER_KEY, 'anthropic class uses its own key');
  assert(anthropicCall.apiKey !== AEGIS_KEY, 'the AEGIS key is never used for anthropic');
}

console.log('aegis-key tests passed');
