'use strict';

/**
 * Onboarding screens — trust check, theme picker, welcome.
 *
 * A direct port of `aegiscodex-dev/src/screens.js`, which is where the
 * reference's session actually begins: a genuine first run is
 *
 *     showTrustCheck(ctx) → showThemePicker(ctx) → updateConfig() → welcome
 *
 * and every later run goes straight to the welcome box. The CLI had none of
 * this — `runInteractive` went directly into `chatflow.runSession`, so the
 * trust check, the theme picker and the pre-session welcome did not exist and
 * `configExists()` was dead code with zero callers. That is the gap this file
 * closes; the ordering and the copy are the reference's.
 *
 * Two deliberate departures, both so this client stays honest:
 *
 *  - `runOnboarding` **returns** whether the user declined rather than calling
 *    `process.exit` from inside a library function, so the caller owns process
 *    lifecycle (and a test can drive the whole flow).
 *  - The `What's new` box lists *this* package's release notes, not
 *    Aegiscodex's: printing another project's changelog in our banner would be
 *    a lie about what the user just installed.
 *
 * Every screen is split into a pure line-builder (`trustLines`,
 * `themePickerLines`, `welcomeLines`) plus a thin key loop, so the exact
 * content of each screen is asserted by tests with no terminal and no timing.
 */

const { getSize, paint, span, lineWidth, clip, w } = require('./screen.js');
const events = require('./events.js');
const { nextKey, KEY } = events;
const { C, BOLD, BOLD_OFF, GLYPH, THEME_TABLE, themeOf } = require('./theme.js');
const { welcomeArtParts } = require('./art.js');
const { renderDiffPreview } = require('./markdown.js');
const render = require('./render.js');
const { updateConfig, configExists } = require('./config.js');

const VERSION = require('../package.json').version;

const PRODUCT = 'AEGIS Code';

/** The two boxes' contents. `What's new` is this package's own changelog. */
const TIPS = [
  ' Run /init to create an AEGIS.md',
  ' Use ↑↓ to recall past prompts',
  ' Press / for commands',
  ' Press Tab to complete a command',
  ' Press ? for shortcuts',
];

const WHATS_NEW = [
  ' v6.3.0: onboarding — trust check,',
  '  theme picker and this welcome',
  ' v6.1.0: the / palette, the full',
  '  command registry, session',
  '  persistence and auto-checkpoints',
  ' v6.0.0: the aegiscodex-dev design',
  '  system — palette, mark, verbs',
  ' /release-notes for more',
];

/** Centre a plain string, returning one span line. Clip first, or a string
 *  wider than the terminal produces a row that wraps and shears the frame. */
function centered(text, cols, style) {
  const t = clip(String(text), Math.max(1, cols));
  const pad = Math.max(0, Math.floor((cols - w(t)) / 2));
  return [span('', ' '.repeat(pad)), span(style, t)];
}

/** Wrap body copy to `cols - 4`, one span line per row (the reference's
 *  wrapGray, kept here because screen.js's wrapBlock takes spans). */
function wrapped(text, cols, style, indent = 0) {
  const words = String(text).split(' ');
  const out = [];
  let line = [];
  let len = 0;
  for (const word of words) {
    if (len + w(word) + 1 > cols - 4 - indent && line.length) {
      out.push([span('', ' '.repeat(indent)), span(style, line.join(' '))]);
      line = [word];
      len = w(word);
    } else {
      if (line.length) len++;
      line.push(word);
      len += w(word);
    }
  }
  if (line.length) out.push([span('', ' '.repeat(indent)), span(style, line.join(' '))]);
  return out;
}

// ── trust check ──────────────────────────────────────────────────────────────

/** The trust screen's lines. `sel` is 0 = trust, 1 = exit. Pure. */
function trustLines(ctx, cols, sel = 0, cwd = process.cwd()) {
  const lines = [];
  lines.push([span(C.gold, '─'.repeat(Math.max(1, cols)))]);
  lines.push([span(C.white + BOLD, 'Accessing workspace:')]);
  lines.push([span(C.white + BOLD, clip(cwd, Math.max(1, cols - 1)))]);
  lines.push([span('', '')]);
  for (const l of wrapped(
    `Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.`,
    cols,
    C.white
  )) {
    lines.push(l);
  }
  lines.push([span('', '')]);
  lines.push([span(C.white, `${PRODUCT} will be able to read, edit, and execute files here.`)]);
  lines.push([span('', '')]);
  lines.push([span(C.white + BOLD, 'Security guide')]);
  lines.push([span('', '')]);
  for (let i = 0; i < 2; i++) {
    const active = sel === i;
    const left = active ? span(C.lavender, GLYPH.cursor) : span('', ' ');
    const n = span(C.gray, ` ${i + 1}.`);
    const label = i === 0 ? 'Yes, I trust this folder' : 'No, exit';
    lines.push([
      left,
      n,
      span(active ? C.lavender : C.white, label),
    ]);
  }
  lines.push([span('', '')]);
  lines.push([span(C.gray, `Enter to confirm ${GLYPH.bullet} Esc to cancel`)]);
  return lines;
}

