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
    // A faithful /api/v1/models payload, copied from what the live server
    // actually serves (verified against aegiscloud.org): raw per-provider ids
    // whose keys drift in and out of validity, plus six pooled-brain tiers.
    // `nexus-brain` is the canonical tier (hidden:false, no alias_of); every
    // other spelling is marked `hidden:true, alias_of:"nexus-brain"`. The
    // desktop collapses all of it to the single "Nexus" entry.
    return {
      models: [
        { id: 'openai', capabilities: ['tools'], context_window: 0, max_output: 0 },
        { id: 'anthropic' },
        { id: 'groq' },
        { id: 'gemini' },
        { id: 'nexus-brain', label: 'NEXUS', tier: 'brain', hidden: false },
        { id: 'aegis-brain', label: '', tier: 'brain', hidden: true, alias_of: 'nexus-brain' },
        { id: 'nexus-brain-smart', tier: 'smart', hidden: true, alias_of: 'nexus-brain' },
        { id: 'aegis-brain-smart', tier: 'smart', hidden: true, alias_of: 'nexus-brain' },
        { id: 'nexus-brain-neo', tier: 'neo', hidden: true, alias_of: 'nexus-brain' },
        { id: 'aegis-brain-neo', tier: 'neo', hidden: true, alias_of: 'nexus-brain' },
      ],
    };
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
  list: () => [],
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
for (const n of ['aegis', 'ollama', 'openai-compat', 'anthropic', 'byok']) {
  assert(names.includes(n), `missing class ${n}`);
}
assert(classes.find((c) => c.class === 'ollama').configured === true, 'ollama configured');

// listModels per class
// The aegis class offers exactly one choice: the collapsed Nexus brain. Raw
// provider ids and the other brain tiers never reach the dropdown — picking a
// provider that happens to have no live key today is an ops detail, not a
// model choice (the pool auto-routes).
const aegisModels = (await engine.listModels('aegis')).models;
assert(aegisModels.length === 1, `the aegis class collapses to exactly one entry, got ${aegisModels.length}`);
assert(aegisModels[0].id === 'nexus-brain', `the collapsed entry is the canonical brain tier, got ${aegisModels[0].id}`);
assert(aegisModels[0].label === 'Nexus', `the collapsed entry is labelled Nexus, got ${aegisModels[0].label}`);
assert(aegisModels[0].hidden === undefined, 'the collapsed entry must not carry hidden:true or the renderer filters it back out');
assert(aegisModels[0].alias_of === undefined, 'the collapsed entry must not carry alias_of bookkeeping');
assert(!aegisModels.some((m) => ['openai', 'anthropic', 'groq', 'gemini'].includes(m.id)), 'raw provider ids are filtered out');
assert(!aegisModels.some((m) => /-(smart|neo)$/.test(String(m.id))), 'non-default brain tiers are filtered out');
assert((await engine.listModels('ollama')).models[0].id === 'llama3', 'ollama models');

// Regression: an older/trimmed catalog that serves *only* the alias must still
// yield a selectable entry. The previous fixed-id lookup would return [] here,
// leaving the Aegis class with an empty dropdown and nothing to send.
const aliasOnlyAegis = { apiKey: 'k', async listModels() { return { models: [{ id: 'aegis-brain', label: '', hidden: true, alias_of: 'nexus-brain' }] }; } };
const aliasOnlyModels = (await createLocalEngine({ aegis: aliasOnlyAegis, settings, ollama, providers }).listModels('aegis')).models;
assert(aliasOnlyModels.length === 1, `alias-only catalog still yields one entry, got ${aliasOnlyModels.length}`);
assert(aliasOnlyModels[0].id === 'aegis-brain', `alias-only catalog falls back to the alias, got ${aliasOnlyModels[0].id}`);
assert(aliasOnlyModels[0].label === 'Nexus', 'alias-only fallback is still labelled Nexus');

// Regression: a catalog where the brain is renamed but still points at the same
// canonical id must resolve via `alias_of` rather than emptying the class.
const renamedAegis = { apiKey: 'k', async listModels() { return { models: [{ id: 'nexus-brain-v2', hidden: true, alias_of: 'nexus-brain' }] }; } };
const renamedModels = (await createLocalEngine({ aegis: renamedAegis, settings, ollama, providers }).listModels('aegis')).models;
assert(renamedModels.length === 1, `renamed brain still yields one entry, got ${renamedModels.length}`);
assert(renamedModels[0].id === 'nexus-brain-v2', `renamed brain resolves via alias_of, got ${renamedModels[0].id}`);

// Regression: a catalog with no brain at all yields no entries (not a crash).
const noBrainAegis = { apiKey: 'k', async listModels() { return { models: [{ id: 'openai' }, { id: 'groq' }] }; } };
const noBrainModels = (await createLocalEngine({ aegis: noBrainAegis, settings, ollama, providers }).listModels('aegis')).models;
assert(noBrainModels.length === 0, `a provider-only catalog yields no entries, got ${noBrainModels.length}`);

