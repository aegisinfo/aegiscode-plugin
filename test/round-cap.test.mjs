/**
 * A turn must have a horizon.
 *
 * aegiscodex-dev has capped tool rounds all along (24 chat / 40 autonomous,
 * src/autonomous.js). This engine removed its cap entirely — the comment said
 * 12 rounds "cut off genuinely long research", which was true and left the
 * turn unbounded. On 2026-09-15 "can you check the plan" ran ~70 rounds, grew
 * the context from 2,260 to 116,011 tokens and cost about EUR 2 for one
 * question. Each round re-sends the whole conversation, so an unbounded loop
 * gets more expensive the longer it runs.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createLocalEngine } = require(join(root, 'desktop', 'lib', 'local', 'engine.js'));

function assert(c, m) { if (!c) throw new Error(`ASSERT FAILED: ${m}`); }
const eq = (a, b, m) => assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/** A provider that calls a tool forever — the runaway this bound exists for. */
function neverStops() {
  let n = 0;
  return {
    async chat() {
      n += 1;
      return {
        model: 'fake',
        usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 },
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: `c${n}`, function: { name: 'listDir', arguments: '{"path":"."}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      };
    },
    calls: () => n,
  };
}

async function runWith(env, payload = {}) {
  const provider = neverStops();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const engine = createLocalEngine({
      aegis: { chatCompletion: (o) => provider.chat(o) },
      ollama: {},
      providers: {
        openaiCompatible: (o) => provider.chat(o),
        anthropicMessages: (o) => provider.chat(o),
      },
    });
    const res = await engine.chat(
      { class: 'aegis', prompt: 'check the plan', sessionId: 's1', ...payload },
      () => {}
    );
    return { res, rounds: provider.calls() };
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// ── a runaway stops, and says why ──────────────────────────────────────────
{
  const { res, rounds } = await runWith({ AEGIS_CHAT_MAX_ROUNDS: '5' });
  assert(rounds <= 6, `runaway must stop near the cap, ran ${rounds} rounds`);
  const text = res && res.choices && res.choices[0] && res.choices[0].message.content;
  assert(/stopped at 5 tool rounds/.test(text || ''), `must say why it stopped: ${text}`);
  assert(/AEGIS_CHAT_MAX_ROUNDS/.test(text || ''), 'and name the knob to raise');
  eq(res.stoppedOnRounds, true, 'the caller can tell this was a horizon, not an answer');
}

// ── the turn's real usage still comes back ─────────────────────────────────
{
  const { res } = await runWith({ AEGIS_CHAT_MAX_ROUNDS: '3' });
  assert(res.usage && res.usage.total_tokens > 0,
    'a stopped turn must still report what it spent — silence here is how a bill surprises you');
}

// ── autonomous gets the longer horizon, matching aegiscodex-dev ────────────
{
  const chat = await runWith({ AEGIS_CHAT_MAX_ROUNDS: '2', AEGIS_AUTONOMOUS_MAX_ROUNDS: '7' });
  const auto = await runWith(
    { AEGIS_CHAT_MAX_ROUNDS: '2', AEGIS_AUTONOMOUS_MAX_ROUNDS: '7' },
    { autonomous: true }
  );
  assert(auto.rounds > chat.rounds,
    `autonomous must get more room (chat ${chat.rounds}, auto ${auto.rounds})`);
}

console.log('round-cap tests passed');
