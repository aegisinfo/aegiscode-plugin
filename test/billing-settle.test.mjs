/**
 * A customer must be billed — and, just as importantly, must be *told* — the
 * number the pool actually charged.
 *
 * Three defects in the CLI's settled-charge path, each of which produced a
 * figure that was not the bill:
 *
 *  1. `persistTurn` was bound in makeHost() with only three parameters, so the
 *     settled charge chatflow passes as its fourth argument was dropped on the
 *     floor. Every interactive turn landed in history.jsonl with no charge, and
 *     /cost recomputed it from a local rate table that knows about neither the
 *     pool's margin nor its prompt-cache discount.
 *  2. The linear `/ask` path persisted the exchange BEFORE asking the ledger
 *     what it settled at, so it could never attach a charge at all.
 *  3. `refreshSpend` identified "a new ledger row" by `created_at`, which is
 *     stamped to the second. Two turns in the same second collided: the second
 *     was skipped as already-counted and persisted with no charge.
 *
 * These are asserted against the real modules — history.js is also handed a
 * top-up row, which must not be counted as spend.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function assert(c, m) { if (!c) throw new Error(`ASSERT FAILED: ${m}`); }
const eq = (a, b, m) => assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const home = fs.mkdtempSync(join(os.tmpdir(), 'billing-settle-'));
process.env.AEGIS_HOME = home;
process.env.AEGISCODE_HOME = home;

const history = require(join(root, 'cli', 'src', 'history.js'));
const { createApp } = require(join(root, 'cli', 'src', 'app.js'));
const appSrc = fs.readFileSync(join(root, 'cli', 'src', 'app.js'), 'utf8');
const chatflowSrc = fs.readFileSync(join(root, 'cli', 'src', 'chatflow.js'), 'utf8');

/**
 * Build a real app around a stub balance endpoint.
 *
 * `refreshSpend` is exported from createApp and the client is injectable, so
 * the session-accounting contract below is exercised by RUNNING it — not by
 * pattern-matching its source, which passes against code that does not work and
 * fails against code that does (as the previous `new Set()` assertion did).
 * `read()` returns the current ledger so a test can mutate it between refreshes
 * the way the server does between turns.
 */
function makeApp(initialLedger = []) {
  const state = { ledger: initialLedger, failing: false, reads: 0 };
  const app = createApp({
    client: {
      apiKey: 'test-key',
      apiBase: 'http://127.0.0.1:0',
      tokenBankBalance: async () => {
        state.reads += 1;
        if (state.failing) throw new Error('balance endpoint unreachable');
        return { balance_eur: 10, currency: 'EUR', ledger: state.ledger };
      },
      listModels: async () => ({ models: [] }),
    },
    tools: { TOOLS: {}, toolList: [] },
    out: { write() {} },
    err: { write() {} },
  });
  return {
    app,
    reads: () => state.reads,
    setLedger: (rows) => { state.ledger = rows; },
    setFailing: (v) => { state.failing = v; },
    // Newest-first, which is the order the endpoint actually returns (mcp/tools
    // takes `.slice(0, 5)` as "Recent activity").
    prepend: (rows) => { state.ledger = [...rows, ...state.ledger]; },
  };
}

// ── 1. the host forwards the settled charge it is given ─────────────────────
{
  // chatflow calls host.persistTurn(prompt, result, status, lastCost) — four
  // arguments. A three-parameter binding silently discards the fourth, which is
  // the charge. Assert the wiring keeps the parameter.
  const binding = appSrc.match(/persistTurn:\s*\(([^)]*)\)\s*=>\s*persistTurn\(([^)]*)\)/);
  assert(binding, 'makeHost binds persistTurn explicitly');
  const params = binding[1].split(',').map((s) => s.trim());
  const args = binding[2].split(',').map((s) => s.trim());
  eq(params.length, 4, 'the binding accepts the charge as a fourth parameter');
  assert(args[args.length - 1] === params[params.length - 1],
    `the binding forwards the charge rather than dropping it (args: ${args.join(', ')})`);
  assert(/costEur/.test(params[params.length - 1]),
    'the fourth parameter is named for what it carries');
}

// ── 2. the charge is read BEFORE the turn is written ────────────────────────
{
  // In the linear path, `refreshSpend` must precede `persistTurn`: reading it
  // afterwards can never attach it to the row being written.
  const linear = appSrc.slice(appSrc.indexOf('async function runPrompt'));
  const refreshAt = linear.indexOf('await refreshSpend()');
  const persistAt = linear.indexOf('persistTurn(prompt, res,');
  assert(refreshAt !== -1, 'the linear path asks the ledger what it settled at');
  assert(persistAt !== -1, 'the linear path persists the turn');
  assert(refreshAt < persistAt, 'the ledger is consulted before the turn is persisted');
  assert(/persistTurn\(prompt, res,[^)]*settledCost\)/.test(linear),
    'and the settled charge is passed through to persistTurn');

  // Same contract in the chatflow loop.
  const flow = chatflowSrc.slice(chatflowSrc.indexOf('host.recordTurn(result)'));
  assert(flow.indexOf('await host.refreshSpend()') < flow.indexOf('host.persistTurn('),
    'the session loop consults the ledger before persisting too');
  // NB: the status argument between `result,` and `lastCost` contains its own
  // parentheses — `(result && result.error) ? 'error' : 'done'` — so this must
  // match across them rather than stop at the first `)`, which never reaches
  // the charge and made the assertion fail against correct source.
  assert(/host\.persistTurn\(\s*prompt,\s*result,[\s\S]*?lastCost\s*\)/.test(flow),
    'and passes lastCost as the settled charge');
}