// Regression: with no key, the default class must not fire a catalog call it
// knows will 401. GET /api/v1/models answers `401 {"error":{"message":"No API
// key"}}` (verified against aegiscloud.org), and Aegis Cloud is the class a
// fresh install defaults to — so the doomed call is what a brand new user saw,
// rendered as a raw "listModels failed: …" over the model picker instead of the
// one instruction that helps. `needsKey` is that instruction's signal, and the
// proof that no request went out is that this stub throws if called.
let keylessListModelsCalled = false;
const keylessAegis = {
  apiKey: '',
  async listModels() {
    keylessListModelsCalled = true;
    throw new Error('No API key');
  },
};
const keyless = await createLocalEngine({ aegis: keylessAegis, settings, ollama, providers }).listModels('aegis');
assert(keyless.needsKey === true, 'a keyless Aegis class reports needsKey so the renderer can offer the connect step');
assert(Array.isArray(keyless.models) && keyless.models.length === 0, 'and offers no model list rather than a partial one');
assert(keylessListModelsCalled === false, 'and makes no catalog request at all (the 401 was the bug, not the fix)');
// A key that is present must still take the normal path (no behaviour change).
assert((await engine.listModels('aegis')).needsKey === undefined, 'a configured Aegis class never reports needsKey');

// chat routing per class
await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1' }, () => {});
assert(calls[calls.length - 1][0] === 'chatCompletion', 'aegis routes to chatCompletion');
// The cloud class is the one streamed transport in the desktop, and an
// OpenAI-compatible SSE response omits `usage` unless asked — so the engine
// must ask, or the pooled "Nexus" brain reports its answer but never its token
// spend while the same model through the MCP path reports both.
assert(
  calls[calls.length - 1][1].includeUsage === true,
  'the aegis cloud dispatch must request usage on its stream (stream_options.include_usage)'
);
assert(
  calls[calls.length - 1][1].stream === true,
  'the aegis cloud dispatch stays streamed — usage is requested, not traded away'
);
assert(
  calls[calls.length - 1][1].model === 'm1',
  'the selected model id is forwarded verbatim (no client-side tier rewriting)'
);

await engine.chat({ class: 'ollama', prompt: 'hi', model: 'llama3' }, () => {});
assert(calls[calls.length - 1][0] === 'ollama', 'ollama routes to ollama.chat');

await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'x' }, () => {});
assert(calls[calls.length - 1][0] === 'openai', 'custom routes to openaiCompatible');

await engine.chat({ class: 'anthropic', prompt: 'hi', model: 'x' }, () => {});
assert(calls[calls.length - 1][0] === 'anthropic', 'anthropic routes to anthropicMessages');

// ---- DeepSeek reasoning budget: one authority per call --------------------
//
// A caller-stated number IS the budget and is honoured verbatim. For the
// non-pooled classes the renderer's max-tokens dropdown is their only budget
// control (updateBudgetControls hides the effort row for them), so raising it
// to an effort rung is what made the figure beside the dropdown untrustworthy:
// a caller asking for 1024 used to run on 32768. The effort rung is the
// DEFAULT, consulted only when no number was stated at all. An over-budget
// turn is caught by the doubled-budget retry and emptyTurnError instead of by
// inflating the ceiling up front — escalating on a demonstrated empty turn
// costs less than granting the top rung to every reasoning call.
for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-reasoner']) {
  await engine.chat({ class: 'openai-compat', prompt: 'hi', model, maxTokens: 4096 }, () => {});
  const [, args] = calls[calls.length - 1];
  assert(args.maxTokens === 4096, `${model} honours a stated ceiling verbatim, got ${args.maxTokens}`);
}

// The case the old Math.max() overrode by an order of magnitude.
await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'deepseek-v4-pro', maxTokens: 1024 }, () => {});
assert(calls[calls.length - 1][1].maxTokens === 1024, 'a deliberate small cap is never raised to a rung');

// No number stated at all -> the effort rung supplies the default.
await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'deepseek-flash' }, () => {});
assert(calls[calls.length - 1][1].maxTokens === 32768, 'an unstated budget defaults to the high rung');
await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'deepseek-flash', effort: 'low' }, () => {});
assert(calls[calls.length - 1][1].maxTokens === 8192, 'an unstated budget at low effort uses the low rung');

// A non-reasoning DeepSeek id (deepseek-chat) and a non-DeepSeek model both
// pass their maxTokens through untouched.
await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'deepseek-chat', maxTokens: 4096 }, () => {});
assert(calls[calls.length - 1][1].maxTokens === 4096, 'deepseek-chat (non-reasoning) is not floored');
await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'gpt-4o-mini', maxTokens: 4096 }, () => {});
assert(calls[calls.length - 1][1].maxTokens === 4096, 'a non-DeepSeek model is not floored');

