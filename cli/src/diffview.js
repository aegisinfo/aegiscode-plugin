'use strict';

/**
 * The edit block's paint layer: a one-line summary row plus, when the block is
 * open, the diff itself in Monokai Extended colors.
 *
 * Two shapes, driven by one boolean (`open`):
 *
 *   collapsed   ● editFile
 *                 ⎿  Update(src/diff.js)  +12 -3  · click to view diff
 *
 *   open        ● editFile
 *                 ⎿  Update(src/diff.js)  +12 -3  · click to collapse
 *                      12   const a = 1;
 *                      13 - const b = 2;
 *                      13 + const b = 3;
 *
 * Small diffs open themselves (AUTO_OPEN_ROWS) so the common one-line edit is
 * readable with no gesture at all — and that is not a nicety on this host: the
 * CLI writes finished turns once to scrollback (screen.js's design note), so
 * an edit the user has to ask for twice is an edit they will not read. Anything
 * bigger starts collapsed so a 300-line rewrite cannot bury the transcript.
 *
 * Width safety is a hard requirement here, not a preference: `cli-render.test.mjs`
 * pins that no emitted row exceeds the terminal width, because one row that
 * wraps corrupts the cursor arithmetic of every row after it. Every row this
 * module returns is therefore built from `clip()`-measured plain text and
 * closed with RESET, so an add/del background can never bleed into the next
 * line of scrollback.
 */

const { DIM, RESET, GLYPH, themeOf, diffOf } = require('./theme.js');
const { w, clip } = require('./screen.js');

/** Diff body rows at or below this size open without a gesture. */
const AUTO_OPEN_ROWS = 30;
/** Rows painted inside one open block before the "… more diff lines" footer. */
const MAX_BLOCK_ROWS = 200;

/** "  ⎿  " is five cells, so block rows indent under the summary's text. */
const INDENT = '     ';

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
  const D = d || diffOf(null);
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
 * unrelated text. Mutates rows in place, adding `hi = {start, end}` in
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

/**
 * The summary row: `  ⎿  Update(src/diff.js)  +12 -3  · click to view diff`.
 *
 * @param {object} preview From diff.js's editPreview().
 * @param {object} ctx App context (selects the light/dark diff palette).
 */
function diffSummaryRow(preview, ctx) {
  const t = themeOf(ctx);
  const D = diffOf(ctx);
  const bits = [`  ${t.gray}${GLYPH.hook}  ${RESET}`];
  bits.push(`${t.lavender}${preview.kind}(${preview.short})${RESET}`);
  if (preview.adds) bits.push(`${D.addFg}  +${preview.adds}${RESET}`);
  if (preview.dels) bits.push(`${D.delFg}  -${preview.dels}${RESET}`);
  if (!preview.adds && !preview.dels) bits.push(`${t.gray}  no line changes${RESET}`);
  if (preview.misses) bits.push(`${t.gold}  ${preview.misses} edit(s) not applied${RESET}`);
  return bits.join('');
}

/**
 * Everything the transcript paints for one edit block: the summary row, plus
 * the colored diff body when open.
 *
 * @param {object} preview From diff.js's editPreview().
 * @param {object} ctx App context (selects the light/dark diff palette).
 * @param {number} cols Terminal width — the add/del backgrounds run the full
 *   width, which is what makes the rows read as one block rather than as loose
 *   colored text.
 * @param {{open?: boolean}} [opts]
 * @returns {string[]} ANSI rows, each at most `cols` cells wide and RESET-closed.
 */
