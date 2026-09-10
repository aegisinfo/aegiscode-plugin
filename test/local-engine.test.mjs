#!/usr/bin/env node
/** Unit tests for desktop/lib/local/engine.js (plan P1 §5.2). */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLocalEngine } = require('../desktop/lib/local/engine.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const calls = [];
const aegis = {
  apiKey: 'k',
  async listModels() {
    return { models: [{ id: 'openai' }] };
  },
  async byokStatus() {
    return { keys: { openai: true } };
  },
  async chatCompletion(args) {
    calls.push(['chatCompletion', args]);
    if (args.onStream) args.onStream({ delta: 'hi' });
    return { model: args.model, choices: [{ message: { content: 'hi' } }] };
  },
  async byokChatCompletion(args) {
    calls.push(['byok', args]);
    return { model: args.model, choices: [{ message: { content: 'hi' } }] };
  },
};

const settings = {
  get: () => ({ baseURL: 'http://local', configured: true, keyMask: 'sk-…' }),
  rawKey: () => 'raw-key',
};

const ollama = {
  async probe() {
    return { running: true };
  },
  async listTags() {
    return [{ id: 'llama3' }];
  },
  async chat(args) {
    calls.push(['ollama', args]);
    return { model: args.model, choices: [{ message: { content: 'hi' } }] };
  },
};

const providers = {
  async openaiCompatible(args) {
    calls.push(['openai', args]);
    return { model: args.model, choices: [{ message: { content: 'hi' } }] };
  },
  async anthropicMessages(args) {
    calls.push(['anthropic', args]);
    return { model: args.model, choices: [{ message: { content: 'hi' } }] };
  },
};

const engine = createLocalEngine({ aegis, settings, ollama, providers });

// listClasses exposes all five classes with live ollama probe state
const classes = await engine.listClasses();
assert(classes.length === 5, `expected 5 classes, got ${classes.length}`);
const names = classes.map((c) => c.class);
for (const n of ['aegis', 'byok', 'ollama', 'openai-compat', 'anthropic']) {
  assert(names.includes(n), `missing class ${n}`);
}
assert(classes.find((c) => c.class === 'ollama').configured === true, 'ollama configured');

// listModels per class
assert((await engine.listModels('aegis')).models[0].id === 'openai', 'aegis models');
assert((await engine.listModels('ollama')).models[0].id === 'llama3', 'ollama models');

// BYOK models come from the relay's model catalog, *not* from keyed provider
// names — surfacing the latter as ids put provider names in the picker
// (defect #4). Keyed providers are reported separately for labelling.
const byok = await engine.listModels('byok');
assert(byok.models[0].id === 'openai', `byok models from catalog, got ${byok.models[0].id}`);
assert(
  JSON.stringify(byok.providers) === JSON.stringify(['openai']),
  `byok providers reported separately, got ${JSON.stringify(byok.providers)}`
);

// defect #4 regression: provider-tagged catalog entries are filtered to the
// providers that actually hold a key, and an unkeyed provider yields nothing.
const taggedAegis = {
  ...aegis,
  async listModels() {
    return {
      models: [
        { id: 'gpt-4o', provider: 'openai' },
        { id: 'claude-3-5-sonnet', provider: 'anthropic' },
        { id: 'untagged' },
      ],
    };
  },
};
const taggedEngine = createLocalEngine({ aegis: taggedAegis, settings, ollama, providers });
const filtered = await taggedEngine.listModels('byok');
assert(
  JSON.stringify(filtered.models.map((m) => m.id)) ===
    JSON.stringify(['gpt-4o', 'untagged']),
  `unkeyed provider filtered out, got ${JSON.stringify(filtered.models.map((m) => m.id))}`
);

const noKeyEngine = createLocalEngine({
  aegis: { ...taggedAegis, async byokStatus() { return { keys: {} }; } },
  settings,
  ollama,
  providers,
});
const none = await noKeyEngine.listModels('byok');
assert(none.models.length === 0, `no BYOK key -> no models, got ${none.models.length}`);

// A relay that cannot report key state falls back to the untagged catalog
// rather than hiding every model.
const offlineEngine = createLocalEngine({
  aegis: { ...taggedAegis, async byokStatus() { throw new Error('relay down'); } },
  settings,
  ollama,
  providers,
});
const offline = await offlineEngine.listModels('byok');
assert(offline.models.length === 3, `key state unknown -> full catalog, got ${offline.models.length}`);
assert(
  JSON.stringify(offline.providers) === JSON.stringify([]),
  'key state unknown -> empty providers list'
);

// chat routing per class
await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1' }, () => {});
assert(calls[calls.length - 1][0] === 'chatCompletion', 'aegis routes to chatCompletion');

await engine.chat({ class: 'byok', prompt: 'hi', model: 'openai' }, () => {});
assert(calls[calls.length - 1][0] === 'byok', 'byok routes to byokChatCompletion');

await engine.chat({ class: 'ollama', prompt: 'hi', model: 'llama3' }, () => {});
assert(calls[calls.length - 1][0] === 'ollama', 'ollama routes to ollama.chat');

await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'x' }, () => {});
assert(calls[calls.length - 1][0] === 'openai', 'custom routes to openaiCompatible');

await engine.chat({ class: 'anthropic', prompt: 'hi', model: 'x' }, () => {});
assert(calls[calls.length - 1][0] === 'anthropic', 'anthropic routes to anthropicMessages');

// cancel: unknown id is a no-op; aborting an in-flight stream works
assert(engine.cancel('nope').ok === false, 'unknown session cancel -> false');

const abortable = {
  async chatCompletion(args) {
    return new Promise((_resolve, reject) => {
      args.signal.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      );
    });
  },
};
const engine2 = createLocalEngine({
  aegis: { ...aegis, chatCompletion: abortable.chatCompletion, apiKey: 'k' },
  settings,
  ollama,
  providers,
});
const pending = engine2.chat({ class: 'aegis', prompt: 'x', sessionId: 's1' }, () => {});
const cancelRes = engine2.cancel('s1');
assert(cancelRes.ok === true, 'known session cancel -> true');
let aborted = false;
try {
  await pending;
} catch (err) {
  aborted = err.name === 'AbortError';
}
assert(aborted, 'cancel aborts the in-flight stream');

console.log('engine tests passed');
