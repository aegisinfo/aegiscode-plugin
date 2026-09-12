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
  async chatCompletion(args) {
    calls.push(['chatCompletion', args]);
    if (args.onStream) args.onStream({ delta: 'hi' });
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

// listClasses exposes all four classes with live ollama probe state
const classes = await engine.listClasses();
assert(classes.length === 4, `expected 4 classes, got ${classes.length}`);
const names = classes.map((c) => c.class);
for (const n of ['aegis', 'ollama', 'openai-compat', 'anthropic']) {
  assert(names.includes(n), `missing class ${n}`);
}
assert(classes.find((c) => c.class === 'ollama').configured === true, 'ollama configured');

// listModels per class
assert((await engine.listModels('aegis')).models[0].id === 'openai', 'aegis models');
assert((await engine.listModels('ollama')).models[0].id === 'llama3', 'ollama models');

// chat routing per class
await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1' }, () => {});
assert(calls[calls.length - 1][0] === 'chatCompletion', 'aegis routes to chatCompletion');

await engine.chat({ class: 'ollama', prompt: 'hi', model: 'llama3' }, () => {});
assert(calls[calls.length - 1][0] === 'ollama', 'ollama routes to ollama.chat');

await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'x' }, () => {});
assert(calls[calls.length - 1][0] === 'openai', 'custom routes to openaiCompatible');

await engine.chat({ class: 'anthropic', prompt: 'hi', model: 'x' }, () => {});
assert(calls[calls.length - 1][0] === 'anthropic', 'anthropic routes to anthropicMessages');

// ---- DeepSeek reasoning floor (matches aegiscodex-dev's own DeepSeek fix) --
//
// A user pointing "Custom OpenAI-compatible" straight at DeepSeek's API with
// the renderer's 4k default hits the same bug aegiscodex-dev already fixed
// for itself: DeepSeek's reasoning models spend max_tokens on hidden
// chain-of-thought, so a low cap burns the whole budget and the turn
// finishes with empty content. The floor only raises a too-low value, never
// lowers an explicit higher one, and never touches non-reasoning ids.
for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-reasoner']) {
  await engine.chat({ class: 'openai-compat', prompt: 'hi', model, maxTokens: 4096 }, () => {});
  const [, args] = calls[calls.length - 1];
  assert(args.maxTokens === 32768, `${model} floors the default 4k up to the high-effort budget, got ${args.maxTokens}`);
}
await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'deepseek-flash', maxTokens: 4096, effort: 'low' }, () => {});
assert(calls[calls.length - 1][1].maxTokens === 8192, 'an explicit low effort uses the low-effort budget (8192)');

// A non-reasoning DeepSeek id (deepseek-chat) and a non-DeepSeek model both
// pass their maxTokens through untouched.
await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'deepseek-chat', maxTokens: 4096 }, () => {});
assert(calls[calls.length - 1][1].maxTokens === 4096, 'deepseek-chat (non-reasoning) is not floored');
await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'gpt-4o-mini', maxTokens: 4096 }, () => {});
assert(calls[calls.length - 1][1].maxTokens === 4096, 'a non-DeepSeek model is not floored');

// The floor only ever raises — an explicit choice already above the budget
// (e.g. "adaptive" sending the model's real ceiling) is left alone.
await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'deepseek-v4-pro', maxTokens: 300000 }, () => {});
assert(calls[calls.length - 1][1].maxTokens === 300000, 'an already-higher explicit value is never lowered');

// autonomous + effort/workers reach aegis1's pool_brain via `extra`
// (services/pool_brain.py parse_brain_request reads body.effort/body.workers)
await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1', autonomous: true, effort: 'medium', workers: 5 }, () => {});
{
  const [, args] = calls[calls.length - 1];
  assert(args.extra.brain === true, 'autonomous turn sets extra.brain');
  assert(args.extra.effort === 'medium', `effort forwarded: ${JSON.stringify(args.extra)}`);
  assert(args.extra.workers === 5, `workers forwarded: ${JSON.stringify(args.extra)}`);
}

// effort/workers are dropped when NOT autonomous — never sent bare, and never
// sent when autonomous is on but the value itself is falsy/omitted.
await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1', effort: 'high', workers: 4 }, () => {});
{
  const [, args] = calls[calls.length - 1];
  assert(!('brain' in args.extra), 'non-autonomous turn sets no brain flag');
  assert(!('effort' in args.extra) && !('workers' in args.extra), `effort/workers withheld without autonomous: ${JSON.stringify(args.extra)}`);
}
await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1', autonomous: true }, () => {});
{
  const [, args] = calls[calls.length - 1];
  assert(args.extra.brain === true
    && !('effort' in args.extra) && !('workers' in args.extra), `autonomous with no effort/workers omits both: ${JSON.stringify(args.extra)}`);
}

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

// ---- defect B: custom endpoints offer no base-URL-as-model-id -------------
//
// listModels used to return [{ id: cfg.baseURL }] for openai-compat/anthropic.
// Leaving that default selected POSTed `model: "https://api.openai.com/v1"`,
// an upstream 400 invalid-model on every call.
for (const cls of ['openai-compat', 'anthropic']) {
  const listed = await engine.listModels(cls);
  assert(
    Array.isArray(listed.models) && listed.models.length === 0,
    `${cls} lists no models, got ${JSON.stringify(listed.models)}`
  );
  assert(listed.needsModelId === true, `${cls} sets needsModelId`);
  assert(
    !listed.models.some((m) => m && m.id === 'http://local'),
    `${cls} never offers the base URL as a model id`
  );
  assert(
    !listed.models.some((m) => m && typeof m.id === 'string' && /^https?:/.test(m.id)),
    `${cls} never offers a URL as a model id`
  );
  assert(listed.baseURL === 'http://local', `${cls} reports its base URL for display`);
}

