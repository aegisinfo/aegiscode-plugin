'use strict';

/**
 * The edit block's paint layer for the DOM transcript: a one-line, clickable
 * summary plus, when the block is open, the diff itself in Monokai Extended
 * colors.
 *
 * Two shapes, driven by one boolean (`open`):
 *
 *   collapsed   ⎿  Update(src/diff.js)  +12 -3  · click to view diff
 *
 *   open        ⎿  Update(src/diff.js)  +12 -3  · click to collapse
 *                    12   const a = 1;
 *                    13 - const b = 2;
 *                    13 + const b = 3;
 *
 * This is the DOM twin of `cli/src/diffview.js`: same structure decisions, same
 * tokenizer, but it builds real element nodes instead of ANSI strings. Small
 * diffs open themselves (AUTO_OPEN_ROWS) so the common one-line edit is
 * readable with no gesture at all; anything bigger starts collapsed so a
 * 300-line rewrite cannot bury the transcript.
 *
 * Every piece of text goes in through `textContent`/`createTextNode` and never
 * `innerHTML` — a diff's content is arbitrary file bytes, so the one thing this
 * module must never do is let a line like `<img src=x onerror=…>` become live
 * markup.
 */

/** Diff body rows at or below this size open without a gesture. */
const AUTO_OPEN_ROWS = 30;
/** Rows painted inside one open block before the "… more diff lines" footer. */
const MAX_BLOCK_ROWS = 200;

// The Monokai Extended diff palette, copied from cli/src/theme.js's DIFF so the
// desktop block and the CLI block read as the same object.
const DIFF_COLORS = {
  delFg: '#dc5a5a',
  delBg: '#3d0100',
  addFg: '#50c850',
  addBg: '#022800',
  delHiFg: '#f8f8f2',
  delHiBg: '#5c0200',
  addHiFg: '#ffffff',
  addHiBg: '#044700',
  codeFg: '#f8f8f2',
  gutter: '#787878',
  kind: '#c099ff',
  kw: '#66d9ef',
  fn: '#a6e22e',
  str: '#e6db74',
  num: '#ae81ff',
  comment: '#75715e',
};

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'import', 'export', 'from', 'default', 'class', 'extends',
  'new', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield', 'static', 'typeof',
  'instanceof', 'in', 'of', 'delete', 'this', 'super', 'null', 'undefined', 'true', 'false',
  'def', 'elif', 'lambda', 'pass', 'raise', 'with', 'as', 'not', 'and', 'or', 'is', 'None',
  'True', 'False', 'self', 'fn', 'mut', 'pub', 'impl', 'struct', 'enum', 'trait', 'match',
  'package', 'func', 'defer', 'chan', 'nil', 'echo', 'local', 'then', 'fi', 'esac',
]);

/**
 * Split one line of code into colored tokens. Deliberately line-local and cheap
 * — it runs on every changed row of every block — so it colors comments,
 * strings, numbers, keywords and called functions and leaves the rest plain,
 * which is all the tinted diff rows need to read as code.
 *
 * @param {string} text
 * @param {object} [d] Diff palette (defaults to the dark one).
 * @returns {Array<{t: string, c: string}>} tokens; `c` is a foreground color.
 */
function highlightLine(text, d) {
  const D = d || DIFF_COLORS;
  const out = [];
  const src = String(text == null ? '' : text);
  const re = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)|([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const push = (t, c) => { if (t) out.push({ t, c }); };
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) push(src.slice(last, m.index), D.codeFg);
    if (m[1]) push(m[1], D.comment);
    else if (m[2]) push(m[2], D.str);
    else if (m[3]) push(m[3], D.num);
    else {
      const word = m[4];
      const isCall = /^\s*\(/.test(src.slice(m.index + word.length));
      push(word, KEYWORDS.has(word) ? D.kw : isCall ? D.fn : D.codeFg);
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) push(src.slice(last), D.codeFg);
  return out;
}

/**
 * Pair a run of removed rows with the added run that follows it and mark the
 * slice that actually differs, so the changed word renders in the bright
 * variant of the diff color. Equal run lengths only, and only when the shared
 * prefix+suffix dominates the line — otherwise the mark would land on
 * unrelated text. Mutates rows in place, adding `hi = {start, end, side}` in
 * code-point offsets.
 */
function markIntraLine(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].sign !== '-') continue;
    let d = i;
    while (d < rows.length && rows[d].sign === '-') d++;
    let a = d;
    while (a < rows.length && rows[a].sign === '+') a++;
    const delCount = d - i;
    const addCount = a - d;
    if (delCount && delCount === addCount) {
      for (let k = 0; k < delCount; k++) {
        const pair = intraLine(rows[i + k].text, rows[d + k].text);
        if (!pair) continue;
        rows[i + k].hi = { start: pair.delStart, end: pair.delEnd, side: 'del' };
        rows[d + k].hi = { start: pair.addStart, end: pair.addEnd, side: 'add' };
      }
    }
    i = a - 1;
  }
  return rows;
}

