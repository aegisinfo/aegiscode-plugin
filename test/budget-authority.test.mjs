#!/usr/bin/env node
/**
 * The budget has exactly ONE authority per call, and a reasoned-out rung is
 * never laundered into "the caller stated this cap".
 *
 * engine.js resolves a budget from three inputs (a caller-stated cap, the
 * /effort rung, the model id) and the pooled class must treat the two facts
 * differently: a STATED cap is a liability ceiling aegis1 honours downward
 * (`pass_budgets`: total = min(ladder, max_tokens x passes)), while an
 * effort-derived rung is the server's own arithmetic stated twice — sending it
 * is what let the client and server copies of the ladder drift apart.
 *
 * The laundering bug this pins: `chat()` derives `maxTokens` via
 * reasoningBudget() (8192/16384/32768 for a DeepSeek reasoning id), the tool
 * loop hands that SAME value to runSubagent(), and runSubagent() re-enters
 * chat() with it as `payload.maxTokens` — where it is re-read as the caller's
 * own number and shipped to aegis1 as `max_tokens`. So every subagent turn
 * silently capped the pool's effort ladder at a number the client guessed, and
 * a high-effort subagent ran at the low rung's 8192.
 *
 * The rule asserted here: a number the caller did not state never appears as
 * `max_tokens` on a pooled request — but the effort rung, which is the real
 * authority, still travels.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLocalEngine } = require('../desktop/lib/local/engine.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** Tool module whose single tool is the subagent spawner. */
const SUBAGENT_TOOL = 'task';
const tools = {
  SUBAGENT_TOOL,
  MUTATING_TOOLS: new Set(),
  toolsFor: () => [
    { type: 'function', function: { name: SUBAGENT_TOOL, parameters: { type: 'object', properties: {} } } },
  ],
  async executeTool() {
    return { ok: true, output: 'unused — the task tool never reaches this path' };
  },
  toolResultText: (r) => (r && r.output) || '',
};

const settings = { get: () => ({}), rawKey: () => 'k' };

/**
 * Drive one turn that spawns a subagent. Returns every pooled request the
 * engine made, in order: [top-level round 1, subagent round 1, top-level
 * round 2 (the write-up)].
 */
async function runTurn(payload) {
  const sent = [];
  let n = 0;
  const aegis = {
    apiKey: 'k',
    async listModels() {
      return { models: [{ id: 'nexus-brain', label: 'NEXUS', tier: 'brain' }] };
    },
    async chatCompletion(args) {
      sent.push(args);
      n += 1;
      if (n === 1) {
        return {
          model: args.model,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  { id: 'c1', function: { name: SUBAGENT_TOOL, arguments: '{"description":"dig"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        };
      }
      return {
        model: args.model,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        choices: [{ message: { content: `answer ${n}` }, finish_reason: 'stop' }],
      };
    },
  };
  const engine = createLocalEngine({
    aegis,
    settings,
    ollama: { async probe() { return { running: false }; }, async listTags() { return []; }, async chat() { throw new Error('unused'); } },
    // A custom class would use this; the pooled class must not.
    providers: {
      async openaiCompatible() { throw new Error('the pooled class must not reach providers.openaiCompatible'); },
      async anthropicMessages() { throw new Error('the pooled class must not reach providers.anthropicMessages'); },
    },
    tools,
  });
  await engine.chat(payload, () => {});
  return sent;
}

// ── 1. A subagent inherits the rung, not a guessed ceiling ──────────────────
{
  const sent = await runTurn({ class: 'aegis', prompt: 'go', model: 'nexus-brain', effort: 'high' });
  assert(sent.length === 3, `expected 3 pooled requests (top, subagent, write-up), got ${sent.length}`);

  const sub = sent[1];
  assert(
    sub.maxTokens === undefined,
    `a subagent must send no max_tokens the caller never stated, got ${sub.maxTokens}`
  );
  assert(
    !('max_tokens' in (sub.body || {})),
    `and nothing may synthesise the field downstream: ${JSON.stringify(sub.body)}`
  );
  // The status quo was `maxTokens: 32768` on this request — the high rung
  // reasoned out locally and re-read as a caller cap by aegis1.
  assert(
    sub.maxTokens !== 32768,
    'the high rung must not reach the wire as a caller-stated cap'
  );
  // The rung is still the authority: it travels as `effort`, which is what
  // aegis1 sizes the fan-out and its ladder from.
  assert(
    sub.extra && sub.extra.effort === 'high',
    `the subagent inherits the rung: ${JSON.stringify(sub.extra)}`
  );
}

// ── 2. A cap the caller DID state still reaches the subagent ────────────────
{
  const sent = await runTurn({ class: 'aegis', prompt: 'go', model: 'nexus-brain', maxTokens: 2048 });
  assert(sent[0].maxTokens === 2048, `round 1 keeps the caller's cap, got ${sent[0].maxTokens}`);
  assert(
    sent[1].maxTokens === 2048,
    `a stated cap is a liability ceiling and applies to the subagent too, got ${sent[1].maxTokens}`
  );
}

// ── 3. Nothing invents a ceiling when the caller stated none ────────────────
{
  const sent = await runTurn({ class: 'aegis', prompt: 'go', model: 'nexus-brain' });
  for (const [i, req] of sent.entries()) {
    assert(
      req.maxTokens === undefined,
      `request ${i} of an unpinned pooled turn sends no max_tokens, got ${req.maxTokens}`
    );
  }
}

console.log('Budget-authority tests passed: effort is the only pooled budget; no guessed cap is laundered into a caller-stated one.');