/**
 * The trust check. Resolves true when the folder is trusted, false when the
 * user declines — the caller must abort the session on false, as the reference
 * does (it never reaches `session(ctx)`).
 */
async function showTrustCheck(ctx) {
  const { cols } = getSize();
  let sel = 0;
  const renderScreen = () => paint(trustLines(ctx, cols, sel));
  renderScreen();
  for (;;) {
    const key = await nextKey();
    if (key.name === KEY.UP || key.name === KEY.DOWN || key.name === KEY.TAB) {
      sel = 1 - sel;
      renderScreen();
    } else if (key.name === KEY.ENTER) {
      return sel === 0;
    } else if (key.name === KEY.ESC || key.name === KEY.CTRL_C || key.name === KEY.CTRL_D) {
      return false;
    } else if (key.name === 'char') {
      const c = String(key.ch).trim();
      if (c === '1') {
        sel = 0;
        renderScreen();
      }
      if (c === '2') {
        sel = 1;
        renderScreen();
      }
    }
  }
}

// ── theme picker ─────────────────────────────────────────────────────────────

/** Apply a picker row to a context: both the row index and the light flag, the
 *  way the reference commits (`ctx.light = sel === 2 || sel === 4 || sel === 6`). */
function applyTheme(ctx, sel) {
  const row = THEME_TABLE[sel] || THEME_TABLE[1];
  ctx.themeIndex = sel;
  ctx.light = row.light;
  return sel;
}

/** The theme picker's lines. Pure, so the 7 rows and their notes are testable. */
function themePickerLines(ctx, cols, rows, sel) {
  const lines = [];
  lines.push([span(C.coral, `Welcome to ${PRODUCT} v${VERSION}`)]);
  lines.push([span(C.white + BOLD, "Let's get started.")]);
  lines.push([span(C.white, 'Choose the text style that looks best with your terminal')]);
  lines.push([span(C.gray, 'To change this later, run /theme')]);
  lines.push([span('', '')]);
  for (let i = 0; i < THEME_TABLE.length; i++) {
    const t = THEME_TABLE[i];
    const active = sel === i;
    const left = active ? span(C.lavender, GLYPH.cursor) : span('', ' ');
    const n = span(C.gray, `${i + 1}.`);
    const check = active ? span(C.green, ' ' + GLYPH.check) : span('', '');
    lines.push([
      left,
      n,
      span(active ? C.lavender : C.white, t.name),
      ...(t.note ? [span(C.gray, ' ' + t.note)] : []),
      check,
    ]);
  }
  // The diff preview is drawn in this terminal's palette, so a row actually
  // shows what it will look like rather than describing it.
  for (const l of renderDiffPreview(cols, ctx)) lines.push(l);
  lines.push([span(C.gray, ' Syntax theme: Monokai Extended (ctrl+t to disable)')]);
  while (lines.length < rows - 1) lines.push([span('', '')]);
  return lines;
}

/**
 * The theme picker. Resolves the chosen row index. Esc commits the highlighted
 * row rather than discarding it, matching the reference — there is no "cancel"
 * that leaves the theme unset on a first run.
 */
async function showThemePicker(ctx, title = `Welcome to ${PRODUCT}`) {
  const { cols, rows } = getSize();
  let sel = typeof ctx.themeIndex === 'number' ? ctx.themeIndex : 1;
  const renderScreen = () => paint(themePickerLines(ctx, cols, rows, sel));
  renderScreen();
  for (;;) {
    const key = await nextKey();
    if (key.name === KEY.UP) {
      sel = Math.max(0, sel - 1);
      renderScreen();
    } else if (key.name === KEY.DOWN) {
      sel = Math.min(THEME_TABLE.length - 1, sel + 1);
      renderScreen();
    } else if (key.name === KEY.ENTER || key.name === KEY.ESC || key.name === KEY.CTRL_C || key.name === KEY.CTRL_D) {
      return applyTheme(ctx, sel);
    } else if (key.name === KEY.CTRL_T) {
      ctx.light = !ctx.light;
      renderScreen();
    } else if (key.name === 'char') {
      const n = parseInt(key.ch, 10);
      if (n >= 1 && n <= THEME_TABLE.length) {
        sel = n - 1;
        renderScreen();
      }
    }
  }
}