function intraLine(delText, addText) {
  const d = [...String(delText == null ? '' : delText)];
  const a = [...String(addText == null ? '' : addText)];
  let pre = 0;
  while (pre < d.length && pre < a.length && d[pre] === a[pre]) pre++;
  let post = 0;
  while (post < d.length - pre && post < a.length - pre && d[d.length - 1 - post] === a[a.length - 1 - post]) post++;
  const shared = pre + post;
  const longest = Math.max(d.length, a.length) || 1;
  if (shared < longest * 0.4) return null;
  return {
    delStart: pre,
    delEnd: d.length - post,
    addStart: pre,
    addEnd: a.length - post,
  };
}

/**
 * Should this preview start open? Small diffs (the routine edit) do, so the
 * change is readable immediately; a big one stays a one-line summary.
 */
function defaultOpen(preview) {
  if (!preview || !preview.rows) return false;
  return preview.rows.length <= AUTO_OPEN_ROWS;
}

/** One colored span. `bg` set means this is an intra-line highlight slice. */
function tokenSpan(document, text, color, bg, fg) {
  const span = document.createElement('span');
  if (bg) {
    span.style.background = bg;
    span.style.color = fg;
  } else {
    span.style.color = color;
  }
  span.textContent = String(text);
  return span;
}

/** A single colored code/highlight fragment inside a row's `.diff-code`. */
function appendCode(document, container, text, hi) {
  const src = String(text == null ? '' : text);
  let idx = 0;
  for (const tk of highlightLine(src, DIFF_COLORS)) {
    const chars = [...tk.t];
    const start = idx;
    const end = idx + chars.length;
    idx = end;
    if (!hi || end <= hi.start || start >= hi.end) {
      container.appendChild(tokenSpan(document, tk.t, tk.c));
      continue;
    }
    const a = Math.max(hi.start, start) - start;
    const b = Math.min(hi.end, end) - start;
    if (a > 0) container.appendChild(tokenSpan(document, chars.slice(0, a).join(''), tk.c));
    if (b > a) {
      const bg = hi.side === 'del' ? DIFF_COLORS.delHiBg : DIFF_COLORS.addHiBg;
      const fg = hi.side === 'del' ? DIFF_COLORS.delHiFg : DIFF_COLORS.addHiFg;
      container.appendChild(tokenSpan(document, chars.slice(a, b).join(''), null, bg, fg));
    }
    if (b < chars.length) container.appendChild(tokenSpan(document, chars.slice(b).join(''), tk.c));
  }
}

/** One `<div class="diff-row diff-add|diff-del|diff-ctx">` with gutter + tokens. */
function renderRow(document, r, gutterW) {
  const side = r.sign === '-' ? 'del' : r.sign === '+' ? 'add' : 'ctx';
  const row = document.createElement('div');
  row.className = `diff-row diff-${side}`;

  const gutter = document.createElement('span');
  gutter.className = 'diff-gutter';
  gutter.textContent = `${String(r.no == null ? '' : r.no).padStart(gutterW)} `;
  row.appendChild(gutter);

  const sign = document.createElement('span');
  sign.className = 'diff-sign';
  sign.textContent = r.sign === ' ' ? ' ' : r.sign;
  row.appendChild(sign);

  const code = document.createElement('span');
  code.className = 'diff-code';
  appendCode(document, code, r.text, r.hi);
  row.appendChild(code);

  return row;
}

