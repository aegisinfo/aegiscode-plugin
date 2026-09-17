'use strict';

/**
 * Line-level diff for the transcript's edit blocks.
 *
 * An `editFile`/`writeFile` call used to render as a single gray row
 * ("  ⎿  → editFile src/hello.js ✓"): you could see that a file changed and
 * never *what* changed — the one thing a coding session is actually about.
 * This module turns the tool call's arguments into a real unified-style diff,
 * which diffview.js paints as a collapsible colored block.
 *
 * Where the two sides come from:
 *   editFile  — args.old_string → args.new_string. No I/O at all.
 *   writeFile — the file as it was on disk *before* the call ran, against
 *               args.content. app.js builds the preview when the tool's
 *               `phase: 'run'` event arrives, which is strictly before the
 *               executor writes, so the read is the pre-edit state.
 *
 * Pure: strings in, plain row objects out — no spans, no colors, no globals —
 * so the whole thing is unit-testable with no TTY. The DOM painting lives in
 * diffview.js, exactly the split render.js already keeps between structure and
 * paint.
 *
 * Ported from `cli/src/diff.js`; the engine's tool names are
 * `Edit`/`Write`/`MultiEdit`, this host's are `editFile`/`writeFile`, so
 * `editPreview` accepts both spellings. `MultiEdit` has no counterpart here
 * and is kept only so a newer engine frame cannot silently render nothing.
 *
 * `fs`/`path` are Node-only and the renderer is sandboxed (main.js sets
 * contextIsolation:true, nodeIntegration:false, sandbox:true), so `require`
 * may not exist at all when this loads as a classic <script>. The require is
 * therefore guarded and the pre-edit read is injectable (`opts.readFile`):
 * without either a Node fs or an injected reader a `Write` degrades to a
 * create-style diff instead of throwing — a preview is decoration, and
 * decoration must never break a turn.
 */

// Guarded so the same file loads both as a Node module (tests, CLI reuse) and
// as a sandboxed classic script, where `require` is simply absent.
let fs = null;
let path = null;
try {
  if (typeof require === 'function') {
    fs = require('node:fs');
    path = require('node:path');
  }
} catch {
  fs = null; // sandboxed renderer: fall back to an injected readFile
  path = null;
}

// Budgets. The preview is built synchronously inside the tool event, on the
// render path, so a 200 MB writeFile must not stall the window — the read is
// capped and the LCS table is bounded so a pathological pair of long files
// cannot allocate hundreds of megabytes. Past a budget the middle collapses to
// "remove everything, add everything", which is honest about being incomplete
// (`truncated: true` on the preview, `… N unchanged lines` in the block).
const DIFF_LIMITS = {
  fileBytes: 256 * 1024, // bytes read from disk for writeFile
  lcsCells: 250000, // n*m cap for the LCS table (~1 MB of Int32)
  rows: 400, // diff rows kept per preview
  context: 3, // unchanged lines kept around each change
};

/**
 * Split text into display lines. A trailing newline is a terminator, not an
 * empty last line — otherwise every normal file diff ends in a phantom
 * "- " / "+ " pair. CRLF is normalized so a Windows checkout doesn't render as
 * "every line changed".
 */
