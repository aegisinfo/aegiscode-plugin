'use strict';

/**
 * The CLI's renderers: banner, transcript turns, per-turn meta line, status bar,
 * and the markdown-lite body treatment.
 *
 * Every function returns an array of lines (strings with SGR escapes) rather
 * than writing to stdout, so the whole surface is assertable from a plain Node
 * test with no TTY and no child process — the same split the desktop uses for
 * its pure renderer modules.
 */

const { RGB, BG, RESET, BOLD, DIM, ITALIC, UNDER, RESET_FG, RESET_BG, GLYPH, themeOf } = require('./theme.js');
const { SIGIL, CORE, WORDMARK, TAGLINE, center } = require('./art.js');
const { w, pad, padStart, wrapBlock, clip } = require('./screen.js');
const { fmtTokens, fmtEur, fmtElapsed } = require('./format.js');

const fg = (t, c) => `${RGB(...c)}`;
const bg = (c) => BG(...c);

/**
 * The start-up banner: sigil art, wordmark, tagline and a heavy-ruled identity
 * box (heavy corners, never rounded — the rounded frame is the Claude Code
 * look this CLI exists to not be).
 */
function renderBanner(ctx, info = {}) {
  const t = themeOf(ctx);
  const width = Number(info.width) || 80;
  const lines = [];

  if (width >= 34) {
    const artRows = center(SIGIL, width);
    for (const [i, row] of artRows.entries()) {
      // `center()` only ever left-pads with spaces, so the offset is the width
      // the core cell moved by; shift the core columns to match.
      const offset = row.length - SIGIL[i].length;
      const coreCols = CORE.filter((c) => c.row === i).map((c) => c.col + offset);
      if (!coreCols.length) {
        lines.push(fg(t, t.plasma) + row + RESET);
        continue;
      }
      // Paint the core cell in the secondary colour so the mark reads as a
      // signal rather than a solid block.
      let painted = '';
      [...row].forEach((ch, c) => {
        painted += coreCols.includes(c) ? fg(t, t.beam) + ch + fg(t, t.plasma) : ch;
      });
      lines.push(fg(t, t.plasma) + painted + RESET);
    }
    lines.push('');
    lines.push(' '.repeat(Math.max(0, Math.floor((width - w(WORDMARK)) / 2))) + fg(t, t.plasma) + BOLD + WORDMARK + RESET);
    lines.push(' '.repeat(Math.max(0, Math.floor((width - w(TAGLINE)) / 2))) + fg(t, t.muted) + TAGLINE + RESET);
    lines.push('');
  }

  lines.push(...renderIdentityBox(ctx, info, width));
  return lines;
}

/** The `┏━ AEGIS ━┓` identity panel: what you are talking to, and as what. */
function renderIdentityBox(ctx, info, width) {
  const t = themeOf(ctx);
  const boxW = Math.max(24, Math.min(width, 64));
  const inner = boxW - 2;

  const rows = [
    ['version', info.version ? `v${info.version}` : null],
    ['model', info.model || 'server default'],
    ['base', info.base || ''],
    ['key', info.key || 'not set'],
    ['render', info.stream === false ? 'buffered' : 'streaming'],
  ].filter(([, v]) => v);

  const title = ' AEGIS terminal ';
  const headFill = Math.max(0, inner - w(title) - 1);
  const out = [
    fg(t, t.plasma) + GLYPH.box.tl + GLYPH.box.h + BOLD + title + RESET + fg(t, t.plasma) + GLYPH.box.h.repeat(headFill) + GLYPH.box.tr + RESET,
  ];
  for (const [k, v] of rows) {
    const label = fg(t, t.muted) + k.padEnd(8) + RESET;
    // Row budget: 1 border + 1 space + 8 label + 1 space + value + fill + 1 space
    // + 1 border = boxW, so the value gets `inner - 11` cells.
    const value = clip(String(v), Math.max(0, inner - 11));
    out.push(
      fg(t, t.plasma) + GLYPH.box.v + RESET + ' ' + label + ' ' + fg(t, t.text) + value + RESET +
        ' '.repeat(Math.max(0, inner - 11 - w(value))) + ' ' + fg(t, t.plasma) + GLYPH.box.v + RESET
    );
  }
  out.push(fg(t, t.plasma) + GLYPH.box.bl + GLYPH.box.h.repeat(inner) + GLYPH.box.br + RESET);
  // Clip the hint as plain text *before* styling — clipping an already-styled
  // line would cut through an escape sequence and bleed colour.
  const hint = clip(` type /help for commands ${GLYPH.bullet} /quit to exit`, width);
  out.push(fg(t, t.dim) + hint + RESET);
  return out;
}

