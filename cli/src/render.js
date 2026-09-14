'use strict';

/**
 * The CLI's renderers — the start-up banner, transcript turns, the per-turn
 * accounting line, the status bar, the live working line and the transcript's
 * markdown body. The presentation layer is a fidelity port of
 * `aegiscodex-dev`: gold `━`/`─` rules, the two-tone welcome mark (gold mascot,
 * blue/lavender/dim whale), the coral-bold welcome title, the `❯` prompt, the
 * `⎿` hook rows, the `●` answer/stream cursor and the `✻` done glyph.
 *
 * Every function returns lines (strings carrying SGR escapes) rather than
 * writing to stdout, so the whole surface is assertable from a plain Node test
 * with no TTY and no child process — the same split the desktop uses for its
 * pure renderer modules. The markdown body is delegated to `./markdown.js`
 * (returning span lines); the require is guarded so this file always loads even
 * if that module is absent, falling back to the built-in `mdLines`.
 */

const {
  RGB,
  BG,
  RESET,
  BOLD,
  DIM,
  ITALIC,
  UNDER,
  RESET_FG,
  RESET_BG,
  GLYPH,
  VERBS,
  DONE_VERBS,
  themeOf,
} = require('./theme.js');
const { WELCOME_TITLE, WELCOME_BACK, TAGLINE, welcomeArtParts } = require('./art.js');
const { w, pad, padStart, wrapBlock, clip, span } = require('./screen.js');
const { fmtTokens, fmtEur, fmtElapsed } = require('./format.js');

// Guarded: a concurrent workstream owns ./markdown.js.
let markdown = null;
try {
  // eslint-disable-next-line global-require
  markdown = require('./markdown.js');
} catch {
  markdown = null;
}

/** Error mark — the reference's failed-check glyph (theme.js has no GLYPH.err). */
const ERR = '✗';
/** Warning mark — the reference's ⚠ (theme.js has no GLYPH.warn). */
const WARN = '⚠';

const fg = (t, c) => `${c}`;
const bg = (c) => BG(...c);

/** Flatten a span line back to an ANSI string (what the transcript emits). */
const spansToString = (line) => line.map((sp) => (sp.s || '') + sp.t).join('') + RESET;

/** Centre plain `text` inside `width`, painted with `style` (never overflows). */
function centerStyled(text, width, style) {
  const tt = clip(text, width);
  const p = Math.max(0, Math.floor((width - w(tt)) / 2));
  return ' '.repeat(p) + style + tt + RESET;
}

/** The right (moon + whale) half of the mark: ▓ blue, ▒ lavender, ░ dim,
 *  eye white, stars gold. */
function tintWhale(str, t) {
  const map = { '▓': t.blue, '▒': t.lavender, '░': t.dim, '█': t.white, '✦': t.gold, '·': t.dim };
  const spans = [];
  let cur = null;
  let style = '';
  for (const ch of str) {
    const s = map[ch] != null ? map[ch] : '';
    if (cur !== null && s === style) {
      cur += ch;
    } else {
      if (cur !== null) spans.push(span(style, cur));
      cur = ch;
      style = s;
    }
  }
  if (cur !== null) spans.push(span(style, cur));
  return spans;
}

/** One centred welcome-art row: gold mascot on the left, tinted whale right. */
function artRow(ctx, row, parts, leftPad) {
  const t = themeOf(ctx);
  const left = row[0] || '';
  const right = row[1] || '';
  const spans = [span('', ' '.repeat(leftPad))];
  if (left && right) {
    spans.push(span(t.gold, left));
    spans.push(span('', ' '.repeat(parts.gutter)));
    spans.push(...tintWhale(right, t));
  } else if (left) {
    spans.push(span(t.gold, left));
    if (w(left) < parts.width) spans.push(span('', ' '.repeat(parts.width - w(left))));
  } else if (right) {
    spans.push(...tintWhale(right, t));
    if (w(right) < parts.width) spans.push(span('', ' '.repeat(parts.width - w(right))));
  } else {
    spans.push(span('', ' '.repeat(parts.width)));
  }
  return spansToString(spans);
}

/**
 * The start-up banner, matching aegiscodex-dev's welcome legs: a gold `━`+`─`
 * rule across the full terminal, the centred welcome mark (mascot half gold,
 * moon/whale half blue/lavender/dim), the coral-bold welcome title and a
 * version line, then the compact identity block.
 */
