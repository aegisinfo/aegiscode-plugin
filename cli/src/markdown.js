'use strict';

// Minimal markdown → styled span lines, in the spirit of Claude Code's
// transcript rendering (monokai-flavored code, bold text, inline code).
//
// Ported from aegiscodex-dev/src/markdown.js (ESM → CommonJS). The one
// structural change: instead of importing `span`/`w` from screen.js — which a
// concurrent workstream is rewriting — this module carries a local cell-width
// function and a local `span()` that produce the *same* shape the rest of the
// design system consumes: { t: text, s: style-prefix, w: cell-width }. That
// shape is a contract with whoever renders these lines.
//
// Colours come from the theme tokens (via themeOf(ctx)) rather than a bare
// palette, so light/dark both work.

const {
  BOLD,
  BOLD_OFF,
  DIM,
  ITALIC,
  ITALIC_OFF,
  RESET_BG,
  RESET_FG,
  themeOf,
} = require('./theme.js');

// Real terminal cell width, mirroring aegiscodex-dev/src/screen.js's w():
// combining marks / variation selectors are zero-width, CJK fullwidth forms and
// emoji are two cells, everything else one. A plain codepoint count misaligns
// every width decision the moment a line contains CJK or emoji.
const RE_ZERO = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE00-\uFE0F\uFE20-\uFE2F]/u;
const RE_WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
function w(t) {
  let n = 0;
  for (const ch of String(t == null ? '' : t)) {
    if (RE_ZERO.test(ch)) continue;
    n += RE_WIDE.test(ch) ? 2 : 1;
  }
  return n;
}

/** A styled text run. Shape { t, s, w } is shared with the render model. */
function span(style, t) {
  return { t, s: style, w: w(t) };
}

// Turn an fg colour token into its background twin (38;2;R;G;B → 48;2;R;G;B),
// so a code block sits on the theme's own code-block tint without typing a
// colour inline — it stays theme-aware for free.
function asBg(fgSgr) {
  return fgSgr.replace('[38;2;', '[48;2;');
}

// Rendering rules verified against a live capture of Claude Code 2.1.211:
//   - code lines: two-space indent, no fence label; a theme-tinted background
//     so the block reads as a distinct surface
//   - "- item" → "  - item" (hyphen kept, two-space indent)
//   - "> quote" → "  ▎ quote" (dim ▎, italic text)
function renderMarkdown(text, width, ctx) {
  const t = themeOf(ctx);
  const codeStyle = asBg(t.black) + t.white; // code-block surface
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  let inCode = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue; // fences are not rendered
    }
    if (inCode) {
      out.push([span(codeStyle, '  ' + (line || ''))]);
      continue;
    }
    out.push(...inlineLine(line, width, t));
  }
  return out;
}

// Render one plain line with inline **bold** / `code` / "- " bullets / quotes.
function inlineLine(text, width, t) {
  const ts = text.trimStart();
  let body = text;
  let prefix = null;
  let isQuote = false;
  // "- item" → "  - item": keep the hyphen marker with a two-space indent.
  if (ts.startsWith('- ')) {
    prefix = span(t.white, '  - ');
    body = ts.slice(2);
  } else if (ts.startsWith('  - ')) {
    prefix = span(t.white, '    - ');
    body = ts.slice(4);
  } else if (ts.startsWith('> ')) {
    // "> quote" → "  ▎ quote" (dim bar, italic body).
    prefix = span(DIM, '  ▎ ');
    body = ts.slice(2);
    isQuote = true;
  }

  const spans = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(body))) {
    if (m.index > last) pushText(spans, body.slice(last, m.index), t);
    const tok = m[0];
    if (tok.startsWith('**')) pushText(spans, tok.slice(2, -2), t, BOLD);
    else pushText(spans, tok.slice(1, -1), t, t.green);
    last = m.index + tok.length;
  }
  if (last < body.length) pushText(spans, body.slice(last), t);
  if (isQuote) {
    // italicize the body of a quote line
    for (const sp of spans) sp.s = ITALIC + sp.s + ITALIC_OFF;
  }
  return wrapInline(spans, width, prefix);
}

function pushText(spans, text, t, style) {
  // Emit only non-space words; wrapInline adds separators. This avoids
  // double-spacing when text arrives in chunks.
  const s = style == null ? t.white : style;
  const parts = text.split(/[ \t]+/).filter(Boolean);
  for (const p of parts) {
    spans.push(span(s, p));
  }
}