/** Markdown-lite body: fenced code, bullets, headings, inline code/bold. */
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
      for (const l of wrapBlock(raw, bodyW)) out.push(fg(t, t.beam) + '  ' + l + RESET);
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
        out.push(`${indent}${fg(t, t.dim)}${GLYPH.bullet}${RESET} ${l}`);
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(fg(t, t.plasma) + BOLD + inline(heading[2], ctx) + RESET);
      continue;
    }
    for (const l of wrapBlock(inline(raw, ctx), bodyW, '')) out.push(l);
  }
  return out;
}

/** Inline span treatment: `code` in beam, **bold** in bold. */
function inline(text, ctx) {
  const t = themeOf(ctx);
  return String(text)
    .replace(/`([^`]+)`/g, (_, code) => fg(t, t.beam) + code + RESET)
    .replace(/\*\*([^*]+)\*\*/g, (_, bold) => BOLD + bold + RESET);
}

/**
 * One transcript turn. Roles get a heavy gutter (┃) and their own sigil, so a
 * turn is scannable without the boxed-bubble or `>`-prefix look.
 */
function renderTurn(ctx, turn, width = 80) {
  const t = themeOf(ctx);
  const role = turn.role || 'assistant';
  const rail = fg(t, t.dim) + GLYPH.rail + RESET;
  const lines = [];

  const head = {
    user: { mark: GLYPH.prompt, label: 'you', colour: t.text },
    assistant: { mark: GLYPH.sigil, label: 'aegis', colour: t.plasma },
    tool: { mark: GLYPH.pointer, label: turn.label || 'tool', colour: t.beam },
    system: { mark: GLYPH.warn, label: 'aegis', colour: t.muted },
    error: { mark: GLYPH.err, label: 'error', colour: t.fault },
  }[role] || { mark: GLYPH.bullet, label: role, colour: t.muted };

  lines.push(`${rail}${fg(t, head.colour)}${head.mark} ${BOLD}${head.label}${RESET}`);

  const body = role === 'assistant' || role === 'system' ? mdLines(turn.text, width - 2, ctx) : wrapBlock(turn.text, width - 4);
  for (const l of body) lines.push(`${rail} ${l}`);

  if (turn.meta) lines.push(renderMeta(ctx, turn.meta, width));
  return lines;
}

/**
 * The per-turn accounting line — tokens consumed beside what they cost, which
 * is the readout this whole surface exists to make possible.
 */
function renderMeta(ctx, meta, width = 80) {
  const t = themeOf(ctx);
  const bits = [];
  if (meta.model) bits.push(fg(t, t.beam) + meta.model + RESET);
  const tokens = meta.tokens == null ? null : `${fmtTokens(meta.tokens)} tok`;
  if (tokens) bits.push(fg(t, t.text) + tokens + RESET);
  if (meta.usage) {
    const { input, output } = meta.usage;
    if (Number.isFinite(input) || Number.isFinite(output)) {
      bits.push(fg(t, t.muted) + `${fmtTokens(input || 0)}/${fmtTokens(output || 0)}` + RESET);
    }
  }
  if (meta.eur != null) bits.push(fg(t, meta.eur > 0 ? t.alert : t.pulse) + fmtEur(meta.eur) + RESET);
  if (meta.ms != null) bits.push(fg(t, t.muted) + fmtElapsed(meta.ms) + RESET);
  if (meta.calls > 1) bits.push(fg(t, t.muted) + `${meta.calls} calls` + RESET);
  if (!bits.length) return '';
  return `${fg(t, t.dim)}${GLYPH.railEnd}${GLYPH.divider} ${RESET}${GLYPH.spend} ${bits.join(fg(t, t.dim) + ' ' + GLYPH.bullet + ' ' + RESET)}`;
}

/**
 * The bottom bar: a full-width inverted strip. Segments are packed left and the
 * hint is right-aligned; the bar is clipped (never wrapped) so a narrow
 * terminal degrades instead of corrupting the transcript.
 */
function renderStatus(ctx, state = {}, width = 80) {
  const t = themeOf(ctx);
  const left = [];
  left.push(`${GLYPH.sigil} aegis`);
  if (state.model) left.push(state.model);
  if (state.tokens != null) left.push(`${fmtTokens(state.tokens)} tok`);
  if (state.spend != null) left.push(fmtEur(state.spend));
  if (state.mode) left.push(state.mode);

  const right = state.hint || 'ctrl+c quit';
  const body = ` ${left.join('  ' + GLYPH.bullet + ' ')} `;
  const gap = width - w(body) - w(right) - 1;
  // Always exactly `width` cells: the bar is a background, so a short line
  // would leave the terminal's own background showing through the strip.
  const content = gap > 0 ? body + ' '.repeat(gap) + right + ' ' : clip(body, width);
  return bg(t.ink) + fg(t, t.plasma) + pad(content, width) + RESET + RESET_BG;
}

/** The working line (drawn in the live region, then replaced by the turn). */
function renderWorking(ctx, state = {}) {
  const t = themeOf(ctx);
  const frame = GLYPH.spin[Math.floor((state.tick || 0)) % GLYPH.spin.length];
  const verb = state.verb || 'Working';
  const tail = [];
  if (state.elapsedMs != null) tail.push(fmtElapsed(state.elapsedMs));
  if (state.streamed) tail.push(`${fmtTokens(state.streamed)} char`);
  return (
    fg(t, t.plasma) + frame + RESET + ' ' + fg(t, t.text) + verb + RESET +
    fg(t, t.muted) + '…' + (tail.length ? ` ${tail.join(' ' + GLYPH.bullet + ' ')}` : '') + RESET +
    fg(t, t.dim) + '  esc to interrupt' + RESET
  );
}

/** A ruled section header used by command output (`/balance`, `/models`). */
function renderHeading(ctx, text, width = 80) {
  const t = themeOf(ctx);
  const label = ` ${text} `;
  const fill = Math.max(0, width - w(label) - 2);
  const left = Math.floor(fill / 2);
  return (
    fg(t, t.dim) + GLYPH.rule.repeat(left) + RESET + fg(t, t.plasma) + BOLD + label + RESET +
    fg(t, t.dim) + GLYPH.rule.repeat(fill - left) + RESET
  );
}

/** Render a tool result body: heading + indented lines, no role gutter. */
function renderToolResult(ctx, name, text, width = 80) {
  const t = themeOf(ctx);
  const lines = [renderHeading(ctx, name, width)];
  for (const l of wrapBlock(String(text == null ? '' : text), width - 2)) {
    lines.push('  ' + (l ? fg(t, t.text) + l + RESET : ''));
  }
  return lines;
}

/** The transient "you didn't finish a stream" note. */
function renderNotice(ctx, kind, text) {
  const t = themeOf(ctx);
  const colour = kind === 'error' ? t.fault : kind === 'warn' ? t.alert : t.muted;
  const mark = kind === 'error' ? GLYPH.err : kind === 'warn' ? GLYPH.warn : GLYPH.ok;
  return fg(t, colour) + `${mark} ${text}` + RESET;
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
  renderNotice,
  mdLines,
  inline,
  fg,
  bg,
  UNDER,
  ITALIC,
  RESET_FG,
  pad,
  padStart,
};
