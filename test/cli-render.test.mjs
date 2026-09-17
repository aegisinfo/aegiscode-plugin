#!/usr/bin/env node
/**
 * The terminal host's rendering surface, driven directly (no TTY, no child
 * process).
 *
 * What it pins: the aegiscode-dev welcome frame (a gold full-width rule over the
 * two-tone mark, the coral-bold title, a version line), width safety (a line
 * never exceeds the terminal — a wrapped escape sequence corrupts every line
 * after it), the accounting line (tokens beside €, which is the whole reason the
 * CLI exists), the glyph fidelity (`❯` prompt, `⎿` hook, `✻` done) and the
 * ephemeral live region's escape arithmetic (an off-by-one there leaves spinner
 * rows in the scrollback after every turn).
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

// Expected glyphs come from the resolved capability CLASS, not the host
// platform. theme.js swaps a couple for font stacks that lack them, and the
// honest axis is what the terminal can draw — PowerShell in Windows Terminal
// draws ⎿ and ✻ exactly like zsh, while this test's `process.platform` says
// nothing about the far end of an SSH session. The class table is pinned
// explicitly; the live table is then required to agree with the live class.
const capsMod = require(join(cliDir, 'src', 'caps.js'));
const NATIVE = { glyphs: 'unicode', face: 'native', star: 'native' };
const EDGES = { glyphs: 'unicode', face: 'edges', star: 'native' };
const ASCII = { glyphs: 'ascii', face: 'edges', star: 'narrow' };

// ── glyph fidelity ──────────────────────────────────────────────────────────
eq(theme.GLYPH.cursor, '❯', 'the prompt/cursor glyph is ❯');

// The class→rune mapping: only the edge-only and ASCII classes drop ⎿/✻/⏸.
eq(theme.glyphsFor(NATIVE).hook, '⎿', 'a native-unicode class keeps the ⎿ hook');
eq(theme.glyphsFor(NATIVE).bloom, '✻', 'a native-unicode class keeps the ✻ bloom');
eq(theme.glyphsFor(NATIVE).pause, '⏸', 'a native-unicode class keeps the ⏸ pause glyph');
eq(theme.glyphsFor(EDGES).hook, '_|', 'an edge-only font class falls back to the ASCII hook');
eq(theme.glyphsFor(EDGES).bloom, '*', 'an edge-only font class falls back to the ASCII bloom');
eq(theme.glyphsFor(ASCII).hook, '_|', 'an ASCII class uses the ASCII hook');
eq(theme.glyphsFor(ASCII).bloom, '*', 'an ASCII class uses the ASCII bloom');

// …and the live table agrees with the class this host resolved to.
const liveGlyphs = theme.glyphsFor(capsMod.caps());
eq(theme.GLYPH.hook, liveGlyphs.hook, "the hook glyph matches this host's glyph class");
eq(theme.GLYPH.bloom, liveGlyphs.bloom, "the done glyph matches this host's glyph class");
// Downstream assertions read these; they follow the live class, never the OS.
const HOOK = liveGlyphs.hook;
const BLOOM = liveGlyphs.bloom;

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
// A styled line measures as its visible text (ANSI is transparent to w()).
eq(screen.w(`${theme.C.gold}abc${theme.RESET}`), 3, 'w() ignores ANSI escapes');

// ── span / line render model (adopted from aegiscode-dev) ───────────────────
const sp = screen.span(theme.C.gold, '日本');
assert(sp.t === '日本' && sp.s === theme.C.gold && sp.w === 4, 'span() is { t, s, w } with a cell width');
eq(screen.lineWidth([sp, screen.span('', 'ab')]), 6, 'lineWidth sums span widths');
const paddedLine = screen.padLine([screen.span('', '日')], 4);
eq(screen.lineWidth(paddedLine), 4, 'padLine pads a span line to exact width');
const clippedLine = screen.padLine([screen.span('', '日本語')], 3);
eq(clippedLine[0].t, '日', 'padLine truncates on whole wide glyphs, never splitting a 2-cell char');
eq(screen.lineWidth(clippedLine), 3, 'padLine pads the truncated line to exact width');

// ── the accounting line ────────────────────────────────────────────────────
const meta = plain(render.renderMeta({}, { model: 'deepseek/deepseek-v4-flash', tokens: 1562, usage: { input: 1250, output: 312 }, eur: 0.0007, ms: 2400 }, 80)).join('\n');
assert(meta.includes('1,562 tok'), 'the meta line states the tokens consumed');
assert(meta.includes('1,250/312'), 'and the input/output split');
assert(meta.includes('€0.0007'), 'and what those tokens cost');
assert(meta.includes('deepseek/deepseek-v4-flash'), 'and which model answered');
assert(meta.includes('2.4s'), 'and how long it took');
assert(meta.includes(HOOK), 'the meta line hangs off the ⎿ hook row');
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
const userTurn = plain(render.renderTurn({}, { role: 'user', text: 'hello there' }, 80));
assert(userTurn[0].startsWith(theme.GLYPH.cursor), 'a user turn is prefixed with the ❯ prompt glyph');
assert(userTurn.join('\n').includes('hello there'), 'and shows the prompt text');

const asst = plain(render.renderTurn({}, { role: 'assistant', text: 'a **bold** word and `code`', meta: { tokens: 10 } }, 80));
assert(asst[0].includes(theme.GLYPH.block), 'an assistant turn carries the ● marker');
assert(asst.join('\n').includes('a bold word and code'), 'inline markup is stripped to its text, not dropped');
assert(asst.join('\n').includes(`${HOOK}  10 tok`), 'the accounting line sits under the answer');

const streaming = plain(render.renderTurn({}, { role: 'assistant', text: 'streaming now', streaming: true }, 80));
assert(streaming[streaming.length - 1].includes(theme.GLYPH.block), 'a streaming answer shows the ● cursor');

const toolTurn = plain(render.renderTurn({}, { role: 'tool', label: 'Ran 1 shell command', args: { command: 'ls' } }, 80));
assert(toolTurn.join('\n').includes(`${HOOK}  $`), 'a tool turn renders its ⎿ hook row');

const wrappedTurn = plain(render.renderTurn({}, { role: 'assistant', text: 'word '.repeat(60) }, 40));
assert(wrappedTurn.every((l) => screen.w(l) <= 40), 'turn lines respect the render width');
const wrappedUser = plain(render.renderTurn({}, { role: 'user', text: 'x'.repeat(120) }, 40));
assert(wrappedUser.every((l) => screen.w(l) <= 40), 'a long user turn respects the render width');

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
assert(!bar.includes('\x1b[48;2;'), 'the status bar paints no background (the CLI stays pipeable)');

// ── banner: the aegiscode-dev welcome frame ────────────────────────────────
const banner = render.renderBanner({}, { width: 76, version: '0.1.0', model: 'nexus-brain', base: 'https://aegiscloud.org', key: 'aegis_••••abcd' });
const bannerPlain = plain(banner);
// The header rule is a full-width gold ━…━ line.
const rule = bannerPlain[0];
eq(screen.w(rule), 76, 'the header rule spans the terminal width');
assert(rule.startsWith('━') && rule.endsWith('━'), 'the header rule is capped with ━');
assert(rule.includes('─'), 'and filled with ─');
assert(banner[0].includes(theme.C.gold), 'and painted in the gold token');
// The art is present, and every art row is the same display width.
const artRows = bannerPlain.filter((l) => /[█▓▒░]/.test(l));
assert(artRows.length >= 5, 'the banner contains the welcome mark');
const artWidths = new Set(artRows.map((l) => screen.w(l)));
eq(artWidths.size, 1, `every art row is the same display width (got ${[...artWidths].join('/')})`);
// Both ink halves are used: mascot gold + whale blue/lavender/dim.
assert(banner.some((l) => l.includes(theme.C.gold)) && banner.some((l) => l.includes(theme.C.lavender)), 'the mark is two-tone (gold mascot, whale ink)');
// Title + version line.
assert(bannerPlain.some((l) => l.includes('Welcome to AEGIS Code')), 'the banner shows the welcome title');
assert(bannerPlain.some((l) => l.includes('v0.1.0')), 'the banner states the version');
assert(bannerPlain.some((l) => l.includes('nexus-brain')), 'the banner states the model');
assert(bannerPlain.some((l) => l.includes('aegiscloud.org')), 'the banner states the base');
assert(!banner.some((l) => /[╭╮╰╯]/.test(stripAnsi(l))), 'the banner never draws a rounded frame');
// "Welcome back!" on a returning run.
const back = plain(render.renderBanner({}, { width: 76, version: '0.1.0', firstRun: false })).join('\n');
assert(back.includes('Welcome back!'), 'a returning run shows the back title');
// Narrow terminals stay inside their width.
for (const width of [24, 40, 60, 72, 110]) {
  const b = render.renderBanner({}, { width, version: '0.1.0' });
  assert(b.every((l) => screen.w(l) <= width), `a ${width}-col banner stays inside the terminal`);
}

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

// ── the working line and the done line ─────────────────────────────────────
const working = plain(render.renderWorking({}, { tick: 3, verb: 'Consulting', elapsedMs: 4200 })).join('');
assert(working.includes('Consulting'), 'the working line names the phase');
assert(working.includes('4.2s'), 'and shows elapsed time');
assert(working.includes('esc to interrupt'), 'and offers the interrupt');
assert(theme.GLYPH.spin.includes(plain(render.renderWorking({}, { tick: 0 })).join('')[0]), 'the spinner frame comes from the theme');
const doneChat = plain(render.renderWorking({}, { done: true, secs: 4 })).join('');
assert(doneChat === `${BLOOM} Churned for 4s`, `a chat turn completes with "✻ Churned for Ns" (got ${JSON.stringify(doneChat)})`);
const doneTools = plain(render.renderWorking({}, { done: true, secs: 6, tools: true })).join('');
assert(doneTools === `${BLOOM} Worked for 6s`, `a tool turn completes with "✻ Worked for Ns" (got ${JSON.stringify(doneTools)})`);

// ── notices and tool results ───────────────────────────────────────────────
assert(stripAnsi(render.renderNotice({}, 'error', 'boom')).startsWith('✗'), 'errors carry the ✗ mark');
assert(stripAnsi(render.renderNotice({}, 'ok', 'done')).startsWith(theme.GLYPH.check), 'success carries the check mark');
assert(stripAnsi(render.renderNotice({}, 'warn', 'careful')).startsWith('⚠'), 'warnings carry the ⚠ mark');
assert(stripAnsi(render.renderNotice({}, 'info', 'fyi')).startsWith(theme.GLYPH.bullet), 'info carries the · mark');
const toolOut = plain(render.renderToolResult({}, 'aegis_balance', 'Balance: €3.50', 60));
assert(toolOut[0].includes('aegis_balance'), 'tool output is headed by the tool name');
assert(toolOut.some((l) => l.includes('€3.50')), 'and shows the body');
assert(toolOut.every((l) => screen.w(l) <= 60), 'tool output respects the width');

console.log('CLI render test passed');
console.log('  accounting: 1,562 tok · 1,250/312 · €0.0007 · grouped + 4dp verified');
console.log(`  glyphs: prompt ${theme.GLYPH.cursor} · hook ${theme.GLYPH.hook} · done ${theme.GLYPH.bloom}`);
console.log('  banner: gold ━ rule at full width, two-tone art rows equal width, coral title');
