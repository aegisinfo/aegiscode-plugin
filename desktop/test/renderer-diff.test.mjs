#!/usr/bin/env node
/**
 * Behavioural tests for the transcript's file-edit diff block — the line-diff
 * engine (renderer/diff.js) and its DOM paint layer (renderer/diffview.js).
 *
 * The three regressions this file exists to pin down are all ones the ported
 * CLI engine shipped at some point:
 *
 *   1. a bogus leading "… N unchanged lines" marker on an ordinary small edit
 *      (the old `ctxBeforeStart < pre` condition fired whenever *any* line
 *      preceded the change), and the count being `context` rather than the real
 *      number hidden;
 *   2. trailing-context rows reading `b[a.length - post + i]` — the wrong line
 *      and the wrong gutter number for any edit that changes the line count;
 *   3. the LCS cap not bounding a pathological pair of long files.
 *
 * …plus the host-specific one: diff content is arbitrary file bytes, so the
 * renderer must put every line in as *text*, never innerHTML.
 *
 * No third-party dependency and no jsdom: diffview.js takes an injectable
 * `document`, so the fake below is the ~40 lines it actually needs. The two
 * modules under test are the real production files, loaded as CommonJS (they
 * carry the same `typeof module !== 'undefined'` export block the other
 * renderer modules do).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const diff = require('../renderer/diff.js');
const diffview = require('../renderer/diffview.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ------------------------------------------------------------------ fake DOM
//
// Records every element tag and attribute created so the escaping test can
// assert that nothing structural — an `<img>`, an `onerror` — was ever built
// from the file content. Real layout is not simulated; `textContent` on an
// element with children concatenates them the way a browser's would, which is
// what lets the tests read a row's rendered text back out.
function createDom() {
  const tags = [];
  const attrs = [];

  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.className = '';
      this.style = {};
      this.children = [];
      this.listeners = new Map();
      this.attributes = {};
      this._text = '';
      tags.push(this.tagName.toLowerCase());
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      attrs.push(name);
    }
    dispatch(type, event) {
      for (const fn of this.listeners.get(type) || []) fn(event || { type, preventDefault() {} });
    }
    get textContent() {
      if (this.children.length) {
        return this.children.map((c) => (c == null ? '' : c.textContent)).join('');
      }
      return this._text;
    }
    set textContent(v) {
      this.children = [];
      this._text = String(v);
    }
  }

  const document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  };
  return { document, tags, attrs };
}

/** Every element in the subtree, depth-first. */
function walk(node, out = []) {
  if (!node || !node.children) return out;
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}

const MARKER = (r) => r.marker === true;
const CODE = (el) => /diff-(add|del|ctx)\b/.test(el.className);

// ============================================================== (a) identical
{
  const d = diff.lineDiff('a\nb\nc', 'a\nb\nc');
  assert(d.adds === 0 && d.dels === 0, `identical text has no adds/dels (got +${d.adds} -${d.dels})`);
  assert(!d.rows.some(MARKER), 'identical text produces no marker rows');
  // Not merely "no marker": identical input must render as NOTHING. The earlier
  // assertion here was `every((r) => r.sign === ' ')`, which an all-context
  // orphan block satisfies — it passed against code that painted three phantom
  // context rows over an unchanged pair.
  assert(d.rows.length === 0, `identical text produces no rows (got ${d.rows.length})`);
}

// ================================================= (b) plain 3-line edit, no marker
{
  // A change with <= DIFF_LIMITS.context lines on both sides must NOT grow a
  // "… N unchanged lines" note — that was the leading-context bug.
  const d = diff.lineDiff('a\nb\nc', 'a\nB\nc');
  assert(!d.rows.some(MARKER), 'a small middle edit has no leading or trailing marker');
  assert(d.adds === 1 && d.dels === 1, `small edit is +1 -1 (got +${d.adds} -${d.dels})`);
}

