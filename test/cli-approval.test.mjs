#!/usr/bin/env node
/**
 * The CLI's approval vocabulary, pinned against the engine that consumes it.
 *
 * What it pins: that every token `chatflow.js` can answer with is a token the
 * VENDORED engine actually honours. This is the regression guard for a bug that
 * was invisible and expensive — the confirm overlay used to resolve `'allow'`,
 * the desktop renderer's word for "yes" rather than the engine's. The engine
 * accepts only `'once'` and `'session'` and coerces everything else to `'deny'`
 * (see respondApproval in cli/vendor/desktop/lib/local/engine.js), so pressing
 * "1. Yes" denied the tool anyway. The model then read "the user denied the
 * request", re-planned, and called the gate again — burning rounds of tokens to
 * accomplish nothing, with no message ever explaining why.
 *
 * The guard drives the real vendored engine rather than grepping for tokens,
 * because a source-text assertion happily passes while the behaviour is wrong.
 *
 * House style: ESM test file, CommonJS modules pulled in with createRequire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The vendored copies — the code the shipped CLI actually runs.
const { createLocalEngine } = require(join(__dirname, '..', 'cli', 'vendor', 'desktop', 'lib', 'local', 'engine.js'));
const chatflow = require(join(__dirname, '..', 'cli', 'src', 'chatflow.js'));
const app = require(join(__dirname, '..', 'cli', 'src', 'app.js'));

const settings = {
  get: () => ({ baseURL: 'http://local', configured: true, keyMask: 'sk-…' }),
  rawKey: () => 'raw-key',
};
const aegis = { apiKey: 'k' };
const ollama = { async probe() { return { running: true }; }, async listTags() { return []; } };

/**
 * A provider that asks for `exec` on round 1 and stops on round 2 — so a single
 * approval decides the turn.
 */
function oneShotProvider() {
  let n = 0;
  return {
    reset() { n = 0; },
    async openaiCompatible() {
      n += 1;
      if (n === 1) {
        return {
          model: 'x',
          choices: [{
            message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'exec', arguments: '{"command":"ls"}' } }] },
            finish_reason: 'tool_calls',
          }],
        };
      }
      return { model: 'x', choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] };
    },
  };
}

/** Build an engine whose only tool is a mutating `exec`, recording each run. */
function harness() {
  const ran = [];
  const tools = {
    SUBAGENT_TOOL: 'task',
    MUTATING_TOOLS: new Set(['exec']),
    toolsFor: () => [{ type: 'function', function: { name: 'exec', parameters: {} } }],
    async executeTool(name, args) { ran.push([name, args]); return { ok: true, output: 'ran' }; },
    toolResultText: (r) => r.output,
  };
  const provider = oneShotProvider();
  const engine = createLocalEngine({ aegis, settings, ollama, providers: provider, tools });
  /** Drive one turn, answering every approval card with `decision`. */
  const turn = async (decision, sessionId = 's') => {
    const cards = [];
    await engine.chat({ class: 'openai-compat', prompt: 'do it', model: 'x', sessionId }, (chunk) => {
      if (chunk && chunk.approval) {
        cards.push(chunk.approval);
        if (decision) engine.respondApproval(chunk.approval.id, decision);
      }
    });
    return cards;
  };
  return { ran, provider, engine, turn };
}

test('the CLI answers with tokens the engine honours, and never the desktop-only word "allow"', () => {
  const decisions = chatflow.APPROVAL_DECISIONS;
  assert.deepEqual(decisions, ['once', 'session', 'deny'],
    `the CLI must speak the engine's dialect exactly (got ${JSON.stringify(decisions)})`);
  assert.ok(!decisions.includes('allow'),
    "'allow' is the desktop renderer's word; respondApproval coerces it to 'deny'");
});

test('a CLI "once" actually runs the tool in the vendored engine', async () => {
  const h = harness();
  const cards = await h.turn('once');
  assert.equal(cards.length, 1, 'the mutating call raised exactly one approval card');
  assert.equal(h.ran.length, 1, `answering 'once' ran the tool (ran ${h.ran.length}x)`);
});

test("a CLI 'session' runs the tool and stops asking for it in the same conversation", async () => {
  const h = harness();
  const first = await h.turn('session');
  assert.equal(first.length, 1, 'session approval asks once');
  assert.equal(h.ran.length, 1, "answering 'session' ran the tool");

  // A second turn in the SAME conversation must not re-prompt for `exec`.
  h.provider.reset();
  const again = await h.turn(null, 's');
  assert.equal(again.length, 0, "the session allow is remembered — no second card");
  assert.equal(h.ran.length, 2, 'the tool ran again unattended');
});

test("a CLI 'deny' does not run the tool", async () => {
  const h = harness();
  const cards = await h.turn('deny');
  assert.equal(cards.length, 1, 'the card was raised');
  assert.equal(h.ran.length, 0, 'a denied tool never executes');
});

test('normalizeDecision bridges foreign prompter vocabulary into the engine dialect', () => {
  const expected = {
    once: 'once',
    session: 'session',
    allow: 'once',      // the desktop's word for yes
    yes: 'once',
    approve: 'once',
    approved: 'once',
    ' ONCE ': 'once',   // trimmed + lowercased
    deny: 'deny',
    no: 'deny',
    '': 'deny',
  };
  for (const [input, want] of Object.entries(expected)) {
    assert.equal(app.normalizeDecision(input), want,
      `normalizeDecision(${JSON.stringify(input)}) should be ${JSON.stringify(want)}`);
  }
  assert.equal(app.normalizeDecision(undefined), 'deny', 'a missing answer is a refusal, never an allow');
  assert.equal(app.normalizeDecision(null), 'deny', 'null is a refusal');
});

test('the confirm overlay renders one option per decision, in order', () => {
  const overlay = { type: 'confirm', name: 'exec', args: { command: 'rm -rf /tmp/x' }, sel: 0 };
  const flat = chatflow.confirmLines(overlay, 80, {}).map((line) => line.map((sp) => sp.t).join('')).join('\n');
  chatflow.APPROVAL_CHOICES.forEach((label, i) => {
    assert.ok(flat.includes(`${i + 1}. `), `option ${i + 1} is numbered`);
  });
  assert.ok(flat.includes('Yes'), 'the yes option is present');
  assert.ok(flat.includes('No'), 'the no option is present');
  assert.ok(/allow exec for this session/.test(flat),
    'the session option names the tool it will stop asking about');
  assert.equal(chatflow.APPROVAL_CHOICES.length, chatflow.APPROVAL_DECISIONS.length,
    'every rendered option maps to exactly one decision token');
});
