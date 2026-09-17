#!/usr/bin/env node
/**
 * Discovery-lane cost test — the renderer silently billing 3× a turn.
 *
 * The bug this locks down: measured against the CLI on the same engine, the
 * desktop burned roughly three model calls per turn where the CLI burned one.
 * The cause was the discovery lane. After every successful turn the renderer
 * called `addFlowLane`, whose body fires `FLOW_PATHS.slice(0, 2)` — two extra
 * `models.chat` dispatches, each resending the whole original prompt. Two
 * independent mistakes made that both invisible and worse than 2×:
 *
 *   1. index.html shipped `#explore-toggle` with the `checked` attribute, and
 *      the boot code only *un*ticked it on an explicit saved `'off'`. Nothing
 *      had ever written `aegis.explore` on a fresh install, so the lane was on
 *      by default — contradicting app.js's own comment calling it opt-in.
 *
 *   2. The lane's `models.chat` payload set neither `autonomous` nor
 *      `singlePass`. The engine derives the pooled brain flag as
 *      `singlePass ? false : autonomous ? true : undefined` (engine.js:731),
 *      so on a `nexus-brain*` model id the flag was `undefined` and the model
 *      id's own default — the workers + synthesis fan-out — decided. A card
 *      meant to be one cheap 1024-token pass could bill a fan-out, twice per
 *      turn. `tools: false` did not prevent that; it only removed the agent
 *      loop from the dispatch it was already paying for.
 *
 * Everything below is derived from the real sources rather than hardcoded, so
 * the test fails on a *reintroduction* of either mistake rather than on a
 * cosmetic reword:
 *
 *   - the toggle's default is checked by *evaluating* the boot expression
 *     against every localStorage state, not by grepping for `=== 'on'`;
 *   - the lane's real options literal is extracted by brace matching and
 *     evaluated in a vm with stubbed `spec`, so `singlePass`/`tools`/the
 *     maxTokens clamp are asserted on the object the renderer actually sends;
 *   - the lane's fan-out width is pinned to `FLOW_PATHS.slice(0, 2)`, so
 *     widening the lane is a deliberate, visible edit;
 *   - `addFlowLane` is required to have exactly one call site, guarded by
 *     `exploreEnabled()`, so it can never become unconditional.
 *
 * Limits, stated honestly: this does not run Electron, does not count bytes
 * sent to a provider, and does not price anything. It proves the three
 * decisions that produced the 3× — default-on, un-pinned fan-out flag, and an
 * unguarded call site — and that a single card is one dispatch.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(here, '..', 'desktop', 'renderer');
const HTML_SRC = readFileSync(join(RENDERER, 'index.html'), 'utf8');
const APP_SRC = readFileSync(join(RENDERER, 'app.js'), 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error(`ASSERT FAILED: ${msg}`);
  }
}

// ------------------------------------------------------- brace/string walker

/** Skip a quoted string starting at `i`; returns the index just past it. */
function skipString(src, i) {
  const quote = src[i];
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === quote) return i + 1;
    else if (src[i] === '\n') return i + 1; // unterminated: fail soft
    else i += 1;
  }
  return i;
}

/**
 * Skip a template literal, including nested `${ … }` expressions which may
 * themselves contain templates. Returns the index just past the closing
 * backtick. The lane payload is mostly template literal (`${spec.prompt}`,
 * `${FLOW_SYSTEM}`), so a walker that mis-handled these would slice the
 * options object in half and the assertions below would test nothing.
 */
function skipTemplate(src, i) {
  i += 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') i += 2;
    else if (c === '`') return i + 1;
    else if (c === '$' && src[i + 1] === '{') i = skipBalanced(src, i + 1) .end;
    else i += 1;
  }
  return i;
}

/** Slice a balanced `{ … }` block starting at `start`. */
function skipBalanced(src, start) {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(src, i);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 };
    }
    i += 1;
  }
  throw new Error(`unbalanced braces starting at offset ${start}`);
}