// ── welcome ──────────────────────────────────────────────────────────────────

/**
 * The welcome screen's lines: gold rule, the two-tone mark, the coral title,
 * the two boxes, the footer hint. Pure, so a test can assert all of it.
 *
 * The mark reuses `render.artRow`, the same renderer the scrollback banner
 * uses, so the mascot cannot render two different ways in two places.
 */
function welcomeLines(ctx, cols, rows, firstRun = true) {
  const t = themeOf(ctx);
  const lines = [];
  lines.push([span(t.gold, '━' + '─'.repeat(Math.max(0, cols - 2)) + '━')]);
  lines.push([span('', '')]);

  const parts = welcomeArtParts(cols);
  if (cols >= parts.width + 2) {
    const leftPad = Math.max(0, Math.floor((cols - parts.width) / 2));
    for (const row of parts.rows) {
      lines.push(wrapPlain(render.artRow(ctx, row, parts, leftPad)));
    }
  } else {
    lines.push(centered(`${PRODUCT}`, cols, t.gold + BOLD));
  }
  lines.push([span('', '')]);

  const title = firstRun ? `Welcome to ${PRODUCT}` : 'Welcome back!';
  lines.push(centered(title, cols, t.coral + BOLD));
  // Shorten the subtitle rather than clipping it: a truncated tagline reads as
  // a rendering fault, a shorter one just reads as a shorter one.
  const tagline =
    cols >= 40
      ? 'Cloud brain in your shell — one account, three hosts.'
      : 'Cloud brain in your shell.';
  lines.push(centered(tagline, cols, t.gray));
  lines.push([span('', '')]);

  lines.push(...boxes(t, cols, rows - lines.length - 4));
  lines.push([span('', '')]);
  lines.push([span(t.gray, GLYPH.hint), span(t.white, ' Try "write a test for <filepath>"')]);
  while (lines.length < rows - 1) lines.push([span('', '')]);
  return lines;
}

/**
 * One box: a `╭─ Header ────╮` top rule, the body rows, a bottom rule. The
 * reference draws only the side rails, which reads as a table next to the
 * identity panel's rules; the rounds match the CLI's overlay frames.
 */
function boxLines(t, header, rows, boxW) {
  const inner = Math.max(1, boxW - 4);
  // The top rule must be exactly `boxW` cells, like the body rows and the
  // bottom rule: `╭` + `─` + head + dashes + `╮`. Deriving the pad from
  // `inner + 2 - head.length` made the rule one cell too wide, so a full-width
  // pair of boxes overran the terminal by two columns and wrapped, shearing the
  // frame. The header is clipped rather than allowed to push the box open.
  const head = ` ${clip(header, Math.max(0, boxW - 4))} `;
  const top = [
    span(t.gray, '╭─'),
    span(t.gray + BOLD, head),
    span(t.gray, '─'.repeat(Math.max(0, boxW - 3 - head.length)) + '╮'),
  ];
  const out = [top];
  for (const r of rows) {
    const text = clip(String(r), inner);
    out.push([span(t.gray, '│ '), span(t.white, text + ' '.repeat(Math.max(0, inner - w(text)))), span(t.gray, ' │')]);
  }
  out.push([span(t.gray, '╰' + '─'.repeat(inner + 2) + '╯')]);
  return out;
}

/** The Tips + What's new boxes, side by side (stacked when too narrow). */
function boxes(t, cols, avail) {
  const gap = 2;
  const twoUp = Math.floor((cols - gap) / 2);
  const tipRows = TIPS.map((s) => `${GLYPH.pointer}${s}`);
  const newsRows = WHATS_NEW;
  if (twoUp >= 30) {
    let a = boxLines(t, 'Tips for getting started', tipRows, twoUp);
    let b = boxLines(t, "What's new", newsRows, twoUp);
    // Equalise the heights so both bottom rules land on the same row — boxes of
    // different heights leave a ragged pair of corners otherwise.
    const h = Math.max(a.length, b.length);
    const padBox = (box) => {
      if (box.length >= h) return box;
      const out = box.slice(0, box.length - 1);
      const blank = [span(t.gray, '│ '), span('', ' '.repeat(Math.max(0, twoUp - 4))), span(t.gray, ' │')];
      while (out.length < h - 1) out.push(blank);
      out.push(box[box.length - 1]);
      return out;
    };
    a = padBox(a);
    b = padBox(b);
    const out = [];
    for (let i = 0; i < h; i++) {
      out.push([...a[i], span('', ' '.repeat(gap)), ...b[i]]);
    }
    return out;
  }
  // Narrow: stack, so neither box is rendered at an unreadable width.
  const wd = Math.max(20, cols - 1);
  return [...boxLines(t, 'Tips for getting started', tipRows, wd), ...boxLines(t, "What's new", newsRows, wd)];
}

