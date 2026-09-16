'use strict';

/**
 * Token + cost estimation. Tokens are estimated from text length (~4
 * chars/token, the usual rule of thumb) and priced against the per-model rates
 * below. Everything is labeled approximate in the UI.
 *
 * Ported from aegiscodex-dev/src/tokens.js (ESM → CommonJS).
 */

// Per-million-token USD rates. Cache-read/write matter for long sessions.
//
// These are the PROVIDER's rates, for the fallback path where a turn has no
// server-settled charge (a direct provider, ollama, a custom endpoint). A
// pooled turn reports the ledger figure instead — see accountingFromUsage's
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
  // This row was MISSING, and usageCost fell through to RATES.sonnet for every
  // DeepSeek turn: $3.00/$15.00 per M against a real $0.14/$0.28 — 21x the
  // input rate and 54x the output rate, on every direct DeepSeek call. That is
  // the number that made a local turn look like it cost a fraction of the
  // cloud's, when most of the reported gap was the meter itself.
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
 * longest matching prefix, then the Sonnet-class default — the same resolution
 * order contextWindowFor uses, so the cost meter and the context meter cannot
 * disagree about which family a model belongs to.
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

// System prompt + tool definitions overhead, roughly, in tokens.
const SYSTEM_TOKENS = 18000;
const TOOL_TOKENS = 12000;
// Default context window we budget against (Sonnet 5 class).
const CONTEXT_WINDOW = 200000;

// Real per-provider context budgets for the /context meter. The default above
// is the Claude-class window the UI was built around; providers with a
// different window map here so the meter shows the truth instead of a
// Sonnet-flavored estimate.
//
// DeepSeek V4 — verified live 2026-09-11 against api.deepseek.com:
//   - a 942,031-token prompt was ACCEPTED (HTTP 200)
//   - a 1,122,032-token prompt was REJECTED, verbatim: "This model's maximum
//     context length is 1048576 tokens."
// so the window is 1M. The old 256k figure here understated it 4x and made the
// /context meter lie. Max output is 393216 — the API rejects anything larger
// with "the valid range of max_tokens is [1, 393216]".
// Keyed by provider name or model-id prefix (longest prefix wins via the
// iteration order below — exact id matches take priority).
const CONTEXT_WINDOWS = {
  deepseek: 1_048_576,
  openrouter: 256_000,
  together: 256_000,
  xai: 256_000,
  groq: 128_000,
  ollama: 128_000,
  openai: 200_000,
  anthropic: 200_000,
  google: 1_000_000,
  gemini: 1_000_000,
};

/** The context budget to show/guard against for a model id, provider, or raw model string. */
function contextWindowFor(model) {
  const id = String(model || '').toLowerCase();
  if (!id) return CONTEXT_WINDOW;
  if (CONTEXT_WINDOWS[id]) return CONTEXT_WINDOWS[id];
  for (const [prefix, win] of Object.entries(CONTEXT_WINDOWS)) {
    if (id.startsWith(prefix)) return win;
  }
  return CONTEXT_WINDOW;
}

/** Rough token estimate: ~4 chars per token (heuristic, labeled approximate). */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil([...String(text)].length / 4));
}

/**
 * Bucket the transcript's token usage.
 *   input   — user prompts + system + tools (per exchange)
 *   output  — assistant replies
 *   cacheRead  — what a resumed session reads back (prior context, approximated
 *                as all prior user+assistant text)
 *   cacheWrite — the newest user+assistant chunk written to cache
 */
function transcriptUsage(transcript, model = 'sonnet') {
  const userMsgs = transcript.filter((m) => m.role === 'user');
  const asstMsgs = transcript.filter((m) => m.role === 'assistant');
  const input = userMsgs.reduce((a, m) => a + estimateTokens(m.text || ''), 0);
  const output = asstMsgs.reduce((a, m) => a + estimateTokens(m.text || ''), 0);
  const cacheRead = Math.max(0, input - (userMsgs.length ? estimateTokens(userMsgs[userMsgs.length - 1].text || '') : 0));
  const cacheWrite = userMsgs.length ? estimateTokens(userMsgs[userMsgs.length - 1].text || '') : 0;
  return { input, output, cacheRead, cacheWrite };
}

/** Dollar cost of a usage record at the given model's rates. */
function usageCost(usage, model = 'sonnet') {
  const r = ratesFor(model);
  const toD = (n, rate) => (n / 1_000_000) * rate;
  return toD(usage.input, r.input)
    + toD(usage.output, r.output)
    + toD(usage.cacheRead, r.cacheRead)
    + toD(usage.cacheWrite, r.cacheWrite);
}

/** Full session accounting: per-bucket tokens, cost, and context used %. */
function sessionAccounting(transcript, model = 'sonnet') {
  const usage = transcriptUsage(transcript, model);
  const system = SYSTEM_TOKENS;
  const tools = TOOL_TOKENS;
  const history = usage.input + usage.output;
  const used = system + tools + history;
  const contextWindow = contextWindowFor(model);
  return {
    usage,
    system,
    tools,
    history,
    used,
    contextWindow,
    pct: Math.min(100, Math.round((used / contextWindow) * 100)),
    cost: usageCost(usage, model),
  };
}

/**
 * Phase 4: build the same accounting shape from summed history.jsonl token
 * records (live usage numbers when `real`, estimated otherwise). Real usage
 * already includes system prompt + tools in cacheRead, so `used` counts
 * input + output + cache instead of re-adding the constants.
 */
function accountingFromUsage(usage, model = 'sonnet', { exchanges = 0, real = false, costUsd } = {}) {
  const cost = typeof costUsd === 'number' ? costUsd : usageCost(usage, model);
  const used = real
    ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    : SYSTEM_TOKENS + TOOL_TOKENS + usage.input + usage.output;
  const contextWindow = contextWindowFor(model);
  return {
    usage,
    system: SYSTEM_TOKENS,
    tools: TOOL_TOKENS,
    history: usage.input + usage.output,
    used,
    contextWindow,
    pct: Math.min(100, Math.round((used / contextWindow) * 100)),
    cost,
    exchanges,
    real,
  };
}

function fmtTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(d) {
  return `$${d.toFixed(4)}`;
}

module.exports = {
  RATES,
  SYSTEM_TOKENS,
  TOOL_TOKENS,
  CONTEXT_WINDOW,
  CONTEXT_WINDOWS,
  contextWindowFor,
  ratesFor,
  estimateTokens,
  transcriptUsage,
  usageCost,
  sessionAccounting,
  accountingFromUsage,
  fmtTokens,
  fmtCost,
};
