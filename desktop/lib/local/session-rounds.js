'use strict';

/**
 * Session-scoped tool-round ledger.
 *
 * The engine's tool-round cap used to be a wall. A turn that reached it ended
 * mid-investigation with `[stopped at 24 tool rounds…]`, and because the
 * accounting lived only for the duration of that call, the next turn in the
 * same conversation started from zero: it knew nothing about the horizon that
 * had just cut it off, so a long job could be truncated by the cap forever
 * without ever being finished.
 *
 * This makes the cap *session* state instead of turn state:
 *
 *   - a turn that reaches its horizon records the unfinished work against the
 *     session key (rounds spent, tokens, the note the user saw, and the
 *     tool-call transcript itself — see `record`'s `messages`);
 *   - the next turn in that session takes the record — consuming it, so one
 *     resume per interruption and a chain of interruptions is a chain of
 *     deliberate asks, never an automatic loop — and gets a continuation
 *     preamble plus a small round bonus, so re-orientation does not eat the
 *     new horizon before any work happens;
 *   - an entry nobody comes back for expires after TTL_MS.
 *
 * State is module-level, so it outlives a turn, a `send()` and whichever
 * engine instance the desktop happens to be using. It never leaves the
 * process and is never written to disk.
 */

/** How long an unclaimed interruption stays resumable (30 min). */
const TTL_MS = 30 * 60 * 1000;
/** Bound on live entries: a long-lived app must not grow without limit. */
const MAX_ENTRIES = 64;

const entries = new Map(); // key -> { rounds, tokens, note, at, interruptions }
const historyKeys = new WeakMap(); // history[] -> key
let historyKeySeq = 0;

/** Drop expired entries, then the oldest ones past the bound. */
function prune(now = Date.now()) {
  for (const [key, entry] of entries) {
    if (now - entry.at > TTL_MS) entries.delete(key);
  }
  while (entries.size > MAX_ENTRIES) {
    // Map iteration is insertion-ordered and `record` re-inserts on write, so
    // the first key is the oldest.
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
  return entries.size;
}

/**
 * The key an interruption is filed under. A caller that states its session
 * (desktop payloads carry an id) gets an exact match; otherwise the working
 * directory, then the identity of the history array, then a single shared
 * bucket. `adopt` covers the remaining case — a caller that mints a fresh key
 * every turn.
 */
function keyFor(payload, history) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const stated = p.sessionKey || p.sessionId || p.chatId || p.threadId || p.conversationId;
  if (typeof stated === 'string' && stated.trim()) return `s:${stated.trim()}`;
  if (typeof p.cwd === 'string' && p.cwd.trim()) return `cwd:${p.cwd.trim()}`;
  if (history && typeof history === 'object') {
    let key = historyKeys.get(history);
    if (!key) {
      historyKeySeq += 1;
      key = `hist-${historyKeySeq}`;
      historyKeys.set(history, key);
    }
    return key;
  }
  return 'default';
}

/**
 * Extra rounds granted to a resuming turn. Deliberately small and bounded: the
 * point of resuming is to *continue* work that already exists, not to hand out
 * a second full horizon (every round re-sends the whole conversation, so this
 * is the cheapest way to make the cap non-fatal).
 */
function bonus(base) {
  const n = Number.isFinite(base) && base > 0 ? base : 0;
  return Math.max(4, Math.ceil(n / 4));
}

/** Peek without consuming — the entry stays resumable. */
function peek(key, now = Date.now()) {
  prune(now);
  return entries.get(key) || null;
}

/** Claim the interruption for `key`, if any. Consuming: a second call gets null. */
function take(key, now = Date.now()) {
  prune(now);
  const entry = entries.get(key);
  if (!entry) return null;
  entries.delete(key);
  return entry;
}

/**
 * Claim the most recent interruption filed under ANY key. This is the bridge
 * for a caller whose key does not survive between turns: the next turn on this
 * process adopts the held work rather than losing it. Bounded by `maxAgeMs` so
 * an unrelated new conversation is not handed yesterday's job.
 */
function adopt({ now = Date.now(), maxAgeMs = 10 * 60 * 1000 } = {}) {
  prune(now);
  let bestKey = null;
  let best = null;
  for (const [key, entry] of entries) {
    if (now - entry.at > maxAgeMs) continue;
    if (!best || entry.at > best.at) {
      best = entry;
      bestKey = key;
    }
  }
  if (!best) return null;
  entries.delete(bestKey);
  return { key: bestKey, entry: best };
}

/**
 * File an interruption. `chain` carries the count forward from the entry this
 * turn resumed, so `interruptions` reports how many times one job has been cut
 * off — visible in the note and useful when deciding to raise the horizon.
 *
 * `messages` is the interrupted turn's own tool-call transcript (its live
 * `history` array at the moment it hit the horizon) — real memory of what was
 * already done, not just a rounds/tokens count of it. Without it a caller
 * that supplies no conversation of its own (a queue task's fresh dispatch)
 * resumes with an empty history: the model is told "continue, don't restart"
 * with nothing to continue FROM, which is a cold start wearing a note.
 * Stored as a defensive copy — the caller's `history` array keeps being
 * mutated by the turn that is returning it.
 */
function record(key, { rounds, tokens, note, chain, messages, added } = {}, now = Date.now()) {
  prune(now);
  const prior = entries.get(key);
  const entry = {
    rounds: Number.isFinite(rounds) ? rounds : 0,
    tokens: Number.isFinite(tokens) ? tokens : 0,
    note: typeof note === 'string' ? note : '',
    at: now,
    interruptions: (Number.isFinite(chain) ? chain : prior && prior.interruptions) || 0,
    messages: Array.isArray(messages) ? messages.slice() : [],
    // And what the interrupted turn added on TOP of what its caller already
    // had. A resuming caller who brings its own conversation (an interactive
    // chat) must get this half, not `messages` — pushing the full transcript
    // into a history that already holds its first half duplicates the user's
    // own turns back to the model.
    added: Array.isArray(added) ? added.slice() : [],
  };
  entry.interruptions += 1;
  entries.delete(key);
  entries.set(key, entry); // re-insert so Map order stays age order
  prune(now);
  return entry;
}

/** The instruction that turns a cold start into a continuation. */
function resumePreamble(entry) {
  const rounds = entry && entry.rounds ? entry.rounds : 'the previous turn\'s';
  const tokens = entry && entry.tokens ? ` (${entry.tokens.toLocaleString()} tokens)` : '';
  return (
    `[session resume] The previous turn in this conversation was cut off at ${rounds} tool rounds${tokens} ` +
    'because it reached the round horizon, so the work it started is unfinished. Continue that work now: ' +
    'do not restart, do not re-do steps that already completed, and do not treat the interruption as a ' +
    'failure to report. Pick up the next unfinished step and finish with a written answer.'
  );
}

/** Read-only snapshot for the UI (and for tests). */
function state(now = Date.now()) {
  prune(now);
  return {
    size: entries.size,
    ttlMs: TTL_MS,
    maxEntries: MAX_ENTRIES,
    entries: [...entries].map(([key, entry]) => ({ key, ...entry })),
  };
}

/** Test hook: forget everything. */
function reset() {
  entries.clear();
  return entries.size;
}

module.exports = {
  TTL_MS,
  MAX_ENTRIES,
  keyFor,
  bonus,
  peek,
  take,
  adopt,
  record,
  resumePreamble,
  state,
  reset,
};