function splitLines(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Unified-style diff of two strings.
 *
 * @returns {{rows: Array<{sign: string, text: string, no: number|null,
 *   marker?: boolean, note?: string}>, adds: number, dels: number,
 *   truncated: boolean}} `rows` carries context rows around each change run
 *   (DIFF_LIMITS.context lines), collapsed runs of unchanged lines as `marker`
 *   rows, and every changed line with a `no` for the gutter (old number on
 *   '-', new number otherwise).
 */
function lineDiff(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;

  const midA = a.slice(pre, a.length - post);
  const midB = b.slice(pre, b.length - post);
  const ops = lcsOps(midA, midB);
  const truncated = ops === null;
  // Nothing changed: say so with no rows at all. The prefix/suffix trim ate the
  // whole file (pre === a.length, post === 0), so the context arithmetic below
  // would otherwise paint "… N unchanged lines" plus three orphans over an
  // identical pair — a marker claiming an omission that never happened. This
  // guard is what keeps `lineDiff(x, x)` from rendering as a fake edit.

  const body = ops || [
    ...midA.map((text) => ({ sign: '-', text })),
    ...midB.map((text) => ({ sign: '+', text })),
  ];
  if (!body.some((op) => op.sign !== ' ')) return { rows: [], adds: 0, dels: 0, truncated };

  const ctx = DIFF_LIMITS.context;

  const rows = [];
  let oldNo = 1;
  let newNo = 1;
  // Leading context: keep *all* of it when it fits, otherwise the last `ctx`
  // lines plus a marker for the ones actually dropped. The engine's original
  // condition (`ctxBeforeStart < pre`) fires whenever the change is preceded by
  // any line at all, so an ordinary three-line edit grew a bogus
  // "… 1 unchanged line" marker and a change deep in a file reported `ctx` as
  // the number hidden rather than the real count. A marker means "something was
  // omitted", so it may only appear when something was.
  const leadStart = pre > ctx ? pre - ctx : 0;
  const hiddenLead = leadStart;
  if (hiddenLead > 0) {
    rows.push({ sign: ' ', text: '', marker: true, note: `… ${hiddenLead} unchanged line${hiddenLead === 1 ? '' : 's'}` });
  }
  for (let i = leadStart; i < pre; i++) {
    rows.push({ sign: ' ', text: a[i], no: newNo });
    newNo++;
    oldNo++;
  }
  for (const op of body) {
    if (op.sign === ' ') {
      rows.push({ sign: ' ', text: op.text, no: newNo });
      newNo++;
      oldNo++;
    } else if (op.sign === '-') {
      rows.push({ sign: '-', text: op.text, no: oldNo });
      oldNo++;
    } else {
      rows.push({ sign: '+', text: op.text, no: newNo });
      newNo++;
    }
  }
  // Suffix context: the first `ctx` lines of the untouched tail, then a marker
  // for whatever unchanged tail is left over. Both the index into `b` and the
  // gutter number come from `b`'s tail, not `a`'s: the engine read
  // `b[a.length - post + i]`, which is the wrong line — and the wrong numbering
  // — for every edit that changes the line count.
  const tailStart = b.length - post;
  const tailCount = Math.min(post, ctx);
  newNo = tailStart + 1;
  for (let i = 0; i < tailCount; i++) {
    rows.push({ sign: ' ', text: b[tailStart + i], no: newNo });
    newNo++;
    oldNo++;
  }
  if (post > ctx) {
    const n = post - ctx;
    rows.push({ sign: ' ', text: '', marker: true, note: `… ${n} unchanged line${n === 1 ? '' : 's'}` });
  }

  const adds = rows.filter((r) => r.sign === '+').length;
  const dels = rows.filter((r) => r.sign === '-').length;
  let out = rows;
  let cut = false;
  if (out.length > DIFF_LIMITS.rows) {
    out = out.slice(0, DIFF_LIMITS.rows);
    out.push({ sign: ' ', text: '', marker: true, note: `… ${rows.length - DIFF_LIMITS.rows} more diff lines` });
    cut = true;
  }
  return { rows: out, adds, dels, truncated: truncated || cut };
}

/**
 * Longest-common-subsequence walk over two line arrays.
 * @returns {Array<{sign: string, text: string}>|null} ops, or null when the
 *   table would exceed DIFF_LIMITS.lcsCells (the caller then treats the middle
 *   as a full replacement).
 */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) {
    return [
      ...a.map((text) => ({ sign: '-', text })),
      ...b.map((text) => ({ sign: '+', text })),
    ];
  }
  if (n * m > DIFF_LIMITS.lcsCells) return null;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w); // dp[i*w+j] = |LCS(a[i:], b[j:])|
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ sign: ' ', text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { ops.push({ sign: '-', text: a[i] }); i++; }
    else { ops.push({ sign: '+', text: b[j] }); j++; }
  }
  while (i < n) ops.push({ sign: '-', text: a[i++] });
  while (j < m) ops.push({ sign: '+', text: b[j++] });
  return ops;
}

/** Capped read for the pre-edit state. Never throws; missing/unreadable → null. */
function readCapped(file, opts = {}) {
  // No Node fs (sandboxed renderer) → report missing so a Write degrades to a
  // create-style diff rather than throwing on the render path.
  if (!fs) return { text: null, missing: true };
  const bytes = opts.bytes == null ? DIFF_LIMITS.fileBytes : opts.bytes;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { text: null, missing: true };
    const text = fs.readFileSync(file, 'utf8');
    if (st.size > bytes) return { text: text.slice(0, bytes), missing: false, truncated: true };
    return { text, missing: false };
  } catch {
    return { text: null, missing: true };
  }
}

