'use strict';

/**
 * Pure token-usage → display-number mapping, and the cost half of it.
 *
 * Standalone from app.js (same reason as budget.js/stream-policy.js): it is
 * requireable from a plain Node test without window.aegis. app.js only calls
 * into it.
 *
 * Why this exists at all: the two wire formats spell the same quantity
 * differently, and the renderer used to read exactly one of the spellings.
 *
 *   OpenAI-compatible       { prompt_tokens, completion_tokens, total_tokens }
 *   Anthropic-compatible    { input_tokens,  output_tokens }        ← no total
 *
 * Reading only `total_tokens` — the field OpenAI happens to provide — meant
 * every Anthropic-compatible model rendered with no token count at all, while
 * the call was silently being billed. Accepting both spellings, and deriving
 * the total when the provider doesn't state one, is what makes the spend
 * visible regardless of which endpoint answered.
 *
 * ── The cost half, on the CLI's principle ──────────────────────────────────
 *
 * The renderer printed a token count and nothing else, so the desktop had no
 * meter to compare against `aegiscodex` on the same engine and the same
 * prompt — the comparison that started this whole line of work. The CLI's
 * rule (cli/src/tokens.js, ported here) has three parts, and all three matter:
 *
 *   1. A pooled turn's bill is settled SERVER-side and carries a margin and a
 *      prompt-cache discount the client cannot see. When the response states
 *      `costUsd`, that figure wins verbatim — it is the truth about the
 *      charge, not an estimate of it.
 *   2. Only in the absence of a settled charge does the local rate table
 *      apply, and the result is labeled an estimate so nobody reads a guess as
 *      a bill.
 *   3. The rate table is resolved by exact id, then longest prefix. The
 *      DeepSeek row is load-bearing: without it every direct DeepSeek turn
 *      fell through to Sonnet's $3.00/$15.00 per M against a real
 *      $0.14/$0.28 — 21x the input rate and 54x the output rate — which made
 *      the *meter* the largest single contributor to the apparent cost gap
 *      between two surfaces running identical code.
 */

/**
 * Number of tokens to show for a completed turn, or `null` when the provider
 * reported none (an unknown count must render as nothing, never as `0`).
 *
 * @param {{total_tokens?: number, prompt_tokens?: number, completion_tokens?: number,
 *          input_tokens?: number, output_tokens?: number}|null|undefined} usage
 * @returns {number|null}
 */
function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return null;
  return (input || 0) + (output || 0);
}

// Per-million-token USD rates. Cache-read/write matter for long sessions.
//
// These are the PROVIDER's rates, for the fallback path where a turn has no
// server-settled charge (a direct provider, ollama, a custom endpoint). A
// pooled turn reports the ledger figure instead — see turnAccounting's
// `costUsd` — because the pool's bill carries a margin and a prompt-cache
// discount this table cannot see.
//
// Keys are matched by exact id first, then by prefix (ratesFor below), so a
// family row covers every dated variant of it.
const RATES = {
  sonnet:  { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  default: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  fable:   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  opus:    { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  // DeepSeek V4 — the provider's published rate, independently corroborated by
  // aegis1 services/nexus_provider/catalog.py (cost_per_1k_input=0.00014,
  // cost_per_1k_output=0.00028) and referenced in services/pricing.py.
  //
  // This row was MISSING upstream, and usageCost fell through to RATES.sonnet
  // for every DeepSeek turn: $3.00/$15.00 per M against a real $0.14/$0.28 —
  // 21x the input rate and 54x the output rate, on every direct DeepSeek call.
  //
  // cacheRead is 0.1x input (aegis1 services/pricing.py
  // CACHE_READ_FRACTION_BY_COMPANY["deepseek"] = 0.1 -> $0.014/M).
  // cacheWrite is the input rate: DeepSeek bills a cache write as ordinary
  // input tokens and charges no separate write premium, unlike Anthropic's
  // 1.25x. A zero here would understate a session that writes cache.
  deepseek: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
};

/**
 * The rate row for a model id, provider, or alias. Exact id wins, then the
 * longest matching prefix, then the Sonnet-class default.
 */
function ratesFor(model) {
  const id = String(model || '').toLowerCase();
  if (!id) return RATES.default;
  if (RATES[id]) return RATES[id];
  let best = null;
  let bestLen = 0;
  for (const [prefix, rates] of Object.entries(RATES)) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = rates;
      bestLen = prefix.length;
    }
  }
  return best || RATES.default;
}