function renderBanner(ctx, info = {}) {
  const t = themeOf(ctx);
  const width = Math.max(20, Number(info.width) || 80);
  const lines = [];

  // Full-width gold header rule.
  lines.push(`${t.gold}━${'─'.repeat(Math.max(0, width - 2))}━${RESET}`);
  lines.push('');

  const parts = welcomeArtParts(width);
  if (width >= parts.width + 2) {
    const leftPad = Math.max(0, Math.floor((width - parts.width) / 2));
    for (const row of parts.rows) lines.push(artRow(ctx, row, parts, leftPad));
  } else {
    // Too narrow for the mark: a compact gold wordmark keeps every row in width.
    lines.push(centerStyled('AEGIS  CODE', width, t.gold + BOLD));
  }
  lines.push('');

  const title = info.firstRun === false ? WELCOME_BACK : WELCOME_TITLE;
  lines.push(centerStyled(title, width, t.coral + BOLD));
  const verLine = [info.version ? `v${info.version}` : null, TAGLINE].filter(Boolean).join(` ${GLYPH.bullet} `);
  lines.push(centerStyled(verLine, width, t.gray));
  lines.push('');

  lines.push(...renderIdentityBox(ctx, info, width));
  return lines;
}

/** The identity panel: what you are talking to, and as what. Routed through
 *  renderHeading so it shares the CLI's ruled-section look (no rounded frame). */
function renderIdentityBox(ctx, info = {}, width = 80) {
  const t = themeOf(ctx);
  const lines = [renderHeading(ctx, 'aegiscode', width)];

  const rows = [
    ['version', info.version ? `v${info.version}` : null],
    ['model', info.model || 'server default'],
    ['base', info.base || ''],
    ['key', info.key || 'not set'],
    ['render', info.stream === false ? 'buffered' : 'streaming'],
  ].filter(([, v]) => v);

  for (const [k, v] of rows) {
    const value = clip(String(v), Math.max(0, width - 12));
    lines.push(`  ${t.gray}${k.padEnd(8)}${RESET}${t.white}${value}${RESET}`);
  }
  const hint = clip(` type /help for commands ${GLYPH.bullet} /quit to exit`, width);
  lines.push('');
  lines.push(`${t.dim}${hint}${RESET}`);
  return lines;
}

/** Markdown-lite body (fallback when ./markdown.js is unavailable): fenced
 *  code, bullets, headings, inline code/bold. */
