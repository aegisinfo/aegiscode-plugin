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
 *          input_tokens?: number, output_tokens?: number,
 *          input?: number, output?: number}|null|undefined} usage
 * @returns {number|null}
 */
function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  // Three spellings of the same quantity: OpenAI's, Anthropic's, and this
  // file's own bucket shape — which is also the shape a LEDGER row carries
  // (cli/src/history.js writes `{input, output, cacheRead, cacheWrite}` into
  // sessions.json, and the CLI's demo path writes `{input, output}`). Reading
  // only the two wire spellings left every stored row uncountable, so a
  // resumed session's rolling total started at zero even though its ledger
  // said otherwise.
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.input;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.output;
  if (typeof input !== 'number' && typeof output !== 'number') return null;
  return (input || 0) + (output || 0);
}

/**
 * Rough token count for text the wire never measured — a direct port of the
 * CLI's own estimator (`aegiscodex-dev/src/tokens.js estimateTokens`), and the
 * reason its session total is MONOTONIC.
 *
 * This is the whole difference being fixed. The CLI's `appendHistory`
 * (aegiscodex-dev/src/history.js) writes a `tokens` object for EVERY finished
 * exchange: `{input, output, cacheRead, cacheWrite, real: true}` when the wire
 * reported usage, and `{input: estimateTokens(prompt), output:
 * estimateTokens(reply), real: false}` when it did not. `real` is a FLAG, not a
 * gate — `aggregateSessionUsage` adds `t.input || 0` for every row regardless,
 * so a turn without usage still moves the total and only marks it as partly
 * estimated.
 *
 * The desktop rolled only reported usage and dropped everything else, so its
 * total was flat across any turn the pool did not report on — the meter looked
 * dead while the conversation was being billed. ~4 characters per token, the
 * CLI's heuristic, kept identical so the two surfaces estimate the same turn
 * the same way. Empty text is 0, never the `Math.max(1, …)` floor.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil([...String(text)].length / 4));
}

/**
 * The bucket shape an exchange gets when the wire reported no usage: the CLI's
 * `{input: estimateTokens(prompt), output: estimateTokens(reply)}`.
 *
 * `null` when there is no text at all to estimate from, so a dispatch that
 * genuinely reported nothing (no usage, no prompt, no reply) still lands in
 * `unknown` instead of being handed a fabricated zero.
 *
 * `reasoning` is the extended-thinking trace, and it is OUTPUT: a reasoning
 * model bills its chain of thought as output tokens, which is why the wire's
 * own `output_tokens` already includes it. The desktop renders that trace in
 * its own element (app.js `reasoningText`) rather than in the reply body, so
 * the two streams had to be added back together here — an estimate measured off
 * the visible answer alone sat still for the entire think phase, which on a
 * reasoning model is both the longest and the most expensive part of the turn.
 *
 * @param {string} [prompt]
 * @param {string} [reply]
 * @param {string} [reasoning]
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}|null}
 */
