'use strict';

/**
 * Terminal capabilities — ONE probe, resolved once, consulted by everything.
 *
 * The UI used to decide how to draw itself from `process.platform`: Windows got
 * the ASCII stencil, macOS got a half-stencil, Linux got the native mark. That
 * is the wrong axis. The platform of the *process* says nothing about the
 * terminal it is talking to, and the two most common real-world runtimes prove
 * it:
 *
 *   · PowerShell *inside Windows Terminal* (`WT_SESSION` set) draws
 *     █▓▒░▐▛▜▌▝▘ and ✦ exactly like zsh does — but `process.platform` is still
 *     `win32`, so it was being handed the hyphen-and-hash ASCII mark.
 *   · `zsh` over SSH from a Windows box, inside `mintty`/`ConEmu`, is `linux`
 *     on the far side and `win32` on the client — the mark must be chosen once,
 *     from what the *terminal* can draw.
 *
 * So the decision is made from the environment the process is actually running
 * in — `TERM`, `COLORTERM`, `TERM_PROGRAM`, the Windows terminal markers
 * (`WT_SESSION`, `ConEmuANSI`, `ANSICON`, …), the locale's character set, and
 * whether stdout is a TTY. Every axis is overridable, because only the person
 * looking at the screen can settle the cases no environment variable can
 * (a Windows console with a font that lacks the block glyphs, a macOS terminal
 * that renders ✦ as a wide emoji).
 *
 * The axes:
 *   glyphs   'unicode' | 'ascii'   — can the mark's palette be drawn at all?
 *   face     'native' | 'edges'    — do the quartile edges ▐▛▜▌▝▘ exist in the
 *                                    terminal's font, or must they be stencilled?
 *   star     'native' | 'narrow'   — is ✦ a single-cell text glyph, or does the
 *                                    terminal fall back to a wide emoji?
 *   depth    24 | 8 | 4 | 0        — truecolor, 256, the 16 ANSI slots, none
 *   vt       boolean               — are cursor/erase escapes honoured?
 *   cols/rows                      — the frame, with `AEGIS_WIDTH`/`COLUMNS` over
 *                                    the reported size and a stable 80 fallback,
 *   wideRunes                      — runes the terminal draws two cells wide
 *                                    that the wcwidth table does not know about
 *                                    (`AEGIS_WIDE_RUNES=✦`), so every width
 *                                    decision stays exact.
 *
 * Overrides (all read from the environment, all documented in README.md):
 *   AEGIS_ART=unicode|ascii    AEGIS_ASCII=1      AEGIS_UNICODE=0|1
 *   AEGIS_STAR=native|narrow   AEGIS_COLOR=0|1|2|3
 *   AEGIS_VT=0|1               AEGIS_WIDTH=<cols> AEGIS_WIDE_RUNES=<runes>
 *
 * `caps()` is cached; `setCaps()` re-resolves and notifies subscribers, which is
 * how `theme.js` re-materialises its palette and glyph table when the user runs
 * `aegiscode --ascii` (the flag is applied before the app is required, so the
 * whole session draws with the pass the user asked for) or toggles it in the
 * `/terminal` command.
 *
 * This module requires nothing — no cycles, and it is safe to load first.
 */

// ── the cell-width core ──────────────────────────────────────────────────────
// Real terminal cell width (wcwidth-style), copied verbatim from
// aegiscodex-dev/src/screen.js. Combining marks and variation selectors occupy
// no cell; CJK fullwidth forms and emoji-presentation glyphs occupy two;
// everything else one. A plain code-point count misaligns every width decision
// the moment a line contains CJK, emoji or a terminal's wide fallback glyph.
const RE_ZERO = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE00-\uFE0F\uFE20-\uFE2F]/u;
const RE_WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/**
 * Windows terminals that draw the full mark. `WT_SESSION` is set by Windows
 * Terminal for every shell it hosts (pwsh, cmd, wsl, git-bash); `TERM_PROGRAM`
 * by VS Code and the other Electron/ConPTY hosts; the rest are the classic
 * ConPTY-era consoles. Presence of any of them means the console is VT-capable
 * and its default font carries the block-element range.
 */
