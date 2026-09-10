#!/usr/bin/env node
/**
 * Memory view test — the sidebar list and the full-screen inspector overlay.
 *
 * No Electron and no DOM library are installed, so this harness loads the
 * *real* renderer functions straight out of desktop/renderer/app.js by name
 * (brace-matched, not re-implemented) and runs them against a minimal fake
 * DOM. Testing a copy of the logic would prove nothing; extracting the actual
 * source means a regression in app.js fails here.
 *
 * What this locks down:
 *   - the response key is `entries` (aegis1/app.py:9254). Reading `results`
 *     is precisely the defect that kept the Memory card empty for every
 *     account, so it is asserted directly, with `results` kept only as a
 *     documented back-compat fallback;
 *   - `embedding` never reaches the DOM;
 *   - a malformed row degrades instead of throwing mid-render;
 *   - HTTP 402 `free_session_limit_reached` renders as an upgrade prompt, not
 *     as "no memory entries" (aegis1/app.py:9229);
 *   - the inspector itself — paint, chip filters, open/close, save routing —
 *     which is the headline feature and previously had no coverage at all;
 *   - every element id app.js asks for actually exists in index.html.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(__dirname, '..', 'desktop', 'renderer');
const APP_SRC = readFileSync(join(RENDERER, 'app.js'), 'utf8');
const HTML_SRC = readFileSync(join(RENDERER, 'index.html'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** Drain pending microtasks/timers so an un-awaited async call can settle.
 *  openMemoryOverlay() deliberately does not await loadMemoryOverlay(), so the
 *  fetch it kicks off is still in flight when the function returns. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Pull `function NAME(...) { ... }` out of a source string by brace matching.
 *  Keeps any `async ` prefix — dropping it turns `await` inside the body into
 *  a syntax error when the extracted source is re-evaluated. */