/**
 * The four billable buckets from a wire usage object, accepting both provider
 * spellings. Cache fields have no Anthropic-compatible short form here because
 * the desktop's transport normalises them (desktop/lib/local/providers.js).
 *
 * @param {object|null|undefined} usage
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}}
 */
function usageBuckets(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const num = (...candidates) => {
    for (const c of candidates) if (typeof c === 'number') return c;
    return 0;
  };
  const input = num(u.input_tokens, u.prompt_tokens, u.input);
  const output = num(u.output_tokens, u.completion_tokens, u.output);
  // A stated total larger than the split means the provider counted tokens the
  // split does not name (thinking, cached reads). Attribute the remainder to
  // input rather than dropping it: dropping it would understate the bill.
  const total = num(u.total_tokens);
  const cacheRead = num(u.cache_read_input_tokens, u.cacheRead);
  const cacheWrite = num(u.cache_creation_input_tokens, u.cacheWrite);
  const accounted = input + output + cacheRead + cacheWrite;
  return {
    input: total > accounted ? input + (total - accounted) : input,
    output,
    cacheRead,
    cacheWrite,
  };
}

/** Dollar cost of a usage record at the given model's rates (USD, estimate). */
function usageCost(usage, model = 'sonnet') {
  const r = ratesFor(model);
  const u = usageBuckets(usage);
  const toD = (n, rate) => (n / 1_000_000) * rate;
  return toD(u.input, r.input)
    + toD(u.output, r.output)
    + toD(u.cacheRead, r.cacheRead)
    + toD(u.cacheWrite, r.cacheWrite);
}

/**
 * What one turn cost, as the CLI reports it: the server's settled charge when
 * the response carries one, otherwise the rate table's estimate, always with
 * the distinction preserved so it can be labeled.
 *
 * @param {object|null|undefined} usage  the response's `usage` object
 * @param {string} model                 the model id that answered
 * @param {{costUsd?: number}} [opts]    the server-settled charge, if any
 * @returns {{tokens: number|null, cost: number|null, real: boolean, estimated: boolean}}
 *          `real` is true only when `cost` is the settled charge. `cost` is
 *          `null` when nothing was reported and no model was named — an
 *          unpriced turn must render as nothing, never as $0.0000.
 */
function turnAccounting(usage, model, opts = {}) {
  const tokens = usageTokens(usage);
  const u = usage && typeof usage === 'object' ? usage : {};
  // The settled charge can arrive either on the response or folded into the
  // usage object — aegiscodex-dev/src/main.js does the latter
  // (`{ ...result.usage, costUsd: result.costUsd }`), so both are accepted.
  const settled = typeof opts.costUsd === 'number'
    ? opts.costUsd
    : (typeof u.costUsd === 'number' ? u.costUsd : undefined);
  if (typeof settled === 'number') {
    return { tokens, cost: settled, real: true, estimated: false };
  }
  if (tokens == null) return { tokens, cost: null, real: false, estimated: false };
  const priced = usageCost(u, model);
  // A model the table cannot place is still priced at the Sonnet-class default
  // (ratesFor never returns nothing), so this is always an estimate.
  return { tokens, cost: priced, real: false, estimated: true };
}

/**
 * A cost for display. Estimates are marked with `~` so an estimate is never
 * mistaken for a settled charge.
 *
 * @param {number} cost
 * @param {boolean} [real]
 * @returns {string}
 */
function fmtCost(cost, real) {
  if (typeof cost !== 'number' || !isFinite(cost)) return '';
  return `${real ? '' : '~'}$${cost.toFixed(4)}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RATES,
    usageTokens,
    ratesFor,
    usageBuckets,
    usageCost,
    turnAccounting,
    fmtCost,
  };
}
