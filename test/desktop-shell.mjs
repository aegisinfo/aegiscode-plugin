#!/usr/bin/env node
/**
 * Headless smoke test for the desktop host's IPC surface.
 *
 * No Electron binary is booted (none is installed in CI). desktop/main.js is
 * deliberately structured so its dispatch map + IPC registration are plain
 * Node: we drive them with a stub client and a fake ipcMain, asserting the
 * whitelisted surface forwards payloads to the shared client exactly like the
 * real IPC layer will. Nothing here touches the network.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createIpcDispatch, registerIpc, IPC_PREFIX, maskKey } = require(
  '../desktop/main.js'
);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// A real-looking key built at runtime so the CI secret scanner (which greps
// source text) stays quiet — never put real keys in this repo.
const RAW_KEY = `sk-${'a'.repeat(24)}`;
const MASKED_KEY = `sk-${'a'.repeat(6)}\u2026${'a'.repeat(4)}`;

const calls = [];
const stubClient = {
  clientVersion: '3.1.0-smoke',
  apiBase: 'https://aegiscloud.org',
  apiKey: RAW_KEY,
  async verifyApiKey() {
    return { valid: true, plan: 'smoke' };
  },
  async listModels() {
    calls.push(['listModels']);
    return {
      models: [
        { id: 'anthropic', capabilities: ['chat'] },
        { id: 'groq', capabilities: ['fast'] },
      ],
    };
  },
  async chatCompletion(args) {
    calls.push(['chatCompletion', args]);
    return {
      model: 'nexus-smart',
      choices: [{ message: { content: 'hi from stub' } }],
      usage: { total_tokens: 7 },
    };
  },
  async tokenBankBalance() {
    return { balance: 100 };
  },
  async byokStatus() {
    return { keys: [] };
  },
  async byokSet(provider, apiKey) {
    calls.push(['byokSet', provider, apiKey]);
    return { ok: true };
  },
  async memorySearch() {
    return { results: [] };
  },
  async memorySave(entry) {
    calls.push(['memorySave', entry]);
    return { ok: true };
  },
  async memoryList() {
    return { results: [] };
  },
};

const EXPECTED = [
  'status',
  'verifyApiKey',
  'tokenBankBalance',
  'listModels',
  'chatCompletion',
  'byokStatus',
  'byokSet',
  'memorySearch',
  'memorySave',
  'memoryList',
];

try {
  // 1. maskKey never reveals a full key
  assert(maskKey(null) === null, 'maskKey(null) should be null');
  assert(maskKey('short') === 'configured', 'short keys should be "configured"');
  assert(maskKey(RAW_KEY) === MASKED_KEY, 'long keys should be masked');

  // 2. Dispatch surface is exactly the whitelist — no accidental additions.
  const dispatch = createIpcDispatch(stubClient);
  const names = Object.keys(dispatch).sort();
  assert(
    names.length === EXPECTED.length,
    `expected ${EXPECTED.length} methods, got ${names.length}`
  );
  for (const n of EXPECTED) {
    assert(typeof dispatch[n] === 'function', `missing dispatch.${n}`);
  }

  // 3. status is local and key-safe
  const status = await dispatch.status();
  assert(status.keyConfigured === true, 'key should read as configured');
  assert(status.keyMask === MASKED_KEY, 'status should expose the mask only');
  assert(
    !JSON.stringify(status).includes(RAW_KEY),
    'status must not leak the raw key'
  );
  assert(
    status.appVersion === '0.2.0',
    `appVersion should come from desktop/package.json, got ${status.appVersion}`
  );
  assert(
    status.clientVersion === '3.1.0-smoke',
    'clientVersion should pass through'
  );

  // 4. Payload forwarding into the shared-client call shapes.
  const chat = await dispatch.chatCompletion({
    prompt: 'hi',
    system: 'be brief',
    model: 'groq',
    mode: 'fast',
    maxTokens: 99,
  });
  const chatCall = calls[calls.length - 1];
  assert(chatCall[0] === 'chatCompletion', 'chatCompletion should be called');
  assert(
    chatCall[1].prompt === 'hi' &&
      chatCall[1].system === 'be brief' &&
      chatCall[1].model === 'groq' &&
      chatCall[1].mode === 'fast' &&
      chatCall[1].maxTokens === 99,
    'chatCompletion args should be forwarded verbatim'
  );
  assert(
    chat.choices[0].message.content === 'hi from stub',
    'chat response should pass through'
  );

  await dispatch.byokSet({ provider: 'anthropic', apiKey: RAW_KEY });
  const byokCall = calls[calls.length - 1];
  assert(
    byokCall[0] === 'byokSet' &&
      byokCall[1] === 'anthropic' &&
      byokCall[2] === RAW_KEY,
    'byokSet should forward provider + key'
  );

  await dispatch.memorySave({ entry: { text: 'remember me' } });
  const memCall = calls[calls.length - 1];
  assert(
    memCall[0] === 'memorySave' && memCall[1].text === 'remember me',
    'memorySave should forward the entry'
  );

  const models = await dispatch.listModels();
  assert(models.models.length === 2, 'listModels response should pass through');

  // 5. IPC registration wires every method under aegis:<name>.
  const fakeIpc = {
    handles: {},
    handle(name, cb) {
      this.handles[name] = cb;
    },
  };
  registerIpc(fakeIpc, stubClient);
  const channels = Object.keys(fakeIpc.handles).sort();
  assert(
    channels.length === EXPECTED.length,
    `expected ${EXPECTED.length} IPC channels, got ${channels.length}`
  );
  for (const n of EXPECTED) {
    assert(
      fakeIpc.handles[`${IPC_PREFIX}${n}`],
      `missing IPC channel aegis:${n}`
    );
  }

  const ipcStatus = await fakeIpc.handles[`${IPC_PREFIX}status`]({}, undefined);
  assert(
    ipcStatus.keyMask === MASKED_KEY &&
      !JSON.stringify(ipcStatus).includes(RAW_KEY),
    'status over IPC must be key-safe'
  );
  const ipcModels = await fakeIpc.handles[`${IPC_PREFIX}listModels`](
    {},
    undefined
  );
  assert(ipcModels.models.length === 2, 'listModels over IPC should pass through');

  console.log(`Desktop shell smoke test passed: ${channels.join(', ')}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
