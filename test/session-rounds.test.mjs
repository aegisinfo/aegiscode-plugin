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
      // SNAPSHOT, not a reference. `args.messages` is the engine's live
      // `history` array: the turn keeps pushing tool calls and results into
      // that same array after this returns, so storing `args` and reading
      // `.messages` later measures what the turn ENDED with, not what it was
      // DISPATCHED with. Every length assertion below is about the dispatch,
      // so the copy is load-bearing — without it `>= 2` is true for free.
      requests.push({ ...args, messages: (args.messages || []).map((m) => ({ ...m })) });
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
  // The preamble text alone only says HOW MUCH was done, not WHAT. A resume
  // with no real memory of the tool calls/results already made is a cold
  // start wearing a note — this is the actual transcript, held alongside it.
  //
  // Captured here, before turn 2 runs: the record is per-session and turn 2
  // will overwrite it, so this is turn 1's transcript and the length turn 2
  // must open on.
  const heldTranscriptLength = rounds.peek('s:resume-s1').messages.length;
  assert.ok(
    heldTranscriptLength >= 2,
    'the interruption holds the actual tool-call transcript, not just a summary',
  );
  assert.ok(
    rounds.peek('s:resume-s1').messages.some((m) => m.role === 'tool'),
    'the held transcript includes the tool results, not just the assistant side',
  );

  const before = requests.length;
  const second = await eng.chat({ class: 'aegis', prompt: 'keep going', model: 'm1', sessionId: 'resume-s1' }, () => {});

  assert.match(requests[before].prompt, /\[session resume\]/, 'turn 2 dispatches with the continuation preamble');
  assert.match(requests[before].prompt, /2 tool rounds/, 'and says where the previous turn was cut off');
  assert.match(requests[before].prompt, /do not restart/i);
  assert.match(requests[before].prompt, /keep going/, 'the new ask is still there, below the preamble');
  // The whole point: turn 2's OWN dispatch actually carries the restored
  // transcript as `messages` (a queue task sends none of its own, so this is
  // the only way the model can see what it already did) — not just a preamble
  // string asserting that memory exists.
  //
  // Exactly turn 1's transcript and nothing else: this caller sends no
  // conversation of its own, so the restored record IS the whole history at
  // round 1. Pinned, not bounded — a bound here passed even when the array was
  // read live, which is precisely the defect the snapshot above fixes.
  assert.equal(
    requests[before].messages.length,
    heldTranscriptLength,
    `turn 2 opens on exactly turn 1's transcript (got ${requests[before].messages.length}, want ${heldTranscriptLength})`,
  );
  assert.ok(
    requests[before].messages.some((m) => m.role === 'tool'),
    'including the actual tool results from turn 1, not a text summary of them',
  );
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