/** Path as the user thinks of it: relative to the session cwd when it is inside it. */
function shortPath(file, cwd) {
  const f = String(file || '');
  if (!cwd || !path) return f; // no node:path in the sandbox → show the raw path
  const rel = path.relative(cwd, f);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const parts = f.split(path.sep).filter(Boolean);
  const base = f.startsWith(path.sep) ? path.sep : '';
  return parts.length > 2 ? base + '…' + path.sep + parts.slice(-2).join(path.sep) : f;
}

/**
 * Build the diff preview for a tool call, or null when the call isn't an edit
 * or its arguments don't carry enough to diff (a partial stream, a malformed
 * call). Never throws — a preview is decoration, not the tool result, so a bad
 * argument object must not be able to break a turn.
 *
 * @param {string} name Tool name — this host's `editFile`/`writeFile`, or the
 *   engine's `Edit`/`Write`/`MultiEdit` (a vendored frame can carry either).
 * @param {object|string} args Tool arguments as parsed from the stream.
 * @param {{cwd?: string, readFile?: Function}} [opts] `readFile` is injectable
 *   so tests never touch disk and the sandboxed renderer can inject a bridge.
 */
function editPreview(name, args, opts = {}) {
  try {
    const cwd = opts.cwd == null ? (typeof process !== 'undefined' ? process.cwd() : '') : opts.cwd;
    const readFile = opts.readFile || readCapped;
    if (!args || typeof args !== 'object') return null;
    const file = typeof args.file_path === 'string' ? args.file_path
      : typeof args.path === 'string' ? args.path : null;
    if (!file) return null;
    const base = { file, short: shortPath(file, cwd) };

    if (name === 'Edit' || name === 'editFile') {
      if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return null;
      return Object.assign(
        { kind: 'Update' },
        base,
        lineDiff(args.old_string, args.new_string),
        { replaceAll: !!args.replace_all },
      );
    }

    if (name === 'Write' || name === 'writeFile') {
      if (typeof args.content !== 'string') return null;
      const prev = readFile(file) || { text: null, missing: true };
      const d = lineDiff(prev.text == null ? '' : prev.text, args.content);
      return Object.assign(
        { kind: prev.missing ? 'Create' : 'Write' },
        base,
        d,
        { truncated: d.truncated || !!prev.truncated },
      );
    }

    if (name === 'MultiEdit') {
      const edits = (Array.isArray(args.edits) ? args.edits : []).filter(
        (e) => e && typeof e.old_string === 'string' && typeof e.new_string === 'string',
      );
      if (!edits.length) return null;
      const prev = readFile(file) || { text: null, missing: true };
      if (typeof prev.text === 'string') {
        let cur = prev.text;
        let misses = 0;
        for (const e of edits) {
          if (cur.indexOf(e.old_string) === -1) { misses++; continue; }
          cur = e.replace_all
            ? cur.split(e.old_string).join(e.new_string)
            : cur.replace(e.old_string, e.new_string);
        }
        const d = lineDiff(prev.text, cur);
        return Object.assign(
          { kind: 'Update' },
          base,
          d,
          { misses, replaceAll: edits.some((e) => e.replace_all) },
        );
      }
      // No base on disk: stack each edit's own diff rather than inventing one.
      let rows = [];
      let adds = 0;
      let dels = 0;
      let truncated = false;
      edits.forEach((e, i) => {
        const d = lineDiff(e.old_string, e.new_string);
        if (i) rows.push({ sign: ' ', text: '', marker: true, note: `… edit ${i + 1} of ${edits.length}` });
        rows = rows.concat(d.rows);
        adds += d.adds;
        dels += d.dels;
        truncated = truncated || d.truncated;
      });
      return Object.assign(
        { kind: 'Update' },
        base,
        { rows, adds, dels, truncated, stacked: edits.length },
      );
    }

    return null;
  } catch {
    return null; // decoration must never break a turn
  }
}

/** Human count line in the reference's wording: "Added 3 lines, removed 1 line". */
function changeSummary(preview) {
  const parts = [];
  if (preview.adds) parts.push(`Added ${preview.adds} line${preview.adds === 1 ? '' : 's'}`);
  if (preview.dels) parts.push(`removed ${preview.dels} line${preview.dels === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'no line changes';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DIFF_LIMITS,
    splitLines,
    lineDiff,
    lcsOps,
    readCapped,
    shortPath,
    changeSummary,
    editPreview,
  };
}