function mdLines(text, width, ctx) {
  const t = themeOf(ctx);
  const out = [];
  let inFence = false;
  const bodyW = Math.max(20, width - 4);

  for (const raw of String(text == null ? '' : text).split('\n')) {
    const fence = /^\s*```/.test(raw);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      for (const l of wrapBlock(raw, bodyW)) out.push(`${t.gray}  ${l}${RESET}`);
      continue;
    }
    if (raw.trim() === '') {
      out.push('');
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      const indent = ' '.repeat(Math.min(6, bullet[1].length));
      for (const l of wrapBlock(inline(bullet[2], ctx), bodyW - 2)) {
        out.push(`${indent}${t.gray}${GLYPH.bullet}${RESET} ${l}`);
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(`${t.gold}${BOLD}${inline(heading[2], ctx)}${RESET}`);
      continue;
    }
    for (const l of wrapBlock(inline(raw, ctx), bodyW, '')) out.push(l);
  }
  return out;
}

/** Inline span treatment: `code` in green, **bold** in bold. */
function inline(text, ctx) {
  const t = themeOf(ctx);
  return String(text == null ? '' : text)
    .replace(/`([^`]+)`/g, (_, code) => `${t.green}${code}${RESET}`)
    .replace(/\*\*([^*]+)\*\*/g, (_, bold) => `${BOLD}${bold}${RESET}`);
}

/** Assistant body: ./markdown.js span lines flattened to ANSI strings, else the
 *  plain mdLines fallback. */
function assistantLines(ctx, text, width) {
  if (markdown && typeof markdown.renderMarkdown === 'function') {
    return markdown.renderMarkdown(String(text == null ? '' : text), width, ctx).map(spansToString);
  }
  return mdLines(text, width, ctx);
}

/**
 * One transcript turn: a `❯`-prefixed user line, an assistant answer whose
 * first line carries the `●` marker (and a `●` cursor while streaming), a tool
 * line with its `⎿  $ …` hook row, and each turn's accounting line beneath.
 */
function renderTurn(ctx, turn, width = 80) {
  const t = themeOf(ctx);
  const role = turn.role || 'assistant';
  const text = String(turn.text == null ? '' : turn.text);
  const lines = [];

  if (role === 'user') {
    const body = wrapBlock(text, Math.max(8, width - 2));
    body.forEach((l, i) => {
      if (i === 0) lines.push(`${t.gray}${GLYPH.cursor}${RESET} ${t.white}${l}${RESET}`);
      else lines.push(`  ${t.white}${l}${RESET}`);
    });
  } else if (role === 'assistant' || role === 'system') {
    const body = assistantLines(ctx, text, Math.max(8, width - 2));
    if (!body.length) body.push('');
    body[0] = `${t.white}${GLYPH.block}${RESET} ` + body[0];
    if (turn.streaming) body[body.length - 1] += `${t.white}${GLYPH.block}${RESET}`;
    lines.push(...body);
  } else if (role === 'tool') {
    // turn.ok is only known once the call has actually run (the agent loop's
    // tool-activity event fires after execution); undefined means "no result
    // yet to report" (the plain registry-tool path, which never set it).
    const status = turn.ok === undefined ? '' : turn.ok ? ` ${t.green}✓${RESET}` : ` ${t.red}${ERR}${RESET}`;
    lines.push(`${t.white}${GLYPH.block}${RESET} ${t.gray}${turn.label || 'tool'}${RESET}${status}`);
    const args =
      turn.args == null
        ? ''
        : typeof turn.args === 'string'
          ? turn.args
          : JSON.stringify(turn.args);
    if (args) lines.push(`  ${t.gray}${GLYPH.hook}  $ ${clip(args, Math.max(0, width - 6))}${RESET}`);
  } else if (role === 'error') {
    lines.push(`${t.red}${ERR} ${text}${RESET}`);
  } else {
    for (const l of wrapBlock(text, Math.max(8, width - 2))) lines.push(`${t.white}${l}${RESET}`);
  }

  if (turn.meta) {
    const m = renderMeta(ctx, turn.meta, width);
    if (m) lines.push(m);
  }
  return lines;
}

/**
 * The per-turn accounting line — tokens beside what they cost, in the `⎿` hook
 * row style, e.g. `⎿  1,562 tok · 1,250/312 · €0.0007 · 4.2s`.
 */
function renderMeta(ctx, meta = {}, width = 80) {
  const t = themeOf(ctx);
  const bits = [];
  if (meta.model) bits.push(`${t.blue}${meta.model}${RESET}`);
  if (meta.tokens != null) bits.push(`${t.white}${fmtTokens(meta.tokens)} tok${RESET}`);
  // The producer (chatflow.js's accounting row) pushes the split flat, as
  // `input`/`output` — reading it as `meta.usage.input` here meant the pair was
  // never printed on this path even though the docstring above promises it.
  // Both shapes are accepted: `usage` is what the desktop's renderer hands over.
  const split = meta.usage && typeof meta.usage === 'object' ? meta.usage : meta;
  const { input, output } = split;
  if (Number.isFinite(input) || Number.isFinite(output)) {
    bits.push(`${t.gray}${fmtTokens(input || 0)}/${fmtTokens(output || 0)}${RESET}`);
  }
  if (meta.eur != null) bits.push(`${meta.eur > 0 ? t.coral : t.green}${fmtEur(meta.eur)}${RESET}`);
  if (meta.ms != null) bits.push(`${t.gray}${fmtElapsed(meta.ms)}${RESET}`);
  if (meta.calls > 1) bits.push(`${t.gray}${meta.calls} calls${RESET}`);
  if (!bits.length) return '';
  const sep = `${t.dim} ${GLYPH.bullet} ${RESET}`;
  return `${t.dim}${GLYPH.hook}  ${RESET}${bits.join(sep)}`;
}

/**
 * The bottom bar: segments packed left, the hint right-aligned, always exactly
 * `width` cells (clipped, never wrapped, so a narrow terminal degrades instead
 * of corrupting the transcript). No background — the CLI stays pipeable.
 */
function renderStatus(ctx, state = {}, width = 80) {
  const t = themeOf(ctx);
  const left = ['aegis'];
  if (state.model) left.push(state.model);
  if (state.tokens != null) left.push(`${fmtTokens(state.tokens)} tok`);
  if (state.spend != null) left.push(fmtEur(state.spend));
  if (state.mode) left.push(state.mode);

  const right = state.hint || 'ctrl+c quit';
  const body = ` ${left.join(` ${GLYPH.bullet} `)} `;
  const gap = width - w(body) - w(right) - 1;
  const content = gap > 0 ? body + ' '.repeat(gap) + right + ' ' : clip(body, width);
  return `${t.gray}${pad(content, width)}${RESET}`;
}

/**
 * The working line (drawn in the live region, then replaced by the turn):
 * the `✻`-family spinner cycling with a VERBS entry. With `state.done`, the
 * completion line `✻ <DoneVerb> for Ns` in gray (Churned after a chat turn,
 * Worked after a turn that used tools).
 */
function renderWorking(ctx, state = {}) {
  const t = themeOf(ctx);
  if (state.done) {
    const verb = state.verb || DONE_VERBS[state.tools ? 1 : 0] || DONE_VERBS[0];
    const secs =
      state.secs != null ? state.secs : Math.max(1, Math.round((state.elapsedMs || 0) / 1000));
    return `${t.gray}${GLYPH.bloom} ${verb} for ${secs}s${RESET}`;
  }
  const frame = GLYPH.spin[Math.abs(Math.floor(state.tick || 0)) % GLYPH.spin.length];
  const verb = state.verb || VERBS[0];
  const tail = [];
  if (state.elapsedMs != null) tail.push(fmtElapsed(state.elapsedMs));
  if (state.streamed != null) tail.push(`↓${fmtTokens(state.streamed)} tokens`);
  const tailStr = tail.length ? ` ${t.gray}(${tail.join(` ${GLYPH.bullet} `)})${RESET}` : '';
  return (
    `${t.coral}${frame}${RESET} ${t.white}${verb}${RESET}${t.white}…${RESET}${tailStr}` +
    `${t.dim}  esc to interrupt${RESET}`
  );
}

/** A ruled section header used by command output (`/help`, `/cost`). */
function renderHeading(ctx, text, width = 80) {
  const t = themeOf(ctx);
  const label = ` ${text} `;
  const fill = Math.max(0, width - w(label));
  const left = Math.floor(fill / 2);
  return (
    `${t.gray}${'─'.repeat(left)}${RESET}${t.gold}${BOLD}${label}${RESET}` +
    `${t.gray}${'─'.repeat(Math.max(0, fill - left))}${RESET}`
  );
}

/** Render a tool result body: heading + indented lines, no role gutter. */
function renderToolResult(ctx, name, text, width = 80) {
  const t = themeOf(ctx);
  const lines = [renderHeading(ctx, name, width)];
  for (const l of wrapBlock(String(text == null ? '' : text), Math.max(8, width - 2))) {
    lines.push(l ? `  ${t.white}${l}${RESET}` : '');
  }
  return lines;
}

/**
 * The tool-approval card: the mutating call the model wants to run (a diff
 * for writeFile/editFile, the command for exec) and the three answers. One
 * inline question, matching aegiscodex-dev's Bash/edit approval dialog.
 */
function renderApproval(ctx, info = {}, width = 80) {
  const t = themeOf(ctx);
  const lines = [renderHeading(ctx, `confirm ${info.tool || 'tool'}`, width)];
  const body = info.diff
    ? info.diff
    : info.args == null
      ? ''
      : typeof info.args === 'string'
        ? info.args
        : JSON.stringify(info.args);
  for (const l of wrapBlock(body, Math.max(8, width - 2))) {
    lines.push(l ? `  ${t.gray}${l}${RESET}` : '');
  }
  lines.push('');
  lines.push(
    `  ${t.coral}${GLYPH.bullet}${RESET} ${t.white}y${RESET}es once` +
      `  ${t.dim}${GLYPH.bullet}${RESET} ${t.white}s${RESET}ession` +
      `  ${t.dim}${GLYPH.bullet}${RESET} ${t.white}n${RESET}o ${t.dim}(default)${RESET}`
  );
  return lines;
}

/** A transient notice. Kinds map gray / coral / red / green with the matching
 *  glyph: info `·`, warn `⚠`, error `✗`, ok `✔`. */
const NOTICE = {
  info: ['gray', GLYPH.bullet],
  warn: ['coral', WARN],
  error: ['red', ERR],
  ok: ['green', GLYPH.check],
};

function renderNotice(ctx, kind, text) {
  const t = themeOf(ctx);
  const [token, mark] = NOTICE[kind] || NOTICE.info;
  return `${t[token]}${mark} ${text}${RESET}`;
}

module.exports = {
  renderBanner,
  renderIdentityBox,
  renderTurn,
  renderMeta,
  renderStatus,
  renderWorking,
  renderHeading,
  renderToolResult,
  renderApproval,
  renderNotice,
  mdLines,
  inline,
  // Welcome-mark pieces, shared with the onboarding screens so there is exactly
  // one renderer for the mascot/moon/whale mark rather than two that can drift.
  artRow,
  tintWhale,
  // Style helpers kept for legacy consumers.
  fg,
  bg,
  UNDER,
  ITALIC,
  RESET_FG,
  RESET_BG,
  pad,
  padStart,
};
