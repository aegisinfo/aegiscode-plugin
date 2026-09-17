#!/usr/bin/env node
/**
 * The transcript's file-edit diff block — the pure line engine (`cli/src/diff.js`)
 * and its ANSI paint layer (`cli/src/diffview.js`), plus the one-line wiring that
 * makes a tool row actually paint them.
 *
 * What it pins, and why each one matters:
 *
 *  · the shape of a change: a `-` row then a `+` row; a pure insert is all `+`,
 *    a pure delete is all `-` — the diff has to say *what* changed, which is the
 *    whole reason the block replaced the gray `$ {args}` row;
 *  · an IDENTICAL old/new pair emits NO rows at all. This is the regression the
 *    port shipped: the reference (`aegiscodex-dev/src/diff.js`) returns early
 *    when nothing changed, but the CLI copy dropped that guard, so the
 *    context arithmetic below painted three orphan rows — and, past the context
 *    window, a phantom "… N unchanged lines" marker claiming an omission that
 *    never happened;
 *  · context collapse: a change deep in a long file shows a `…` marker for the
 *    lines it actually dropped, and a change at the very start / end must NOT
 *    invent a leading / trailing marker (the old `ctxBeforeStart < pre`
 *    condition fired whenever *any* line preceded the change);
 *  · the budgets: the LCS table cap and the row cap both set `truncated` and
 *    still return a bounded row set, because the preview is built synchronously
 *    on the render path and a 200 MB write must not stall the CLI;
 *  · `editPreview` is pure and total: an `editFile` preview does no I/O at all,
 *    a `writeFile` preview reads the pre-edit file through the injected reader,
 *    and garbage (unknown tool, null args, a throwing reader, a missing path)
 *    yields null / a Create instead of throwing — a preview is decoration, not
 *    the tool result, so it must never break a turn;
 *  · width safety in the renderer: EVERY row is clipped to the terminal — one
 *    that wraps corrupts the cursor arithmetic of every row after it — and every
 *    painted row is closed with RESET so an add/del background cannot bleed into
 *    the next line of scrollback;
 *  · and the wiring itself: `renderTurn` consults the diff data and calls the
 *    block renderer, so an edit tool row paints the diff instead of the args.
 *
 * No third-party dependency and no TTY: the modules under test are CommonJS,
 * loaded through createRequire, and every renderer returns strings.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, '..', 'cli');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) =>
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const diff = require(join(cliDir, 'src', 'diff.js'));
const diffview = require(join(cliDir, 'src', 'diffview.js'));
const render = require(join(cliDir, 'src', 'render.js'));
const screen = require(join(cliDir, 'src', 'screen.js'));
const { stripAnsi, w } = screen;

const RESET = '\x1b[0m';
const ctx = { light: false };
const plain = (lines) => (Array.isArray(lines) ? lines : [lines]).map(stripAnsi);
const rowsOf = (d) => d.rows;
const changed = (d) => d.rows.filter((r) => r.sign === '-' || r.sign === '+');
const markerRows = (d) => d.rows.filter((r) => r.marker === true);

// ── pure engine: the shape of a change ──────────────────────────────────────
{
  const d = diff.lineDiff('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma');
  const [del, add] = changed(d);
  eq(changed(d).length, 2, 'a one-line edit yields exactly two changed rows');
  eq(del.sign, '-', 'the removed line comes first');
  eq(add.sign, '+', 'the added line follows it');
  eq(del.text, 'beta', 'the - row carries the old text');
  eq(add.text, 'BETA', 'the + row carries the new text');
  eq(d.adds, 1, 'adds counts the + row');
  eq(d.dels, 1, 'dels counts the - row');
  assert(!d.truncated, 'a small edit is not truncated');
}

// ── identical old/new: an EMPTY row set, no phantom marker ──────────────────
// The regression the port shipped. Both the small case (three orphan context
// rows) and the long case (a bogus "… N unchanged lines" marker) are pinned:
// the marker only appeared once the file was longer than the context window.
{
  const d = diff.lineDiff('a\nb\nc', 'a\nb\nc');
  eq(rowsOf(d).length, 0, 'an identical pair produces an EMPTY row set');
  assert(!d.truncated, 'an identical pair is not truncated');
  eq(d.adds, 0, 'an identical pair adds nothing');
  eq(d.dels, 0, 'an identical pair deletes nothing');
  eq(markerRows(d).length, 0, 'an identical pair invents no "… N unchanged lines" marker');

  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  const long = diff.lineDiff(lines, lines);
  eq(rowsOf(long).length, 0, 'a long identical pair is also empty');
  eq(markerRows(long).length, 0, 'and invents no phantom omission marker');
  assert(!long.truncated, 'a long identical pair is not truncated');

  // A trailing newline is a terminator, not an empty last line.
  eq(rowsOf(diff.lineDiff('a\nb\n', 'a\nb')).length, 0, 'a trailing newline does not fabricate a change');
  eq(rowsOf(diff.lineDiff('x', 'x')).length, 0, 'a one-line identical pair is empty too');
}

// ── pure insertion: only + rows, no - rows ──────────────────────────────────
{
  const d = diff.lineDiff('a\nb\nc', 'a\nX\nY\nb\nc');
  eq(d.dels, 0, 'a pure insertion deletes nothing');
  eq(d.rows.filter((r) => r.sign === '-').length, 0, 'a pure insertion emits no - rows');
  const adds = d.rows.filter((r) => r.sign === '+');
  eq(adds.length, 2, 'both inserted lines are + rows');
  eq(adds.map((r) => r.text).join('|'), 'X|Y', 'the inserted lines carry their text');
  eq(d.adds, 2, 'adds counts both inserted lines');
  assert(!d.truncated, 'a small insertion is not truncated');
}

// ── pure deletion: only - rows, no + rows ───────────────────────────────────
{
  const d = diff.lineDiff('a\nX\nY\nb\nc', 'a\nb\nc');
  eq(d.adds, 0, 'a pure deletion adds nothing');
  eq(d.rows.filter((r) => r.sign === '+').length, 0, 'a pure deletion emits no + rows');
  const dels = d.rows.filter((r) => r.sign === '-');
  eq(dels.length, 2, 'both removed lines are - rows');
  eq(dels.map((r) => r.text).join('|'), 'X|Y', 'the removed lines carry their text');
  eq(d.dels, 2, 'dels counts both removed lines');
}

// ── context collapse: a marker means "something was omitted" ────────────────
{
  // An ordinary small edit with <= context lines on both sides grows no marker.
  const small = diff.lineDiff('a\nb\nc', 'a\nB\nc');
  eq(markerRows(small).length, 0, 'a three-line edit grows no bogus "… N unchanged lines" marker');
  const smallStart = diff.lineDiff('a\nb\nc', 'A\nb\nc');
  eq(markerRows(smallStart).length, 0, 'nor does a change at the very start of a short file');
}
{
  // Deep inside a long file: a real omission, reported with the REAL count.
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  const b = lines.slice();
  b[49] = 'CHANGED';
  const d = diff.lineDiff(lines.join('\n'), b.join('\n'));
  const markers = markerRows(d);
  assert(markers.length >= 1, 'a change deep inside a long file omits a run of unchanged lines');
  assert(
    markers.every((m) => /^… \d+ unchanged line/.test(m.note)),
    `marker rows describe the omission (got ${JSON.stringify(markers.map((m) => m.note))})`,
  );
  eq(markers[0].note, '… 46 unchanged lines', 'the leading marker reports the true number hidden, not `context`');
}
{
  // A change at the VERY START emits NO leading marker.
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  const b = lines.slice();
  b[0] = 'CHANGED';
  const d = diff.lineDiff(lines.join('\n'), b.join('\n'));
  assert(!d.rows[0].marker, 'a change at the very start of the file emits NO leading marker');
  eq(d.rows[0].sign, '-', 'the first row is the removed line itself');
}
{
  // A change at the VERY END emits NO trailing marker.
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  const b = lines.slice();
  b[99] = 'CHANGED';
  const d = diff.lineDiff(lines.join('\n'), b.join('\n'));
  const last = d.rows[d.rows.length - 1];
  assert(!last.marker, 'a change at the very end of the file emits NO trailing marker');
  eq(last.sign, '+', 'the last row is the added line itself');
}

// ── the budgets: LCS table cap and row cap ──────────────────────────────────
{
  // 600x600 mismatched lines = 360000 cells > lcsCells (250000): the table is
  // refused and the whole middle collapses to remove-all / add-all.
  const A = Array.from({ length: 600 }, (_, i) => `old ${i} alpha`);
  const B = Array.from({ length: 600 }, (_, i) => `new ${i} beta`);
  const started = Date.now();
  const d = diff.lineDiff(A.join('\n'), B.join('\n'));
  const elapsed = Date.now() - started;
  assert(d.truncated === true, 'exceeding the LCS cap sets truncated');
  assert(elapsed < 2000, `the cap path must not hang (took ${elapsed}ms)`);
  assert(
    d.rows.length <= diff.DIFF_LIMITS.rows + 1,
    `rows are bounded by DIFF_LIMITS.rows + footer (got ${d.rows.length})`,
  );
  assert(d.rows[d.rows.length - 1].marker, 'a capped diff ends in a truncation footer');
}
{
  // 300x300 distinct lines stay inside the LCS cap but blow the row budget:
  // the row cap path is exercised independently of the table cap.
  const A = Array.from({ length: 300 }, (_, i) => `old ${i}`);
  const B = Array.from({ length: 300 }, (_, i) => `new ${i}`);
  const d = diff.lineDiff(A.join('\n'), B.join('\n'));
  assert(d.truncated === true, 'a diff over the row cap sets truncated');
  eq(d.rows.length, diff.DIFF_LIMITS.rows + 1, 'the set is clipped to the row budget plus its footer');
  assert(d.rows[d.rows.length - 1].marker, 'and ends in the omission footer');
}

// ── editPreview: editFile does no I/O at all ────────────────────────────────
{
  let called = 0;
  const p = diff.editPreview(
    'editFile',
    { file_path: '/repo/src/a.js', old_string: 'const a = 1;', new_string: 'const b = 2;' },
    { cwd: '/repo', readFile: () => { called++; throw new Error('must not read the filesystem'); } },
  );
  assert(p, 'an editFile call produces a preview');
  eq(p.kind, 'Update', 'editFile is an Update');
  eq(p.file, '/repo/src/a.js', 'the preview keeps the full path');
  eq(p.short, 'src/a.js', 'short is the path relative to cwd');
  eq(called, 0, 'an editFile preview never touches the filesystem');
  eq(p.adds, 1, 'the editFile preview counts one add');
  eq(p.dels, 1, 'the editFile preview counts one delete');
  assert(p.rows.some((r) => r.sign === '-' && r.text === 'const a = 1;'), 'the old text is a - row');
  assert(p.rows.some((r) => r.sign === '+' && r.text === 'const b = 2;'), 'the new text is a + row');

  // The engine's own spelling is accepted, and replace_all rides through.
  const e = diff.editPreview('Edit', { file_path: '/repo/src/a.js', old_string: 'a', new_string: 'b', replace_all: true }, { cwd: '/repo' });
  assert(e && e.kind === 'Update', 'the engine spelling `Edit` maps to the same path');
  assert(e.replaceAll === true, 'replace_all is carried on the preview');
}

// ── editPreview: writeFile builds a real pre/post diff via the injected read ─
{
  let reads = 0;
  const p = diff.editPreview(
    'writeFile',
    { file_path: '/repo/src/a.js', content: 'const b = 2;\nconst c = 3;\n' },
    {
      cwd: '/repo',
      readFile: (file) => {
        reads++;
        eq(file, '/repo/src/a.js', 'the injected reader is handed the target path');
        return { text: 'const a = 1;\n', missing: false };
      },
    },
  );
  eq(reads, 1, 'a writeFile preview reads the pre-edit file exactly once');
  eq(p.kind, 'Write', 'an existing base file is a Write');
  eq(p.adds, 2, 'both new lines count as adds');
  eq(p.dels, 1, 'the replaced line counts as a delete');
  assert(p.rows.some((r) => r.sign === '-' && r.text === 'const a = 1;'), 'the prior content is a - row');
  assert(p.rows.some((r) => r.sign === '+' && r.text === 'const c = 3;'), 'the new content is a + row');

  // No base on disk → a Create (all additions).
  const c = diff.editPreview(
    'writeFile',
    { file_path: '/repo/src/new.js', content: 'export const x = 1;\n' },
    { cwd: '/repo', readFile: () => ({ text: null, missing: true }) },
  );
  eq(c.kind, 'Create', 'a write with no base file is a Create');
  eq(c.adds, 1, 'a create-style diff is all additions');
  eq(c.dels, 0, 'a create-style diff deletes nothing');
}

// ── editPreview never throws on garbage ─────────────────────────────────────
{
  eq(diff.editPreview('someOtherTool', { file_path: '/x', old_string: 'a', new_string: 'b' }), null, 'an unknown tool name yields null');
  eq(diff.editPreview('editFile', null), null, 'null args yield null');
  eq(diff.editPreview('editFile', 'not-an-object'), null, 'a string args yields null');
  eq(diff.editPreview('editFile', {}), null, 'args without a path yield null');
  eq(diff.editPreview('editFile', { file_path: '/x', old_string: 1, new_string: 'b' }), null, 'a non-string old_string yields null');
  eq(diff.editPreview('writeFile', { file_path: '/x', content: 42 }), null, 'a non-string content yields null');
  eq(
    diff.editPreview('writeFile', { file_path: '/x', content: 'y' }, { readFile: () => { throw new Error('boom'); } }),
    null,
    'a throwing reader is swallowed, not propagated',
  );

  let p;
  let threw = false;
  try {
    p = diff.editPreview('writeFile', { file_path: `/no/such/file-${process.pid}-${Date.now()}.txt`, content: 'x\n' });
  } catch {
    threw = true;
  }
  assert(!threw, 'a path that does not exist must not throw');
  assert(p && p.kind === 'Create', 'a non-existent path previews as a Create (the base is simply missing)');
}

// ── renderer: the summary row ───────────────────────────────────────────────
{
  const p = diff.editPreview(
    'editFile',
    { file_path: '/repo/src/keep.js', old_string: 'keep\nold', new_string: 'keep\nnew1\nnew2' },
    { cwd: '/repo' },
  );
  const row = diffview.diffSummaryRow(p, ctx);
  assert(typeof row === 'string' && row.length > 0, 'the summary row is a non-empty string');
  assert(row.includes('\x1b['), 'the summary row carries ANSI escapes');
  assert(stripAnsi(row).includes('src/keep.js'), 'the summary row names the file');
  assert(stripAnsi(row).includes('Update'), 'the summary row names the change kind');
  assert(stripAnsi(row).includes(`+${p.adds}`), `the summary row shows the add count (got ${stripAnsi(row)})`);
  assert(stripAnsi(row).includes(`-${p.dels}`), `the summary row shows the del count (got ${stripAnsi(row)})`);

  // A changed-only summary reports its own counts.
  const d = diff.editPreview('editFile', { file_path: '/repo/src/b.js', old_string: 'a\nb', new_string: 'a\nB\nc' }, { cwd: '/repo' });
  const dr = stripAnsi(diffview.diffSummaryRow(d, ctx));
  assert(dr.includes('+2') && dr.includes('-1'), `a 2-add/1-del edit summarises as +2 -1 (got ${dr})`);
}

// ── renderer: width safety, reset discipline, defaultOpen ───────────────────
{
  // A pathologically long single line must be CLIPPED, never wrapped.
  const longLine = `const value = ${'x'.repeat(400)};`;
  const p = diff.editPreview(
    'editFile',
    { file_path: '/repo/src/long.js', old_string: 'const value = 0;', new_string: longLine },
    { cwd: '/repo' },
  );
  const cols = 60;
  const block = diffview.renderDiffBlock(p, ctx, cols, { open: true });
  assert(Array.isArray(block), 'renderDiffBlock returns an array of rows');
  assert(block.length >= 3, 'an open block emits the summary plus body rows');
  assert(block.every((r) => typeof r === 'string'), 'every emitted row is a string');
  for (const r of block) {
    const vis = w(stripAnsi(r));
    assert(vis <= cols, `a diff row must be clipped to ${cols} cells (got ${vis}: ${JSON.stringify(stripAnsi(r))})`);
  }

  // The SUMMARY row itself can overflow on a deep path — clipRow, not the
  // per-code clip, is what keeps it inside the terminal.
  const deepPath = `/repo/${'nested/'.repeat(30)}a-very-long-filename-for-a-long-summary-row.js`;
  const wide = diff.editPreview('editFile', { file_path: deepPath, old_string: 'a', new_string: 'b' }, { cwd: '/repo' });
  assert(stripAnsi(diffview.diffSummaryRow(wide, ctx)).length > cols, 'the fixture summary must exceed the width to exercise clipRow');
  const wideBlock = diffview.renderDiffBlock(wide, ctx, cols, { open: false });
  for (const r of wideBlock) {
    const vis = w(stripAnsi(r));
    assert(vis <= cols, `an over-long summary row must be clipped to ${cols} cells (got ${vis})`);
  }

  // Wide glyphs are measured in cells, and never split mid-glyph.
  const cjk = '日本語のコード'.repeat(20);
  const cjkPreview = diff.editPreview('editFile', { file_path: '/repo/src/cjk.js', old_string: 'a', new_string: cjk }, { cwd: '/repo' });
  const cjkBlock = diffview.renderDiffBlock(cjkPreview, { light: false }, 40, { open: true });
  for (const r of cjkBlock) {
    assert(w(stripAnsi(r)) <= 40, `a CJK diff row respects the cell width (got ${w(stripAnsi(r))})`);
  }
}
{
  // Every painted row is RESET-closed and leaves no dangling escape behind.
  const p = diff.editPreview(
    'editFile',
    { file_path: '/repo/src/a.js', old_string: 'a\nb\nc', new_string: 'a\nB\nC\nd' },
    { cwd: '/repo' },
  );
  for (const open of [false, true]) {
    const block = diffview.renderDiffBlock(p, ctx, 60, { open });
    assert(block.length > 0, `a block always emits its summary (open=${open})`);
    for (const r of block) {
      assert(r.endsWith(RESET), `every painted row ends reset (open=${open}): ${JSON.stringify(r.slice(-24))}`);
      assert(!stripAnsi(r).includes('\x1b'), `no dangling escape survives a painted row (open=${open})`);
    }
  }
}
{
  // A small diff opens itself; a large one starts collapsed.
  const small = diff.editPreview('editFile', { file_path: '/x', old_string: 'a', new_string: 'b' });
  eq(diffview.defaultOpen(small), true, 'a small diff opens by default');

  const A = Array.from({ length: 60 }, (_, i) => `old ${i}`).join('\n');
  const B = Array.from({ length: 60 }, (_, i) => `new ${i}`).join('\n');
  const big = diff.lineDiff(A, B);
  assert(big.rows.length > diffview.AUTO_OPEN_ROWS, `the big fixture must exceed AUTO_OPEN_ROWS (got ${big.rows.length})`);
  eq(diffview.defaultOpen(big), false, 'a large diff starts collapsed');
  eq(diffview.defaultOpen(null), false, 'a null preview does not open');
}

// ── wiring: the tool row paints the diff block ──────────────────────────────
// Behavioural first — renderTurn is exported and pure, so drive it directly.
// If render.js stopped consulting turn.diff, the row would fall back to the
// gray `$ {args}` line and none of the diff text would appear.
{
  const args = { file_path: '/repo/src/a.js', old_string: 'const a = 1;', new_string: 'const b = 2;' };
  const preview = diff.editPreview('editFile', args, { cwd: '/repo' });
  const turn = { role: 'tool', label: 'editFile', args, ok: true, diff: preview, diffOpen: true };

  const openText = plain(render.renderTurn(ctx, turn, 80)).join('\n');
  assert(openText.includes('Update(src/a.js)'), 'the tool row renders the diff summary');
  assert(openText.includes('const b = 2;'), 'the open block paints the changed line');
  assert(!openText.includes(`$ ${JSON.stringify(args)}`), 'the gray "$ {args}" fallback is replaced by the diff block');

  const collapsedText = plain(render.renderTurn(ctx, { ...turn, diffOpen: false }, 80)).join('\n');
  assert(collapsedText.includes('Update(src/a.js)'), 'a collapsed tool row still shows the summary');
  assert(!collapsedText.includes('const b = 2;'), 'and withholds the body');

  // A non-edit tool keeps the args fallback (the diff block is edit-specific).
  const fallback = plain(render.renderTurn(ctx, { role: 'tool', label: 'Bash', args: { command: 'ls' } }, 80)).join('\n');
  assert(fallback.includes('$ {"command":"ls"}'), 'a non-edit tool keeps the $ args row');
}
// And a source-level assertion, so a refactor that silently drops the consult
// still fails the build even if the behavioural path were stubbed.
{
  const src = readFileSync(join(cliDir, 'src', 'render.js'), 'utf8');
  assert(src.includes('renderDiffBlock'), 'render.js imports and calls the diff-block renderer');
  assert(/turn\.diff\b/.test(src), 'the tool branch consults turn.diff');
  assert(/if\s*\(\s*turn\.diff\s*\)/.test(src), 'the tool branch guards on the diff preview');
}

console.log('CLI diff test passed');
console.log('  engine: -/+ rows, pure insert/delete, identical → empty, context markers at start/end only');
console.log('  budgets: LCS table cap + row cap both truncate and stay bounded');
console.log('  editPreview: editFile does no I/O, writeFile reads via the injected reader, garbage never throws');
console.log('  renderer: cells-clipped rows, RESET-closed, defaultOpen small/large');
console.log('  wiring: renderTurn paints the diff block for an edit tool row');