// "adaptive" sends the model's real ceiling; it passes through unchanged.
await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'deepseek-v4-pro', maxTokens: 300000 }, () => {});
assert(calls[calls.length - 1][1].maxTokens === 300000, 'a stated ceiling above the ladder passes through unchanged');

// autonomous + effort/workers reach aegis1's pool_brain via `extra`
// (services/pool_brain.py parse_brain_request reads body.effort/body.workers)
await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1', autonomous: true, effort: 'medium', workers: 5 }, () => {});
{
  const [, args] = calls[calls.length - 1];
  assert(args.extra.brain === true, 'autonomous turn sets extra.brain');
  assert(args.extra.effort === 'medium', `effort forwarded: ${JSON.stringify(args.extra)}`);
  assert(args.extra.workers === 5, `workers forwarded: ${JSON.stringify(args.extra)}`);
}

// effort and workers part company here. `workers` sizes a fan-out, so it is
// withheld from a turn that is not running one. `effort` picks the budget rung
// and travels either way: the fan-out is enabled by the *model id* this class
// sends (`nexus-brain`), so a non-autonomous turn is still a pooled call — it
// used to be one the caller could not size at all, which is how a one-word
// prompt ended up on the server's own top-of-ladder default.
await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1', effort: 'high', workers: 4 }, () => {});
{
  const [, args] = calls[calls.length - 1];
  assert(!('brain' in args.extra), 'non-autonomous turn sets no brain flag');
  assert(!('workers' in args.extra), `workers withheld without autonomous: ${JSON.stringify(args.extra)}`);
  assert(args.extra.effort === 'high',
    `effort still sizes the pooled call: ${JSON.stringify(args.extra)}`);
}
await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1', autonomous: true }, () => {});
{
  const [, args] = calls[calls.length - 1];
  assert(args.extra.brain === true
    && !('effort' in args.extra) && !('workers' in args.extra), `autonomous with no effort/workers omits both: ${JSON.stringify(args.extra)}`);
}

// Recall is the READ half of aegis_memory, and this engine sends only that
// half. aegis_memory is both: aegis1 app.py injects the account's synced
// memory AND persists the turn back into it, charging sync quota for the
// write. Both flags were the same flag until the split, so every GUI and CLI
// turn on this engine paid for a write it never asked for — "hey" was a
// memory-write. aegis_memory implies aegis_recall server-side, so the browser
// client is unaffected by dropping it here.
//
// Both directions are pinned, because getting either one wrong is silent: a
// missing aegis_recall starts every pooled session blind (services/
// tiered_recall.py never runs), and a stray aegis_memory bills every turn.
await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm1', sessionId: 's-1' }, () => {});
{
  const [, args] = calls[calls.length - 1];
  assert(args.extra.aegis_recall === true, `read half sent: ${JSON.stringify(args.extra)}`);
  assert(!('aegis_memory' in args.extra),
    `the write half must not follow the recall: ${JSON.stringify(args.extra)}`);
  assert(args.extra.session === 's-1',
    `recall is scoped to the caller's session, so session survives the swap: ${args.extra.session}`);
}
{
  // Every aegis request recorded above — autonomous, single-pass, or plain —
  // is checked, not just the last one: a write re-introduced on one path
  // (the fan-out's synthesis pass, say) would be missed by a single sample.
  const aegisCalls = calls.filter(([kind, args]) => kind === 'chatCompletion' && args.extra).map(([, args]) => args);
  assert(aegisCalls.length >= 4, `the block above recorded aegis turns: ${aegisCalls.length}`);
  for (const args of aegisCalls) {
    assert(args.extra.aegis_recall === true, `every aegis turn recalls: ${JSON.stringify(args.extra)}`);
    assert(!('aegis_memory' in args.extra), `no aegis turn writes back: ${JSON.stringify(args.extra)}`);
  }
}

