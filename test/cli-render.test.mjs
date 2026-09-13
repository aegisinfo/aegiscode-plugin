#!/usr/bin/env node
/**
 * The terminal host's rendering surface, driven directly (no TTY, no child
 * process).
 *
 * What it pins: width safety (a line never exceeds the terminal — a wrapped
 * escape sequence corrupts every line after it), the accounting line (tokens
 * beside €, which is the whole reason the CLI exists), and the ephemeral live
 * region's escape arithmetic (an off-by-one there leaves spinner rows in the
 * scrollback after every turn).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, '..', 'cli');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const screen = require(join(cliDir, 'src', 'screen.js'));
const format = require(join(cliDir, 'src', 'format.js'));
const render = require(join(cliDir, 'src', 'render.js'));
const theme = require(join(cliDir, 'src', 'theme.js'));
const { stripAnsi } = screen;
const plain = (lines) => (Array.isArray(lines) ? lines : [lines]).map((l) => stripAnsi(l));

// ── number formatting: the €4dp rule is the fix the CLI must not lose ───────
eq(format.fmtTokens(1500), '1,500', 'tokens are grouped');
eq(format.fmtTokens(0), '0', 'zero tokens render as 0, not empty');
eq(format.fmtEur(0.0007), '€0.0007', 'sub-cent spend keeps 4dp');
eq(format.fmtEur(5), '€5.00', 'cash-sized amounts keep 2dp');
eq(format.fmtEurSigned(-0.0007), '-€0.0007', 'spend is negative from the user side');
eq(format.fmtEurSigned(5), '+€5.00', 'top-ups are positive');
eq(format.fmtElapsed(900), '0.9s', 'sub-10s shows one decimal');
eq(format.fmtElapsed(65000), '1m05s', 'minutes are padded');
assert(!format.maskKey('aegis_' + 'x'.repeat(30)).includes('x'.repeat(20)), 'maskKey must not echo the key');
eq(format.maskKey(''), 'not set', 'an absent key says so');

// ── cell maths ─────────────────────────────────────────────────────────────
eq(screen.w('abc'), 3, 'ascii width');
eq(screen.w('⬢'), 1, 'the sigil is one cell');
eq(screen.w('日本'), 4, 'CJK is two cells per char');
eq(screen.pad('ab', 5), 'ab   ', 'pad fills to width');
eq(screen.w(screen.pad('日本', 5)), 5, 'pad treats wide chars as 2 cells');
eq(screen.clip('日本語', 4), '日本', 'clip never splits a wide char');
const wrapped = screen.wrapLine('alpha beta gamma delta', 11);
assert(wrapped.length > 1, 'long lines wrap');
assert(wrapped.every((l) => screen.w(l) <= 11), 'every wrapped line fits the width');
assert(screen.wrapLine('x'.repeat(50), 10).every((l) => screen.w(l) <= 10), 'unbreakable tokens hard-split');

// ── the accounting line ────────────────────────────────────────────────────
const meta = plain(render.renderMeta({}, { model: 'deepseek/deepseek-v4-flash', tokens: 1562, usage: { input: 1250, output: 312 }, eur: 0.0007, ms: 2400 }, 80)).join('\n');
assert(meta.includes('1,562 tok'), 'the meta line states the tokens consumed');
assert(meta.includes('1,250/312'), 'and the input/output split');
assert(meta.includes('€0.0007'), 'and what those tokens cost');
assert(meta.includes('deepseek/deepseek-v4-flash'), 'and which model answered');
assert(meta.includes('2.4s'), 'and how long it took');
eq(plain(render.renderMeta({}, {}, 80)).join(''), '', 'a turn with no accounting renders no meta line');

// A usage object in the Anthropic wire spelling must still total correctly —
// this is the bug that made tokens invisible on anthropic-compatible models.
const { usageTokens } = require(join(cliDir, 'src', 'deps.js'));
eq(usageTokens({ input_tokens: 1250, output_tokens: 312 }), 1562, 'anthropic spelling sums');
eq(usageTokens({ prompt_tokens: 1250, completion_tokens: 312, total_tokens: 1562 }), 1562, 'openai spelling uses total');
eq(usageTokens(null), null, 'absent usage is null, never 0');
const anthropicMeta = plain(render.renderMeta({}, { tokens: usageTokens({ input_tokens: 1250, output_tokens: 312 }) }, 80)).join('');
assert(anthropicMeta.includes('1,562 tok'), 'an anthropic-shaped usage still renders a token count');

// ── turns ──────────────────────────────────────────────────────────────────
const turn = plain(render.renderTurn({}, { role: 'user', text: 'hello there' }, 80));
assert(turn[0].includes(theme.GLYPH.prompt), 'a user turn is marked with the prompt glyph');
assert(turn[0].includes('you'), 'and labelled');
assert(turn.every((l) => l.startsWith(theme.GLYPH.rail)), 'every turn line hangs off the rail');
const asst = plain(render.renderTurn({}, { role: 'assistant', text: 'a **bold** word and `code`', meta: { tokens: 10 } }, 80));
assert(asst[0].includes(theme.GLYPH.sigil), 'an assistant turn is marked with the sigil');
assert(asst.join('\n').includes('a bold word and code'), 'inline markup is stripped to its text, not dropped');
const wrappedTurn = plain(render.renderTurn({}, { role: 'assistant', text: 'word '.repeat(60) }, 40));
assert(wrappedTurn.every((l) => screen.w(l) <= 40), 'turn lines respect the render width');

// Markdown-lite: fences are treated as code, not rendered as bullets.
const md = plain(render.mdLines('- one\n- two\n\n```\nconst x = 1;\n```\n# Title', 60, {}));
assert(md.some((l) => l.includes(`${theme.GLYPH.bullet} one`)), 'bullets use the CLI bullet');
assert(md.some((l) => l.includes('const x = 1;')), 'code lines are kept');
assert(!md.some((l) => l.includes('```')), 'fence markers are not printed');
assert(md.some((l) => l.includes('Title')), 'headings are kept');

// ── status bar ─────────────────────────────────────────────────────────────
const bar = render.renderStatus({}, { model: 'nexus-brain', tokens: 1500, spend: 0.0007, mode: 'stream' }, 72);
eq(screen.w(bar), 72, 'the status bar is exactly the terminal width');
const barPlain = stripAnsi(bar);
for (const bit of ['nexus-brain', '1,500 tok', '€0.0007', 'stream']) {
  assert(barPlain.includes(bit), `the status bar shows ${bit}`);
}
eq(screen.w(render.renderStatus({}, {}, 20)), 20, 'a narrow bar is clipped, not wrapped');

// ── banner ─────────────────────────────────────────────────────────────────
const banner = render.renderBanner({}, { width: 76, version: '0.1.0', model: 'nexus-brain', base: 'https://aegiscloud.org', key: 'aegis_••••abcd' });
const bannerPlain = plain(banner);
assert(bannerPlain.some((l) => l.includes('v0.1.0')), 'the banner states the version');
assert(bannerPlain.some((l) => l.includes('nexus-brain')), 'the banner states the model');
assert(bannerPlain.some((l) => l.includes('aegiscloud.org')), 'the banner states the base');
assert(bannerPlain.some((l) => l.includes('A E G I S')), 'the banner shows the wordmark');
assert(banner.some((l) => l.includes(theme.GLYPH.box.tl)), 'the banner draws the heavy frame');
assert(!banner.some((l) => /[╭╮╰╯]/.test(stripAnsi(l))), 'the banner never draws a rounded frame');
const narrow = render.renderBanner({}, { width: 24, version: '0.1.0' });
assert(narrow.every((l) => screen.w(l) <= 24), 'a narrow banner stays inside the terminal');

// ── the live region's escape arithmetic ────────────────────────────────────
class FakeOut {
  constructor() {
    this.buf = '';
    this.isTTY = true;
  }
  write(s) {
    this.buf += s;
    return true;
  }
}
const out = new FakeOut();
const live = new screen.LiveRegion(out);
live.update(['first']);
assert(out.buf.includes('first'), 'the first paint writes the block');
const afterFirst = out.buf.length;
live.update(['second']);
const second = out.buf.slice(afterFirst);
assert(second.includes('\x1b[1G'), 'a repaint homes the column');
assert(second.includes('\x1b[1A'), 'and walks back over the previous block');
assert(second.includes('\x1b[0K'), 'and clears the tail of each row');
eq(live.rows, 1, 'the region tracks its row count');
live.update(['a', 'b', 'c']);
eq(live.rows, 3, 'a taller block updates the row count');
const beforeClear = out.buf.length;
live.clear();
const afterClear = out.buf.slice(beforeClear);
assert(afterClear.includes('\x1b[2K'), 'clear erases the block');
assert(afterClear.includes('\x1b[2A'), 'clear walks back up through every row it drew');
eq(live.rows, 0, 'a cleared region forgets its rows');
eq(live.active, false, 'a cleared region is inactive');
live.clear();
eq(out.buf.length, beforeClear + afterClear.length, 'clearing twice is a no-op');

// The working line has to say what it is doing and how long for.
const working = plain(render.renderWorking({}, { tick: 3, verb: 'Consulting', elapsedMs: 4200 })).join('');
assert(working.includes('Consulting'), 'the working line names the phase');
assert(working.includes('4.2s'), 'and shows elapsed time');
assert(working.includes('esc to interrupt'), 'and offers the interrupt');
assert(theme.GLYPH.spin.includes(plain(render.renderWorking({}, { tick: 0 })).join('')[0]), 'the spinner frame comes from the theme');

// ── notices and tool results ───────────────────────────────────────────────
assert(stripAnsi(render.renderNotice({}, 'error', 'boom')).startsWith(theme.GLYPH.err), 'errors carry the error mark');
assert(stripAnsi(render.renderNotice({}, 'ok', 'done')).startsWith(theme.GLYPH.ok), 'success carries the check mark');
const toolOut = plain(render.renderToolResult({}, 'aegis_balance', 'Balance: €3.50', 60));
assert(toolOut[0].includes('aegis_balance'), 'tool output is headed by the tool name');
assert(toolOut.some((l) => l.includes('€3.50')), 'and shows the body');
assert(toolOut.every((l) => screen.w(l) <= 60), 'tool output respects the width');

console.log('CLI render test passed');
console.log('  accounting: 1,562 tok · 1,250/312 · €0.0007 · grouped + 4dp verified');
console.log(`  geometry: status bar exact-width, ${screen.w('日本')}-cell wide chars safe, wrap bounded`);
