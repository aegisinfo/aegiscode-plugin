/**
 * The local rate table must price a model at ITS provider's rate.
 *
 * usageCost resolved `RATES[model] || RATES.sonnet`, and RATES had no DeepSeek
 * row — so every direct DeepSeek turn was priced at Sonnet's $3.00/$15.00 per M
 * against the provider's real $0.14/$0.28. That is 21x the input rate and 54x
 * the output rate, and it is the number that made a local turn look like it
 * cost a fraction of Aegis Cloud's: most of the reported gap was the meter,
 * not the margin.
 *
 * The provider figure is corroborated outside this repo — aegis1
 * services/nexus_provider/catalog.py (cost_per_1k_input=0.00014,
 * cost_per_1k_output=0.00028) and services/pricing.py.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function assert(c, m) { if (!c) throw new Error(`ASSERT FAILED: ${m}`); }
const eq = (a, b, m) => assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const close = (a, b, m) => assert(Math.abs(a - b) < 1e-9, `${m} (got ${a}, want ${b})`);

const tokens = require(join(root, 'cli', 'src', 'tokens.js'));
const { usageCost, ratesFor, RATES } = tokens;

const M = 1_000_000;

// ── a provider family row exists, at the provider's rates ──────────────────
{
  close(RATES.deepseek.input, 0.14, 'DeepSeek input is the published per-M rate');
  close(RATES.deepseek.output, 0.28, 'DeepSeek output is the published per-M rate');
  // aegis1 pricing.py CACHE_READ_FRACTION_BY_COMPANY["deepseek"] = 0.1
  close(RATES.deepseek.cacheRead, 0.1 * RATES.deepseek.input, 'cache read is 0.1x input');
  close(RATES.deepseek.cacheWrite, RATES.deepseek.input, 'a cache write bills as ordinary input');
}

// ── a DATED id resolves to its family, not to the Sonnet default ───────────
{
  // The configured model is an id, never the bare family name — this is the
  // exact string ~/.aegiscodex/config.json holds.
  const id = 'deepseek-v4-flash-0731';
  eq(ratesFor(id), RATES.deepseek, 'a dated DeepSeek id resolves to the DeepSeek row');

  const oneM = { input: M, output: M, cacheRead: 0, cacheWrite: 0 };
  close(usageCost(oneM, id), 0.42, '1M in + 1M out costs the provider figure');
  // What the fall-through used to report for the same call.
  close(usageCost(oneM, id), 0.14 + 0.28, 'not Sonnet money');
  assert(usageCost(oneM, id) < usageCost(oneM, 'sonnet') / 20,
    'the overstatement was more than 20x, so the fall-through cannot come back quietly');
}

// ── the resolution order is exact, then longest prefix, then default ───────
{
  eq(ratesFor('sonnet'), RATES.sonnet, 'an exact alias match still wins');
  eq(ratesFor('opus'), RATES.opus, 'and so does the Opus alias');
  eq(ratesFor('deepseek-chat'), RATES.deepseek, 'a sibling DeepSeek id resolves by prefix');
  eq(ratesFor('deepseek-v4-pro'), RATES.deepseek, 'including the pro variant');
  // An id from a provider this table does not know must keep the old,
  // conservative Sonnet-class default rather than invent a cheap rate.
  eq(ratesFor('some-unknown-model'), RATES.default, 'an unknown id keeps the default row');
  eq(ratesFor(''), RATES.default, 'an empty id keeps the default row');
  eq(ratesFor(undefined), RATES.default, 'an absent id keeps the default row');
  close(usageCost({ input: M, output: 0, cacheRead: 0, cacheWrite: 0 }, 'some-unknown-model'),
    3.00, 'an unknown model is not silently repriced');
}

// ── the cache slice is billed at the DeepSeek cache rate, not Sonnet's ─────
{
  // A resumed long session: nearly all input served from cache.
  const usage = { input: 116011, output: 532, cacheRead: 110000, cacheWrite: 0 };
  const cost = usageCost(usage, 'deepseek-v4-flash');
  // The three buckets are additive by this module's convention (cacheRead is a
  // separate slice, not a subset of input — see transcriptUsage and history's
  // aggregateSessionUsage), so the total is ~$0.018, NOT sub-cent. An earlier
  // draft of this test asserted "< 0.01" from nowhere instead of from this sum.
  close(cost, (116011 / M) * 0.14 + (532 / M) * 0.28 + (110000 / M) * 0.014,
    'every bucket priced at the DeepSeek row');
  assert(Math.abs(cost - 0.01793) < 0.0001,
    `a 116k-token DeepSeek turn costs about 1.8 cents (got ${cost})`);
  // And the fall-through it replaces was not off by a rounding error.
  const atSonnet = usageCost(usage, 'sonnet');
  assert(atSonnet / cost > 20,
    `the Sonnet fall-through overstated this turn ${(atSonnet / cost).toFixed(1)}x`);
}

// ── a certified charge is still preferred over any local rate ─────────────
{
  // accountingFromUsage must not let the repaired table override the ledger:
  // a pooled turn's `costUsd` is the real bill, margin and discount included.
  const agg = tokens.accountingFromUsage(
    { input: 116011, output: 532, cacheRead: 110000, cacheWrite: 0 },
    'deepseek-v4-flash',
    { real: true, costUsd: 0.0047 }
  );
  close(agg.cost, 0.0047, 'the settled charge wins over the local table');
}

console.log('rate-truth tests passed');