/** Source text of a named top-level function, via brace matching. */
function functionSource(src, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`, 'g');
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const brace = src.indexOf('{', m.index);
  return skipBalanced(src, brace).text;
}

// ------------------------------------------- 1. the toggle ships opt-in

const inputTag = (HTML_SRC.match(/<input\b[^>]*\bid="explore-toggle"[^>]*>/s) || [])[0];
assert(!!inputTag, 'index.html still contains an #explore-toggle input');

if (inputTag) {
  assert(
    !/(^|\s)checked(\s|=|>|\/|$)/.test(inputTag),
    'the #explore-toggle input must not ship the `checked` attribute — the lane bills two extra model calls per turn, so it is opt-in'
  );
}

// ---------------------------------- 2. the boot default is off, behaviourally

const bootMatch = APP_SRC.match(/els\.exploreToggle\.checked\s*=\s*([^;]+);/);
assert(!!bootMatch, 'app.js still assigns els.exploreToggle.checked at boot');

if (bootMatch) {
  const expr = bootMatch[1].trim();
  const evaluate = (saved) =>
    vm.runInNewContext(expr, { savedExplore: saved }, { timeout: 1000 });

  for (const neverAsked of [null, undefined, '']) {
    assert(
      evaluate(neverAsked) === false,
      `with no saved preference (${JSON.stringify(neverAsked)}) the lane must be off, got ${evaluate(neverAsked)}`
    );
  }
  assert(evaluate('off') === false, "a saved 'off' keeps the lane off");
  assert(evaluate('on') === true, "only an explicit saved 'on' turns the lane on");
  assert(
    evaluate('ON') === false && evaluate('true') === false,
    `any value other than the exact string 'on' must leave the lane off; the boot expression "${expr}" accepts more than it should`
  );
}

const changeHandler = APP_SRC.match(
  /addEventListener\('change'[\s\S]{0,400}?localStorage\.setItem\(EXPLORE_KEY[\s\S]{0,120}?\)/
);
assert(
  !!changeHandler,
  'the toggle still persists its state to EXPLORE_KEY, so an opt-in survives a reload'
);

// -------------------------------- 3. the lane sends exactly one provider call

// The dispatch is three functions deep: `addFlowLane` (container) builds one
// `flowCard` per FLOW_PATHS entry, and each card hands off to `spawnPath`, which
// is the only thing that awaits `models.chat`. Asserting against the wrong link
// is how a cost test passes while the lane still bills a fan-out, so the whole
// chain is checked, link by link, for a single call site each.
const laneBody = functionSource(APP_SRC, 'addFlowLane');
const cardBody = functionSource(APP_SRC, 'flowCard');
const pathBody = functionSource(APP_SRC, 'spawnPath');

const chatIdx = pathBody.indexOf('models.chat(');
assert(chatIdx > 0, 'spawnPath still dispatches the lane card through models.chat');
assert(
  laneBody.indexOf('models.chat(') === -1 && cardBody.indexOf('models.chat(') === -1,
  'only spawnPath may reach models.chat — a second dispatch path in the lane would bill a call the toggle does not describe'
);

const optionBrace = pathBody.indexOf('{', pathBody.indexOf('(', chatIdx));
const optionsLiteral = skipBalanced(pathBody, optionBrace).text;

const spec = {
  cls: 'local',
  model: 'nexus-brain-test',
  maxTokens: 8192,
  prompt: 'Original prompt text',
  path: { hint: 'Path hint text' },
};
const payload = vm.runInNewContext(
  `(${optionsLiteral})`,
  { spec, id: 'sess-1', FLOW_SYSTEM: '[flow system prompt]' },
  { timeout: 1000 }
);

assert(
  payload.singlePass === true,
  'the lane payload must set `singlePass: true` — without it the engine leaves the pooled brain flag undefined (engine.js:731) and a nexus-brain* id bills the workers + synthesis fan-out for a 1024-token card'
);
assert(
  payload.tools === false,
  'the lane payload must keep `tools: false`; the lane is a summariser, not an agent loop'
);
assert(
  payload.autonomous !== true,
  'the lane must never declare itself autonomous — that is the flag that turns the fan-out on'
);
assert(
  payload.maxTokens <= 1024,
  `the lane card is capped at 1024 output tokens (got ${payload.maxTokens}); raising the cap silently multiplies the lane's cost per turn`
);
assert(
  payload.model === spec.model,
  'the lane runs on the same priced model as the turn it follows'
);