// ============================ (c) deep change: correct omitted-line count
{
  const lines = [];
  for (let i = 1; i <= 100; i++) lines.push(`line ${i}`);
  const b = lines.slice();
  b[49] = 'line 50 CHANGED'; // the 50th line
  const d = diff.lineDiff(lines.join('\n'), b.join('\n'));

  assert(d.rows[0] && d.rows[0].marker, 'a change deep in a file gets a leading marker');
  assert(
    d.rows[0].note === '… 46 unchanged lines',
    `leading marker must report the real hidden count (… 46), got "${d.rows[0].note}"`,
  );
  // 49 leading lines existed; the last 3 are kept, so exactly 46 are hidden.
  assert(!/… 3 /.test(d.rows[0].note), 'the marker must not report `context` as the hidden count');
}

// ================= (d) line-count change: trailing gutter numbers are from `b`
{
  const oldText = 'a\nb\nc\nd\ne';
  const newText = 'a\nb\nX\nY\nc\nd\ne'; // +2 lines inserted
  const d = diff.lineDiff(oldText, newText);

  let lastChange = -1;
  d.rows.forEach((r, i) => {
    if (r.sign === '+' || r.sign === '-') lastChange = i;
  });
  const tail = d.rows.slice(lastChange + 1).filter((r) => !r.marker);
  assert(tail.length === 3, `expected 3 trailing context rows, got ${tail.length}`);
  assert(
    tail.map((r) => r.text).join('|') === 'c|d|e',
    `trailing context must be the tail of the NEW text, got "${tail.map((r) => r.text).join('|')}"`,
  );
  assert(
    tail.map((r) => r.no).join(',') === '5,6,7',
    `trailing gutter numbers must come from the new file (5,6,7), got "${tail.map((r) => r.no).join(',')}"`,
  );
}

// ================================================== (e) the LCS cap path
{
  const A = [];
  const B = [];
  for (let i = 0; i < 600; i++) {
    A.push(`old ${i} alpha`);
    B.push(`new ${i} beta`); // 600x600 = 360000 cells > lcsCells (250000)
  }
  const started = Date.now();
  const d = diff.lineDiff(A.join('\n'), B.join('\n'));
  const elapsed = Date.now() - started;

  assert(d.truncated === true, 'exceeding the LCS cap must set truncated');
  assert(elapsed < 2000, `the cap path must not hang (took ${elapsed}ms)`);
  assert(
    d.rows.length <= diff.DIFF_LIMITS.rows + 1,
    `rows are bounded by DIFF_LIMITS.rows + footer (got ${d.rows.length})`,
  );
  assert(d.rows[d.rows.length - 1].marker, 'a full replacement ends in a truncation footer');
}

// =================================== (f) writeFile with a missing base file
{
  const p = diff.editPreview(
    'writeFile',
    { file_path: '/repo/src/new.js', content: 'export const x = 1;\n' },
    { cwd: '/repo', readFile: () => ({ text: null, missing: true }) },
  );
  assert(p && p.kind === 'Create', `a write with no base file is a Create (got ${p && p.kind})`);
  assert(p.adds === 1 && p.dels === 0, 'a create-style diff is all additions');

  // The engine's own spelling maps to the same path.
  const p2 = diff.editPreview(
    'Write',
    { file_path: '/repo/src/new.js', content: 'x' },
    { cwd: '/repo', readFile: () => ({ text: null, missing: true }) },
  );
  assert(p2 && p2.kind === 'Create', 'the engine `Write` spelling is accepted too');
}

// ============================================ (g) garbage args → null, no throw
{
  assert(diff.editPreview('editFile', null) === null, 'null args → null');
  assert(diff.editPreview('editFile', 'not-an-object') === null, 'string args → null');
  assert(diff.editPreview('editFile', {}) === null, 'args without a path → null');
  assert(diff.editPreview('editFile', { file_path: '/x', old_string: 1, new_string: 'b' }) === null,
    'a non-string old_string → null');
  assert(diff.editPreview('writeFile', { file_path: '/x', content: 42 }) === null,
    'a non-string write content → null');
  assert(diff.editPreview('someOtherTool', { file_path: '/x' }) === null,
    'a non-edit tool → null');
  // A reader that throws must be swallowed (decoration never breaks a turn).
  assert(
    diff.editPreview('writeFile', { file_path: '/x', content: 'y' }, {
      readFile: () => { throw new Error('boom'); },
    }) === null,
    'a throwing readFile is swallowed, not propagated',
  );
}