/**
 * Split a plain ANSI string back into the span model `paint` expects. Only the
 * SGR prefixes `render.artRow` emits are recognised, and every non-SGR run is
 * taken verbatim, so an unknown escape degrades to visible text rather than
 * being silently dropped.
 */
function wrapPlain(s) {
  const out = [];
  const re = /\x1b\[[0-9;]*m/g;
  let last = 0;
  let style = '';
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(make(style, s.slice(last, m.index)));
    style = m[0];
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(make(style, s.slice(last)));
  return out;
}

function make(style, text) {
  const sp = span(style, text);
  if (style) {
    sp.s = style;
    sp.w = w(text);
  }
  return sp;
}

/**
 * The welcome screen. Enter or Esc continues into the session; ctrl+c/d is the
 * user asking to leave, which is returned to the caller as `{ exit: true }`
 * rather than calling `process.exit` from here.
 */
async function showWelcome(ctx, firstRun = true) {
  const renderScreen = () => {
    const { cols, rows } = getSize();
    paint(welcomeLines(ctx, cols, rows, firstRun));
  };
  renderScreen();
  for (;;) {
    const key = await nextKey();
    if (key.name === KEY.ENTER || key.name === KEY.ESC) return { exit: false };
    if (key.name === KEY.CTRL_C || key.name === KEY.CTRL_D) return { exit: true };
  }
}

// ── the sequence ─────────────────────────────────────────────────────────────

/**
 * Run the pre-session onboarding, exactly as the reference orders it.
 *
 * @param {object} ctx    the shared command context (in: themeIndex, light)
 * @param {object} [o]
 * @param {boolean} [o.continue]  skip onboarding (the reference's --continue)
 * @param {() => boolean} [o.seen] an explicit "has run before" probe; defaults
 *                                 to the config file's existence
 * @param {(patch:object)=>void} [o.save] persist patch; defaults to updateConfig
 * @returns {Promise<{ok:boolean, firstRun:boolean, themeIndex:number}>} `ok`
 *          is false when the user declined the trust check or asked to exit.
 */
async function runOnboarding(ctx, o = {}) {
  const seen = o.seen || configExists;
  const save = o.save || updateConfig;
  // Injectable so the *sequence* — which screens run, in what order, and what is
  // persisted — can be asserted without a terminal. The screens themselves are
  // tested directly through their pure line-builders.
  const ui = o.ui || { showTrustCheck, showThemePicker, showWelcome };
  if (o.continue) return { ok: true, firstRun: false, themeIndex: ctx.themeIndex };

  // Onboarding runs *before* the session loop, and the session loop is what
  // normally attaches the key pump — so without this the first screen paints and
  // then blocks forever on a key queue nothing feeds. Only attach if nobody
  // else has (the chatflow re-attaches for the session), and only ever detach
  // what we attached.
  const owns = !events.isKeyStreamAttached() && !!(process.stdin && process.stdin.isTTY);
  if (owns) events.attachKeyStream(process.stdin);
  try {
    return await runScreens();
  } finally {
    if (owns) events.detachKeyStream();
  }

  async function runScreens() {
    if (!seen()) {
      // Genuine first run: trust check, then the theme picker, then persist so
      // neither is ever shown again. Re-running this every launch greeted
      // returning users with "Let's get started." and discarded their session.
      const trusted = await ui.showTrustCheck(ctx);
      if (!trusted) return { ok: false, firstRun: true, themeIndex: ctx.themeIndex };
      await ui.showThemePicker(ctx);
      save({ themeIndex: ctx.themeIndex, light: ctx.light });
      const welcome = await ui.showWelcome(ctx, true);
      if (welcome && welcome.exit) return { ok: false, firstRun: true, themeIndex: ctx.themeIndex };
      return { ok: true, firstRun: true, themeIndex: ctx.themeIndex };
    }

    const welcome = await ui.showWelcome(ctx, false);
    if (welcome && welcome.exit) return { ok: false, firstRun: false, themeIndex: ctx.themeIndex };
    return { ok: true, firstRun: false, themeIndex: ctx.themeIndex };
  }
}

module.exports = {
  PRODUCT,
  TIPS,
  WHATS_NEW,
  trustLines,
  themePickerLines,
  applyTheme,
  welcomeLines,
  boxes,
  boxLines,
  centered,
  wrapped,
  wrapPlain,
  showTrustCheck,
  showThemePicker,
  showWelcome,
  runOnboarding,
};