const MODERN_WINDOWS = [
  'WT_SESSION',
  'WT_PROFILE_ID',
  'ConEmuANSI',
  'ANSICON',
  'TERM_PROGRAM',
  'WEZTERM_PANE',
  'ALACRITTY_SOCKET',
  'KITTY_WINDOW_ID',
];

/**
 * `TERM_PROGRAM` values whose font renders the whole palette natively, `✦`
 * included. `Apple_Terminal` is deliberately NOT here — see `resolveGlyphs`.
 */
const NATIVE_TERM_PROGRAMS = new Set([
  'vscode',
  'vscode-insiders',
  'iTerm.app',
  'WezTerm',
  'kitty',
  'ghostty',
  'Alacritty',
  'Hyper',
  'Tabby',
  'WarpTerminal',
  'Warp',
  'rio',
  'mintty',
  'JetBrains-JediTerm',
]);

const TRUTHY_RE = /^(1|true|yes|on)$/i;

/** Is an env value "on"? (`WT_SESSION=` with no value still counts.) */
function truthy(v) {
  if (v == null) return false;
  return v === '' || TRUTHY_RE.test(String(v).trim());
}

/** First defined, non-empty value among `names`. */
function firstEnv(env, names) {
  for (const n of names) {
    const v = env[n];
    if (v != null && v !== '') return { name: n, value: String(v) };
  }
  return null;
}

function modernWindows(env) {
  return firstEnv(env, MODERN_WINDOWS);
}

/**
 * The locale's character set. POSIX terminals signal UTF-8 support here and
 * nowhere else: a terminal launched with `LANG=C` cannot draw ░▒▓, and no
 * amount of TERM sniffing will tell you that.
 */
function localeOf(env) {
  const hit = firstEnv(env, ['LC_ALL', 'LC_CTYPE', 'LANG']);
  return hit ? hit.value : '';
}

function utf8Locale(env) {
  const loc = localeOf(env);
  if (!loc) return true; // unset: every shell we ship to defaults to UTF-8
  return /utf-?8/i.test(loc);
}

/** The explicit art mode, or 'auto'. */
function artMode(env) {
  const raw = String(env.AEGIS_ART || '').trim().toLowerCase();
  if (raw === 'ascii' || raw === 'plain' || raw === 'text') return 'ascii';
  if (raw === 'unicode' || raw === 'native' || raw === 'utf8' || raw === 'utf-8') return 'unicode';
  if (truthy(env.AEGIS_ASCII) || env.AEGIS_UNICODE === '0') return 'ascii';
  if (truthy(env.AEGIS_UNICODE)) return 'unicode';
  return 'auto';
}

/**
 * Resolve what the mark may be drawn with. Order matters: an explicit request
 * always wins, then the terminal's own declarations, then the two signals that
 * mean "this cannot work" (a dumb terminal, a non-UTF-8 locale), then the
 * legacy-Windows console.
 */