function estimatedBuckets(prompt, reply, reasoning) {
  const hasPrompt = typeof prompt === 'string' && prompt.length > 0;
  const out =
    (typeof reply === 'string' ? reply : '') +
    (typeof reasoning === 'string' ? reasoning : '');
  const hasReply = out.length > 0;
  if (!hasPrompt && !hasReply) return null;
  return {
    input: estimateTokens(prompt),
    output: estimateTokens(out),
    cacheRead: 0,
    cacheWrite: 0,
    real: false,
  };
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
 * ── The rolling session tallies, on the CLI's rule ─────────────────────────
 *
 * The two surfaces did not merely print different numbers — they counted
 * differently. The CLI never shows a turn's tokens in isolation: `recordTurn`
 * (cli/src/app.js) folds each finished turn's usage into one `session` object
 * — `tokens`, `inputTokens`, `outputTokens`, `calls` — and what the user reads
 * back is that RUNNING TOTAL. The status bar prints `state.tokens`
 * (renderStatus), and `ctrl+t` prints the tallies in one line
 * (`tokenSummary`: `12,400 tok (10,100 in / 2,300 out) · 4 calls · €0.03`).
 * The tallies are reproduced; that one abbreviation is not — `fmtRoll` explains
 * why it drops the parenthetical rather than carrying the CLI's line verbatim.
 *
 * The desktop counted per turn only. Every meta row was a fresh count that
 * reset at the next call, so "what has this session spent" was answerable only
 * by adding the rows up by eye across a scrollback — which is most of why the
 * desktop looked like it accounted differently from the CLI on identical
 * engine code and an identical prompt.
 *
 * Three properties of the CLI's fold are load-bearing and are reproduced here
 * exactly, because dropping any one of them reintroduces a specific lie:
 *
 *   1. `turns` and `calls` are incremented BEFORE the "did usage come back?"
 *      gate (recordTurn counts first, then tests `tokens != null`). A turn
 *      that reported nothing still happened; a tally that skipped it would
 *      report the session as shorter and cheaper than it was.
 *   2. `tokens`, `input` and `output` accumulate — never reset. A rolling
 *      total that resets per turn is the per-turn count it replaced.
 *   3. A `null` count contributes nothing and is counted in `unknown`, so
 *      `tokens: 0` is only ever read as a real zero. Nothing is ever added as
 *      a fabricated 0 to make the arithmetic look complete.
 *
 * The money split is the CLI's too: a settled charge (the pool's ledger
 * figure) rolls into `cost`, and a locally priced turn rolls into `estimate`.
 * They are kept apart rather than summed so a `~`-estimate can never be read
 * as part of the bill — the distinction `fmtCost` marks on a single turn, held
 * across the session.
 */

/** A session with nothing accounted for yet. */
function emptyRoll() {
  return {
    turns: 0,
    calls: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    /** Dispatches that reported no usage at all — the honest gap in `tokens`. */
    unknown: 0,
    /**
     * Exchanges folded from TEXT rather than reported usage, on the CLI's
     * `real: false` rule. They are counted in `tokens` — that is the point —
     * and named here so an estimated figure is never read as a measured one.
     */
    estimated: 0,
    /** Settled charges (server-settled `costUsd`), rolled. */
    cost: 0,
    /** Locally priced turns, rolled. Never mixed into `cost`. */
    estimate: 0,
  };
}

/**
 * Fold one completed dispatch into a session's rolling tallies. Pure: it
 * returns a NEW roll and never mutates the one it was handed, so a half-applied
 * fold cannot exist.
 *
 * @param {object} [roll]      the roll so far (emptyRoll() when omitted)
 * @param {object} [usage]     the response's `usage` object
 * @param {{model?: string, costUsd?: number, calls?: number, turns?: number,
 *          prompt?: string, reply?: string, estimated?: boolean}} [opts]
 *        `calls` defaults to 1; a pooled turn may report how many provider
 *        calls it actually made. `turns: 0` folds a dispatch that is not a
 *        turn of its own — the discovery-lane card, which bills like any other
 *        call but is not something the user asked for. `prompt`/`reply` are the
 *        turn's text, used ONLY when the wire reported no usage, so the turn is
 *        estimated rather than dropped (the CLI's `appendHistory` rule).
 * @returns {object} the new roll
 */
function rollTurn(roll, usage, opts = {}) {
  const next = Object.assign(emptyRoll(), roll || {});
  next.turns += opts.turns === undefined ? 1 : Number(opts.turns) || 0;
  next.calls += opts.calls === undefined ? 1 : Number(opts.calls) || 0;
  const turn = turnAccounting(usage, opts.model, { costUsd: opts.costUsd });
  // A row folded from text rather than from the wire: either this turn's own
  // fallback below, or a stored ledger row carrying `real: false` — the shape
  // the CLI's `appendHistory` writes for an exchange the provider did not
  // report on.
  const estimated = opts.estimated === true || (usage && usage.real === false);
  if (turn.tokens == null) {
    // No reported usage. The CLI does not let such a turn vanish from the
    // total: `appendHistory` estimates it from the text and marks it
    // `real: false` (aegiscodex-dev/src/history.js), and
    // `aggregateSessionUsage` then adds it like any other row. Folding the same
    // estimate here is what makes the live roll and the rebuilt roll the same
    // number, and what stops the total standing still on exactly the turns the
    // pool declined to report on — the symptom this fallback exists to remove.
    const est = estimatedBuckets(opts.prompt, opts.reply, opts.reasoning);
    if (!est) {
      // Nothing reported AND no text to estimate from. The single case that
      // stays uncounted: `unknown` names the gap, where a fabricated zero would
      // read as a measurement.
      next.unknown += 1;
      return next;
    }
    next.tokens += est.input + est.output;
    next.input += est.input;
    next.output += est.output;
    next.estimated += 1;
    return next;
  }
  const b = usageBuckets(usage);
  next.tokens += turn.tokens;
  next.input += b.input;
  next.output += b.output;
  next.cacheRead += b.cacheRead;
  next.cacheWrite += b.cacheWrite;
  if (estimated) {
    // Money stays out of an estimated exchange, deliberately and in both
    // directions: the CLI writes no `costUsd` for one, so pricing it here would
    // make the live roll drift from the rebuilt one — and pricing tokens that
    // were themselves guessed would stack one guess on another.
    next.estimated += 1;
    return next;
  }
  if (turn.real) next.cost += turn.cost;
  else if (turn.cost != null) next.estimate += turn.cost;
  return next;
}

