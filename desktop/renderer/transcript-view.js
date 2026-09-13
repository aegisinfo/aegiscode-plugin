'use strict';

/**
 * The DOM-touching half of the transcript policy (plan Phase 8), extracted
 * from app.js so the two symptoms this work exists to prevent can be asserted
 * *behaviourally* — not just as pure math in stream-policy.js:
 *
 *   - the transcript snapping to the bottom while you read → `follow()` asks
 *     stream-policy's `shouldFollow()` and the reader's own scroll sets the
 *     veto through `attachScrollVeto()`;
 *   - Escape failing to interrupt → `bindEscapeInterrupt()` is the one place
 *     the keyboard listener is registered.
 *
 * Why extract instead of testing app.js itself: app.js boots only under the
 * Electron host (`window.aegis`/`window.models`) and builds a 2000-line UI, so
 * a test that drives it would assert on a mock of everything. Everything here
 * touches exactly four DOM surfaces — three numbers on the transcript element
 * (scrollHeight/scrollTop/clientHeight), one passive `scroll` listener, one
 * `keydown` listener on the document, and `requestAnimationFrame` — so
 * test/renderer-dom.test.mjs drives the real file with a 60-line fake DOM and
 * no third-party dependency. app.js only calls into this.
 *
 * Loaded as a classic script (index.html) *before* app.js, and requireable
 * from Node like max-tokens.js/stream-policy.js.
 */

// The decisions stay in stream-policy.js — one definition of "at the tail" and
// of "the reader has the veto". Classic script: resolve the globals declared by
// the sibling script tag; CommonJS: resolve the module. Eager, so a missing
// stream-policy.js script tag fails at load instead of on the first paint.
const policy =
  typeof module !== 'undefined' && module.exports
    ? require('./stream-policy.js')
    : { nearBottom: nearBottom, shouldFollow: shouldFollow };

/**
 * Coalescing paint + follow-the-tail state for the one transcript element.
 *
 * `messages` is the transcript (`#messages`); `requestFrame` defaults to the
 * window's `requestAnimationFrame` and is injectable so a test can flush
 * frames deterministically.
 */
function createTranscriptView(deps) {
  const d = deps || {};
  const messages = d.messages;
  const requestFrame =
    typeof d.requestFrame === 'function'
      ? d.requestFrame
      : typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn) => fn();

  /** Set while the reader has deliberately scrolled away from the tail. */
  let scrolledUp = false;

  /** Current transcript scroll metrics, or null when there is no transcript. */
  function metrics() {
    if (!messages) return null;
    return {
      scrollHeight: messages.scrollHeight,
      scrollTop: messages.scrollTop,
      clientHeight: messages.clientHeight,
    };
  }

  /**
   * The reader's veto over the streaming auto-scroll. This is the passive
   * `scroll` listener: without it `scrolledUp` can never become true, leaving
   * the transcript pinned to the tail no matter how far up you read while a
   * model is working. Fires on every scroll frame, so it only records position.
   */
  function noteScroll() {
    scrolledUp = !policy.nearBottom(metrics());
    return scrolledUp;
  }

  function attachScrollVeto(el) {
    const target = el || messages;
    if (!target || typeof target.addEventListener !== 'function') return false;
    target.addEventListener('scroll', noteScroll, { passive: true });
    return true;
  }

  /**
   * Follow the tail only while the reader is still there (was
   * `stickToBottom`). A streaming turn must never yank the view back down once
   * someone has scrolled up to read — that was why the transcript felt
   * unscrollable while a model was working. `force` is for the cases where the
   * view genuinely must follow: a message the user just sent, or a card they
   * just opened. Returns whether the view moved.
   */
  function follow(opts) {
    if (!messages) return false;
    if (!policy.shouldFollow(metrics(), { force: opts && opts.force, userScrolledUp: scrolledUp })) {
      return false;
    }
    if (opts && opts.force) scrolledUp = false;
    messages.scrollTop = messages.scrollHeight;
    return true;
  }

  /**
   * Coalesce high-frequency stream updates to one paint per frame (was
   * `rafPainter`). A cloud brain fan-out emits dozens of chunks a second, and
   * each repaint read scrollHeight (forcing a synchronous layout) — that
   * thrash is what made the window feel frozen mid-turn. Only the latest
   * payload is painted; dropped frames are invisible because the text is
   * cumulative. The returned function is idempotent within a frame.
   */
  function paint(fn) {
    let queued = false;
    return function schedule() {
      if (queued) return;
      queued = true;
      requestFrame(() => {
        queued = false;
        fn();
      });
    };
  }

  return {
    metrics: metrics,
    noteScroll: noteScroll,
    attachScrollVeto: attachScrollVeto,
    follow: follow,
    paint: paint,
    isScrolledUp: () => scrolledUp,
  };
}

/**
 * Escape → the running turn's interrupt (the keyboard twin of the cancel
 * button, for the window that is too busy to aim at it).
 *
 * Deliberately the only `keydown` registration: the memory overlay wins while
 * it is open — Escape closes it rather than reaching past it to cancel a turn
 * the user may not be looking at — and Escape does nothing at all when no turn
 * is pending, so the key never becomes a surprise.
 *
 * Returns the handler plus an `unbind()` for symmetry with the listener it
 * owns; the return value is also what lets a test call the decision directly.
 */
function bindEscapeInterrupt(deps) {
  const d = deps || {};

  function handle(e) {
    if (!e || e.key !== 'Escape') return false;
    if (typeof d.isOverlayOpen === 'function' && d.isOverlayOpen()) {
      if (typeof d.onOverlayEscape === 'function') d.onOverlayEscape();
      return false;
    }
    if (typeof d.hasPendingTurn === 'function' && !d.hasPendingTurn()) return false;
    if (typeof d.stopTurn !== 'function') return false;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    d.stopTurn();
    return true;
  }

  if (d.doc && typeof d.doc.addEventListener === 'function') {
    d.doc.addEventListener('keydown', handle);
  }

  return {
    handle: handle,
    unbind: () => {
      if (d.doc && typeof d.doc.removeEventListener === 'function') {
        d.doc.removeEventListener('keydown', handle);
      }
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createTranscriptView, bindEscapeInterrupt };
}
