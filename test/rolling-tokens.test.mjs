#!/usr/bin/env node
/**
 * The rolling token counter must move on EVERY turn — the CLI's rule.
 *
 * The symptom this locks down: the desktop's meter stood still while the CLI's
 * climbed on the same engine and the same prompt. The cause was not the
 * rendering but the accounting. The CLI's `appendHistory`
 * (aegiscodex-dev/src/history.js:36) writes a `tokens` object for every finished
 * exchange — the wire's figures when it reported them, and otherwise an estimate
 * from the turn's own text marked `real: false` — and `aggregateSessionUsage`
 * then sums `t.input || 0` over every entry, with `real` demoted to a mere flag.
 *
 * `rollTurn` instead added nothing at all when the wire reported no usage, so
 * on any turn the pool declined to report on (the whole point of the fallback)
 * the total did not move. Two surfaces, one engine, two different sums.
 *
 * What is asserted here, in order of what would silently rot:
 *
 *   1. MONOTONIC: a turn with text always increases the total, reported or not.
 *      This is the user-visible property.
 *   2. NO FABRICATED ZERO: `fmtRoll` never prints `0 tok` for a turn that was
 *      never measured — an empty tally reads as a broken counter, which is
 *      exactly how the missing accounting was reported.
 *   3. LIVE === REBUILT: the roll after folding a turn equals the roll rebuilt
 *      from that turn's persisted ledger row. This is the invariant that makes
 *      the meter survive a reopen, and it is what forces the ledger write and
 *      the fold to agree on one shape instead of drifting apart.
 *   4. THE ABORT PATH IS FOLDED: a stopped turn is billed by the provider, and
 *      the CLI records a `status: 'stopped'` entry for it. The desktop must too.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const usage = require(join(root, 'desktop', 'renderer', 'usage.js'));
const { emptyRoll, rollTurn, rollMessages, ledgerRow, fmtRoll, estimateTokens } = usage;

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error(`ASSERT FAILED: ${msg}`);
  }
}
const eq = (a, b, m) =>
  assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const deep = (a, b, m) =>
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${m}\n   live:    ${JSON.stringify(a)}\n   rebuilt: ${JSON.stringify(b)}`
  );

// ── 1. monotonic: every turn with text moves the total ──────────────────────
{
  // Each step declares what it must ADD, hand-written from the text it carries.
  // The reported steps add the wire's own figure; the unreported ones add the
  // CLI's estimate, which is the rule under test. Both are stated explicitly, so
  // this is not a restatement of whatever `rollTurn` happens to do.
  const est = (a, b) => estimateTokens(a) + estimateTokens(b);
  const steps = [
    {
      label: 'pool turn that reported usage and settled the charge',
      usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
      costUsd: 0.0047,
      prompt: 'refactor the token meter so it rolls like the CLI',
      reply: 'first answer',
      adds: 1500,
      counted: true,
    },
    {
      // The case that used to add nothing: no usage at all. The pool retries
      // without `stream_options` when the server 400s it
      // (desktop/vendor/aegis.js:421) and the stream then carries no usage
      // frame — so the turn is billed and unreported at the same time.
      label: 'no usage reported at all',
      usage: undefined,
      prompt: 'and now the same again',
      reply: 'second answer, unreported',
      adds: est('and now the same again', 'second answer, unreported'),
      counted: true,
    },
    {
      label: 'reported again — the total must not restart',
      usage: { input_tokens: 2000, output_tokens: 400 },
      prompt: 'third',
      reply: 'third answer',
      adds: 2400,
      counted: true,
    },
    {
      label: 'no usage, but the prompt alone is text to estimate from',
      usage: undefined,
      prompt: 'fourth',
      reply: '',
      adds: est('fourth', ''),
      counted: true,
    },
    {
      label: 'a discovery-lane dispatch: calls, no turn of its own',
      usage: undefined,
      prompt: 'lane seed',
      reply: 'a lane path',
      turns: 0,
      calls: 3,
      adds: est('lane seed', 'a lane path'),
      counted: true,
    },
    {
      label: 'nothing reported AND no text: the one uncounted case',
      usage: undefined,
      prompt: '',
      reply: '',
      adds: 0,
      counted: false,
    },
  ];

  let roll = emptyRoll();
  let prev = 0;
  let expected = 0;
  const traced = [];
  for (const [i, s] of steps.entries()) {
    roll = rollTurn(roll, s.usage, {
      model: 'deepseek-v4-flash-0731',
      costUsd: s.costUsd,
      calls: s.calls,
      turns: s.turns,
      prompt: s.prompt,
      reply: s.reply,
    });
    traced.push(fmtRoll(roll));
    expected += s.adds;
    eq(roll.tokens, expected, `${i + 1}. ${s.label}: the total must move by ${s.adds}`);
    if (s.counted) {
      assert(
        roll.tokens > prev,
        `${i + 1}. ${s.label}: a counted turn must move the total (${prev} -> ${roll.tokens})`
      );
    }
    prev = roll.tokens;
  }

  eq(roll.turns, 5, 'six dispatches, one of which is not a turn the user asked for');
  eq(roll.calls, 8, '1 + 1 + 1 + 1 + 3 + 1 calls: the lane fan-out is not hidden');
  eq(roll.estimated, 3, 'the three text-estimated exchanges are named as inferences');
  eq(roll.unknown, 1, 'and the one dispatch with nothing to count is named as unreported');
  assert(roll.tokens > 3900, `reported turns alone are 3,900 (got ${roll.tokens})`);

  for (const [i, line] of traced.entries()) {
    assert(
      !/(^|[^\d])0 tok/.test(line),
      `line ${i + 1} must never print "0 tok" on a turn that was not measured: ${JSON.stringify(line)}`
    );
  }
}

// ── 2. no fabricated zero in the rendered line ──────────────────────────────
{
  const roll = rollTurn(emptyRoll(), undefined, { model: 'sonnet', reply: '' });
  const line = fmtRoll(roll);
  eq(line.includes('tok'), false, 'nothing was counted, so no token figure is claimed');
  assert(line.includes('1 unrpt'), `the gap is named instead: ${JSON.stringify(line)}`);
  eq(emptyRoll().tokens, 0, 'an empty roll is a real zero internally');
  eq(fmtRoll(emptyRoll()), '', 'and renders as nothing at all — an unused thread shows no meter');
}

// ── 3. live roll === roll rebuilt from the persisted ledger row ─────────────
// The invariant that makes a reopened thread the SAME quantity as a live one.
{
  const model = 'deepseek-v4-flash-0731';
  const prompt = 'what did this conversation cost so far';
  const cases = [
    ['reported + settled', { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 }, 0.0047, 'an answer'],
    ['reported + total gap', { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1500 }, undefined, 'an answer'],
    ['reported with cache', { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 }, undefined, 'an answer'],
    ['unreported, has text', undefined, undefined, 'an answer nobody reported on'],
    ['lane dispatch', undefined, undefined, 'a lane path'],
  ];
  for (const [label, wire, costUsd, reply] of cases) {
    const live = rollTurn(emptyRoll(), wire, { model, costUsd, prompt, reply });
    const turn = usage.turnAccounting(wire, model, { costUsd });
    const row = ledgerRow(wire, turn, { model, costUsd, calls: 1, prompt, reply });
    assert(row !== null, `${label}: a row with text must be written, never skipped`);
    assert(
      row.tokens && typeof row.tokens.input === 'number',
      `${label}: the row carries the CLI's tokens object`
    );
    assert(
      row.tokens.real === false || typeof row.costUsd === 'number' || row.tokens.real === undefined,
      `${label}: the row is either settled or explicitly an estimate`
    );
    const rebuilt = rollMessages([
      { role: 'user', content: prompt },
      { role: 'assistant', content: reply, tokens: row.tokens, costUsd: row.costUsd, calls: row.calls, model },
    ]);
    deep(rebuilt, live, `${label}: the rebuilt roll must equal the live one`);
    assert(live.tokens > 0, `${label}: and it must have counted something`);
  }

  // No usage AND no text is the one dispatch that writes nothing at all.
  eq(
    ledgerRow(undefined, usage.turnAccounting(undefined, model, {}), { model }),
    null,
    'nothing reported and nothing to estimate writes no row — never a fabricated zero'
  );
}

// ── 4. a stopped turn is a billed exchange and is folded ────────────────────
{
  const prompt = 'do the thing';
  const partial = 'I started doing the thing and then you stopped me';
  // The abort path has no wire usage: it is exactly the CLI's
  // `status: 'stopped'` entry shape.
  const roll = rollTurn(emptyRoll(), undefined, { model: 'sonnet', prompt, reply: partial });
  assert(roll.tokens > 0, 'a stopped turn carries the tokens it generated, as the CLI records them');
  eq(roll.turns, 1, 'a stopped turn is still a turn');
  eq(roll.estimated, 1, 'and it is marked an estimate, not a measurement');
  eq(roll.cost, 0, 'no settled charge is invented for it');
  eq(roll.estimate, 0, 'and no local price is invented either — the CLI writes none');

  const APP = readFileSync(join(root, 'desktop', 'renderer', 'app.js'), 'utf8');
  const stop = APP.slice(APP.indexOf("if (isCancellation(err, { userStopped }))"));
  const body = stop.slice(0, stop.indexOf('autoPersistTurn'));
  assert(body.length > 0, 'the abort path is where the smoke test says it is');
  assert(/foldRoll\(/.test(body), 'the abort path folds the stopped turn into the session roll');
  assert(/ledgerFields\(/.test(body), 'and persists its ledger row, as the CLI does');
  assert(
    /stopBits\s*=\s*\['stopped by you'\]/.test(body),
    'the label the smoke test looks for is kept'
  );
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('rolling token tests passed');