function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`extractFn: ${name} not found in app.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`extractFn: unbalanced braces for ${name}`);
}

// ------------------------------------------------------------- fake DOM

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this._text = '';
    this.listeners = {};
    this.hidden = false;
    this.value = '';
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      contains: (c) => this.classList._set.has(c),
      toggle: (c) => (this.classList._set.has(c) ? this.classList._set.delete(c) : this.classList.add(c)),
    };
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = v;
    this.children = []; // assigning text replaces children, like the real DOM
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  /** The renderers clear with `innerHTML = ''`, so honour it by dropping
   *  children — without this, re-renders appended forever and every "one <li>"
   *  assertion would be checking a stale pile. */
  set innerHTML(v) {
    if (v === '') this.children = [];
  }
  get innerHTML() {
    return '';
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  focus() {}
  /** Depth-first text of this node and everything under it. */
  allText() {
    return [this._text, ...this.children.map((c) => c.allText())].join(' ');
  }
  /** Every descendant whose className contains `cls`. */
  findAll(cls, out = []) {
    if (this.className && String(this.className).split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) c.findAll(cls, out);
    return out;
  }
}

const fakeNodeCache = new Map();
const document = {
  createElement: (tag) => new FakeEl(tag),
  getElementById: (id) => {
    if (!fakeNodeCache.has(id)) fakeNodeCache.set(id, new FakeEl('div'));
    return fakeNodeCache.get(id);
  },
  addEventListener: () => {},
  body: new FakeEl('body'),
};
const window = { getSelection: () => '' };

// The extracted functions reference these module-scope bindings, so they are
// injected as real globals before the sources are evaluated.
//
// `els` mirrors the real renderer: app.js's ELEMENT_IDS maps a camelCase prop
// to a kebab-case element id, so the proxy must translate too — a naive
// `getElementById(prop)` silently returns a fresh, detached node and every
// render assertion would pass against nothing.
const ELEMENT_IDS = {};
for (const m of APP_SRC.slice(APP_SRC.indexOf('const ELEMENT_IDS'), APP_SRC.indexOf('const els = {}')).matchAll(/(\w+):\s*'([^']+)'/g)) {
  ELEMENT_IDS[m[1]] = m[2];
}
const els = new Proxy(
  {},
  {
    get: (_t, prop) => document.getElementById(ELEMENT_IDS[prop] || String(prop)),
    has: () => true,
  }
);
const memoryView = { entries: [], query: '', source: '', role: '', error: '', upgrade: null, loading: false };
const aegis = {};
const MEMORY_INSPECTOR_LIMIT = 50;

const NS = { document, window, els, memoryView, aegis, MEMORY_INSPECTOR_LIMIT };
const names = Object.keys(NS);
const src = [
  'const { document, window, els, memoryView, aegis, MEMORY_INSPECTOR_LIMIT } = __NS;',
  extractFn(APP_SRC, 'overlayOpen'),
  extractFn(APP_SRC, 'relTime'),
  extractFn(APP_SRC, 'normalizeMemoryEntry'),
  extractFn(APP_SRC, 'fetchMemory'),
  extractFn(APP_SRC, 'renderMemoryResults'),
  extractFn(APP_SRC, 'memoryChip'),
  extractFn(APP_SRC, 'memoryCard'),
  extractFn(APP_SRC, 'memoryFacets'),
  extractFn(APP_SRC, 'memoryMatches'),
  extractFn(APP_SRC, 'renderMemoryChips'),
  extractFn(APP_SRC, 'renderMemoryOverlay'),
  extractFn(APP_SRC, 'loadMemoryOverlay'),
  extractFn(APP_SRC, 'openMemoryOverlay'),
  extractFn(APP_SRC, 'closeMemoryOverlay'),
  extractFn(APP_SRC, 'activeMemoryEntry'),
  'return { overlayOpen, relTime, normalizeMemoryEntry, fetchMemory, renderMemoryResults, memoryChip, memoryCard, memoryFacets, memoryMatches, renderMemoryChips, renderMemoryOverlay, loadMemoryOverlay, openMemoryOverlay, closeMemoryOverlay, activeMemoryEntry };',
].join('\n');

// eslint-disable-next-line no-new-func
const api = new Function('__NS', src)(NS);
void names;

async function main() {
  // ---------------------------------------------------------- relTime
  const now = Date.now();
  assert(api.relTime(now) === 'just now', 'now should read "just now"');
  assert(api.relTime(now - 5 * 60e3) === '5m ago', '5 minutes ago');
  assert(api.relTime(now - 3 * 3600e3) === '3h ago', '3 hours ago');
  assert(api.relTime(now - 2 * 86400e3) === '2d ago', '2 days ago');
  assert(api.relTime(null) === '', 'null createdAt renders nothing, not "NaN"');
  assert(api.relTime(undefined) === '', 'undefined createdAt renders nothing');

  // ------------------------------------------------- normalisation
  // Exact field set from aegis1/app.py:9349 _memory_row_to_dict.
  const ROW = {
    id: 'm1',
    timestamp: '2026-02-01T10:00:00',
    createdAt: now - 60e3,
    source: 'claude-desktop',
    role: 'user',
    tags: ['prefs', ''],
    content: 'Prefers dark mode and short answers.',
    session: 'sess-9',
    importance: 7,
    summary: false,
    topics: ['ui'],
    entities: ['AEGIS'],
    sentiment: 'neutral',
    tokenCount: 11,
    embedding: [0.1, 0.2, 0.3],
  };
  const n = api.normalizeMemoryEntry(ROW);
  assert(n.source === 'claude-desktop', 'source survives normalisation');
  assert(n.content === ROW.content, 'content survives normalisation');
  assert(n.importance === 7, 'importance coerced to a number');
  assert(n.createdAt === ROW.createdAt, 'createdAt survives');
  assert(n.tags.length === 1 && n.tags[0] === 'prefs', 'blank tags dropped');
  assert(!('embedding' in n), 'embedding MUST NOT be carried into the view');
  assert(JSON.stringify(n).indexOf('0.1') === -1, 'no embedding floats in the rendered object');

  // Malformed rows must degrade, not throw.
  for (const bad of [null, undefined, 42, 'str', {}, { tags: 'not-an-array', content: 12 }]) {
    const g = api.normalizeMemoryEntry(bad);
    assert(typeof g.content === 'string', 'malformed row yields string content');
    assert(g.source === '(unknown source)', 'malformed row yields a source label');
    assert(Array.isArray(g.tags) && Array.isArray(g.topics) && Array.isArray(g.entities),
      'malformed row yields arrays');
  }
  assert(api.normalizeMemoryEntry(ROW).source !== '(unknown source)', 'valid row is not labelled unknown');

  // ------------------------------------------------------ fetchMemory
  // THE defect: the backend sends `entries`. This is the regression lock.
  Object.assign(aegis, {
    memoryList: async (_limit) => ({ entries: [ROW] }),
    memorySearch: async (_q, _l) => ({ entries: [ROW, { ...ROW, id: 'm2' }] }),
  });
  const listRes = await api.fetchMemory('', 50);
  assert(listRes.entries.length === 1, `empty query should yield 1 entry, got ${listRes.entries.length}`);
  assert(listRes.error === '' && listRes.upgrade === null, 'clean response has no error/upgrade');

  const searchRes = await api.fetchMemory('dark', 50);
  assert(searchRes.entries.length === 2, 'search should yield 2 entries');

  // Back-compat: an older backend that still sends `results` keeps working.
  aegis.memoryList = async () => ({ results: [ROW] });
  assert((await api.fetchMemory('', 50)).entries.length === 1, '`results` fallback still works');

  // A shape we do not recognise must be empty, never a crash.
  aegis.memoryList = async () => ({ whatever: 1 });
  assert((await api.fetchMemory('', 50)).entries.length === 0, 'unknown shape yields an empty list');

  aegis.memoryList = async () => null;
  assert((await api.fetchMemory('', 50)).entries.length === 0, 'null body yields an empty list');

  // 402 from _memory_sync_access is an upgrade prompt, NOT an error/empty list.
  aegis.memoryList = async () => {
    const e = new Error('free_session_limit_reached');
    e.status = 402;
    e.data = { error: 'free_session_limit_reached', sessionsUsed: 3, freeSessionLimit: 3, upgradeUrl: 'https://aegiscloud.org/subscribe' };
    throw e;
  };
  const up = await api.fetchMemory('', 50);
  assert(up.upgrade !== null, '402 must set upgrade, got null');
  assert(up.error === '', '402 is not an "error" row');
  assert(up.entries.length === 0, '402 has no entries');
  assert(up.upgrade.url.includes('subscribe'), 'upgrade carries a URL');
  assert(up.upgrade.used === 3, 'upgrade carries sessions used');

  // Any other failure is an error row and must not masquerade as an upgrade.
  aegis.memoryList = async () => {
    const e = new Error('HTTP 500');
    e.status = 500;
    throw e;
  };
  const err = await api.fetchMemory('', 50);
  assert(err.error.includes('500'), `error surfaces the message, got "${err.error}"`);
  assert(err.upgrade === null, 'a 500 is not an upgrade prompt');

  // ------------------------------------------------- sidebar rendering
  const side = document.getElementById('memory-results');
  api.renderMemoryResults([api.normalizeMemoryEntry(ROW)]);
  assert(side.children.length === 1, 'sidebar renders one <li> per entry');
  assert(side.children[0].allText().includes('Prefers dark mode'), 'sidebar shows the content');
  assert(side.children[0].allText().includes('claude-desktop'), 'sidebar shows the source');

  api.renderMemoryResults([], '');
  assert(side.children[0].className === 'empty', 'empty list renders the placeholder');
  assert(side.children[0].textContent === 'no memory entries', 'placeholder text is stable');

  api.renderMemoryResults([], 'search failed: HTTP 500');
  assert(side.children[0].textContent.includes('500'), 'an error is shown, not swallowed as "empty"');

  // ------------------------------------------------- card + facets
  const card = api.memoryCard(api.normalizeMemoryEntry(ROW));
  const cardText = card.allText();
  for (const want of ['claude-desktop', 'user', 'imp 7', 'ui', 'AEGIS', 'Prefers dark mode']) {
    assert(cardText.includes(want), `card should show "${want}"`);
  }
  assert(cardText.includes('1m ago') || cardText.includes('session sess-9'),
    'card shows relative time and session');
  assert(!cardText.includes('0.1'), 'card must not render embedding floats');
  assert(card.findAll('mem-chip').length >= 4, 'card renders provenance chips');
  assert(card.findAll('mem-card-body').length === 1, 'card has exactly one body');
  // Clicking the body expands; clicking while text is selected must not.
  const body = card.findAll('mem-card-body')[0];
  assert(card.classList.contains('expanded') === false, 'card starts collapsed');
  body.listeners.click[0]({});
  assert(card.classList.contains('expanded') === true, 'click expands the card');
  body.listeners.click[0]({});
  assert(card.classList.contains('expanded') === false, 'clicking again collapses it');

  // A fresh card + an active selection: the click must be ignored, so the card
  // stays collapsed (selecting text to copy must not toggle the card).
  const selectCard = api.memoryCard(api.normalizeMemoryEntry(ROW));
  const selectBody = selectCard.findAll('mem-card-body')[0];
  NS.window.getSelection = () => 'selected text';
  selectBody.listeners.click[0]({});
  assert(selectCard.classList.contains('expanded') === false,
    'a click with an active text selection must not toggle');
  NS.window.getSelection = () => '';

  memoryView.entries = [ROW, { ...ROW, id: 'm2', source: 'aegis-desktop' }, { ...ROW, id: 'm3', source: 'aegis-desktop' }]
    .map(api.normalizeMemoryEntry);
  const facets = api.memoryFacets('source');
  assert(facets[0][0] === 'aegis-desktop' && facets[0][1] === 2, `facets sort by count, got ${JSON.stringify(facets)}`);
  assert(facets.length === 2, 'two distinct sources');
  assert(api.memoryFacets('role').length === 1, 'one distinct role');

  const e1 = api.normalizeMemoryEntry(ROW);
  assert(api.memoryMatches(e1, 'dark mode'), 'matches body text');
  assert(api.memoryMatches(e1, 'DARK'), 'match is case-insensitive');
  assert(api.memoryMatches(e1, 'claude-desktop'), 'matches the source');
  assert(api.memoryMatches(e1, 'aegis'), 'matches an entity');
  assert(api.memoryMatches(e1, 'ui'), 'matches a topic');
  assert(!api.memoryMatches(e1, 'zzz-nope'), 'non-match returns false');

  // --------------------------------------------------- inspector overlay
  // This is the feature itself. Nothing in the suite reached these functions
  // before, so a regression here would ship silently.
  const ov = els.memoryOverlay;

  // Grab a rendered chip button by its text prefix (chips are recreated on
  // every paint, so always re-query rather than holding a stale node).
  const chipButton = (label) => {
    for (const group of els.memoryChips.children) {
      for (const child of group.children) {
        if (child.tagName === 'BUTTON' && String(child.textContent).startsWith(label)) return child;
      }
    }
    return null;
  };
  const resetOverlay = (entries) => {
    memoryView.entries = entries.map(api.normalizeMemoryEntry);
    memoryView.query = '';
    memoryView.source = '';
    memoryView.role = '';
    memoryView.error = '';
    memoryView.upgrade = null;
    memoryView.loading = false;
  };

  // A hidden overlay must not paint — that is what keeps it from costing a
  // repaint (and a request) while the user is in the chat view.
  ov.hidden = true;
  const sideLiCount = side.children.length;
  api.renderMemoryOverlay();
  assert(els.memoryList.children.length === 0, 'a hidden overlay must not paint the list');

  // Now the real paint: three rows across two sources.
  ov.hidden = false;
  resetOverlay([
    { ...ROW, id: 'o1', source: 'claude-desktop' },
    { ...ROW, id: 'o2', source: 'aegis-desktop' },
    // A second role, so the role chip group is renderable too (a single value
    // is deliberately not offered as a filter).
    { ...ROW, id: 'o3', source: 'aegis-desktop', role: 'assistant' },
  ]);
  api.renderMemoryOverlay();
  assert(els.memoryList.children.length === 3,
    `overlay paints one card per entry, got ${els.memoryList.children.length}`);
  assert(els.memoryList.children[0].className.includes('mem-card'), 'painted rows are cards');
  assert(els.memoryCount.textContent.includes('3 of 3'),
    `count line reads "N of M", got "${els.memoryCount.textContent}"`);
  assert(els.memoryCount.textContent.includes('2 sources'), 'count reports distinct sources');
  assert(!els.memoryCount.textContent.includes('newest'), 'exactly 3 rows is not a clamped page');

  // Chip filters narrow the painted list, and click again to clear.
  const aegisChip = chipButton('aegis-desktop');
  assert(!!aegisChip, 'a source chip is rendered for aegis-desktop');
  assert(els.memoryChips.children.length === 2, 'source and role each get a chip group');
  aegisChip.listeners.click[0]({});
  assert(memoryView.source === 'aegis-desktop', 'clicking a chip sets the filter');
  assert(els.memoryList.children.length === 2,
    `source filter narrows to 2, got ${els.memoryList.children.length}`);
  assert(els.memoryCount.textContent.includes('2 of 3'), 'count reflects the active filter');
  chipButton('aegis-desktop').listeners.click[0]({});
  assert(memoryView.source === '', 'clicking the active chip clears the filter');
  assert(els.memoryList.children.length === 3, 'clearing the chip restores every row');

  // Text search, including uppercase — the memoryMatches regression.
  memoryView.query = 'DARK';
  api.renderMemoryOverlay();
  assert(els.memoryList.children.length === 3, 'an uppercase query still matches');
  memoryView.query = 'zzz-nope';
  api.renderMemoryOverlay();
  assert(els.memoryList.children.length === 1 && els.memoryList.children[0].className.includes('mem-empty'),
    'no matches renders the filtered-empty state, not a blank list');

  // 402: an upgrade prompt, explicitly NOT the "no memory entries" text.
  resetOverlay([]);
  memoryView.upgrade = { url: 'https://aegiscloud.org/subscribe', used: 3, limit: 3 };
  api.renderMemoryOverlay();
  assert(els.memoryList.children.length === 1, 'the upgrade state paints one block');
  const upText = els.memoryList.children[0].allText();
  assert(els.memoryList.children[0].className.includes('mem-upgrade'), 'the block is labelled mem-upgrade');
  assert(upText.includes('free plan'), 'it explains the plan state');
  assert(upText.includes('3 of 3'), 'it shows sessions used of the cap');
  assert(upText.includes('subscribe'), 'it links to the subscribe page');
  assert(!upText.includes('no memory entries'), '402 must never read as an empty list');

  // A 500 is an error row, not an upgrade prompt.
  resetOverlay([]);
  memoryView.error = 'search failed: HTTP 500';
  api.renderMemoryOverlay();
  assert(els.memoryList.children[0].allText().includes('500'), 'the error state surfaces the message');
  assert(!els.memoryList.children[0].allText().includes('free plan'), 'a 500 is not an upgrade prompt');

  // Loading and genuinely-empty states.
  resetOverlay([]);
  memoryView.loading = true;
  api.renderMemoryOverlay();
  assert(els.memoryCount.textContent === 'loading…', 'loading sets the count line');
  assert(els.memoryList.children.length === 0, 'loading paints no rows');
  memoryView.loading = false;
  api.renderMemoryOverlay();
  assert(els.memoryCount.textContent === '0 entries', 'the empty state counts zero');

  // A clamped page must say so rather than implying it is complete (option A:
  // app.py:9243 clamps limit to 50, there is no offset).
  resetOverlay(Array.from({ length: 50 }, (_, i) => ({ ...ROW, id: `c${i}` })));
  api.renderMemoryOverlay();
  assert(els.memoryCount.textContent.includes('newest 50'),
    `a full page is labelled as clamped, got "${els.memoryCount.textContent}"`);

  // -------------------------------------------- open / close lifecycle
  aegis.memoryList = async () => ({ entries: [ROW, { ...ROW, id: 'o2', source: 'aegis-desktop' }] });
  ov.hidden = true;
  document.body.classList.remove('memory-open');
  els.memoryQuery.value = '  dark  ';
  memoryView.source = 'stale';
  memoryView.role = 'stale';
  api.openMemoryOverlay();
  await settle();
  assert(ov.hidden === false, 'open un-hides the overlay');
  assert(document.body.classList.contains('memory-open'), 'open locks body scroll');
  assert(memoryView.query === 'dark', `open seeds the query from the sidebar, got "${memoryView.query}"`);
  assert(els.memoryOverlayQuery.value === 'dark', 'open mirrors the query into the overlay field');
  assert(memoryView.source === '' && memoryView.role === '', 'open resets stale chip filters');
  assert(memoryView.entries.length === 2, 'open fetches a fresh page into the inspector');
  assert(memoryView.loading === false, 'loading is cleared once the fetch resolves');
  assert(els.memoryList.children.length === 2, 'the fetched page is painted');

  api.closeMemoryOverlay();
  assert(ov.hidden === true, 'close re-hides the overlay');
  assert(!document.body.classList.contains('memory-open'), 'close releases the scroll lock');

  // Save routing: the button reads whichever textarea is live.
  ov.hidden = false;
  assert(api.activeMemoryEntry() === els.memoryOverlayEntry, 'an open overlay routes save to the overlay box');
  ov.hidden = true;
  assert(api.activeMemoryEntry() === els.memoryEntry, 'a closed overlay routes save to the sidebar box');
  assert(api.overlayOpen() === false, 'overlayOpen() reports the closed state');

  assert(side.children.length === sideLiCount || sideLiCount === 0,
    'repainting the overlay must not disturb the sidebar list');

  // ------------------------------------------------------------- ids
  // Every id app.js queries must exist in index.html, or the overlay silently
  // binds nothing (this is how the sidebar list stayed dead).
  const idsBlock = APP_SRC.slice(APP_SRC.indexOf('const ELEMENT_IDS'), APP_SRC.indexOf('const els = {}'));
  const wanted = [...idsBlock.matchAll(/(\w+):\s*'([^']+)'/g)]
    .map((m) => m[2])
    .filter((id) => id.startsWith('memory') || id.startsWith('mem'));
  assert(wanted.length >= 13, `expected the memory inspector ids, found ${wanted.length}`);
  for (const id of wanted) {
    assert(HTML_SRC.includes(`id="${id}"`), `index.html is missing id="${id}"`);
  }

  // The overlay must start hidden and the heading must be a real button.
  assert(/id="memory-overlay"\s+hidden/.test(HTML_SRC) || /id="memory-overlay"[^>]*hidden/.test(HTML_SRC),
    'overlay ships hidden so it cannot block first paint');
  assert(/<h2>\s*<button[\s\S]{0,300}id="memory-open"/.test(HTML_SRC),
    'the Memory heading must wrap the trigger button');
  assert(HTML_SRC.includes('id="memory-backdrop"'), 'backdrop exists for click-outside close');

  console.log('Memory view test passed: entries key, 402 upgrade, embedding stripped, inspector paint/filter/open/close, ids wired.');
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