// ── deep recall: opt-in only, and only on the user's own turn ────────────────
//
// aegis1 grew a THIRD flag (app.py:8367): `aegis_recall_deep` gates the brain's
// two reads — find_corrections (a bounded row lookup) and find_cached_answer,
// which EMBEDS THE QUERY (services/brain_memory.py:82), one provider embedding
// per turn. That price is why the server will not imply it from `aegis_recall`
// (`aegis_memory` implies it; the cheap read does not), and it is why a client
// that pays per turn must not send it of its own accord. Absent by default and
// present only on an explicit opt-in are therefore BOTH pinned below, and so is
// the narrower scope: a re-dispatch must not buy a second embedding.
//
// `everyAegisRequest` collects the `extra` body of every aegis request this
// file makes, from every transport it scripts, so the whole-file sweep at the
// bottom can check all of them rather than one sample.
const everyAegisRequest = [];
{
  // One scripted turn that walks EVERY dispatch path there is:
  //   dispatch 1  the user's own ask (round 1)
  //   dispatch 2  a tool round, forced by a real tool call in dispatch 1
  //   dispatch 3  the doubled-budget retry, forced by an empty 'length' round
  //   dispatch 4  the write-up re-dispatch, forced by an empty retry
  // A write or a per-round embedding re-introduced on any one of them would be
  // invisible to a single-sample assertion.
  const scripted = (log) => ({
    apiKey: 'k',
    async chatCompletion(args) {
      log.push(args);
      everyAegisRequest.push(args.extra);
      const n = log.length;
      if (n === 1) {
        return {
          model: args.model,
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: { name: 'listDir', arguments: JSON.stringify({ path: '.' }) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        };
      }
      if (n <= 3) {
        return { model: args.model, choices: [{ message: { content: '' }, finish_reason: 'length' }] };
      }
      return { model: args.model, choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] };
    },
  });

  // (a) DEFAULT: no opt-in, and the field is absent on every path — not merely
  // falsy. The engine's own condition is `=== true`, so an absent field is the
  // one shape that cannot be mistaken for consent; sending `false` would also
  // work server-side but would mean the client is stating an opinion about a
  // flag it has no reason to mention.
  const dflt = [];
  await createLocalEngine({ aegis: scripted(dflt), settings, ollama, providers })
    .chat({ class: 'aegis', prompt: 'hi', model: 'm1', sessionId: 's-deep-off' }, () => {});
  assert(dflt.length >= 4, `the scripted turn walked every path: ${dflt.length}`);
  for (const args of dflt) {
    assert(!('aegis_recall_deep' in args.extra),
      `deep recall is absent unless the session opted in: ${JSON.stringify(args.extra)}`);
    assert(args.extra.aegis_recall === true, `the cheap read is still sent: ${JSON.stringify(args.extra)}`);
    assert(!('aegis_memory' in args.extra), `no path writes back: ${JSON.stringify(args.extra)}`);
  }

  // (b) OPT-IN: present on the user's ask, absent on every re-dispatch.
  const opted = [];
  await createLocalEngine({ aegis: scripted(opted), settings, ollama, providers })
    .chat({ class: 'aegis', prompt: 'hi', model: 'm1', sessionId: 's-deep-on', recallDeep: true }, () => {});
  assert(opted.length >= 4, `the opted-in turn walked every path: ${opted.length}`);
  assert(opted[0].extra.aegis_recall_deep === true,
    `the opted-in user turn asks for the deep tier: ${JSON.stringify(opted[0].extra)}`);
  assert(opted[1].extra.brain === undefined || opted[1].extra.brain !== true,
    'the tool round is a continuation, not a new ask');
  for (const args of opted.slice(1)) {
    assert(!('aegis_recall_deep' in args.extra),
      `a re-dispatch (tool round / retry / write-up) must not buy a second embedding: ${JSON.stringify(args.extra)}`);
    assert(args.extra.aegis_recall === true, `every continuation still recalls: ${JSON.stringify(args.extra)}`);
    assert(!('aegis_memory' in args.extra), `no continuation writes back: ${JSON.stringify(args.extra)}`);
  }
  // The session outlives the swap on all four dispatches: recall is scoped per
  // session, so a dropped sessionId would recall into the wrong (or no) scope.
  assert(dflt.every((a) => a.extra.session === 's-deep-off'), 'off-path dispatches keep their session');
  assert(opted.every((a) => a.extra.session === 's-deep-on'), 'on-path dispatches keep their session');

  // A caller that says `false` explicitly is off, exactly like one that says
  // nothing — the flag is consent, not a default flipped by a truthy payload.
  const explicitOff = [];
  await createLocalEngine({ aegis: scripted(explicitOff), settings, ollama, providers })
    .chat({ class: 'aegis', prompt: 'hi', model: 'm1', sessionId: 's-deep-false', recallDeep: false }, () => {});
  for (const args of explicitOff) {
    assert(!('aegis_recall_deep' in args.extra),
      `recallDeep:false is not consent: ${JSON.stringify(args.extra)}`);
  }
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

// ---- an interrupted turn must not re-dispatch ---------------------------
//
// Both "the model said nothing" recoveries — the doubled-budget truncation
// retry and the write-up re-dispatch — are gated on an EMPTY round, and an
// aborted request resolves with exactly that: no text. Without an abort guard
// a user pressing Esc on a slow turn immediately issued a SECOND billed
// provider call, and because every transport concatenates the deltas it has
// already forwarded, the partial answer was streamed twice onto one bubble.
// Measured on the pre-fix code: one interrupted turn, two dispatches.
{
  let dispatches = 0;
  const slow = {
    async chatCompletion(args) {
      dispatches += 1;
      // Stream before hanging, so a re-dispatch would visibly double the text.
      if (args.onStream) args.onStream({ delta: 'partial' });
      // Resolve (not reject) on abort — the shape of a transport that returns
      // whatever it managed to read, which is what the pooled client does. A
      // signal that is ALREADY aborted resolves at once, exactly as the real
      // client does, so a re-dispatch after an abort fails on the dispatch
      // count instead of hanging the test.
      return new Promise((resolve) => {
        const done = () => resolve({ choices: [{ message: { content: '' } }] });
        if (args.signal.aborted) return done();
        args.signal.addEventListener('abort', done);
        return undefined;
      });
    },
  };
  const engine3 = createLocalEngine({
    aegis: { ...aegis, chatCompletion: slow.chatCompletion, apiKey: 'k' },
    settings,
    ollama,
    providers,
  });
  const pending2 = engine3.chat({ class: 'aegis', prompt: 'x', sessionId: 's2' }, () => {});
  await new Promise((r) => setTimeout(r, 20));
  engine3.cancel('s2');
  let res2 = null;
  try {
    res2 = await pending2;
  } catch {
    res2 = null;
  }
  assert(dispatches === 1, `an interrupted turn dispatches once, not twice (got ${dispatches})`);
  const got = res2 && res2.choices && res2.choices[0] && res2.choices[0].message
    ? String(res2.choices[0].message.content || '')
    : '';
  const occurrences = (got.match(/partial/g) || []).length;
  assert(occurrences <= 1, `the partial answer is not duplicated (got ${occurrences})`);
}

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

// ---- token usage is the TURN's, not its last round's ----------------------
//
// An agentic turn is one provider call per tool round, and each of those calls
// is billed. The engine used to return the final `res.usage` verbatim, so a
// turn that made N calls reported only the Nth — the tokens the whole tool
// phase cost were invisible. For Anthropic-compatible models (which report
// input_tokens/output_tokens and no `total_tokens`) that meant a turn could
// show nothing at all, which is the reported symptom.
{
  const ROUNDS = 3;
  const usageTools = {
    SUBAGENT_TOOL: 'task',
    MUTATING_TOOLS: new Set(),
    toolsFor: () => [{ type: 'function', function: { name: 'poke', parameters: {} } }],
    async executeTool() {
      return { ok: true, output: 'poked' };
    },
    toolResultText: (r) => r.output,
  };

  // Each round reports a DIFFERENT, recognisable cost so a last-round-only
  // regression is distinguishable from a real sum.
  let round = 0;
  const usageProviders = {
    async anthropicMessages() {
      round += 1;
      const usage = {
        input_tokens: 100 * round,
        output_tokens: 10 * round,
        prompt_tokens: 100 * round,
        completion_tokens: 10 * round,
        total_tokens: 110 * round,
      };
      if (round > ROUNDS) {
        return { model: 'x', choices: [{ message: { content: 'final summary' } }], usage };
      }
      return {
        model: 'x',
        usage,
        choices: [
          {
            message: { content: '', tool_calls: [{ id: `c${round}`, function: { name: 'poke', arguments: '{}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      };
    },
  };

  const usageEngine = createLocalEngine({
    aegis, settings, ollama, providers: usageProviders, tools: usageTools,
  });
  const res = await usageEngine.chat({ class: 'anthropic', prompt: 'work', model: 'claude-x' }, () => {});
  assert(textOf(res) === 'final summary', `turn completed, got ${JSON.stringify(res)}`);
  // Round r reports 100r/10r tokens; the turn runs ROUNDS tool rounds plus the
  // answering pass, so the totals are the sums over r = 1..ROUNDS+1.
  const dispatches = ROUNDS + 1;
  const expected = (per) => (per * dispatches * (dispatches + 1)) / 2;
  assert(
    res.usage.total_tokens === expected(110),
    `usage sums every round of the turn, expected ${expected(110)}, got ${JSON.stringify(res.usage)}`
  );
  assert(res.usage.input_tokens === expected(100), `input tokens summed (${res.usage.input_tokens})`);
  assert(res.usage.output_tokens === expected(10), `output tokens summed (${res.usage.output_tokens})`);
  assert(res.usage.calls === dispatches, `dispatch count recorded (${res.usage.calls})`);
  // The last round alone would be 110*dispatches — the exact value a
  // last-round-only implementation would have reported.
  assert(
    res.usage.total_tokens !== 110 * dispatches,
    'the reported total is the whole turn, not its final round'
  );
}

// A provider that reports the Anthropic split with NO total still yields a
// printable total, because the accumulator derives one.
{
  const splitOnly = {
    async anthropicMessages() {
      return {
        model: 'x',
        choices: [{ message: { content: 'done' } }],
        usage: { input_tokens: 250, output_tokens: 50 },
      };
    },
  };
  const e = createLocalEngine({ aegis, settings, ollama, providers: splitOnly });
  const res = await e.chat({ class: 'anthropic', prompt: 'hi', model: 'claude-x', tools: false }, () => {});
  assert(
    res.usage.total_tokens === 300,
    `total derived from input+output, got ${JSON.stringify(res.usage)}`
  );
}

// A turn whose provider reports no usage attaches none — an unknown count must
// stay unknown rather than being summed into a confident "0 tokens".
{
  const mute = {
    async anthropicMessages() {
      return { model: 'x', choices: [{ message: { content: 'done' } }] };
    },
  };
  const e = createLocalEngine({ aegis, settings, ollama, providers: mute });
  const res = await e.chat({ class: 'anthropic', prompt: 'hi', model: 'claude-x', tools: false }, () => {});
  assert(res.usage === undefined, `no reported usage stays absent, got ${JSON.stringify(res.usage)}`);
}

// ── the whole-file sweep: no aegis path may write, or self-opt into deep ────
//
// Every aegis request this file recorded — the shared stub's calls AND every
// scripted transport's, across plain turns, autonomous turns, tool rounds, the
// doubled-budget retry, the write-up re-dispatch and subagent turns — is swept
// here. A single-sample pin is what lets a write or a metered read re-appear on
// a path nobody sampled, which is exactly how `aegis_memory` survived as a
// default for so long: it was sent once, in the one place, and the one place is
// where the assertion looked.
{
  const recorded = calls
    .filter(([kind, args]) => kind === 'chatCompletion' && args.extra)
    .map(([, args]) => args.extra);
  const all = [...recorded, ...everyAegisRequest];
  // Sanity floor, not a target: if a refactor stops recording, the sweep must
  // fail loudly rather than pass over an empty list.
  assert(all.length >= 10, `the sweep has aegis requests to check: ${all.length}`);
  for (const extra of all) {
    assert(extra.aegis_recall === true,
      `every aegis request sends the READ half: ${JSON.stringify(extra)}`);
    assert(!('aegis_memory' in extra),
      `NO aegis request may send the WRITE half (it charges sync quota and persists the turn): ${JSON.stringify(extra)}`);
    if ('aegis_recall_deep' in extra) {
      assert(extra.aegis_recall_deep === true,
        `the deep flag is only ever sent as an explicit true: ${JSON.stringify(extra)}`);
    }
  }
  // The metered tier must be a small minority of the fleet: exactly one of
  // every request recorded above — the opted-in user turn — can carry it.
  // Counted rather than assumed, because "opt-in only" that quietly became "on
  // for the tool rounds too" would still pass the per-request check above.
  const deepSent = all.filter((e) => e.aegis_recall_deep === true);
  assert(deepSent.length === 1,
    `the deep tier is sent on exactly the opt-in turn, got ${deepSent.length}: ${JSON.stringify(deepSent)}`);
}

// ---- a denial is remembered for the conversation ------------------------
//
// The waste this pins: the gate used to remember "allow for this session" and
// forget "Deny" the moment it was given. The model reads the refusal, re-plans,
// calls the same tool, and the gate raised a SECOND card — so one "no" cost a
// prompt per round for up to maxRounds rounds (24 chat / 40 autonomous), and
// every round is a billed provider call that re-sends the whole conversation.
// Measured on the pre-fix code: two model rounds, two approval cards, for one
// user decision.
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
    toolResultText: (r) => (r.ok ? String(r.output) : `error: ${r.error}`),
  };
  // The model calls the SAME tool on rounds 1 and 2 — exactly what a capable
  // agent does with a tool result that just says the call failed.
  const retrying = () => {
    let n = 0;
    const seen = [];
    return {
      seen,
      reset() {
        n = 0;
        seen.length = 0;
      },
      async openaiCompatible(args) {
        seen.push(args);
        n += 1;
        if (n <= 2) {
          return {
            model: 'x',
            choices: [{
              message: { content: '', tool_calls: [{ id: `c${n}`, function: { name: 'poke', arguments: '{}' } }] },
              finish_reason: 'tool_calls',
            }],
          };
        }
        return { model: 'x', choices: [{ message: { content: 'stopped' }, finish_reason: 'stop' }] };
      },
    };
  };

  {
    const prov = retrying();
    const e = createLocalEngine({ aegis, settings, ollama, providers: prov, tools: mutatingTools });
    const cards = [];
    const res = await e.chat({ class: 'openai-compat', prompt: 'do it', model: 'x', sessionId: 's-deny' },
      (chunk) => {
        if (chunk && chunk.approval) {
          cards.push(chunk.approval);
          e.respondApproval(chunk.approval.id, 'deny');
        }
      });
    assert(cards.length === 1,
      `one denial asks once, not once per model retry (got ${cards.length} cards)`);
    assert(execCalls.length === 0, `a denied tool never runs (got ${JSON.stringify(execCalls)})`);
    assert(prov.seen.length === 3, `the retry still reaches the model, then it stops (got ${prov.seen.length} dispatches)`);
    // The refusal the second round received must tell the model to stop, not
    // read as a transient failure worth another route.
    const wire = JSON.stringify(prov.seen[1] || {});
    assert(/Do NOT retry/.test(wire), `the denial forbids a retry: ${wire.slice(0, 400)}`);
    assert(!/user denied the request/.test(wire),
      'the old retry-inviting wording is gone');

    // A fresh conversation starts from a clean gate in BOTH directions: the
    // refusal must not survive into a thread where the user never said no.
    e.clearSessionApprovals('s-deny');
    prov.reset();
    execCalls.length = 0;
    const after = [];
    await e.chat({ class: 'openai-compat', prompt: 'do it', model: 'x', sessionId: 's-deny' },
      (chunk) => {
        if (chunk && chunk.approval) {
          after.push(chunk.approval);
          e.respondApproval(chunk.approval.id, 'deny');
        }
      });
    assert(after.length === 1, `clearing the conversation re-opens the gate (got ${after.length} cards)`);
  }

  // The denial is per conversation, not global: a DIFFERENT session is
  // unaffected by another thread's refusal.
  {
    const prov = retrying();
    const e = createLocalEngine({ aegis, settings, ollama, providers: prov, tools: mutatingTools });
    const cards = [];
    await e.chat({ class: 'openai-compat', prompt: 'do it', model: 'x', sessionId: 's-a' },
      (chunk) => { if (chunk && chunk.approval) { cards.push(chunk.approval.id); e.respondApproval(chunk.approval.id, 'deny'); } });
    const other = [];
    prov.reset();
    await e.chat({ class: 'openai-compat', prompt: 'do it', model: 'x', sessionId: 's-b' },
      (chunk) => {
        if (chunk && chunk.approval) {
          other.push(chunk.approval.id);
          e.respondApproval(chunk.approval.id, 'once');
        }
      });
    assert(cards.length === 1 && other.length >= 1,
      `a refusal is scoped to its own conversation — the refused thread asks once (a=${cards.length}), the other still asks (b=${other.length})`);
  }

  // Turning the gate OFF overrides an earlier refusal — that switch is an
  // explicit "run everything", so it must not be blocked by a stale denial.
  {
    let confirm = true;
    const prov = retrying();
    const e = createLocalEngine({
      aegis, settings, ollama, providers: prov, tools: mutatingTools,
      getConfirmMode: () => confirm,
    });
    // execCalls is shared across every block in this file; the previous
    // conversation answered 'once' and left a call behind. Clear it so this
    // assertion measures THIS block, not the last one.
    execCalls.length = 0;
    await e.chat({ class: 'openai-compat', prompt: 'do it', model: 'x', sessionId: 's-off' },
      (chunk) => { if (chunk && chunk.approval) e.respondApproval(chunk.approval.id, 'deny'); });
    assert(execCalls.length === 0, 'refused while the gate is up');
    confirm = false;
    execCalls.length = 0;
    // The stub is round-counted, and the denials above already burned its
    // tool-call rounds; without this the second turn opens on 'stop' and never
    // emits a call, so a green assertion here would prove nothing.
    prov.reset();
    let gateCards = 0;
    await e.chat({ class: 'openai-compat', prompt: 'do it', model: 'x', sessionId: 's-off' },
      (chunk) => { if (chunk && chunk.approval) gateCards += 1; });
    assert(gateCards === 0, 'with confirm mode off no card is raised');
    assert(execCalls.length >= 1, `confirm mode off runs the tool despite the earlier denial (${execCalls.length})`);
  }

  // An UNANSWERED request (the turn was cancelled with the card still open) is
  // not a decision. It must refuse that call but leave no durable "no" behind,
  // or a cancelled turn would silently forbid a tool forever.
  {
    const prov = retrying();
    const e = createLocalEngine({ aegis, settings, ollama, providers: prov, tools: mutatingTools });
    const first = [];
    await e.chat({ class: 'openai-compat', prompt: 'do it', model: 'x', sessionId: 's-cancel' },
      (chunk) => {
        if (chunk && chunk.approval) {
          first.push(chunk.approval.id);
          e.cancel('s-cancel'); // walk away without answering
        }
      });
    assert(first.length === 1, `the card was raised before the cancel (got ${first.length})`);
    const again = [];
    // Same stalled-stub trap: reset so the retry turn actually reaches a tool
    // call. Zero cards here would otherwise pass for the wrong reason.
    prov.reset();
    await e.chat({ class: 'openai-compat', prompt: 'do it', model: 'x', sessionId: 's-cancel' },
      (chunk) => { if (chunk && chunk.approval) { again.push(chunk.approval.id); e.respondApproval(chunk.approval.id, 'deny'); } });
    assert(again.length === 1,
      `an unanswered request is not remembered as a denial (got ${again.length} cards on the retry)`);
  }
}

// ---- byok class: catalog-driven models, per-provider local keys -----------
{
  const catalog = {
    providers: [
      { id: 'anthropic', label: 'Anthropic', models: ['claude-sonnet-5'] },
      { id: 'deepseek', label: 'DeepSeek', models: ['deepseek-v4-flash'] },
    ],
  };
  const byokCalls = [];
  const byokAegis = {
    apiKey: 'aegis-key',
    async byokProviders() { return catalog; },
    async byokChatCompletion(args) {
      byokCalls.push(args);
      if (args.onStream) args.onStream({ delta: 'hi' });
      return { model: args.model, choices: [{ message: { content: 'hi' } }] };
    },
  };
  // A tiny real store (keyed by the namespace string) instead of a constant
  // stub: byok needs a DIFFERENT key per provider, which the constant mock
  // used elsewhere in this file cannot express.
  const store = new Map();
  const byokSettings = {
    get: (p) => ({ provider: p, baseURL: '', configured: store.has(p), keyMask: store.has(p) ? 'sk-…' : null }),
    set: (p, { key } = {}) => { if (key) store.set(p, key); else store.delete(p); return byokSettings.get(p); },
    rawKey: (p) => store.get(p) || null,
    remove: (p) => { store.delete(p); return { ok: true }; },
    list: () => Array.from(store.keys()).map((p) => byokSettings.get(p)),
  };
  const eng = createLocalEngine({ aegis: byokAegis, settings: byokSettings, ollama, providers });

  // listModels builds compound "provider:model" ids from the live catalog,
  // and reports each one's OWN configured state from the local store — not
  // the (irrelevant here) server-side stored-key mechanism's flag.
  const before = await eng.listModels('byok');
  assert(before.models.length === 2, `byok lists every catalog model, got ${before.models.length}`);
  assert(before.models.some((m) => m.id === 'anthropic:claude-sonnet-5'), 'anthropic model is offered');
  assert(before.models.every((m) => m.configured === false), 'nothing configured yet');
  assert(before.needsProviderKey === true, 'needsProviderKey is set when no provider has a key');

  // A turn with no key stored for the chosen provider must refuse before ever
  // reaching the relay — an unconfigured class silently calling the relay
  // with providerKey: undefined is exactly the old "undefined" defect.
  let refused = null;
  try {
    await eng.chat({ class: 'byok', model: 'anthropic:claude-sonnet-5', prompt: 'hi' }, () => {});
  } catch (e) { refused = e; }
  assert(refused && /no key saved/.test(refused.message), `unconfigured provider is refused, got ${refused && refused.message}`);
  assert(byokCalls.length === 0, 'the relay is never called for an unconfigured provider');

  // Saving a key through the SAME generic settings surface openai-compat/
  // anthropic already use (namespaced byok:<provider>) is what listModels and
  // chat both read from.
  await eng.settings.set('byok:anthropic', { key: 'sk-ant-real' });
  const after = await eng.listModels('byok');
  assert(after.models.find((m) => m.id === 'anthropic:claude-sonnet-5').configured === true,
    'the model is configured once its provider has a stored key');
  assert(after.models.find((m) => m.id === 'deepseek:deepseek-v4-flash').configured === false,
    'a different provider is unaffected');
  assert(after.needsProviderKey === false, 'needsProviderKey clears once any provider is configured');

  await eng.chat({ class: 'byok', model: 'anthropic:claude-sonnet-5', prompt: 'hi' }, () => {});
  assert(byokCalls.length === 1, 'the relay is called once a key is configured');
  const call = byokCalls[0];
  assert(call.provider === 'anthropic', `provider is split off the compound id, got ${call.provider}`);
  assert(call.model === 'claude-sonnet-5', `bare model id reaches the relay, got ${call.model}`);
  assert(call.providerKey === 'sk-ant-real', 'the LOCALLY stored provider key is what is sent, never the AEGIS key');

  // byok never sends tool schemas — the relay has no tools/tool_choice param,
  // so promising them would be a silent lie about what the model can do.
  const toolResult = await eng.chat(
    { class: 'byok', model: 'anthropic:claude-sonnet-5', prompt: 'hi', tools: undefined }, () => {}
  );
  assert(toolResult && !toolResult.error, 'a byok turn still succeeds with tools implicitly requested');

  // A malformed model id (no "provider:model" shape) is refused in-process
  // rather than sent upstream as a bare, meaningless string.
  let badModel = null;
  try {
    await eng.chat({ class: 'byok', model: 'claude-sonnet-5', prompt: 'hi' }, () => {});
  } catch (e) { badModel = e; }
  assert(badModel && /provider.*model/.test(badModel.message), `a bare model id is refused, got ${badModel && badModel.message}`);
}

console.log('engine tests passed');