// ── the interactive path: the caller already holds half the transcript ─────
//
// The wiring above drives the QUEUE shape — a caller that sends no
// conversation of its own, so the resume must restore the WHOLE transcript.
// The sessions this feature is actually used from are the other shape: the
// desktop renderer sends `messages: threadMessages.slice()`
// (desktop/renderer/app.js:2882), so a turn arrives with the conversation so
// far already in `history`, and the interrupted turn's internal tool work —
// the part the renderer never saw — is the only thing missing.
//
// That branch needs the opposite half of the record. Restoring the full
// transcript into a history that already holds the user's own turns sends
// every one of them back to the model a second time, and the damage
// compounds: each interruption re-records the transcript it was handed, so a
// chain of resumes grows the conversation quadratically. The `added` half
// exists for this, and until now nothing drove it.
test('an interactive resume restores only the interrupted turn\'s delta', async () => {
  const requests = [];
  const stubs = () => ({
    settings: { get: () => ({ baseURL: 'http://local', configured: true }), rawKey: () => 'k' },
    ollama: { async probe() { return { running: false }; }, async listTags() { return []; } },
    providers: {},
  });

  // Only ever calls a tool, so every turn ends at its horizon rather than
  // finishing — the shape that makes a chain of interruptions observable.
  const neverFinishes = {
    apiKey: 'k',
    async chatCompletion(args) {
      // Same snapshot as above, and here it is the entire point: the delta
      // assertions compare the DISPATCHED length against the caller's history
      // plus the held delta. Read live, every one of them is off by whatever
      // the turn appended after being sent.
      requests.push({ ...args, messages: (args.messages || []).map((m) => ({ ...m })) });
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

  // The renderer's thread as it stands when the user sends turn 1.
  const HISTORY_1 = [
    { role: 'user', content: 'PRIOR-USER-TURN' },
    { role: 'assistant', content: 'PRIOR-ASSISTANT-TURN' },
  ];

  const first = await eng.chat(
    { class: 'aegis', prompt: 'fix the build', model: 'm1', sessionId: 'i-1', messages: HISTORY_1.slice() },
    () => {}
  );
  assert.equal(first.stoppedOnRounds, true, 'turn 1 stops at its horizon');

  const held1 = rounds.peek('s:i-1');
  assert.ok(Array.isArray(held1.added) && held1.added.length > 0,
    'an interactive interruption files what the turn itself added');
  assert.ok(held1.added.some((m) => m.role === 'tool'),
    'including the tool results — the half the renderer never saw');
  assert.ok(!held1.added.some((m) => m.content === 'PRIOR-USER-TURN'),
    "the caller's own turns are not filed as this turn's work");

  // Turn 2: the same renderer thread, plus the note turn 1 ended on.
  const NOTE_1 = '[stopped at 2 tool rounds, 30 tokens. …]';
  const HISTORY_2 = [...HISTORY_1, { role: 'assistant', content: NOTE_1 }];
  const before2 = requests.length;
  await eng.chat(
    { class: 'aegis', prompt: 'keep going', model: 'm1', sessionId: 'i-1', messages: HISTORY_2.slice() },
    () => {}
  );
  const sent2 = requests[before2].messages;

  assert.match(requests[before2].prompt, /\[session resume\]/,
    'an interactive session gets the continuation preamble too');
  assert.match(requests[before2].prompt, /do not restart/i);
  assert.ok(sent2.some((m) => m.role === 'tool'),
    'and the dispatch carries the restored tool work, not just the note about it');

  // The load-bearing assertion: the caller's conversation, plus exactly what
  // the interrupted turn added — nothing restored twice.
  assert.equal(sent2.length, HISTORY_2.length + held1.added.length,
    `an interactive resume restores only the delta (sent ${sent2.length}, expected ${HISTORY_2.length} + ${held1.added.length})`);
  for (const turn of HISTORY_2) {
    assert.equal(sent2.filter((m) => m.content === turn.content).length, 1,
      `the caller's own turn appears exactly once: ${JSON.stringify(turn.content)}`);
  }

  const held2 = rounds.peek('s:i-1');
  const HISTORY_3 = [...HISTORY_2, { role: 'assistant', content: NOTE_1 }];
  const before3 = requests.length;
  await eng.chat(
    { class: 'aegis', prompt: 'again', model: 'm1', sessionId: 'i-1', messages: HISTORY_3.slice() },
    () => {}
  );
  const sent3 = requests[before3].messages;

  // The compounding case: if turn 2's restored transcript had been re-filed as
  // turn 2's own work, turn 3's delta would carry it a second time and this
  // identity would fail — which is exactly how a chain grows without bound.
  assert.equal(sent3.length, HISTORY_3.length + held2.added.length,
    `the delta is not re-recorded on the next resume (sent ${sent3.length}, expected ${HISTORY_3.length} + ${held2.added.length})`);

  // A cold-history caller is untouched by any of this: the queue worker sends
  // no conversation, so it still gets the whole transcript.
  const held3 = rounds.peek('s:i-1');
  const before4 = requests.length;
  await eng.chat(
    { class: 'aegis', prompt: '', model: 'm1', sessionId: 'i-1' },
    () => {}
  );
  const sent4 = requests[before4].messages;
  // `held3.messages` is the full transcript, and the +1 is the preamble
  // itself: with no prompt to prepend to, the engine pushes the continuation
  // note into history as a user turn (engine.js:1084). So the dispatch is the
  // whole transcript PLUS the note that explains why it is being continued —
  // which is the assertion immediately below.
  assert.equal(sent4.length, held3.messages.length + 1,
    'a caller with no conversation of its own still gets the full transcript');
  assert.ok(sent4.some((m) => m.content === 'PRIOR-USER-TURN'),
    'which does include the turns the interactive caller brought to an earlier turn');
  assert.ok(sent4.some((m) => /\[session resume\]/.test(String(m.content))),
    'and the preamble rides in history when there is no prompt to carry it');

  if (previous === undefined) delete process.env.AEGIS_CHAT_MAX_ROUNDS;
  else process.env.AEGIS_CHAT_MAX_ROUNDS = previous;
  rounds.reset();
});
