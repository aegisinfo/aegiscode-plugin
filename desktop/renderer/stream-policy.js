'use strict';

/**
 * Pure decisions behind a live streaming turn: whether the transcript is
 * allowed to follow the stream, and whether a rejection means the user asked
 * to stop. Kept out of app.js — like max-tokens.js — so both rules are
 * unit-testable from plain Node without a DOM or window.aegis. app.js only
 * calls into this.
 *
 * Both rules exist because a running turn used to own the transcript: it
 * re-pinned the view on every chunk (so earlier turns could not be read) and
 * it reported a deliberate stop as a failure (so interrupting lost the answer
 * already on screen).
 */

/** Distance from the bottom still counted as "following the stream". */
const STICK_SLOP_PX = 48;

/**
 * Is the view at (or effectively at) the tail? A few pixels of slack absorbs
 * sub-pixel layout and a scrollbar that appears mid-stream; without it the
 * follow silently stops a fraction short.
 */
function nearBottom(metrics, slop) {
  const m = metrics || {};
  const budget = Number.isFinite(slop) ? slop : STICK_SLOP_PX;
  const scrollHeight = Number(m.scrollHeight) || 0;
  const scrollTop = Number(m.scrollTop) || 0;
  const clientHeight = Number(m.clientHeight) || 0;
  return scrollHeight - scrollTop - clientHeight <= budget;
}

/**
 * May the transcript be scrolled to the bottom right now? `force` is for the
 * cases where the view genuinely must move (the user just sent, or a card is
 * blocking the turn); otherwise the reader's explicit scroll-away wins.
 *
 * The flag is checked before the measurement on purpose: a mid-stream reflow
 * can momentarily measure as "at the bottom" while the reader is nowhere near
 * it, which is exactly the case where re-pinning feels like a hijack.
 */
function shouldFollow(metrics, opts) {
  const o = opts || {};
  if (o.force) return true;
  if (o.userScrolledUp) return false;
  return nearBottom(metrics, o.slop);
}

/**
 * Signatures of a real abort, as each layer spells it: Chromium's fetch
 * ("The user aborted a request."), undici/Node ("This operation was aborted"),
 * and an AbortSignal's own reason ("signal is aborted without reason").
 *
 * Deliberately NOT a bare /abort/i. A dropped socket surfaces as
 * "ECONNABORTED: connection aborted by peer" or "socket hang up", which
 * contains the same word but is a genuine transport failure — matching it
 * would relabel a real error as a deliberate stop and strand the user with a
 * silently truncated answer.
 */
const ABORT_SIGNATURES = [
  /AbortError/,
  /\boperation was aborted\b/i,
  /\buser aborted\b/i,
  /\brequest\s+aborted\b/i,
  /\bsignal is aborted\b/i,
  /\baborted without reason\b/i,
];

/**
 * Did the user ask for this turn to stop? The abort travels back over IPC,
 * which rebuilds the Error object and drops `name`/`code` — the renderer only
 * sees a wrapped message. So the caller's own flag is the primary signal, and
 * the signatures above are a backstop for an abort this renderer did not
 * initiate.
 */
function isCancellation(err, opts) {
  const o = opts || {};
  if (o.userStopped) return true;
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return true;
  const msg = typeof err === 'string' ? err : err.message;
  if (typeof msg !== 'string') return false;
  return ABORT_SIGNATURES.some((re) => re.test(msg));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nearBottom, shouldFollow, isCancellation, STICK_SLOP_PX };
}