function resolveGlyphs(env, platform) {
  const starPref = String(env.AEGIS_STAR || '').trim().toLowerCase();
  const star = /^(native|wide)$/.test(starPref)
    ? 'native'
    : /^(narrow|ascii)$/.test(starPref)
      ? 'narrow'
      : null;
  const mode = artMode(env);

  if (mode === 'ascii') {
    return { glyphs: 'ascii', face: 'edges', star: 'narrow', reason: 'AEGIS_ART=ascii' };
  }
  if (mode === 'unicode') {
    return { glyphs: 'unicode', face: 'native', star: star || 'native', reason: 'AEGIS_ART=unicode' };
  }

  if (String(env.TERM || '').toLowerCase() === 'dumb') {
    return { glyphs: 'ascii', face: 'edges', star: 'narrow', reason: 'TERM=dumb' };
  }

  if (platform === 'win32') {
    const modern = modernWindows(env);
    if (!modern) {
      return {
        glyphs: 'ascii',
        face: 'edges',
        star: 'narrow',
        reason: 'legacy Windows console (no WT_SESSION/ConEmu/TERM_PROGRAM) — Consolas has no block glyphs',
      };
    }
    // A ConPTY host (Windows Terminal, VS Code, ConEmu) renders the block
    // palette, and ConPTY does font fallback — Cascadia Mono lacks ✦ but the
    // system symbol fonts carry it single-width, so the star is drawn natively
    // and the welcome mark is byte-identical to the one zsh prints. That parity
    // is the point: `star: 'narrow'` here would swap all eleven ✦ in the mark
    // for '*', which is the difference a PowerShell user sees.
    //
    // The escape hatches are for the font that does *not* fall back cleanly:
    // AEGIS_STAR=narrow swaps ✦ for '*', AEGIS_WIDE_RUNES=✦ tells the width
    // maths the glyph is two cells wide (which is what a bad fallback actually
    // breaks — the row alignment, not the rune).
    return {
      glyphs: 'unicode',
      face: 'native',
      star: star || 'native',
      reason: `Windows VT host (${modern.name})`,
    };
  }

  if (!utf8Locale(env)) {
    return { glyphs: 'ascii', face: 'edges', star: 'narrow', reason: `locale is not UTF-8 (${localeOf(env)})` };
  }

  const program = String(env.TERM_PROGRAM || '');
  if (platform === 'darwin' && program === 'Apple_Terminal') {
    // Terminal.app's font stack has no ▐▛▜▌▝▘ and renders ✦ with the emoji
    // fallback (two cells), so it gets the edge pass and a narrow star — the
    // shipped behaviour on macOS, now expressed as a capability, not a platform.
    return { glyphs: 'unicode', face: 'edges', star: 'narrow', reason: 'Apple_Terminal font stack' };
  }

  return {
    glyphs: 'unicode',
    face: 'native',
    star: star || 'native',
    reason: program ? `${program} terminal` : `TERM=${env.TERM || 'unset'}`,
  };
}

/**
 * Colour depth in bits per channel: 24 truecolor, 8 the 256-colour cube, 4 the
 * 16 ANSI slots, 0 no colour at all.
 *
 * The default is truecolor, because that is the honest answer for every
 * terminal we can name: the 256-colour terminals in use today all pass 24-bit
 * SGR through, and a terminal that cannot simply downsamples it itself — which
 * is the correct authority for the decision. Only a provably narrow terminal
 * (legacy Windows console, `TERM=linux|vt100|ansi`, `NO_COLOR`) is downgraded,
 * so the palette cannot be silently flattened on a machine that could have
 * shown it.
 */
function resolveDepth(env, platform, isTTY) {
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return { depth: 0, reason: 'NO_COLOR' };
  const forced = String(env.FORCE_COLOR || '').trim();
  if (forced === '0') return { depth: 0, reason: 'FORCE_COLOR=0' };
  if (/^[123]$/.test(forced)) {
    return { depth: forced === '3' ? 24 : forced === '2' ? 8 : 4, reason: `FORCE_COLOR=${forced}` };
  }
  const aegis = String(env.AEGIS_COLOR || '').trim();
  if (/^[0-3]$/.test(aegis)) {
    return { depth: aegis === '0' ? 0 : aegis === '1' ? 4 : aegis === '2' ? 8 : 24, reason: `AEGIS_COLOR=${aegis}` };
  }
  if (String(env.COLORTERM || '').trim() !== '' && /^(truecolor|24bit)$/i.test(env.COLORTERM)) {
    return { depth: 24, reason: `COLORTERM=${env.COLORTERM}` };
  }
  const term = String(env.TERM || '').toLowerCase();
  if (term === 'dumb') return { depth: 0, reason: 'TERM=dumb' };
  if (platform === 'win32') {
    const modern = modernWindows(env);
    if (modern) return { depth: 24, reason: `Windows VT host (${modern.name})` };
    // The classic console: 16 slots, and only when it is actually a console.
    if (isTTY) return { depth: 4, reason: 'legacy Windows console' };
    return { depth: 24, reason: 'redirected output' };
  }
  if (/^(linux|vt100|vt220|ansi|cons25|sun|dumb)$/.test(term) || /^xterm-color$/.test(term)) {
    return { depth: 4, reason: `TERM=${term}` };
  }
  if (env.AEGIS_FORCE_TRUECOLOR === '0' || env.TERM_PROGRAM === 'Apple_Terminal') {
    // Terminal.app advertises truecolor and honours 24-bit SGR on every release
    // that still runs, so it keeps its depth; the check exists for the older
    // builds that dithered. AEGIS_FORCE_TRUECOLOR=0 is the user's override.
    if (env.AEGIS_FORCE_TRUECOLOR === '0') return { depth: 8, reason: 'AEGIS_FORCE_TRUECOLOR=0' };
  }
  return { depth: 24, reason: term ? `TERM=${term}` : 'default' };
}