/**
 * Rebuild a session's rolling total from stored exchanges — the desktop's
 * counterpart of the CLI's `aggregateSessionUsage`, which sums history.jsonl so
 * a resumed session (and a compacted one) still reports everything it spent.
 *
 * Reads the shapes the shared store writes: an assistant message carrying
 * `tokens: {input, output, cacheRead, cacheWrite}` and, when the pool settled
 * the turn, `costUsd` (cli/src/history.js → session-store.recordExchange).
 * Messages the desktop itself appended carry no `tokens` and fold as `unknown`
 * — a resumed thread states what is known and does not invent the rest.
 *
 * @param {Array<{role?: string, tokens?: object, costUsd?: number, model?: string}>} [messages]
 * @returns {object} the roll
 */
function rollMessages(messages) {
  let roll = emptyRoll();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== 'assistant') continue;
    roll = rollTurn(roll, m.tokens, {
      model: m.model,
      costUsd: typeof m.costUsd === 'number' ? m.costUsd : undefined,
      calls: m.calls,
    });
  }
  return roll;
}

/**
 * The ledger row one finished dispatch must carry into the shared session
 * store, so the rolling total can be REBUILT when the thread is reopened —
 * the desktop's counterpart of the CLI's `appendHistory`
 * (aegiscodex-dev/src/history.js:36).
 *
 * One authority for the row, on purpose. The CLI writes a `tokens` object for
 * EVERY exchange and skips none:
 *
 *   tokens: usage
 *     ? { input, output, cacheRead, cacheWrite, real: true }
 *     : { input: estimateTokens(prompt), output: estimateTokens(reply), real: false }
 *
 * …and `aggregateSessionUsage` then sums `t.input || 0` over every entry with
 * `real` as a FLAG, not a gate. Mirroring that shape here is what makes the
 * live roll and the rebuilt roll the same number: `rollTurn` is handed this
 * exact object on reopen, so an estimated exchange adds the same buckets it
 * added live and is counted under `estimated` in both.
 *
 * Returns `null` when there is neither reported usage nor text to estimate
 * from — the one case that must stay unrecorded, because a fabricated
 * `{input: 0, output: 0}` row would read as a measured zero forever after.
 *
 * @param {object} [usage]  the response's `usage` object
 * @param {object} [turn]   its accounting (turnAccounting), when already done
 * @param {{model?: string, costUsd?: number, calls?: number, prompt?: string,
 *          reply?: string}} [opts]
 * @returns {object|null} the row's ledger fields
 */
function ledgerRow(usage, turn, opts = {}) {
  const t = turn || turnAccounting(usage, opts.model, { costUsd: opts.costUsd });
  const calls = Number.isFinite(opts.calls) && opts.calls > 0 ? opts.calls : undefined;
  if (t.tokens != null) {
    const row = { tokens: usageBuckets(usage) };
    // Only a SETTLED charge is persisted. The CLI writes `costUsd` for a real
    // charge only, and the rebuild prices an unpriced row from the same rate
    // table this window used — persisting a local guess would let a stale
    // table outlive the change that wrote it.
    if (t.real && t.cost != null) row.costUsd = t.cost;
    if (calls !== undefined) row.calls = calls;
    return row;
  }
  // `reasoning` is part of the billed output, so it is estimated with the
  // reply — a stored row for a thinking-heavy turn must not persist a count
  // that excludes the longest thing the model wrote.
  const est = estimatedBuckets(opts.prompt, opts.reply, opts.reasoning);
  if (!est) return null;
  const row = { tokens: est };
  if (calls !== undefined) row.calls = calls;
  return row;
}