// ============================ (h) renderDiffBlock: rows, escaping, toggling
{
  const XSS = '<img src=x onerror=alert(1)>';
  const preview = diff.editPreview(
    'editFile',
    { file_path: '/repo/src/a.js', old_string: `const a = 1;\n${XSS}`, new_string: `const b = 2;\n${XSS}` },
    { cwd: '/repo' },
  );
  assert(preview && preview.rows.length === 3, `expected a 3-row preview, got ${preview && preview.rows.length}`);

  const { document, tags, attrs } = createDom();
  const block = diffview.renderDiffBlock(preview, document, { open: true });
  assert(block && block.className === 'diff-block', 'renderDiffBlock returns a .diff-block');

  const summary = block.children[0];
  const body = block.children[1];
  assert(summary.className === 'diff-summary', 'the first child is the clickable summary');
  assert(body.className === 'diff-body', 'the second child is the diff body');
  assert(summary.textContent.includes('Update(src/a.js)'), 'the summary names the file and kind');
  assert(summary.textContent.includes('+1') && summary.textContent.includes('-1'), 'the summary shows +/-counts');
  assert(summary.textContent.includes('click to collapse'), 'an open block offers "collapse"');

  const codeRows = body.children.filter(CODE);
  assert(codeRows.length === 3, `a 3-row preview paints 3 code rows (got ${codeRows.length})`);
  assert(codeRows.filter((r) => /diff-add/.test(r.className)).length === 1, 'one add row');
  assert(codeRows.filter((r) => /diff-del/.test(r.className)).length === 1, 'one del row');

  // The whole point of the escaping requirement: the file content went in as
  // text; no <img>, no onerror, no src attribute was ever constructed.
  assert(!tags.includes('img'), 'file content must never create an <img> element');
  assert(!attrs.includes('onerror') && !attrs.includes('src'), 'file content must never set an on* / src attribute');
  assert(body.textContent.includes(XSS), 'the raw markup survives verbatim as text');
  assert(codeRows.some((r) => r.children.some((c) => c.className === 'diff-code')), 'code rows carry a .diff-code span');

  // Clicking the summary collapses; clicking again reopens — one block only.
  summary.dispatch('click');
  assert(body.children.length === 0, 'a click on the summary collapses the body');
  assert(summary.textContent.includes('click to view diff'), 'the collapsed hint flips to "view diff"');
  summary.dispatch('click');
  assert(body.children.filter(CODE).length === 3, 'a second click re-opens the same block');

  // Keyboard parity (Enter) toggles too.
  summary.dispatch('keydown', { type: 'keydown', key: 'Enter', preventDefault() {} });
  assert(body.children.length === 0, 'Enter on the summary collapses it');
}

// ================================================ defaultOpen / AUTO_OPEN_ROWS
{
  const small = diff.editPreview('editFile', { file_path: '/x', old_string: 'a', new_string: 'b' });
  assert(diffview.defaultOpen(small) === true, 'a small diff opens by default');

  const bigLines = [];
  for (let i = 0; i < 100; i++) bigLines.push(`line ${i}`);
  const bigNew = bigLines.slice();
  bigNew[0] = 'CHANGED';
  const big = diff.lineDiff(bigLines.join('\n'), bigNew.join('\n'));
  assert(diffview.defaultOpen(big) === false || big.rows.length <= diffview.AUTO_OPEN_ROWS,
    'a diff larger than AUTO_OPEN_ROWS does not open by default');

  const { document } = createDom();
  const collapsed = diffview.renderDiffBlock(big, document, { open: false });
  assert(collapsed.children[1].children.length === 0, 'a collapsed block paints no body rows');
  assert(diffview.renderDiffBlock(null, document) === null, 'a null preview renders nothing');
}

console.log('renderer diff-block tests passed (lineDiff context/markers, lcs cap, editPreview, DOM escaping + toggle)');
