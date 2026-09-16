#!/usr/bin/env node
/**
 * Behavioural tests for the DOM half of the transcript policy — the two
 * symptoms the streaming work exists to prevent (plan Phase 8 / P3.5):
 *
 *   1. the transcript snapping back to the bottom while you read;
 *   2. Escape not interrupting a running turn.
 *
 * Both were previously unprovable: `rafPainter`/`stickToBottom`/the Escape
 * listener lived inside app.js, which only boots under the Electron host, so
 * only stream-policy.js's *pure* `shouldFollow()` math was covered. A broken
 * scroll path could ship green — which is exactly how stream-policy.js once
 * shipped with no script tag at all.
 *
 * The files under test are the real production files, loaded the way the
 * browser loads them: this harness reads the `<script src=…>` list out of
 * index.html and evaluates each local script, in document order, into one
 * shared realm (classic scripts share the global lexical environment, so
 * `const`/`function` declarations in one are visible to the next — verified,
 * not assumed). A script tag that disappears therefore fails here too, as a
 * ReferenceError at load, not only in renderer-wiring.test.mjs's static check.
 *
 * No jsdom, no third-party dependency: the policy touches exactly four DOM
 * surfaces (three numbers on the transcript element, one passive `scroll`
 * listener, one `keydown` listener, requestAnimationFrame), so the fakes below
 * are ~60 lines and honest about what they stand in for. Documented limits:
 * real layout is not simulated — scroll metrics are the numbers this file
 * assigns — and `scrollTop` assignment is recorded verbatim rather than
 * clamped the way a browser's would be.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..', 'desktop', 'renderer');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ------------------------------------------------------------------ fake DOM

/** Minimal EventTarget: records listeners per type and dispatches to them. */
class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn, opts) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, opts });
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const i = list.findIndex((l) => l.fn === fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(event) {
    for (const { fn } of this.listeners.get(event.type) || []) fn(event);
    return event;
  }
  listenerOptions(type) {
    return (this.listeners.get(type) || []).map((l) => l.opts);
  }
}

/** A scroll container: only the three metrics app.js reads, plus events. */
class FakeElement extends FakeTarget {
  constructor({ scrollHeight = 0, scrollTop = 0, clientHeight = 0 } = {}) {
    super();
    this.scrollHeight = scrollHeight;
    this.scrollTop = scrollTop;
    this.clientHeight = clientHeight;
  }
}

