#!/usr/bin/env node
/**
 * Unit tests for desktop/renderer/stream-policy.js — the two pure decisions
 * behind a live streaming turn (transcript auto-scroll, and telling a
 * deliberate stop apart from a real failure). Follows the ../test/max-tokens
 * convention: plain Node, no DOM and no window.aegis.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  nearBottom,
  shouldFollow,
  isCancellation,
  STICK_SLOP_PX,
} = require('../desktop/renderer/stream-policy.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** Scroll metrics helper: content of `scrollHeight`, view of `clientHeight`. */
const at = (scrollHeight, scrollTop, clientHeight) => ({ scrollHeight, scrollTop, clientHeight });

// ------------------------------------------------------------------- nearBottom
assert(STICK_SLOP_PX === 48, `expected stick slop 48, got ${STICK_SLOP_PX}`);

// Exactly pinned to the tail.
assert(nearBottom(at(1000, 600, 400)) === true, 'exact bottom counts as near bottom');

// Within the slop budget: a scrollbar appearing mid-stream leaves the view a
// few pixels short, and the follow must survive that.
assert(nearBottom(at(1000, 570, 400)) === true, 'within slop still counts as following');

// Just past the budget is a deliberate scroll away, not sub-pixel drift.
assert(nearBottom(at(1000, 500, 400)) === false, 'past slop is not near bottom');

// Scrolled to the very top of a long transcript.
assert(nearBottom(at(10000, 0, 400)) === false, 'top of a long transcript is not near bottom');

// A transcript shorter than its viewport is trivially at the bottom.
assert(nearBottom(at(100, 0, 400)) === true, 'content shorter than viewport is near bottom');

// Malformed/absent metrics must not throw — scrollMetrics() can return null
// before the transcript exists, and init() wires the listener unconditionally.
assert(nearBottom(null) === true, 'null metrics degrades to near bottom without throwing');
assert(nearBottom(undefined) === true, 'undefined metrics degrades without throwing');
assert(nearBottom({}) === true, 'empty metrics degrades without throwing');
assert(nearBottom({ scrollHeight: 'x', scrollTop: null, clientHeight: NaN }) === true,
  'non-numeric metrics degrade without throwing');

// An explicit slop overrides the default.
assert(nearBottom(at(1000, 400, 400), 250) === true, 'explicit slop is honored');
assert(nearBottom(at(1000, 400, 400), 0) === false, 'zero slop requires an exact pin');

// ----------------------------------------------------------------- shouldFollow
// force wins over everything: sending, and an approval card blocking the turn.
assert(shouldFollow(at(10000, 0, 400), { force: true }) === true, 'force overrides the reader scroll');
assert(shouldFollow(null, { force: true }) === true, 'force works without metrics');
assert(
  shouldFollow(at(10000, 0, 400), { force: true, userScrolledUp: true }) === true,
  'force overrides an explicit scroll-away'
);

// The reported bug: the reader scrolls up mid-stream and the view must stay put.
assert(
  shouldFollow(at(10000, 0, 400), { userScrolledUp: true }) === false,
  'a scrolled-up reader is never dragged back to the tail'
);

// The flag is checked before the measurement on purpose: a reflow can briefly
// measure as "at the bottom" while the reader is nowhere near it.
assert(
  shouldFollow(at(1000, 600, 400), { userScrolledUp: true }) === false,
  'userScrolledUp vetoes even metrics that measure as near-bottom'
);

// Nothing scrolled away, still at the tail -> follow.
assert(shouldFollow(at(1000, 600, 400), {}) === true, 'at the tail with no veto -> follow');
assert(shouldFollow(at(1000, 600, 400)) === true, 'omitted opts -> follow');

// Scrolled away by position alone -> do not fight the reader.
assert(shouldFollow(at(10000, 0, 400), {}) === false, 'scrolled away by position -> no follow');

// ------------------------------------------------------------- isCancellation
// Primary signal: the flag this renderer sets before it calls cancel.
assert(
  isCancellation(new Error('Error invoking remote method'), { userStopped: true }) === true,
  'userStopped is the primary signal, whatever the message says'
);
assert(
  isCancellation({ message: 'anything' }, { userStopped: true }) === true,
  'userStopped wins over an unrecognised message'
);
assert(isCancellation(null, { userStopped: true }) === true, 'userStopped wins over a null error');

// No flag, no error -> not a cancellation.
assert(isCancellation(null, {}) === false, 'null error with no flag is not a cancellation');
assert(isCancellation(undefined) === false, 'undefined error is not a cancellation');

// error.name survives within the renderer even though IPC drops it.
{
  const err = new Error('whatever');
  err.name = 'AbortError';
  assert(isCancellation(err, {}) === true, 'AbortError name is recognised');
}
{
  const err = new Error('whatever');
  err.code = 'ABORT_ERR';
  assert(isCancellation(err, {}) === true, 'ABORT_ERR code is recognised');
}

// The backstop: real abort phrasings, as each layer spells them.
assert(isCancellation(new Error('This operation was aborted'), {}) === true,
  'undici "This operation was aborted" is recognised');
assert(isCancellation(new Error('The user aborted a request.'), {}) === true,
  'Chromium "The user aborted a request." is recognised');
assert(isCancellation(new Error('signal is aborted without reason'), {}) === true,
  'AbortSignal reason is recognised');
assert(isCancellation('The user aborted a request.', {}) === true,
  'a bare string error is handled');

// The caveat this list exists for: a dropped socket contains the word "abort"
// but is a genuine failure. Relabelling it as a stop would hide the error and
// strand the user with a silently truncated answer.
assert(isCancellation(new Error('ECONNABORTED: connection aborted by peer'), {}) === false,
  'ECONNABORTED is a transport failure, not a user stop');
assert(isCancellation(new Error('socket hang up'), {}) === false,
  'socket hang up is not a user stop');
assert(isCancellation(new Error('aborted'), {}) === false,
  'a bare "aborted" is too weak to attribute to the user');
assert(isCancellation(new Error('request timed out'), {}) === false, 'a timeout is a failure');
assert(isCancellation(new Error('402 insufficient aegis-key balance'), {}) === false,
  'a billing refusal is a failure, not a stop');
assert(isCancellation(new Error(''), {}) === false, 'an empty message is not a stop');
assert(isCancellation(42, {}) === false, 'a non-string, non-Error rejection is not a stop');
assert(isCancellation({}, {}) === false, 'an object without message/name is not a stop');

console.log('stream-policy tests passed');