/**
 * Cursor and erase control. Never claimed for a dumb terminal or redirected
 * output on Windows (where `\x1b[2K` would be printed as text), and always
 * assumed for a POSIX terminal — the live spinner line depends on it.
 */
function resolveVt(env, platform, isTTY) {
  const pref = String(env.AEGIS_VT == null ? '' : env.AEGIS_VT).trim();
  if (pref === '0') return { vt: false, reason: 'AEGIS_VT=0' };
  if (pref === '1' || /^(true|yes|on)$/i.test(pref)) return { vt: true, reason: 'AEGIS_VT=1' };
  if (String(env.TERM || '').toLowerCase() === 'dumb') return { vt: false, reason: 'TERM=dumb' };
  if (platform === 'win32') {
    const modern = modernWindows(env);
    if (modern) return { vt: true, reason: `Windows VT host (${modern.name})` };
    if (isTTY) return { vt: true, reason: 'console host (Node enables VT processing)' };
    return { vt: false, reason: 'redirected output' };
  }
  return { vt: true, reason: 'POSIX terminal' };
}

/**
 * The frame. `AEGIS_WIDTH`, then the size the terminal actually reports, then
 * `COLUMNS`, then a fixed 80.
 *
 * The real report outranks `COLUMNS` on purpose: `COLUMNS` is a shell variable
 * that bash exports and then *stops updating* on SIGWINCH, so honouring it over
 * `stdout.columns` would pin a resized terminal to its old width. A fixed
 * fallback rather than a platform guess keeps a redirected run on PowerShell
 * byte-identical to the same run in zsh.
 */
function resolveSize(env, stdout) {
  const forced = parseInt(env.AEGIS_WIDTH || '', 10);
  const columns = parseInt(env.COLUMNS || '', 10);
  const reported = stdout && Number.isFinite(stdout.columns) && stdout.columns > 0 ? stdout.columns : 0;
  const rows = stdout && Number.isFinite(stdout.rows) && stdout.rows > 0 ? stdout.rows : 0;
  const wanted = forced > 0 ? forced : reported || (columns > 0 ? columns : 80);
  return {
    cols: Math.max(20, Math.min(400, wanted)),
    rows: Math.max(5, rows || 24),
    reason: forced > 0 ? 'AEGIS_WIDTH' : reported ? 'stdout.columns' : columns > 0 ? 'COLUMNS' : 'default 80',
  };
}

/** Runes the terminal draws two cells wide that wcwidth does not know about. */
function resolveWideRunes(env) {
  const out = new Map();
  for (const ch of String(env.AEGIS_WIDE_RUNES || '')) {
    if (ch.trim()) out.set(ch, 2);
  }
  return out;
}

/**
 * Resolve every axis, purely, from an environment and a stream. Exported so the
 * platform matrix is a plain function call in a test — no subprocess, no TTY.
 *
 * @param {object} [env]   defaults to `process.env`
 * @param {object} [stdout] defaults to `process.stdout`
 * @param {string} [platform] defaults to `process.platform`
 */
function detect(env = process.env, stdout = process.stdout, platform = process.platform) {
  const isTTY = !!(stdout && stdout.isTTY);
  const glyph = resolveGlyphs(env, platform);
  const color = resolveDepth(env, platform, isTTY);
  const vt = resolveVt(env, platform, isTTY);
  const size = resolveSize(env, stdout);
  return {
    platform,
    isTTY,
    term: String(env.TERM || ''),
    termProgram: String(env.TERM_PROGRAM || ''),
    locale: localeOf(env),
    glyphs: glyph.glyphs,
    face: glyph.face,
    star: glyph.star,
    depth: color.depth,
    color: color.depth > 0,
    vt: vt.vt,
    cols: size.cols,
    rows: size.rows,
    eol: platform === 'win32' && !isTTY ? '\r\n' : '\n',
    wideRunes: resolveWideRunes(env),
    reasons: {
      glyphs: glyph.reason,
      depth: color.reason,
      vt: vt.reason,
      size: size.reason,
    },
  };
}