// ── 3. two charges in the same second are both counted ──────────────────────
{
  // `created_at` has one-second resolution. Two distinct charges can share it;
  // a timestamp-only "new row" test drops the second one entirely.
  const sameSecond = '2026-09-16 12:38:13';
  const first  = { kind: 'usage', amount_eur: -0.0047, created_at: sameSecond };
  const second = { kind: 'usage', amount_eur: -0.0012, created_at: sameSecond };

  // The row key must distinguish them.
  const keyOf = (row) => [
    row.created_at || '', row.kind || '',
    row.amount_eur != null ? row.amount_eur : '',
    row.charged_micros != null ? row.charged_micros : '',
    row.id != null ? row.id : '', row.note != null ? row.note : '',
  ].join('|');
  assert(keyOf(first) !== keyOf(second),
    'two same-second charges get distinct identities');
  assert(!/row\.created_at !== session\.lastLedgerAt/.test(appSrc),
    'the timestamp-only comparison is gone');

  // Both must reach the session tally. Driven through the real refreshSpend:
  // the baseline pass records the pre-existing row, then ONE refresh sees two
  // same-second charges and must fold both.
  const { app, setLedger } = makeApp([
    { kind: 'usage', amount_eur: -1.5, created_at: '2026-09-01 10:00:00' },
  ]);
  await app.refreshSpend(); // baseline: pre-existing spend is not this session's
  eq(app.session.cost, 0, 'the opening refresh folds nothing into session spend');

  setLedger([
    { ...first }, { ...second },
    { kind: 'usage', amount_eur: -1.5, created_at: '2026-09-01 10:00:00' },
  ]);
  const spend = await app.refreshSpend();
  assert(Math.abs(app.session.cost - 0.0059) < 1e-9,
    `both same-second charges land in the session tally (got ${app.session.cost})`);
  // The charge attributed to the turn is the newest row — the endpoint returns
  // newest-first — not an arbitrary one from the pass.
  assert(Math.abs(spend.lastCost - 0.0047) < 1e-9,
    `the newest row is reported as the turn's charge (got ${spend.lastCost})`);

  // The same second, byte-identical rows. This is the realistic shape: the
  // chatflow refreshes after EVERY turn, so two turns inside one second appear
  // as one identical row per refresh, not two at once. Membership alone
  // ("have I seen this key?") says yes on the second refresh and drops the
  // charge; only counting occurrences per pass bills it.
  const identical = { kind: 'usage', amount_eur: -0.0047, created_at: sameSecond, note: null };
  const { app: repApp, prepend: repPrepend } = makeApp([]);
  await repApp.refreshSpend();
  repPrepend([{ ...identical }]);
  await repApp.refreshSpend();
  assert(Math.abs(repApp.session.cost - 0.0047) < 1e-9,
    `the first charge is billed (got ${repApp.session.cost})`);
  repPrepend([{ ...identical }]);
  await repApp.refreshSpend();
  assert(Math.abs(repApp.session.cost - 0.0094) < 1e-9,
    `a second identical charge one refresh later is billed too (got ${repApp.session.cost})`);

  // Two identical rows delivered in a single pass must also both count.
  const { app: dupApp, setLedger: setDup } = makeApp([]);
  await dupApp.refreshSpend();
  setDup([{ ...identical }, { ...identical }]);
  await dupApp.refreshSpend();
  assert(Math.abs(dupApp.session.cost - 0.0094) < 1e-9,
    `two identical charges in one pass are billed twice (got ${dupApp.session.cost})`);

  // And re-reading the SAME ledger twice must not double-charge.
  await dupApp.refreshSpend();
  assert(Math.abs(dupApp.session.cost - 0.0094) < 1e-9,
    `an unchanged ledger adds nothing on re-read (got ${dupApp.session.cost})`);
}

// ── 3b. the account's existing spend is not this session's ──────────────────
{
  // The balance endpoint returns the ACCOUNT's ledger, which holds everything
  // the customer has ever spent. /cost renders session.cost as "This session",
  // so folding history in would report a figure the customer already paid and
  // is not being charged again.
  const { app } = makeApp([
    { kind: 'usage', amount_eur: -12.34, created_at: '2026-01-02 03:04:05' },
    { kind: 'topup', amount_eur: 20, created_at: '2026-01-01 00:00:00' },
  ]);
  await app.refreshSpend();
  eq(app.session.cost, 0, "the customer's lifetime spend is not billed to the session");

  // A top-up is money IN and must never enter the spend tally, even in-session.
  const { app: tApp, prepend } = makeApp([]);
  await tApp.refreshSpend();
  prepend([{ kind: 'topup', amount_eur: 20, created_at: '2026-09-16 12:38:14' }]);
  await tApp.refreshSpend();
  eq(tApp.session.cost, 0, 'a top-up is not spend');
}

