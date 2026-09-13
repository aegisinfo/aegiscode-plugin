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
    // Answer in the wire format the requested endpoint actually speaks. The
    // Anthropic parser reads `content` blocks (not `choices`), so feeding it
    // an OpenAI body yields empty text — which the engine now treats as a
    // failed turn rather than silently passing through.
    const body = String(url).includes('/v1/messages')
      ? { model: 'claude-3-5-sonnet', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
      : { model: 'gpt-4o-mini', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
    return new Response(JSON.stringify(body), {
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

// ---- empty turn: the engine recovers instead of returning nothing --------
//
// The reported bug: a long tool-calling turn ends with a completion whose
// content is empty and which carries no tool call, so engine.js returned it
// verbatim and renderer/app.js painted "(empty response)" — discarding every
// tool result the turn had gathered. These drive the two recovery passes.

const textOf = (res) =>
  (res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || '';

/** Snapshot a dispatch's arguments — `history` is mutated in place by the
 *  loop, so reading `args.messages` after the fact would show the final
 *  state, not what that particular request was actually sent. */
const snapDispatch = (args) => ({
  prompt: args.prompt,
  tools: (args.tools || []).map((t) => t.function && t.function.name),
  messages: (args.messages || []).map((m) => `${m.role}:${String(m.content == null ? '' : m.content)}`),
  maxTokens: args.maxTokens,
});

const fakeTools = {
  SUBAGENT_TOOL: 'task',
  MUTATING_TOOLS: new Set(),
  toolsFor: () => [{ type: 'function', function: { name: 'poke', parameters: {} } }],
  async executeTool() {
    return { ok: true, output: 'poked' };
  },
  toolResultText: (r) => r.output,
};

// A provider that stops with neither text nor a tool call is re-dispatched
// once, with tools withdrawn and the original prompt folded into the history
// so the model still sees the question it is answering.
{
  const seen = [];
  let n = 0;
  const prov = {
    async openaiCompatible(args) {
      seen.push(snapDispatch(args));
      n += 1;
      return n === 1
        ? { model: 'x', choices: [{ message: { content: '' }, finish_reason: 'stop' }] }
        : { model: 'x', choices: [{ message: { content: 'recovered answer' }, finish_reason: 'stop' }] };
    },
  };
  const e = createLocalEngine({ aegis, settings, ollama, providers: prov, tools: fakeTools });
  const res = await e.chat({ class: 'openai-compat', prompt: 'what did you find', model: 'x' }, () => {});

  assert(textOf(res) === 'recovered answer', `synthesis pass delivers the answer, got ${JSON.stringify(res)}`);
  assert(seen.length === 2, `exactly one synthesis dispatch (${seen.length})`);
  assert(seen[1].tools.length === 0, 'synthesis is dispatched with no tools offered');
  assert(
    seen[1].messages.some((m) => m.startsWith('user:') && /came back empty/.test(m)),
    `nudge tells the model its reply was empty: ${JSON.stringify(seen[1].messages)}`
  );
  assert(
    seen[1].messages.some((m) => m === 'user:what did you find'),
    `the original prompt was folded into history before the nudge: ${JSON.stringify(seen[1].messages)}`
  );
}

// The exact reported shape: tool rounds run, then the model answers with an
// empty completion. The gathered tool results must reach the summary.
{
  const seen = [];
  let n = 0;
  const prov = {
    async openaiCompatible(args) {
      seen.push(snapDispatch(args));
      n += 1;
      if (n === 1) {
        return {
          model: 'x',
          choices: [
            {
              message: {
                content: '',
                tool_calls: [{ id: 'c1', function: { name: 'poke', arguments: '{}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        };
      }
      if (n === 2) return { model: 'x', choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
      return { model: 'x', choices: [{ message: { content: 'summarised findings' }, finish_reason: 'stop' }] };
    },
  };
  const e = createLocalEngine({ aegis, settings, ollama, providers: prov, tools: fakeTools });
  const res = await e.chat({ class: 'openai-compat', prompt: 'research the repo', model: 'x' }, () => {});

  assert(textOf(res) === 'summarised findings', `empty final round is rescued, got ${JSON.stringify(res)}`);
  assert(seen.length === 3, `one tool round + one empty round + one synthesis (${seen.length})`);
  assert(
    seen[2].messages.some((m) => m.startsWith('tool:') && m.includes('poked')),
    `the synthesis request still carries the tool results: ${JSON.stringify(seen[2].messages)}`
  );
  assert(!(seen[2].prompt || ''), 'synthesis sends no shorthand prompt alongside the folded history');
}

// Truncation: no visible text and finish_reason 'length' means the budget was
// spent before any content, so the turn is retried once at double the budget.
{
  const seen = [];
  let n = 0;
  const prov = {
    async openaiCompatible(args) {
      seen.push(snapDispatch(args));
      n += 1;
      return n === 1
        ? { model: 'x', choices: [{ message: { content: '' }, finish_reason: 'length' }] }
        : { model: 'x', choices: [{ message: { content: 'after doubling' }, finish_reason: 'stop' }] };
    },
  };
  const e = createLocalEngine({ aegis, settings, ollama, providers: prov, tools: fakeTools });
  const res = await e.chat({ class: 'openai-compat', prompt: 'q', model: 'x', maxTokens: 4096 }, () => {});

  assert(textOf(res) === 'after doubling', `truncated turn recovers, got ${JSON.stringify(res)}`);
  assert(seen.length === 2, `one truncation retry (${seen.length})`);
  assert(seen[1].maxTokens === 8192, `retry doubles the budget (${seen[1].maxTokens})`);
}

// A turn that already produced text is NOT retried on 'length' — the answer
// is merely truncated, and re-dispatching would stream it a second time onto
// the same renderer bubble.
{
  const seen = [];
  const prov = {
    async openaiCompatible(args) {
      seen.push(snapDispatch(args));
      return { model: 'x', choices: [{ message: { content: 'partial answer' }, finish_reason: 'length' }] };
    },
  };
  const e = createLocalEngine({ aegis, settings, ollama, providers: prov, tools: fakeTools });
  const res = await e.chat({ class: 'openai-compat', prompt: 'q', model: 'x', maxTokens: 4096 }, () => {});

  assert(textOf(res) === 'partial answer', `truncated text is returned as-is, got ${JSON.stringify(res)}`);
  assert(seen.length === 1, `no retry when text already arrived (${seen.length})`);
}

// Still empty after the synthesis pass: fail loudly with the cause rather
// than handing the renderer a blank completion to paint "(empty response)".
{
  const seen = [];
  const prov = {
    async openaiCompatible(args) {
      seen.push(snapDispatch(args));
      return { model: 'x', choices: [{ message: { content: '' }, finish_reason: 'length' }] };
    },
  };
  const e = createLocalEngine({ aegis, settings, ollama, providers: prov, tools: fakeTools });
  let threw = null;
  try {
    await e.chat({ class: 'openai-compat', prompt: 'q', model: 'x', maxTokens: 4096 }, () => {});
  } catch (err) {
    threw = err;
  }
  assert(threw, 'a permanently empty turn throws instead of returning blank content');
  assert(/no answer/.test(threw.message), `error names the failure: ${threw.message}`);
  assert(/length/.test(threw.message), `error carries the provider stop reason: ${threw.message}`);
  assert(/8192|4096/.test(threw.message), `error carries the budget actually used: ${threw.message}`);
  assert(seen.length === 3, `truncation retry + synthesis, then give up (${seen.length} dispatches)`);
}

// `tools: false` is the documented single-shot opt-out and has no gathered
// context to rescue, so it keeps returning the provider's own completion.
{
  const seen = [];
  const prov = {
    async openaiCompatible(args) {
      seen.push(snapDispatch(args));
      return { model: 'x', choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
    },
  };
  const e = createLocalEngine({ aegis, settings, ollama, providers: prov, tools: fakeTools });
  const res = await e.chat({ class: 'openai-compat', prompt: 'q', model: 'x', tools: false }, () => {});
  assert(textOf(res) === '', 'tools:false single-shot turn is unchanged');
  assert(seen.length === 1, `no synthesis dispatch when tools are opted out (${seen.length})`);
}

// Confirm-mode toggle (Settings → "Confirm before running tools") gates
// gatedExecuteTool(): on (the default, including when settings predates the
// toggle and getConfirmMode() returns undefined) a mutating call must round
// -trip through an approval chunk before it runs; off, it runs immediately
// with no approval chunk at all. See lib/local/engine.js confirmModeEnabled().
{
  const execCalls = [];
  const mutatingTools = {
    SUBAGENT_TOOL: 'task',
    MUTATING_TOOLS: new Set(['poke']),
    toolsFor: () => [{ type: 'function', function: { name: 'poke', parameters: {} } }],
    async executeTool(name) {
      execCalls.push(name);
      return { ok: true, output: 'poked' };
    },
    toolResultText: (r) => r.output,
  };
  let n = 0;
  const prov = {
    async openaiCompatible() {
      n += 1;
      if (n === 1) {
        return {
          model: 'x',
          choices: [
            {
              message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'poke', arguments: '{}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        };
      }
      return { model: 'x', choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] };
    },
  };

  // On (default): the call is gated behind an approval chunk; execution
  // happens only once respondApproval() resolves it.
  {
    n = 0;
    execCalls.length = 0;
    const e = createLocalEngine({ aegis, settings, ollama, providers: prov, tools: mutatingTools });
    let approvalId = null;
    const onDelta = (chunk) => {
      if (chunk && chunk.approval) {
        approvalId = chunk.approval.id;
        assert(execCalls.length === 0, 'the approval chunk arrives before the tool runs');
        e.respondApproval(approvalId, 'once');
      }
    };
    const res = await e.chat({ class: 'openai-compat', prompt: 'do it', model: 'x' }, onDelta);
    assert(textOf(res) === 'done', `answer arrives once approved, got ${JSON.stringify(res)}`);
    assert(approvalId, 'an approval chunk was sent for the mutating call');
    assert(execCalls.length === 1 && execCalls[0] === 'poke', `tool ran exactly once after approval (${JSON.stringify(execCalls)})`);
  }

  // Off: no approval chunk at all — the tool just runs.
  {
    n = 0;
    execCalls.length = 0;
    const deltas = [];
    const e = createLocalEngine({
      aegis, settings, ollama, providers: prov, tools: mutatingTools,
      getConfirmMode: () => false,
    });
    const res = await e.chat({ class: 'openai-compat', prompt: 'do it', model: 'x' }, (chunk) => deltas.push(chunk));
    assert(textOf(res) === 'done', `answer arrives without approval, got ${JSON.stringify(res)}`);
    assert(!deltas.some((c) => c && c.approval), 'confirm mode off sends no approval chunk');
    assert(execCalls.length === 1 && execCalls[0] === 'poke', `tool still runs exactly once (${JSON.stringify(execCalls)})`);
  }
}

console.log('engine tests passed');