// ----------------------------- 4. the fan-out width and the call-site guard

const width = laneBody.match(/FLOW_PATHS\.slice\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
assert(
  !!width,
  'addFlowLane must still derive its card count from FLOW_PATHS.slice(n, m), so changing how many extra calls a turn bills is a visible edit'
);
if (width) {
  const n = Number(width[1]);
  const m = Number(width[2]);
  assert(
    m - n <= 2,
    `the lane fires ${m - n} extra model calls per turn; the documented cost is two ("around 3x"), so widening it needs a deliberate change here`
  );
}

const callSites = [...APP_SRC.matchAll(/(^|[^.\w])addFlowLane\s*\(/g)].filter((m) => {
  const before = APP_SRC.slice(Math.max(0, m.index - 12), m.index);
  return !/function\s*$/.test(before);
});
assert(
  callSites.length === 1,
  `addFlowLane must have exactly one call site (found ${callSites.length}); a second unguarded call site is how the lane became unavoidable`
);
if (callSites.length === 1) {
  const at = callSites[0].index;
  const guard = APP_SRC.slice(Math.max(0, at - 300), at);
  assert(
    /if\s*\([^)]*exploreEnabled\(\)/.test(guard),
    'the addFlowLane call site must sit behind an `exploreEnabled()` guard, so the lane can never fire for a user who did not opt in'
  );
}

// A card must be reachable only through the lane container and spawn exactly
// one dispatch. One call site per link is what makes "extra calls per turn" a
// number that can be read off FLOW_PATHS rather than measured in a bill.
const countIn = (haystack, name) =>
  [...haystack.matchAll(new RegExp(`(^|[^.\\w])${name}\\s*\\(`, 'g'))].filter((m) => {
    const before = haystack.slice(Math.max(0, m.index - 12), m.index);
    return !/function\s*$/.test(before);
  }).length;

assert(
  countIn(APP_SRC, 'spawnPath') === 1,
  `spawnPath must be called from exactly one place (found ${countIn(APP_SRC, 'spawnPath')}); every extra call site is an unpriced extra model call`
);
assert(
  countIn(cardBody, 'spawnPath') === 1,
  'flowCard must hand off to spawnPath exactly once — one card is one provider call'
);

// Two call sites, both inside addFlowLane: the automatic lane and the `+`
// button that adds a further path on demand. Both are user-visible; a card
// built outside the container is not.
const cardSites = countIn(APP_SRC, 'flowCard');
assert(
  cardSites === 2 && countIn(laneBody, 'flowCard') === 2,
  `flowCard must be called only from inside addFlowLane (found ${cardSites} total, ${countIn(laneBody, 'flowCard')} in the lane); a card built elsewhere bills a provider call with no toggle in the path`
);
assert(
  laneBody.includes('FLOW_PATHS.slice('),
  'addFlowLane must still populate the lane by iterating FLOW_PATHS, so the per-turn call count stays a one-line, reviewable decision'
);

if (failures > 0) {
  console.error(`\ndiscovery-lane cost tests FAILED (${failures} assertion${failures === 1 ? '' : 's'})`);
  process.exit(1);
}

console.log(
  'discovery-lane cost tests passed (toggle ships unchecked, boot default is off for ' +
    'every unset state, lane payload pins singlePass:true + tools:false + <=1024 tokens, ' +
    'lane width <= 2 extra calls, single exploreEnabled-guarded call site)'
);
