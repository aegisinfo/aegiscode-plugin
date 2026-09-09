'use strict';

/**
 * context.js — token-budget trimmer for very large inputs (plan P1 §5.1 /
 * P2 §6.4).
 *
 * Pure Node, no Electron imports. Estimates tokens with a ~4 chars/token
 * heuristic, keeps the system message plus the newest turns, and drops the
 * oldest turns that exceed the budget. The full transcript always stays in
 * the local session record — this only trims what is sent to the wire.
 */

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4; // per-message framing + role overhead

/** Rough token count for a string (no tokenizer in a zero-dep shell). */
function estimateTokens(text) {
  if (text == null) return 0;
  const s = typeof text === 'string' ? text : String(text);
  return Math.max(0, Math.ceil(s.length / CHARS_PER_TOKEN));
}

/** Rough token cost of one { role, content } message. */
function messageTokens(message) {
  if (!message) return 0;
  const content =
    message.content != null
      ? message.content
      : message.text != null
        ? message.text
        : '';
  return MESSAGE_OVERHEAD + estimateTokens(content);
}

/**
 * Trim a message list to fit a token budget, keeping the newest turns.
 *
 * @param {object} opts
 * @param {Array<{role:string,content:string}>} [opts.messages=[]]
 * @param {string} [opts.system='']
 * @param {number} [opts.budgetTokens=8192]  total tokens allowed on the wire
 * @param {number} [opts.reserveTokens=0]    tokens reserved for the reply
 * @returns {{messages:Array, system:string, dropped:number, estimatedTokens:number}}
 */
function trimContext({
  messages = [],
  system = '',
  budgetTokens = 8192,
  reserveTokens = 0,
} = {}) {
  const limit = Math.max(0, budgetTokens - reserveTokens);
  const kept = [];
  let used = 0;

  if (system) used += MESSAGE_OVERHEAD + estimateTokens(system);

  // Walk newest -> oldest; keep a turn if it fits, else stop (older turns are
  // even less relevant). Always keep at least the newest turn so a single
  // oversized message is still sent rather than silently emptied.
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = messageTokens(messages[i]);
    if (used + cost > limit && kept.length > 0) break;
    kept.unshift(messages[i]);
    used += cost;
  }

  return {
    messages: kept,
    system,
    dropped: messages.length - kept.length,
    estimatedTokens: used,
  };
}

module.exports = {
  CHARS_PER_TOKEN,
  MESSAGE_OVERHEAD,
  estimateTokens,
  messageTokens,
  trimContext,
};