// Wrap the word spans, prepending `prefix` verbatim to the first line only
// (so "  - " / "  ▎ " markers keep their exact spacing).
function wrapInline(line, width, prefix) {
  const res = [];
  let cur = prefix ? [prefix] : [];
  let curW = prefix ? prefix.w : 0;
  // Does the accumulator's last character end in whitespace? This mirrors the
  // old /\s$/.test(cur.map(join)) check but tracks incrementally — the join
  // version was O(line) PER WORD, making a paragraph render O(n²) and freezing
  // the UI on long streaming answers.
  let endsSpace = prefix ? /\s$/.test(prefix.t) : false;
  const flush = () => {
    if (cur.length) {
      res.push(cur);
      cur = [];
      curW = 0;
      endsSpace = false;
    }
  };
  for (const sp of line) {
    const words = sp.t.split(' ');
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const ww = w(word);
      // Only insert a separator between words when nothing before already
      // ends in whitespace (prevents "· " + word becoming "·  word").
      const needSep = curW > 0 && i === 0 && /^\S/.test(word) && !endsSpace;
      if (curW + ww + (needSep ? 1 : 0) > width && curW > 0) {
        flush();
      }
      if (ww > width) {
        // An unbreakable token wider than the terminal: emit one width-sized
        // row per piece. Slice once into code-point arrays (O(n)) rather than
        // re-slicing the remainder each piece (O(n²)), and cap the rows so a
        // pathological token can't balloon the transcript either.
        const chars = [...word];
        const cws = chars.map((c) => w(c)); // cell width per code point, once
        let total = 0;
        for (const cw of cws) total += cw;
        const MAX_PIECES = 400;
        let j = 0;
        let piece = 0;
        while (total > width) {
          // Take whole code points until the row is full — a codepoint slice
          // (width chars) would split 2-cell CJK/emoji mid-glyph.
          let take = 0;
          let hw = 0;
          while (j + take < chars.length && hw + cws[j + take] <= width) {
            hw += cws[j + take];
            take++;
          }
          if (!take) take = 1; // single glyph wider than the terminal
          const head = chars.slice(j, j + take).join('');
          if (curW) {
            cur.push(span('', ' '));
            curW++;
            endsSpace = true;
          }
          cur.push(span(sp.s, head));
          curW += hw;
          flush();
          j += take;
          total -= hw;
          if (++piece >= MAX_PIECES) {
            if (curW) {
              cur.push(span('', ' '));
              curW++;
            }
            cur.push(span(sp.s, '…'));
            flush();
            return res.length ? res : [[span('', '')]];
          }
        }
        const rest = chars.slice(j).join('');
        if (rest) {
          cur.push(span(sp.s, rest));
          curW += w(rest);
          endsSpace = /\s$/.test(rest);
        }
      } else {
        if (curW > 0 && needSep) {
          cur.push(span('', ' '));
          curW++;
          endsSpace = true;
        }
        cur.push(span(sp.s, word));
        curW += ww;
        endsSpace = /\s$/.test(word);
      }
    }
  }
  flush();
  return res.length ? res : [[span('', '')]];
}

// The Monokai Extended diff preview shown on the theme picker (verbatim from
// the reference capture; the literals are that theme's colours, not this one's).
function renderDiffPreview(width, ctx) {
  const t = themeOf(ctx);
  const div = '╌'.repeat(Math.max(10, width - 4));
  const num = (s) => span(t.gray + '\x1b[2m', s);
  const plain = (s) => span(t.white, s);
  const kw = (s) => span(RGB_LEGACY(102, 217, 239), s); // monokai: function
  const fn = (s) => span(RGB_LEGACY(166, 226, 46), s);
  const str = (s) => span(RGB_LEGACY(230, 219, 116), s);
  const del = (s) => span('\x1b[38;2;220;90;90m\x1b[48;2;61;1;0m', s);
  const delHi = (s) => span('\x1b[38;2;248;248;242m\x1b[48;2;92;2;0m', s);
  const add = (s) => span('\x1b[38;2;80;200;80m\x1b[48;2;2;40;0m', s);
  const addHi = (s) => span('\x1b[38;2;255;255;255m\x1b[48;2;4;71;0m', s);

  const W = Math.max(28, width - 8);
  const padBg = (spans, bg) => {
    let cur = 0;
    const out = [...spans];
    for (const sp of out) cur += sp.w;
    if (cur < W) out.push(span(bg + ' ', ' '.repeat(W - cur)));
    out.push(span(RESET_BG, ''));
    return out;
  };

  const lines = [];
  lines.push([span(t.dim, div)]);
  lines.push([num(' 1 '), kw('function'), plain(' '), fn('greet'), plain('()'), span(t.white, '{')]);
  lines.push(
    padBg(
      [
        num(' 2 '),
        del('-'),
        plain('  '),
        del('console'),
        span('\x1b[38;2;166;226;46m\x1b[48;2;61;1;0m', '.log'),
        del('('),
        str('"Hello, '),
        delHi('World'),
        del('!");'),
      ],
      '\x1b[48;2;61;1;0m'
    )
  );
  lines.push(
    padBg(
      [
        num(' 2 '),
        add('+'),
        plain('  '),
        add('console'),
        span('\x1b[38;2;166;226;46m\x1b[48;2;2;40;0m', '.log'),
        add('('),
        str('"Hello, '),
        addHi('Claude'),
        add('!");'),
      ],
      '\x1b[48;2;2;40;0m'
    )
  );
  lines.push([num(' 3 '), plain('}')]);
  lines.push([span(t.dim, div)]);
  return lines;
}

function RGB_LEGACY(r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

module.exports = {
  renderMarkdown,
  renderDiffPreview,
  // Re-exported style tokens the reference exposed for legacy consumers.
  RESET_FG,
  BOLD,
  BOLD_OFF,
  // Also expose the local model helpers so consumers/tests can reuse them.
  span,
  w,
};
