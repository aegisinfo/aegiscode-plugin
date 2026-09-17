/**
 * The tool-round cap as session state rather than turn state.
 *
 * Regression target: a turn cut off at its horizon used to end the job — the
 * next turn started cold and re-did or dropped the unfinished work. These
 * cases pin the ledger that holds the interruption across turns, and pin the
 * engine wiring that feeds it (a bad `require` or a renamed field would
 * otherwise only surface as a runtime crash inside a live turn).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const rounds = require(path.join(here, '../desktop/lib/local/session-rounds.js'));
const engine = require(path.join(here, '../desktop/lib/local/engine.js'));

test('the engine loads and still exports its factory', () => {
  assert.equal(typeof engine.createLocalEngine, 'function');
  assert.equal(typeof engine.CLASSES, 'object');
});

test('an interruption is held, and a second take gets nothing', () => {
  rounds.reset();
  const held = rounds.record('s:abc', { rounds: 24, tokens: 12345, note: 'stopped' });
  assert.equal(held.rounds, 24);
  assert.equal(held.interruptions, 1, 'first cut-off in the chain');

  // Peeking must not consume: the entry stays resumable.
  assert.equal(rounds.peek('s:abc').rounds, 24);
  const taken = rounds.take('s:abc');
  assert.equal(taken.tokens, 12345);
  assert.equal(rounds.take('s:abc'), null, 'consumed — one resume per interruption');
  assert.equal(rounds.peek('s:abc'), null);
});

test('the chain counter survives the resume', () => {
  rounds.reset();
  rounds.record('s:x', { rounds: 24 });
  const first = rounds.take('s:x');
  rounds.record('s:x', { rounds: 30, chain: first.interruptions });
  assert.equal(rounds.peek('s:x').interruptions, 2);
});

test('a fresh key per turn is bridged by adopt()', () => {
  rounds.reset();
  rounds.record('hist-1', { rounds: 24 });
  const adopted = rounds.adopt();
  assert.equal(adopted.key, 'hist-1');
  assert.equal(adopted.entry.rounds, 24);
  assert.equal(rounds.adopt(), null, 'consumed');
});

test('adopt() ignores work too old to belong to this conversation', () => {
  rounds.reset();
  rounds.record('hist-1', { rounds: 24 }, Date.now() - 30 * 60 * 1000 - 1);
  assert.equal(rounds.adopt(), null);
});

test('adopt() prefers the most recent interruption', () => {
  rounds.reset();
  const now = Date.now();
  rounds.record('old', { rounds: 24 }, now - 60_000);
  rounds.record('new', { rounds: 40 }, now - 1_000);
  assert.equal(rounds.adopt().key, 'new');
  assert.equal(rounds.adopt().key, 'old');
});

test('entries expire, and the map stays bounded', () => {
  rounds.reset();
  rounds.record('stale', { rounds: 24 }, Date.now() - rounds.TTL_MS - 1);
  assert.equal(rounds.state().size, 0, 'expired entries fall out on read');

  for (let i = 0; i < rounds.MAX_ENTRIES + 6; i += 1) rounds.record(`k${i}`, { rounds: i });
  assert.equal(rounds.state().size, rounds.MAX_ENTRIES, 'the oldest are evicted');
  assert.equal(rounds.peek(`k${rounds.MAX_ENTRIES + 5}`).rounds, rounds.MAX_ENTRIES + 5, 'newest survives');
});

test('the resume bonus is small and never zero', () => {
  rounds.reset();
  assert.equal(rounds.bonus(24), 6);
  assert.equal(rounds.bonus(40), 10);
  assert.equal(rounds.bonus(1), 4, 'a tiny horizon still gets something usable');
  assert.ok(rounds.bonus(24) < 24, 'a resume is a continuation, not a second full turn');
  assert.equal(rounds.bonus(0), 4);
});

test('the preamble asks for continuation, not a restart', () => {
  rounds.reset();
  const text = rounds.resumePreamble(rounds.record('s:abc', { rounds: 24, tokens: 9000 }));
  assert.match(text, /session resume/);
  assert.match(text, /24 tool rounds/);
  assert.match(text, /9,000 tokens/);
  assert.match(text, /do not restart/i);
  assert.match(text, /unfinished/i);
});

test('a stated session id outranks cwd and history', () => {
  rounds.reset();
  const history = [];
  assert.equal(rounds.keyFor({ sessionId: 'chat-1', cwd: '/tmp' }, history), 's:chat-1');
  assert.equal(rounds.keyFor({ cwd: '/tmp' }, history), 'cwd:/tmp');
  const a = rounds.keyFor({}, history);
  assert.equal(rounds.keyFor({}, history), a, 'the same history array keeps its key');
  assert.notEqual(rounds.keyFor({}, []), a, 'a new conversation gets its own key');
  assert.equal(rounds.keyFor(undefined, undefined), 'default');
});

// ── the wiring, end to end ────────────────────────────────────────────────
//
// A provider that only ever calls a tool never ends a turn by itself, which is
// exactly the shape that used to be truncated: the first turn must stop at its
// horizon AND file the interruption, and the next turn on the same session
// must come back carrying the continuation preamble instead of starting cold.
{
  const requests = [];
  const stubs = () => ({
    settings: { get: () => ({ baseURL: 'http://local', configured: true }), rawKey: () => 'k' },
    ollama: { async probe() { return { running: false }; }, async listTags() { return []; } },
    providers: {},
  });

  const neverFinishes = {
    apiKey: 'k',
    async chatCompletion(args) {
      requests.push(args);
      return {
        model: args.model,
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: `call-${requests.length}`,
              type: 'function',
              function: { name: 'listDir', arguments: JSON.stringify({ path: '.' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
    },
  };

  const eng = engine.createLocalEngine({
    aegis: neverFinishes,
    ...stubs(),
    getConfirmMode: () => false,
  });

  rounds.reset();
  const previous = process.env.AEGIS_CHAT_MAX_ROUNDS;
  process.env.AEGIS_CHAT_MAX_ROUNDS = '2';
  const first = await eng.chat({ class: 'aegis', prompt: 'hi', model: 'm1', sessionId: 'resume-s1' }, () => {});
  delete process.env.AEGIS_CHAT_MAX_ROUNDS;

  assert.equal(first.stoppedOnRounds, true, 'turn 1 stops at the horizon');
  assert.equal(first.heldForSession, true, 'and files the work against the session');
  assert.equal(first.heldRounds, 2);
  assert.equal(first.sessionInterruptions, 1);
  assert.equal(requests.length, 2, 'a stated horizon is honoured exactly');
  assert.equal(rounds.peek('s:resume-s1').rounds, 2, 'the interruption is held, not just reported');

  const before = requests.length;
  const second = await eng.chat({ class: 'aegis', prompt: 'keep going', model: 'm1', sessionId: 'resume-s1' }, () => {});

  assert.match(requests[before].prompt, /\[session resume\]/, 'turn 2 dispatches with the continuation preamble');
  assert.match(requests[before].prompt, /2 tool rounds/, 'and says where the previous turn was cut off');
  assert.match(requests[before].prompt, /do not restart/i);
  assert.match(requests[before].prompt, /keep going/, 'the new ask is still there, below the preamble');
  assert.equal(
    requests.length - before,
    30,
    'a resumed turn gets the chat horizon (24) plus the bonus (6) — the bonus pads re-orientation only',
  );
  assert.equal(second.sessionInterruptions, 2, 'the chain count survives the resume');
  assert.equal(second.heldRounds, 30);
  assert.equal(rounds.peek('s:resume-s1').rounds, 30, 'the re-interruption is filed for the next turn');

  // An explicitly stated horizon still wins over the bonus: env is the user
  // overriding the engine, and the ledger may not pad it away.
  process.env.AEGIS_CHAT_MAX_ROUNDS = '3';
  const mark = requests.length;
  const third = await eng.chat({ class: 'aegis', prompt: 'again', model: 'm1', sessionId: 'resume-s1' }, () => {});
  assert.equal(requests.length - mark, 3, 'a stated horizon is exact even on a resume');
  assert.match(requests[mark].prompt, /\[session resume\]/, 'the preamble still applies');
  assert.equal(third.sessionInterruptions, 3, 'the chain keeps counting');

  if (previous === undefined) delete process.env.AEGIS_CHAT_MAX_ROUNDS;
  else process.env.AEGIS_CHAT_MAX_ROUNDS = previous;
  rounds.reset();
}