// A blank/absent model id for a custom class is rejected in-process: the
// provider transport is never reached, so nothing is fetched upstream.
for (const cls of ['openai-compat', 'anthropic']) {
  const seen = [];
  const guardEngine = createLocalEngine({
    aegis,
    settings,
    ollama,
    providers: {
      async openaiCompatible(args) { seen.push(args); return {}; },
      async anthropicMessages(args) { seen.push(args); return {}; },
    },
  });
  for (const blank of [undefined, null, '', '   ']) {
    let threw = null;
    try {
      await guardEngine.chat({ class: cls, prompt: 'hi', model: blank }, () => {});
    } catch (err) {
      threw = err;
    }
    assert(threw, `${cls} chat rejects model=${JSON.stringify(blank)}`);
    assert(
      /model id is required/.test(threw.message),
      `${cls} blank-model error is actionable, got "${threw && threw.message}"`
    );
  }
  assert(seen.length === 0, `${cls} blank model never reaches the transport (${seen.length} calls)`);
}

// ---- defect A through the engine: real transport, one /v1 ------------------
//
// End-to-end with the actual providers module and a fetch spy: the configured
// base URL (which the settings field invites users to paste *with* /v1) must
// produce exactly one version segment.
{
  const req = createRequire(import.meta.url);
  const realProviders = req('../desktop/lib/local/providers.js');

  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return new Response(JSON.stringify({ model: 'gpt-4o-mini', choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const cases = [
    ['openai-compat', 'https://api.openai.com', 'https://api.openai.com/v1/chat/completions'],
    ['openai-compat', 'https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
    ['openai-compat', 'https://api.openai.com/v1/', 'https://api.openai.com/v1/chat/completions'],
    ['anthropic', 'https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
    ['anthropic', 'https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/messages'],
    ['anthropic', 'https://api.anthropic.com/v1/', 'https://api.anthropic.com/v1/messages'],
  ];
  for (const [cls, baseURL, expected] of cases) {
    const eng = createLocalEngine({
      aegis,
      settings: { get: () => ({ baseURL, configured: true }), rawKey: () => 'k' },
      ollama,
      providers: realProviders,
    });
    await eng.chat({ class: cls, prompt: 'hi', model: 'gpt-4o-mini' }, () => {});
    assert(
      fetched[fetched.length - 1] === expected,
      `${cls} base "${baseURL}" fetched "${fetched[fetched.length - 1]}", expected "${expected}"`
    );
  }
  const before = fetched.length;
  const eng = createLocalEngine({
    aegis,
    settings: { get: () => ({ baseURL: 'https://api.openai.com/v1', configured: true }), rawKey: () => 'k' },
    ollama,
    providers: realProviders,
  });
  await eng.chat({ class: 'openai-compat', prompt: 'hi', model: '   ' }, () => {}).catch(() => {});
  assert(fetched.length === before, 'blank model id never reaches fetch()');
  delete globalThis.fetch;
}

// ---- no round cap: a long tool-calling turn is never cut off ---------------
//
// engine.js used to hand back a blank (tool-call, no-text) response once a
// turn hit a fixed 12-round cap, which renderer/app.js rendered as
// "(empty response)" even on a legitimate long research turn. There is no
// cap anymore: the loop keeps running exactly as long as the model keeps
// calling tools, stopping only when it answers in text (or the caller
// cancels). This drives the loop well past the old cap (20 tool rounds) and
// checks every round actually executed before the model's real answer wins.
{
  const OLD_CAP = 12;
  const TOOL_ROUNDS = OLD_CAP + 8;
  const fakeTools = {
    SUBAGENT_TOOL: 'task',
    MUTATING_TOOLS: new Set(),
    toolsFor: () => [{ type: 'function', function: { name: 'poke', parameters: {} } }],
    async executeTool() {
      return { ok: true, output: 'poked' };
    },
    toolResultText: (r) => r.output,
  };

  let dispatchCount = 0;
  let executeCount = 0;
  const originalExecuteTool = fakeTools.executeTool;
  fakeTools.executeTool = async (...args) => {
    executeCount += 1;
    return originalExecuteTool(...args);
  };
  const longHaulProviders = {
    async openaiCompatible() {
      dispatchCount += 1;
      if (dispatchCount > TOOL_ROUNDS) {
        return { model: 'x', choices: [{ message: { content: 'final summary' } }] };
      }
      return {
        model: 'x',
        choices: [{ message: { content: '', tool_calls: [{ id: `c${dispatchCount}`, function: { name: 'poke', arguments: '{}' } }] } }],
      };
    },
  };

  const longHaulEngine = createLocalEngine({
    aegis,
    settings,
    ollama,
    providers: longHaulProviders,
    tools: fakeTools,
  });

  const res = await longHaulEngine.chat({ class: 'openai-compat', prompt: 'dig forever', model: 'x' }, () => {});
  const text = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
  assert(text === 'final summary', `a long tool-calling turn still gets the final text answer, got ${JSON.stringify(res)}`);
  assert(dispatchCount === TOOL_ROUNDS + 1, `no cap: ran past the old ${OLD_CAP}-round limit (${dispatchCount} dispatches)`);
  assert(executeCount === TOOL_ROUNDS, `every tool round actually executed (${executeCount}/${TOOL_ROUNDS})`);
}

console.log('engine tests passed');