// ── the resolved singleton ───────────────────────────────────────────────────

let cached = null;
let sizePinned = false;
/**
 * The environment `setCaps()` last resolved against. The live size re-read has
 * to use THIS, not `process.env`: the CLI entry point builds an environment
 * *copy* (`{...process.env, AEGIS_WIDTH}`) so that `--width`/`--ascii` do not
 * leak into the session's own child processes. Reading `process.env` in
 * `caps()` therefore discarded every override — `aegiscode --width 66` reported
 * `80x24 (default 80)` and rendered at 80.
 */
let sizeEnv = null;
const listeners = [];

/**
 * The derived axes — glyphs, face, star, depth, vt, wideRunes — resolved once
 * per process and re-resolved only by `setCaps()`. The frame is deliberately
 * NOT part of this: `process.stdout.columns` changes on SIGWINCH, and the
 * window is resized far more often than the palette. Caching the size is how a
 * resized terminal ends up pinned to the width it had at module load, which is
 * the one bug this split exists to prevent.
 */
function axes() {
  if (!cached) cached = detect();
  return cached;
}

/**
 * The resolved capabilities for this process.
 *
 * The size is read from the live stream on every call (unless pinned by
 * `setCaps({cols,rows})` or `AEGIS_WIDTH`), so a resize is picked up by the
 * next frame; everything else comes from the cache. `cols`/`rows` are written
 * back onto the same object rather than replaced, so a holder that captured the
 * result — `theme.js` keeps one — sees the new frame without re-subscribing.
 */
function caps() {
  const c = axes();
  if (!sizePinned) {
    const size = resolveSize(sizeEnv || process.env, process.stdout);
    c.cols = size.cols;
    c.rows = size.rows;
    c.reasons.size = size.reason;
  }
  // Surfaced so `/terminal` can warn that a pinned frame ignores resizes.
  c.pinned = sizePinned;
  return c;
}

/**
 * Re-resolve — with `patch` applied on top when given — and tell subscribers.
 * `theme.js` subscribes so its palette and glyph table follow a mid-session
 * change (`/terminal ascii`), and so does the CLI entry point, which applies
 * `--ascii` / `--no-color` before the app module is ever required.
 * @param {object} [patch] partial caps, e.g. `{ glyphs: 'ascii', star: 'narrow' }`
 * @param {object} [env]
 */
function setCaps(patch = null, env = process.env, stdout = process.stdout) {
  cached = Object.assign(detect(env, stdout), patch || {});
  // Every later frame resolves its size against this same environment, so an
  // inherited `AEGIS_WIDTH`/`COLUMNS` override keeps working after a resize
  // instead of silently reverting to the stream's own report.
  sizeEnv = env || process.env;
  // An explicit frame in the patch is a deliberate override, so it must survive
  // the live re-read in `caps()`.
  sizePinned = !!(patch && (patch.cols != null || patch.rows != null));
  // A pinned frame is not re-read from the stream, so the reason the last
  // `detect()` recorded (`stdout.columns`) describes where the size came from
  // BEFORE the pin — the report would claim the width was the stream's when the
  // user had just overridden it with `/terminal width`.
  if (patch && patch.cols != null && cached.reasons) cached.reasons.size = 'pinned (override)';
  for (const fn of listeners) {
    try {
      fn(cached);
    } catch {
      /* a listener must never break the session's capability resolution */
    }
  }
  return cached;
}

/** Drop the cache so the next `caps()` re-probes (used by tests). */
function resetCaps() {
  cached = null;
  sizePinned = false;
  sizeEnv = null;
}

/** Subscribe to `setCaps`. Returns an unsubscribe function. */
function onCapsChange(fn) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

// ── width, through the resolved capabilities ─────────────────────────────────