function renderDiffBlock(preview, ctx, cols, opts = {}) {
  const width = Math.max(8, Number(cols) || 80);
  const D = diffOf(ctx);
  const t = themeOf(ctx);
  const out = [clipRow(diffSummaryRow(preview, ctx), width)];
  if (!opts.open || !preview || !preview.rows || !preview.rows.length) return out;

  const rows = markIntraLine(preview.rows.slice(0, MAX_BLOCK_ROWS).map((r) => Object.assign({}, r)));
  let maxNo = 1;
  for (const r of rows) if (r.no && r.no > maxNo) maxNo = r.no;
  const gutterW = Math.max(2, String(maxNo).length);
  // INDENT + gutter + one separating space + the sign and its space.
  const codeWidth = Math.max(4, width - (INDENT.length + gutterW + 3));

  for (const r of rows) {
    if (r.marker) {
      out.push(clipRow(`${DIM}${INDENT}… ${r.note == null ? '' : r.note}${RESET}`, width));
      continue;
    }
    const side = r.sign === '-' ? 'del' : r.sign === '+' ? 'add' : 'ctx';
    const bg = side === 'del' ? D.delBg : side === 'add' ? D.addBg : '';
    const hiBg = side === 'del' ? D.delHiBg : D.addHiBg;
    const hiFg = side === 'del' ? D.delHiFg : D.addHiFg;
    const fg = side === 'del' ? D.delFg : side === 'add' ? D.addFg : DIM;

    const lead = `${bg}${D.gutter}${INDENT}${String(r.no == null ? '' : r.no).padStart(gutterW)} ${RESET}`;
    const sign = `${bg}${fg}${r.sign === ' ' ? ' ' : r.sign} ${RESET}`;
    // Clip the CODE, never the finished row: clipping the painted string would
    // count escape bytes as cells and could also cut mid-sequence, leaving the
    // terminal in the add/del background for the rest of the scrollback.
    const body = codeRow(clip(String(r.text == null ? '' : r.text), codeWidth), bg, hiBg, hiFg, D, r.hi);
    const used = w(`${INDENT}${String(r.no == null ? '' : r.no).padStart(gutterW)} `) + 2 + w(clip(String(r.text == null ? '' : r.text), codeWidth));
    const fill = bg && used < width ? `${bg}${' '.repeat(width - used)}${RESET}` : '';
    out.push(lead + sign + body + fill + RESET);
  }

  const hidden = preview.rows.length - MAX_BLOCK_ROWS;
  if (hidden > 0) out.push(clipRow(`${DIM}${INDENT}… ${hidden} more diff lines${RESET}`, width));
  if (preview.truncated) {
    out.push(clipRow(`${DIM}${INDENT}… diff truncated (file too large to compare in full)${RESET}`, width));
  }
  return out;
}

/** Colored code tokens for one diff row, with the changed slice highlighted. */
function codeRow(text, bg, hiBg, hiFg, D, hi) {
  const out = [];
  let idx = 0;
  for (const tk of highlightLine(text, D)) {
    const chars = [...tk.t];
    const start = idx;
    const end = idx + chars.length;
    idx = end;
    if (!hi || end <= hi.start || start >= hi.end) {
      out.push(`${bg}${tk.c}${tk.t}`);
      continue;
    }
    const a = Math.max(hi.start, start) - start;
    const b = Math.min(hi.end, end) - start;
    if (a > 0) out.push(`${bg}${tk.c}${chars.slice(0, a).join('')}`);
    if (b > a) out.push(`${hiBg}${hiFg}${chars.slice(a, b).join('')}`);
    if (b < chars.length) out.push(`${bg}${tk.c}${chars.slice(b).join('')}`);
  }
  return out.join('');
}

/** Clip a painted row to `width` cells, measuring only its visible text. */
function clipRow(row, width) {
  if (w(row) <= width) return row;
  // Rebuild from the plain text so the escapes stay paired with the cells that
  // survive the cut; the last segment ends with RESET below.
  return clipVisible(row, width) + RESET;
}

/**
 * Truncate a painted row to `width` visible cells, keeping the escape
 * sequences it passes and never splitting one. Reuse the per-character width
 * rule that `w()`/`clip()` use so a CJK or emoji cell can't be cut in half.
 */
function clipVisible(row, width) {
  let used = 0;
  let out = '';
  let i = 0;
  const s = String(row);
  while (i < s.length) {
    if (s[i] === '\x1b' && s[i + 1] === '[') {
      const close = s.indexOf('m', i);
      if (close === -1) break;
      out += s.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    const cw = w(ch);
    if (used + cw > width) break;
    out += ch;
    used += cw;
  }
  return out;
}

module.exports = {
  AUTO_OPEN_ROWS,
  MAX_BLOCK_ROWS,
  INDENT,
  defaultOpen,
  highlightLine,
  markIntraLine,
  diffSummaryRow,
  renderDiffBlock,
};
