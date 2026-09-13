#!/usr/bin/env node
/**
 * The markdown → styled span lines renderer, ported from aegiscodex-dev.
 *
 * What it pins: the span shape { t, s, w } that the rest of the render model
 * consumes, that `w` is the terminal *cell* width of `t` (not its codepoint
 * count — CJK/emoji are two cells), and that a fenced code block renders on a
 * distinct background surface.
 *
 * House style: ESM test file, CommonJS module pulled in with createRequire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { renderMarkdown, renderDiffPreview, span: spanOf } = require(
  join(__dirname, '..', 'cli', 'src', 'markdown.js')
);
const theme = require(join(__dirname, '..', 'cli', 'src', 'theme.js'));

const flat = (lines) => lines.flat();
const lineText = (line) => line.map((sp) => sp.t).join('');
const hasBg = (s) => /\x1b\[48;2;/.test(s);

// Every span must be exactly { t, s, w } with the right primitive types.
function assertShape(lines) {
  for (const line of lines) {
    assert.ok(Array.isArray(line), 'each line is an array of spans');
    for (const sp of line) {
      assert.deepEqual(Object.keys(sp).sort(), ['s', 't', 'w'], 'span keys are exactly {t,s,w}');
      assert.equal(typeof sp.t, 'string', 'span.t is text');
      assert.equal(typeof sp.s, 'string', 'span.s is a style prefix');
      assert.equal(typeof sp.w, 'number', 'span.w is a cell width');
    }
  }
}

test('the local span() helper produces the exact { t, s, w } shape', () => {
  const sp = spanOf(theme.C.white, 'abc');
  assert.deepEqual(sp, { t: 'abc', s: theme.C.white, w: 3 });
});

test('a heading renders as span lines', () => {
  const out = renderMarkdown('# Title', 60);
  assertShape(out);
  assert.equal(out.length, 1, 'a single-source-line heading yields one output line');
  assert.ok(lineText(out[0]).includes('Title'), 'the heading text survives');
});

test('**bold** becomes a bold span', () => {
  const out = renderMarkdown('a **b** c', 60);
  assertShape(out);
  const bold = flat(out).find((sp) => sp.t === 'b');
  assert.ok(bold, 'the bold word is emitted as its own span');
  assert.ok(bold.s.includes(theme.BOLD), 'and carries the bold token');
});

test('`code` becomes a green span', () => {
  const out = renderMarkdown('use `x` now', 60);
  assertShape(out);
  const code = flat(out).find((sp) => sp.t === 'x');
  assert.ok(code, 'the inline code word is its own span');
  assert.equal(code.s, theme.C.green, 'inline code uses the green token');
});

test('"- item" keeps its marker with a two-space indent', () => {
  const out = renderMarkdown('- one', 60);
  assertShape(out);
  assert.equal(out[0][0].t, '  - ', 'the bullet marker is the first span');
  assert.equal(lineText(out[0]), '  - one', 'and the line reads "  - one"');
});

test('"> quote" renders a dim bar and an italic body', () => {
  const out = renderMarkdown('> hi there', 60);
  assertShape(out);
  assert.equal(out[0][0].t, '  ▎ ', 'the quote bar is the first span');
  assert.equal(out[0][0].s, theme.DIM, 'and it is dim');
  const body = flat(out).find((sp) => sp.t === 'hi');
  assert.ok(body.s.includes(theme.ITALIC), 'the quote body is italic');
});

test('a fenced code block renders on a distinct background surface', () => {
  const out = renderMarkdown('```\nconst x = 1;\n```', 60);
  assertShape(out);
  assert.equal(out.length, 1, 'the fences are not rendered, only the code line');
  const sp = out[0][0];
  assert.equal(sp.t, '  const x = 1;', 'code keeps its two-space indent');
  assert.equal(sp.w, 14, 'and the width is the cell width of the text');
  assert.ok(hasBg(sp.s), 'the code block carries a background token');

  // The code surface must differ from a plain text line's style.
  const plain = renderMarkdown('# Title', 60);
  assert.ok(!hasBg(plain[0][0].s), 'ordinary text has no background');
  assert.notEqual(sp.s, plain[0][0].s, 'the code style is distinct from text');
});

test('every ASCII span has w equal to the cell width of its text', () => {
  const out = renderMarkdown('# Title\n- one two\nsome `code` and **bold** here', 60);
  assertShape(out);
  for (const sp of flat(out)) {
    // All-ASCII text: one cell per codepoint.
    assert.equal(sp.w, sp.t.length, `w matches text length for ${JSON.stringify(sp.t)}`);
  }
});

test('CJK text gets a two-cell width, not a codepoint count', () => {
  const out = renderMarkdown('# 日本', 60);
  assertShape(out);
  const cjk = flat(out).find((sp) => sp.t === '日本');
  assert.ok(cjk, 'the CJK run is emitted as a span');
  assert.equal(cjk.t.length, 2, 'it is two codepoints…');
  assert.equal(cjk.w, 4, '…but four cells wide (2 per wide glyph)');
});

test('CJK inside a code block is measured in cells too', () => {
  const out = renderMarkdown('```\n日本\n```', 60);
  assertShape(out);
  const sp = out[0][0];
  assert.equal(sp.t, '  日本', 'two-space indent plus the run');
  assert.equal(sp.w, 6, 'two indent cells + four wide cells');
});

test('an empty input still yields a well-formed empty span line', () => {
  const out = renderMarkdown('', 60);
  assertShape(out);
  assert.deepEqual(out, [[{ t: '', s: '', w: 0 }]]);
});

test('the diff preview is span lines with the monokai surface', () => {
  const out = renderDiffPreview(80);
  assertShape(out);
  assert.ok(out.length >= 4, 'the preview is a multi-line block');
  assert.ok(flat(out).some((sp) => hasBg(sp.s)), 'diff lines sit on add/remove backgrounds');
  assert.equal(out[0][0].s, theme.C.dim, 'the divider uses the dim token');
});