/** Cell width of one code point, honouring `caps.wideRunes`. */
function cellWidth(ch) {
  // `axes()`, not `caps()`: this is called once per code point by `cells()`, on
  // every pad and clip in the render path. Re-resolving the frame here would
  // parse the environment thousands of times per frame to answer a question
  // about fonts, so the hot path reads the cached wide-rune table directly.
  const c = axes();
  if (c.wideRunes && c.wideRunes.size) {
    const o = c.wideRunes.get(ch);
    if (o != null) return o;
  }
  if (RE_ZERO.test(ch)) return 0;
  if (RE_WIDE.test(ch)) return 2;
  return 1;
}

/** Display width of a string in terminal cells (ANSI-free input). */
function cells(s) {
  let n = 0;
  for (const ch of String(s)) n += cellWidth(ch);
  return n;
}

/** Pad a string with spaces to `n` cells (never truncates). */
function padCells(s, n) {
  const d = n - cells(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}

// ── colour, through the resolved depth ──────────────────────────────────────

/** Nearest slot in the xterm-256 cube/greyscale ladder for an RGB triple. */
function rgbTo256(r, g, b) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const q = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** Nearest of the 8 base colours (the bright half is a bold/attribute matter). */
function rgbTo16(r, g, b) {
  const named = [
    [0, 0, 0, 30],
    [205, 0, 0, 31],
    [0, 205, 0, 32],
    [205, 205, 0, 33],
    [0, 0, 238, 34],
    [205, 0, 205, 35],
    [0, 205, 205, 36],
    [229, 229, 229, 37],
  ];
  let best = named[7];
  let bestD = Infinity;
  for (const c of named) {
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best[3];
}

/**
 * A foreground SGR prefix for the resolved depth: 24-bit, the 256-colour cube,
 * the 16 ANSI slots, or nothing at all (`NO_COLOR`, `TERM=dumb`).
 *
 * Every colour in the UI goes through this — `theme.js` builds its palettes
 * from these calls — so a terminal that cannot show truecolor gets a palette it
 * *can* show instead of a wall of literal escape text.
 */
function rgb(r, g, b) {
  const d = caps().depth;
  if (d >= 24) return `\x1b[38;2;${r};${g};${b}m`;
  if (d >= 8) return `\x1b[38;5;${rgbTo256(r, g, b)}m`;
  if (d >= 4) return `\x1b[${rgbTo16(r, g, b)}m`;
  return '';
}

/** A background SGR prefix for the resolved depth (or nothing). */
function bg(r, g, b) {
  const d = caps().depth;
  if (d >= 24) return `\x1b[48;2;${r};${g};${b}m`;
  if (d >= 8) return `\x1b[48;5;${rgbTo256(r, g, b)}m`;
  if (d >= 4) return `\x1b[${rgbTo16(r, g, b) + 10}m`;
  return '';
}

// ── reporting (the /terminal command, `aegiscode --terminal`) ────────────────

/**
 * The resolved capabilities as `[label, value]` rows — one shape, same on every
 * platform, so a support paste from PowerShell reads like one from zsh.
 */
function describe(c = caps()) {
  const eol = c.eol === '\r\n' ? '\\r\\n' : '\\n';
  return [
    ['platform', `${c.platform}${c.isTTY ? '' : ' (no tty)'}`],
    ['terminal', c.termProgram || c.term || 'unknown'],
    ['locale', c.locale || 'unset'],
    ['mark', c.glyphs === 'ascii' ? 'ascii' : c.face === 'edges' ? 'unicode (edges stencilled)' : 'unicode'],
    ['star', c.star],
    ['color', c.depth === 0 ? 'none' : c.depth >= 24 ? 'truecolor' : c.depth >= 8 ? '256' : '16'],
    ['control', c.vt ? 'ansi' : 'plain'],
    ['size', `${c.cols}x${c.rows} (${c.reasons.size})`],
    ['eol', eol],
    ['why', `${c.reasons.glyphs}; ${c.reasons.depth}`],
  ];
}

module.exports = {
  detect,
  caps,
  setCaps,
  resetCaps,
  onCapsChange,
  cellWidth,
  cells,
  padCells,
  rgb,
  bg,
  rgbTo256,
  rgbTo16,
  describe,
  // internals the tests drive directly
  resolveGlyphs,
  resolveDepth,
  resolveVt,
  resolveSize,
  MODERN_WINDOWS,
  NATIVE_TERM_PROGRAMS,
};
