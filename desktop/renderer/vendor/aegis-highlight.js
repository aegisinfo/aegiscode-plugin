'use strict';

/**
 * Aegis Desktop — minimal self-contained syntax highlighter.
 *
 * First-party (not a third-party vendor drop like marked/DOMPurify): a small
 * regex tokenizer covering the languages that actually show up in AEGIS chat
 * output (JS/TS, Python, JSON, shell, CSS, HTML) without pulling in a full
 * grammar engine like highlight.js/Prism. Unknown languages fall back to
 * plain escaped text rather than guessing wrong colors.
 *
 * UMD-lite: works as a CommonJS module (tests) and as a plain <script> tag
 * (renderer, CSP script-src 'self' — no eval, no Function()).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.AegisHighlight = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Build one alternation regex from an ordered list of [tokenClass, source]
   * pairs (earlier entries win ties, e.g. comments before generic strings)
   * and walk it, emitting escaped text for the gaps and
   * `<span class="tok-X">` for matches. Empty matches advance by one char so
   * a zero-width pattern can never spin the loop forever.
   */
  function tokenize(code, patterns) {
    const combined = new RegExp(patterns.map(([, src]) => '(' + src + ')').join('|'), 'g');
    let out = '';
    let last = 0;
    let m;
    while ((m = combined.exec(code))) {
      if (m.index > last) out += escapeHtml(code.slice(last, m.index));
      for (let i = 0; i < patterns.length; i++) {
        if (m[i + 1] !== undefined) {
          out += `<span class="tok-${patterns[i][0]}">${escapeHtml(m[i + 1])}</span>`;
          break;
        }
      }
      last = combined.lastIndex;
      if (m[0].length === 0) combined.lastIndex += 1;
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  const NUM = String.raw`\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`;
  const DQ_STR = String.raw`"(?:\\.|[^"\\\n])*"`;
  const SQ_STR = String.raw`'(?:\\.|[^'\\\n])*'`;
  const FUNC_CALL = String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()`;
  // Built from a real regex literal (not a hand-escaped string) so the
  // backtick/backslash escaping is guaranteed correct — counting backslashes
  // by hand across two rounds of escaping (JS string, then regex) is where
  // this pattern kept breaking.
  const TEMPLATE_STR = /`(?:\\.|[^`\\])*`/.source;

  const GRAMMARS = {
    js: [
      ['comment', String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`],
      ['string', `${TEMPLATE_STR}|${DQ_STR}|${SQ_STR}`],
      ['keyword', String.raw`\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|class|extends|new|this|super|import|export|from|as|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|void|yield|static|get|set|delete|interface|type|enum|implements|public|private|protected|readonly)\b`],
      ['function', FUNC_CALL],
      ['number', NUM],
    ],
    python: [
      ['comment', String.raw`#[^\n]*`],
      ['string', String.raw`'''[\s\S]*?'''|"""[\s\S]*?"""|${DQ_STR}|${SQ_STR}`],
      ['keyword', String.raw`\b(?:def|return|if|elif|else|for|while|break|continue|class|import|from|as|try|except|finally|raise|with|pass|lambda|yield|global|nonlocal|assert|del|is|in|not|and|or|None|True|False|async|await|self)\b`],
      ['function', FUNC_CALL],
      ['number', NUM],
    ],
    json: [
      ['string', String.raw`${DQ_STR}`],
      ['keyword', String.raw`\b(?:true|false|null)\b`],
      ['number', NUM],
    ],
    bash: [
      ['comment', String.raw`#[^\n]*`],
      ['string', String.raw`${DQ_STR}|${SQ_STR}`],
      ['variable', String.raw`\$\{[^}]*\}|\$[A-Za-z_]\w*`],
      ['keyword', String.raw`\b(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|function|return|export|local|echo|cd|exit|set|source|in)\b`],
    ],
    css: [
      ['comment', String.raw`\/\*[\s\S]*?\*\/`],
      ['string', String.raw`${DQ_STR}|${SQ_STR}`],
      ['property', String.raw`[a-zA-Z-]+(?=\s*:)`],
      ['number', String.raw`\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b`],
    ],
    html: [
      ['comment', String.raw`<!--[\s\S]*?-->`],
      ['string', String.raw`${DQ_STR}|${SQ_STR}`],
      ['tag', String.raw`<\/?[a-zA-Z][\w-]*|\/?>`],
      ['attr', String.raw`\b[a-zA-Z-]+(?==)`],
    ],
  };

  const ALIASES = {
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    ts: 'js', typescript: 'js', tsx: 'js',
    py: 'python', python: 'python', python3: 'python',
    json: 'json', json5: 'json',
    sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', xml: 'html', svg: 'html', htm: 'html',
  };

  /** Normalise a fenced-code-block lang string (e.g. "js" from ```js) to a
   *  known grammar key, or null when unsupported (caller should skip
   *  highlighting and just escape). */
  function resolve(lang) {
    if (!lang) return null;
    const key = String(lang).trim().toLowerCase();
    return ALIASES[key] || null;
  }

  /** Highlight `code` for `lang`. Always returns escaped-safe HTML — falls
   *  back to plain escaped text for an unrecognised or absent language. */
  function highlight(code, lang) {
    const grammar = resolve(lang);
    if (!grammar) return escapeHtml(code);
    return tokenize(code, GRAMMARS[grammar]);
  }

  return { highlight, resolve, escapeHtml };
});
