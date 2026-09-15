/**
 * /cost must report what the POOL charged, not what the client guessed.
 *
 * Every plugin turn is a pooled turn: the bill is computed server-side, with a
 * margin multiplier and (since 2026-09-15) a prompt-cache discount the client
 * cannot see. persistTurn never recorded the settled charge, so /cost fell
 * through to a local rate table every time — a number that matched neither the
 * provider's cost nor the customer's bill.
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

const home = fs.mkdtempSync(join(os.tmpdir(), 'cost-truth-'));
process.env.AEGIS_HOME = home;
process.env.AEGISCODE_HOME = home;

const history = require(join(root, 'cli', 'src', 'history.js'));

// ── a settled charge survives the round trip into /cost's aggregate ─────────
{
  const sessionId = 'sess-settled';
  history.appendHistory({
    sessionId, prompt: 'q1', reply: 'a1', status: 'done',
    usage: { input: 116011, output: 532, cacheRead: 0, cacheWrite: 0, costUsd: 0.0047 },
  });
  history.appendHistory({
    sessionId, prompt: 'q2', reply: 'a2', status: 'done',
    usage: { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 0.0010 },
  });
  const agg = history.aggregateSessionUsage(sessionId);
  eq(agg.entries, 2, 'both turns aggregate');
  assert(Math.abs(agg.costUsd - 0.0057) < 1e-9,
    `the settled charges sum (got ${agg.costUsd})`);
}

// ── a turn with no settled charge does not fabricate one ───────────────────
{
  const sessionId = 'sess-unsettled';
  history.appendHistory({
    sessionId, prompt: 'q', reply: 'a', status: 'done',
    usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 },
  });
  const agg = history.aggregateSessionUsage(sessionId);
  eq(agg.costUsd, 0, 'no charge recorded means no charge claimed');
}

// ── the real numbers from the incident ─────────────────────────────────────
{
  // 116,011 -> 532 billed at 2.0x with ~95% cache hits settles near EUR 0.0047.
  // A local rate table with no margin and no cache awareness reports the raw
  // provider figure instead — the two must not be confused for each other.
  const sessionId = 'sess-incident';
  history.appendHistory({
    sessionId, prompt: 'check the plan', reply: '...', status: 'done',
    usage: { input: 116011, output: 532, cacheRead: 110000, cacheWrite: 0, costUsd: 0.0047 },
  });
  const agg = history.aggregateSessionUsage(sessionId);
  assert(agg.costUsd > 0, 'the settled charge is what /cost reports');
  eq(agg.usage.cacheRead, 110000, 'and the cache slice is kept for the display');
}

fs.rmSync(home, { recursive: true, force: true });
console.log('cost-truth tests passed');