/** A collapsed-context / truncation row: `.diff-marker`. */
function markerRow(document, note) {
  const row = document.createElement('div');
  row.className = 'diff-row diff-marker';
  const code = document.createElement('span');
  code.className = 'diff-code';
  code.textContent = String(note == null ? '' : note);
  row.appendChild(code);
  return row;
}

/**
 * Build the collapsible diff block for one edit preview.
 *
 * @param {object} preview From diff.js's editPreview(). Falsy → null.
 * @param {Document} doc The document (injectable so tests need no jsdom).
 * @param {{open?: boolean}} [opts] `open` overrides the AUTO_OPEN_ROWS default.
 * @returns {HTMLElement|null} `div.diff-block` with a clickable `.diff-summary`.
 */
function renderDiffBlock(preview, doc, opts = {}) {
  const document = doc || (typeof document !== 'undefined' ? document : null);
  if (!document || !preview || !preview.rows) return null;
  let open = opts.open == null ? defaultOpen(preview) : !!opts.open;

  const block = document.createElement('div');
  block.className = 'diff-block';

  const summary = document.createElement('div');
  summary.className = 'diff-summary';
  if (typeof summary.setAttribute === 'function') {
    summary.setAttribute('role', 'button');
    summary.setAttribute('aria-expanded', String(open));
  }

  const body = document.createElement('div');
  body.className = 'diff-body';

  /**
   * Repaint just the summary's text segments. Called on every toggle so the
   * "click to view/collapse" hint and aria-expanded always match the state.
   */
  function paintSummary() {
    summary.textContent = '';
    const segs = [
      { t: '⎿  ', c: DIFF_COLORS.gutter },
      { t: `${preview.kind}(${preview.short})`, c: DIFF_COLORS.kind },
    ];
    if (preview.adds) segs.push({ t: `  +${preview.adds}`, c: DIFF_COLORS.addFg });
    if (preview.dels) segs.push({ t: `  -${preview.dels}`, c: DIFF_COLORS.delFg });
    if (!preview.adds && !preview.dels) segs.push({ t: '  no line changes', c: DIFF_COLORS.gutter });
    if (preview.misses) segs.push({ t: `  ${preview.misses} edit(s) not applied`, c: '#ffd166' });
    segs.push({ t: `  ${open ? '· click to collapse' : '· click to view diff'}`, c: DIFF_COLORS.comment });
    for (const s of segs) {
      const span = document.createElement('span');
      span.style.color = s.c;
      span.textContent = s.t;
      summary.appendChild(span);
    }
    if (typeof summary.setAttribute === 'function') summary.setAttribute('aria-expanded', String(open));
  }

  /** Repaint the body rows. Nothing is built while collapsed. */
  function paintBody() {
    body.textContent = '';
    if (!open) return;
    const rows = markIntraLine(
      preview.rows.slice(0, MAX_BLOCK_ROWS).map((r) => Object.assign({}, r)),
    );
    let maxNo = 1;
    for (const r of rows) if (r.no && r.no > maxNo) maxNo = r.no;
    const gutterW = Math.max(2, String(maxNo).length);
    for (const r of rows) {
      if (r.marker) body.appendChild(markerRow(document, r.note));
      else body.appendChild(renderRow(document, r, gutterW));
    }
    const hidden = preview.rows.length - MAX_BLOCK_ROWS;
    if (hidden > 0) body.appendChild(markerRow(document, `… ${hidden} more diff lines`));
    if (preview.truncated) {
      body.appendChild(markerRow(document, '… diff truncated (file too large to compare in full)'));
    }
  }

  /** The whole point: clicking the summary flips the one block's open state. */
  function toggle() {
    open = !open;
    paintSummary();
    paintBody();
  }
  if (typeof summary.addEventListener === 'function') {
    summary.addEventListener('click', toggle);
    summary.addEventListener('keydown', (e) => {
      if (e && (e.key === 'Enter' || e.key === ' ')) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        toggle();
      }
    });
  }

  paintSummary();
  paintBody();
  block.appendChild(summary);
  block.appendChild(body);
  return block;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AUTO_OPEN_ROWS,
    MAX_BLOCK_ROWS,
    DIFF_COLORS,
    defaultOpen,
    highlightLine,
    markIntraLine,
    renderDiffBlock,
  };
}