class FakeKeyboardEvent {
  constructor(key) {
    this.type = 'keydown';
    this.key = key;
    this.defaultPrevented = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

/** Deterministic requestAnimationFrame: frames only run when flushed. */
function makeFrameClock() {
  const queue = [];
  let framesRequested = 0;
  return {
    requestFrame: (fn) => {
      framesRequested += 1;
      queue.push(fn);
      return framesRequested;
    },
    get framesRequested() {
      return framesRequested;
    },
    get pending() {
      return queue.length;
    },
    /** Run everything scheduled so far — one "display frame". */
    flush() {
      const batch = queue.splice(0, queue.length);
      for (const fn of batch) fn();
      return batch.length;
    },
  };
}

// ----------------------------------------------------------- load the scripts

const html = readFileSync(join(rendererDir, 'index.html'), 'utf8');
// Document order, the policy scripts only. Excluded on purpose:
//   - vendor/*.js are third-party bundles;
//   - markdown.js needs a real document at load time;
//   - app.js boots only under the Electron host (window.aegis/window.models)
//     and builds the whole UI, so it is asserted statically instead —
//     renderer-wiring.test.mjs checks that its script tag is present, ordered
//     after these, and that it actually calls into them.
const notPolicy = new Set(['markdown.js', 'app.js']);
const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((src) => !src.startsWith('vendor/') && !notPolicy.has(src));

// One realm for every script, exactly like consecutive <script> tags in a page.
// No `module` binding, so the files take their classic-script path and publish
// globals — the same objects app.js consumes in the app.
const realm = vm.createContext({ console });
const loadOrder = [];
for (const src of scriptSrcs) {
  // The script tag is the mechanism that makes these globals exist at all. If
  // it is missing from index.html the loop never loads the file, `typeof` below
  // is undefined, and the assertion names the file — the unwired-module bug.
  let code;
  try {
    code = readFileSync(join(rendererDir, src), 'utf8');
  } catch (err) {
    throw new Error(`index.html loads ${src}, which cannot be read: ${err.message}`);
  }
  try {
    vm.runInContext(code, realm, { filename: src });
  } catch (err) {
    throw new Error(
      `${src} threw while loading as a classic script — a script it depends on ` +
        `is missing or loaded after it (order so far: ${[...loadOrder, src].join(' → ')}): ${err.message}`
    );
  }
  loadOrder.push(src);
}

assert(
  typeof realm.createTranscriptView === 'function',
  'index.html must load transcript-view.js before this policy can be driven ' +
    `(loaded: ${loadOrder.join(', ')})`
);
assert(
  typeof realm.bindEscapeInterrupt === 'function',
  'transcript-view.js must publish bindEscapeInterrupt'
);
assert(
  typeof realm.shouldFollow === 'function' && typeof realm.nearBottom === 'function',
  'stream-policy.js must be loaded before transcript-view.js (its decisions)'
);
assert(
  loadOrder.indexOf('stream-policy.js') < loadOrder.indexOf('transcript-view.js'),
  'stream-policy.js must precede transcript-view.js in index.html'
);

const { createTranscriptView, bindEscapeInterrupt, shouldFollow } = realm;

/** Wire the policy exactly as app.js init() does. */
function boot({ messages, clock }) {
  const transcript = createTranscriptView({
    messages,
    requestFrame: clock.requestFrame,
  });
  transcript.attachScrollVeto();
  return transcript;
}

// =================================================== 1. rafPainter coalescing
// A cloud fan-out emits dozens of chunks a second; one paint per frame is what
// kept the window responsive. "N deltas, one repaint" is asserted by counting
// both scheduled frames and actual DOM writes.
{
  const clock = makeFrameClock();
  const messages = new FakeElement({ scrollHeight: 1000, clientHeight: 400 });
  const transcript = boot({ messages, clock });

  let bodyText = '';
  let writes = 0;
  let streamed = '';
  const paintStream = transcript.paint(() => {
    writes += 1;
    bodyText = streamed; // off the latest cumulative text, like app.js
  });

  // 50 deltas inside one display frame (the pathological case).
  for (let i = 0; i < 50; i += 1) {
    streamed += `chunk${i} `;
    paintStream();
  }
  assert(clock.framesRequested === 1, `50 deltas must schedule 1 frame, got ${clock.framesRequested}`);
  assert(clock.pending === 1, 'exactly one frame is queued, not 50 stacked frames');
  assert(writes === 0, 'nothing is painted before the frame runs (no synchronous repaint per chunk)');

  clock.flush();
  assert(writes === 1, `one frame must paint exactly once, got ${writes}`);
  assert(bodyText === streamed, 'the frame paints the latest cumulative text, not a stale chunk');

  // The gate re-arms: the next frame's deltas coalesce again.
  for (let i = 0; i < 20; i += 1) paintStream();
  assert(clock.framesRequested === 2, 'a second burst schedules exactly one more frame');
  clock.flush();
  assert(writes === 2, 'the painter is reusable across frames (a one-shot latch would strand the stream)');

  // A dropped frame loses nothing: the payload is cumulative, so the next paint
  // still shows every delta.
  streamed += 'tail';
  paintStream();
  clock.flush();
  assert(bodyText === streamed, 'no delta is lost by coalescing (last-write-wins on cumulative text)');

  // Independent painter instances must not share the queue flag.
  const other = transcript.paint(() => {});
  paintStream();
  other();
  assert(clock.framesRequested === 5, `each painter keeps its own gate (got ${clock.framesRequested})`);
  clock.flush();
}

// ====================== 2. follow-only-at-tail (the reader's scroll veto) ====
{
  const clock = makeFrameClock();
  const messages = new FakeElement({ scrollHeight: 5000, clientHeight: 400 });
  const transcript = boot({ messages, clock });

  // The listener must be registered, passive, and attached by the module —
  // without it `scrolledUp` can never become true, leaving the transcript
  // pinned to the tail no matter how far up you read mid-turn.
  const scrollOpts = messages.listenerOptions('scroll');
  assert(scrollOpts.length === 1, 'attachScrollVeto registers exactly one scroll listener');
  assert(
    scrollOpts[0] && scrollOpts[0].passive === true,
    'the scroll listener is passive (it fires every frame and must never block scrolling)'
  );

  // ---- the streaming loop while the reader is at the tail: stays pinned ----
  messages.scrollTop = 4600; // scrollHeight - clientHeight
  messages.dispatch({ type: 'scroll' });
  assert(transcript.isScrolledUp() === false, 'at the tail the reader is not scrolled up');

  for (let i = 0; i < 30; i += 1) {
    messages.scrollHeight += 18; // one text delta's worth of height
    assert(transcript.follow() === true, `chunk ${i} follows while the reader is at the tail`);
    assert(
      messages.scrollTop === messages.scrollHeight,
      `chunk ${i} leaves the view pinned to the tail (${messages.scrollTop} vs ${messages.scrollHeight})`
    );
    transcript.noteScroll(); // the assignment above fires a scroll event in a browser
  }
  assert(transcript.isScrolledUp() === false, 'following does not fake a reader veto');

  // ---- THE SYMPTOM: reader scrolls up, the model keeps streaming ----------
  messages.scrollTop = 1200;
  messages.dispatch({ type: 'scroll' });
  assert(transcript.isScrolledUp() === true, 'scrolling up to read sets the veto');

  const before = messages.scrollTop;
  for (let i = 0; i < 30; i += 1) {
    messages.scrollHeight += 120; // ~30 chunks' worth of output
    assert(
      transcript.follow() === false,
      `follow() must be a no-op while the reader is scrolled up (chunk ${i})`
    );
  }
  assert(
    messages.scrollTop === before,
    `the transcript must not snap to the bottom while you read (scrollTop ${messages.scrollTop} != ${before})`
  );

  // The veto outranks the measurement — the reason the flag is checked before
  // scrollHeight/scrollTop are read. A mid-stream reflow can momentarily
  // measure as "at the bottom" while the reader is nowhere near it; that is
  // exactly the repaint that feels like a hijack.
  messages.scrollHeight = messages.scrollTop + messages.clientHeight + 40; // inside the 48px slop
  assert(transcript.follow() === false, 'a reflow that measures as "at the bottom" must not re-pin a vetoed view');
  assert(messages.scrollTop === before, 'the vetoed view is still untouched after the reflow');

  // ---- back at the tail, following resumes (the veto is a position, not a latch)
  messages.scrollTop = messages.scrollHeight - messages.clientHeight;
  messages.dispatch({ type: 'scroll' });
  assert(transcript.isScrolledUp() === false, 'returning to the tail clears the veto');
  messages.scrollHeight += 18;
  assert(transcript.follow() === true, 'following resumes once the reader is back at the tail');
  assert(messages.scrollTop === messages.scrollHeight, 'resumed follow pins to the tail');

  // Metrics are re-read from the element on every call, never snapshotted.
  messages.scrollTop = 10;
  messages.dispatch({ type: 'scroll' });
  assert(transcript.isScrolledUp() === true, 'metrics are re-read from the element, not cached');

  // force is the one override: a message the user just sent, or a card that
  // blocks the turn, must come into view — and it returns the reader to the
  // tail, so it clears the veto.
  messages.scrollHeight = 9000;
  assert(transcript.follow({ force: true }) === true, 'force overrides the reader scroll');
  assert(messages.scrollTop === 9000, 'forced follow pins to the tail even while vetoed');
  assert(transcript.isScrolledUp() === false, 'a forced follow clears the veto');

  // The slop budget still applies through the DOM path: a scrollbar appearing
  // mid-stream leaves the view a few pixels short and must not silently stop
  // the follow.
  messages.scrollHeight = 10000;
  messages.scrollTop = 10000 - 400 - 20; // 20px short of the tail, inside the slop
  messages.dispatch({ type: 'scroll' });
  assert(transcript.isScrolledUp() === false, 'drift inside the slop budget still counts as the tail');
  messages.scrollHeight = 10018;
  assert(transcript.follow() === true, 'follow survives a few pixels of drift');
}

// A transcript element that does not exist yet must not throw — app.js boots
// before #messages is guaranteed (a boot failure must not cascade).
{
  const clock = makeFrameClock();
  const transcript = createTranscriptView({ messages: null, requestFrame: clock.requestFrame });
  assert(transcript.attachScrollVeto() === false, 'attachScrollVeto degrades without an element');
  assert(transcript.follow() === false, 'follow degrades without an element');
  assert(transcript.metrics() === null, 'metrics degrade to null without an element');
}

// ============ 2b. the UI "lift" signal (and why .messages is never smooth) ==
{
  const styleSrc = readFileSync(join(rendererDir, 'style.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
  // `scroll-behavior: smooth` turns every programmatic `scrollTop =` into an
  // animation. Section 2 above is exactly a loop of those assignments, so with
  // it on `.messages` the pane would always be mid-animation toward a tail it
  // never reaches, the scroll events would report "not at the bottom", and the
  // reader's veto would latch itself on. Asserted as CSS because that is where
  // the mistake is made: a one-line addition to a pane selector.
  const smoothTargets = [...styleSrc.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /(?:^|;)\s*scroll-behavior\s*:\s*smooth/.test(m[2]))
    .flatMap((m) => m[1].split(',').map((s) => s.trim()));
  assert(
    !smoothTargets.includes('.messages'),
    '.messages must not set scroll-behavior: smooth — follow() assigns scrollTop every ' +
      'streaming frame, so animating those assignments stalls the transcript short of the tail'
  );
  for (const sel of smoothTargets) {
    assert(
      /^\.(side|memory-scroll)$/.test(sel),
      `scroll-behavior: smooth added for ${sel} — only panes with no programmatic scroll path may use it`
    );
  }

  const { attachScrollLift } = realm;
  assert(typeof attachScrollLift === 'function', 'transcript-view.js must publish attachScrollLift');

  const clock = makeFrameClock();
  const classes = new Set();
  const body = {
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    },
  };
  const transcriptPane = new FakeElement({ scrollHeight: 5000, clientHeight: 400 });
  const sidePane = new FakeElement({ scrollHeight: 2000, clientHeight: 900 });
  const lift = attachScrollLift({
    panes: [transcriptPane, sidePane],
    target: body,
    requestFrame: clock.requestFrame,
  });

  const opts = transcriptPane.listenerOptions('scroll');
  assert(opts.length === 1, 'attachScrollLift registers exactly one scroll listener per pane');
  assert(
    opts[0] && opts[0].passive === true,
    'the lift scroll listener is passive — it fires every frame and must never block scrolling'
  );
  assert(
    !classes.has('is-scrolled'),
    'a pane at its top edge does not lift the chrome (the 4px threshold keeps rest-state sub-pixel scroll from flickering it)'
  );

  sidePane.scrollTop = 600;
  sidePane.dispatch({ type: 'scroll' });
  assert(clock.pending === 1, 'a scroll schedules exactly one frame, not one per event');
  sidePane.dispatch({ type: 'scroll' });
  sidePane.dispatch({ type: 'scroll' });
  assert(clock.pending === 1, 'further scroll events in the same frame coalesce into that one frame');
  clock.flush();
  assert(classes.has('is-scrolled'), 'scrolling any watched pane off its top edge lifts the chrome');

  transcriptPane.scrollTop = 0; // the transcript is back at its top, the side pane is still down
  transcriptPane.dispatch({ type: 'scroll' });
  clock.flush();
  assert(classes.has('is-scrolled'), 'the lift holds while any pane is still off its top edge');

  sidePane.scrollTop = 0;
  sidePane.dispatch({ type: 'scroll' });
  clock.flush();
  assert(!classes.has('is-scrolled'), 'the chrome drops back flat once every pane is at its top');

  lift.unbind();
  assert(
    transcriptPane.listenerOptions('scroll').length === 0,
    'unbind() removes the listeners it registered (no leak across a re-init)'
  );
}

// ================================== 3. Escape → stopPendingTurn (interrupt) ==
{
  const doc = new FakeTarget();
  let overlayOpenFlag = false;
  let overlayClosed = 0;
  let pending = true;
  const stopped = [];
  const esc = bindEscapeInterrupt({
    doc,
    isOverlayOpen: () => overlayOpenFlag,
    onOverlayEscape: () => {
      overlayClosed += 1;
    },
    hasPendingTurn: () => pending,
    stopTurn: () => stopped.push('turn'),
  });
  assert(typeof esc.handle === 'function', 'bindEscapeInterrupt returns its handler');
  assert(doc.listenerOptions('keydown').length === 1, 'Escape is bound on the document, once');

  // THE SYMPTOM: while a turn is running, Escape must interrupt it — the
  // keyboard twin of the cancel button, for the window too busy to aim at it.
  const e1 = new FakeKeyboardEvent('Escape');
  doc.dispatch(e1);
  assert(stopped.length === 1, `Escape must interrupt the running turn (stopTurn calls: ${stopped.length})`);
  assert(e1.defaultPrevented === true, 'the interrupt consumes the key (Escape must not also close a dialog)');

  // A second Escape still reaches the turn — the binding is not single-shot.
  doc.dispatch(new FakeKeyboardEvent('Escape'));
  assert(stopped.length === 2, 'Escape keeps working for later turns (not a one-shot latch)');

  // With nothing running, Escape is inert: it must never turn into a surprise
  // stop or a swallowed key.
  pending = false;
  const idle = new FakeKeyboardEvent('Escape');
  doc.dispatch(idle);
  assert(stopped.length === 2, 'Escape does nothing when no turn is pending');
  assert(idle.defaultPrevented === false, 'an idle Escape is not consumed');
  pending = true;

  // The memory overlay wins while it is open: Escape closes it rather than
  // reaching past it to cancel a turn the user may not be looking at.
  overlayOpenFlag = true;
  doc.dispatch(new FakeKeyboardEvent('Escape'));
  assert(overlayClosed === 1, 'Escape closes the open memory overlay');
  assert(stopped.length === 2, 'Escape must not cancel a turn while the overlay is open');
  overlayOpenFlag = false;

  // Every other key stays untouched — the handler is keydown-wide, so this is
  // the guard against it eating the composer.
  for (const key of ['Enter', 'a', 'Esc', 'F1', 'ArrowUp']) {
    const other = new FakeKeyboardEvent(key);
    doc.dispatch(other);
    assert(stopped.length === 2, `key ${key} must not stop the turn`);
    assert(other.defaultPrevented === false, `key ${key} must not be consumed`);
  }
  // A missing event object (defensive: some emitters pass nothing) must not throw.
  assert(esc.handle(undefined) === false, 'a null event is ignored, not fatal');

  // Unbind is real: after it, the document is clean (used if init ever re-runs).
  esc.unbind();
  assert(doc.listenerOptions('keydown').length === 0, 'unbind removes the keydown listener');
  doc.dispatch(new FakeKeyboardEvent('Escape'));
  assert(stopped.length === 2, 'after unbind, Escape no longer reaches the turn');
}

// .................. the interrupt must end as a *stop*, never as a failure ....
// The other half of the Escape symptom: an abort rejects over IPC, and the
// renderer would otherwise throw the partial answer away and paint a red error.
// app.js's stop path records `userStopped` before aborting and send()'s catch
// classifies with isCancellation(err, {userStopped}) — so assert that the abort
// shape a stopped turn produces is classified as a deliberate stop, while a
// genuine socket failure is not relabelled as one.
{
  const { isCancellation } = realm;
  assert(typeof isCancellation === 'function', 'stream-policy.js publishes isCancellation');

  const ipcAbort = new Error('Error invoking remote method: The user aborted a request.');
  assert(
    isCancellation(ipcAbort, { userStopped: true }) === true,
    'a stopped turn is classified as a stop (the partial answer is salvaged, not discarded)'
  );
  const droppedSocket = new Error('ECONNABORTED: connection aborted by peer');
  assert(
    isCancellation(droppedSocket, { userStopped: false }) === false,
    'a dropped socket stays a real failure even though it contains "aborted"'
  );
  assert(
    shouldFollow({ scrollHeight: 100, scrollTop: 0, clientHeight: 400 }, { userScrolledUp: true }) === false,
    'the veto outranks the measurement: a mid-stream reflow that measures as "at the bottom" must not re-pin the view'
  );
}

console.log(
  'renderer DOM policy tests passed (raf coalescing, follow-only-at-tail, ' +
    'Escape→interrupt, over ' +
    `${loadOrder.length} local scripts: ${loadOrder.join(', ')})`
);