/**
 * The CLI's rendering of a session tally — `cli/src/format.js fmtTokens`, which
 * is the one `tokenSummary` actually imports (`cli/src/app.js:50`). NOT the
 * `1.5k`/`12.3k` form in `cli/src/tokens.js`: that one belongs to the /cost
 * panels, and using it here would print `12.4k` on the very total the CLI
 * prints as `12,400` — a rendering difference stacked on top of the accounting
 * difference this change exists to remove.
 *
 * Comma-grouped integer. Anything not finite and positive renders `0`, which is
 * the CLI's rule and keeps a stray NaN from reaching the topbar.
 */
function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  return Math.round(v)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The rolling session total as one line — the desktop's counterpart of the
 * CLI's `tokenSummary`. Empty string when nothing has been accounted for, so
 * an untouched session adds no noise to a turn's meta line.
 *
 * @param {object} [roll]
 * @returns {string} e.g. `12,400 tok · 4 calls · $0.0310` — the CLI's fields in
 *   the CLI's order, minus the input/output parenthetical (see below).
 */
function fmtRoll(roll) {
  const r = roll || emptyRoll();
  if (!r.turns && !r.calls) return '';
  // The fields are `tokenSummary`'s (cli/src/app.js:1413) in its order — tokens,
  // calls, money — with one dropped: the `(10,100 in / 2,300 out)` split. `in`
  // and `out` are a terminal status-line shorthand, legible to someone already
  // reading that status line and to nobody else, which is what an unlabelled
  // abbreviation in a GUI topbar turns into. The total is the figure a reader
  // wants; `r.input`/`r.output` are still folded onto the roll (see `rollTurn`)
  // for any surface that wants to show the split with real labels. The call
  // count stays unconditional, because it is the number that reveals a
  // fan-out, and it is not hidden at 1.
  const bits = [];
  // The token half only when something was actually counted. `rollTurn` counts
  // turns and calls BEFORE it looks at the token count, so a dispatch that
  // reported nothing still reaches here — and printing its empty tally would
  // put `0 tok` on the topbar, a figure the meter never took, which reads as a
  // counter that does not move. The turn count is still stated, because that
  // much is true.
  if (r.tokens > 0) {
    bits.push(`${fmtTokens(r.tokens)} tok`);
  }
  bits.push(`${r.calls} call${r.calls === 1 ? '' : 's'}`);
  // Money is where this line departs from `tokenSummary`, deliberately: that
  // one sums a single `session.cost` in EUR via fmtEur, while this surface keeps
  // a settled charge and a local estimate apart so a `~`-estimate can never be
  // read as part of the bill. Desktop's pre-existing fmtCost renders both, and
  // its `$` convention is left exactly as it was.
  if (r.cost > 0 || r.estimate > 0) {
    const money = [];
    if (r.cost > 0) money.push(fmtCost(r.cost, true));
    if (r.estimate > 0) money.push(fmtCost(r.estimate, false));
    bits.push(money.join(' + '));
  }
  // No counterpart in `tokenSummary`, which folds a usage-less turn silently and
  // so reports a total short of the truth without saying so. Named here instead:
  // the count appears only when something went unreported, and it never changes
  // a number — it only says the number is not the whole story.
  if (r.unknown) bits.push(`${r.unknown} unrpt`);
  // The other half of the same honesty: a total that includes estimated
  // exchanges says so, because the CLI marks the same rows `real: false` and a
  // reader is entitled to know which figure they are looking at. It changes no
  // number — it says the number is partly inferred.
  if (r.estimated) bits.push(`${r.estimated} est`);
  return bits.join(' · ');
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
    estimateTokens,
    estimatedBuckets,
    emptyRoll,
    rollTurn,
    rollMessages,
    ledgerRow,
    fmtTokens,
    fmtRoll,
    fmtCost,
  };
}