// ── 3c. a failed baseline must not bill the customer's history ──────────────
{
  // The session-start refresh is best-effort: if it fails (offline), the next
  // SUCCESSFUL refresh becomes the baseline. The reverse — treating an
  // unobserved ledger as new — would bill the account's lifetime spend to the
  // first turn that happened to succeed.
  const { app, setFailing, prepend } = makeApp([
    { kind: 'usage', amount_eur: -99.0, created_at: '2026-02-02 02:02:02' },
  ]);
  setFailing(true);
  eq(await app.refreshSpend(), null, 'a dead endpoint reports no spend rather than throwing');
  eq(app.session.cost, 0, 'a failed refresh adds nothing');

  setFailing(false);
  await app.refreshSpend(); // first success: observes history, so it baselines
  eq(app.session.cost, 0,
    'the first successful refresh baselines instead of billing observed history');

  prepend([{ kind: 'usage', amount_eur: -0.0047, created_at: '2026-09-16 12:38:15' }]);
  await app.refreshSpend();
  assert(Math.abs(app.session.cost - 0.0047) < 1e-9,
    `a real charge after a failed baseline is still billed (got ${app.session.cost})`);
}

// ── 3d. one refresh can see more than one new charge ───────────────────────
{
  // A refresh skipped while the endpoint was down, or a turn that dispatched
  // two billed provider calls, lands two new rows at once. Reading only
  // ledger[0] silently dropped the rest from the tally.
  const { app, prepend } = makeApp([]);
  await app.refreshSpend();
  prepend([
    { kind: 'usage', amount_eur: -0.0020, created_at: '2026-09-16 12:38:17' },
    { kind: 'usage', amount_eur: -0.0030, created_at: '2026-09-16 12:38:16' },
  ]);
  await app.refreshSpend();
  assert(Math.abs(app.session.cost - 0.005) < 1e-9,
    `every new charge in one pass is folded, not just the head (got ${app.session.cost})`);
}

// ── 4. a top-up is not spend, and both charges land in the ledger ───────────
{
  // End-to-end through the real writers: the aggregate /cost reads must sum the
  // charges and carry the settled figure for each.
  const sessionId = 'sess-two-same-second';
  for (const cost of [0.0047, 0.0012]) {
    history.appendHistory({
      sessionId, prompt: 'q', reply: 'a', status: 'done',
      usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: cost },
    });
  }
  const agg = history.aggregateSessionUsage(sessionId);
  eq(agg.entries, 2, 'both same-second turns are stored');
  assert(Math.abs(agg.costUsd - 0.0059) < 1e-9,
    `both settled charges are summed into /cost (got ${agg.costUsd})`);

  // A turn persisted with no charge (the regression) must not be mistaken for
  // a zero-cost one — it aggregates to zero, which is exactly the symptom.
  const noCharge = 'sess-missing-charge';
  history.appendHistory({
    sessionId: noCharge, prompt: 'q', reply: 'a', status: 'done',
    usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 },
  });
  eq(history.aggregateSessionUsage(noCharge).costUsd, 0,
    'a dropped charge shows up as zero spend, not as a real number');
}

// ── 5. only charges count as spend ─────────────────────────────────────────
{
  // Mirrors app.js's ledgerRowEur: `kind` gates it (a top-up is money IN), the
  // magnitude is the charge, and non-finite input is null rather than NaN.
  const eurOf = (row) => {
    if (!row || typeof row !== 'object') return null;
    if (row.kind !== 'usage') return null;
    const raw = row.amount_eur != null ? Number(row.amount_eur) : -Number(row.charged_micros || 0) / 1e6;
    return Number.isFinite(raw) ? Math.abs(raw) : null;
  };
  eq(eurOf({ kind: 'usage', amount_eur: -0.0047 }), 0.0047, 'a spend row reports its magnitude');
  eq(eurOf({ kind: 'topup', amount_eur: 20 }), null, 'a top-up is not spend');
  eq(eurOf({ kind: 'usage', charged_micros: 4700 }), 0.0047, 'the micros fallback is sign-corrected');
  eq(eurOf({ kind: 'usage', amount_eur: null }), 0, 'a charge row with no amount is zero, not NaN');
  eq(eurOf({ kind: 'usage', amount_eur: 'nonsense' }), null, 'garbage is null, not NaN');
  assert(!/session\.cost \+= eur\b/.test(appSrc) || /Number\.isFinite/.test(appSrc),
    'a NaN can never be added to the session tally');
}

fs.rmSync(home, { recursive: true, force: true });
console.log('billing-settle tests passed');
