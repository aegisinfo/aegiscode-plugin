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
const { TAGLINE, TAGLINE_SHORT, welcomeArtParts } = require('./art.js');
const { renderDiffPreview } = require('./markdown.js');
const render = require('./render.js');
const { updateConfig, configExists, loadConfig } = require('./config.js');
const { updateNotice, updateLine } = require('./update.js');
const credentials = require('./credentials.js');

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

/**
 * The `What's new` box — newest release first, two rows per release, **eight
 * rows in total**. The row count is load-bearing, not cosmetic: at 80×24 the
 * welcome screen already fills exactly `rows - 1`, so a ninth row pushes the
 * footer hint off the bottom of the commonest terminal there is. Retire the
 * oldest entry rather than adding one.
 *
 * This block went four minor versions stale (it still topped out at v6.3.0
 * while the package shipped 6.7.3) because nothing held it to anything. Two
 * things do now: the box header names `VERSION`, so the screen always says
 * which build is running, and every `/command` named below is asserted to
 * exist in the registry by `test/cli-onboarding.test.mjs`. The prose stays
 * hand-written — a changelog is prose — but it can no longer advertise a
 * command that was renamed away, and it cannot claim to be news for a release
 * the user is not running.
 */
const WHATS_NEW = [
  ' v6.7.x: caps read from the tty,',
  '  edits render as diff blocks',
  ' v6.6.0: autonomous mode — a',
  '  persistent work queue',
  ' v6.5.0: live tool rows, /cost',
  '  from the ledger the pool set',
  ' v6.4.0: `aegiscode login`',
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
 * The welcome screen's lines: gold rule, the wordmark, the coral title,
 * the two boxes, the footer hint. Pure, so a test can assert all of it.
 *
 * The mark reuses `render.artRow`, the same renderer the scrollback banner
 * uses, so the mark cannot render two different ways in two places.
 */
function welcomeLines(ctx, cols, rows, firstRun = true) {
  const t = themeOf(ctx);
  const lines = [];
  lines.push([span(t.gold, '━' + '─'.repeat(Math.max(0, cols - 2)) + '━')]);
  lines.push([span('', '')]);

  // A newer release, if the last run found one. Reads cache only — the
  // refresh it may kick off lands for the NEXT launch, so drawing this box
  // never waits on the registry.
  let updateMsg = null;
  try {
    const cfg = loadConfig();
    const notice = updateNotice({
      current: VERSION,
      cache: cfg.updateCheck,
      save: (v) => { try { updateConfig({ updateCheck: v }); } catch { /* not fatal */ } },
    });
    updateMsg = updateLine({ current: VERSION, ...notice });
  } catch {
    // An update notice is never worth failing a launch over.
  }

  const parts = welcomeArtParts();
  if (cols >= parts.width + 2) {
    const leftPad = Math.max(0, Math.floor((cols - parts.width) / 2));
    for (const row of parts.rows) {
      lines.push(wrapPlain(render.artRow(ctx, row, parts, leftPad)));
    }
  } else {
    lines.push(centered(`${PRODUCT}`, cols, t.gold + BOLD));
  }
  if (updateMsg) {
    lines.push([span('', '')]);
    lines.push(centered(updateMsg, cols, t.gold));
  }
  lines.push([span('', '')]);

  const title = firstRun ? `Welcome to ${PRODUCT}` : 'Welcome back!';
  lines.push(centered(title, cols, t.coral + BOLD));
  // Shorten the subtitle rather than clipping it: a truncated tagline reads as
  // a rendering fault, a shorter one just reads as a shorter one. The threshold
  // is derived from the string's own width, not a fixed column count — the copy
  // lives in `art.js` now, so a hardcoded breakpoint here would silently start
  // clipping the moment the tagline grew by a word.
  const tagline = cols >= w(TAGLINE) + 4 ? TAGLINE : TAGLINE_SHORT;
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
  // Name the running build in the header. `WHATS_NEW` is hand-written prose and
  // will always lag the release it describes by however long it takes someone
  // to remember; the header cannot, so the box is never *silently* stale — a
  // user on a newer build reads "What's new in vX" over notes that end earlier
  // and can see the gap for what it is.
  const newsHead = `What's new in v${VERSION}`;
  if (twoUp >= 30) {
    let a = boxLines(t, 'Tips for getting started', tipRows, twoUp);
    let b = boxLines(t, newsHead, newsRows, twoUp);
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
  return [...boxLines(t, 'Tips for getting started', tipRows, wd), ...boxLines(t, newsHead, newsRows, wd)];
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

// ── the account key ──────────────────────────────────────────────────────────

const KEY_URL = 'https://aegiscloud.org';

/**
 * The key screen's lines. Pure, so what the user is told is asserted directly.
 *
 * `value` is echoed back as bullets: this is the one screen in the product
 * where the thing being typed is a secret, and a screen that echoes it would
 * put the key in a scrollback buffer, a screenshot and a screen share.
 */
function keyLines(ctx, cols, { value = '', error = null, verify = false } = {}) {
  const t = themeOf(ctx);
  const lines = [];
  lines.push([span(t.gold, '─'.repeat(Math.max(1, cols)))]);
  lines.push([span(t.white + BOLD, 'Connect your AEGIS account')]);
  lines.push([span('', '')]);
  for (const l of wrapped(
    `Paste an API key to use AEGIS Cloud. Get one free at ${KEY_URL}. ` +
      'It is stored in your user config directory with owner-only permissions, so later launches and scripts pick it up without an export.',
    cols,
    t.white
  )) {
    lines.push(l);
  }
  lines.push([span('', '')]);
  lines.push([
    span(t.lavender, GLYPH.cursor),
    span(t.gray, ' API key: '),
    span(t.white, '•'.repeat(String(value).length)),
    span(verify ? t.cyan : t.gray, verify ? '  verifying…' : ''),
  ]);
  if (error) lines.push([span(t.coral, `  ${error}`)]);
  lines.push([span('', '')]);
  lines.push([
    span(t.gray, `  ${GLYPH.check} `),
    span(t.gray, 'Enter to save'),
    span(t.gray, ' · '),
    span(t.gray, 'Esc to skip'),
  ]);
  return lines;
}

/**
 * Ask for the account key. Resolves `{key}` when submitted, `{skipped:true}`
 * when the user declines, `{exit:true}` on ctrl+c.
 *
 * `submit(key)` is the caller's verification+persistence step; its rejection
 * message is shown on the screen and the user stays on it, because the failure
 * mode this prevents is a key that is accepted into the config while the
 * account behind it rejects every call.
 */
async function requestApiKey(ctx, o = {}) {
  const submit = o.submit || (async () => ({ ok: true }));
  const { cols } = getSize();
  let value = '';
  let error = null;
  let verify = false;
  const paintScreen = () => paint(keyLines(ctx, cols, { value, error, verify }));
  paintScreen();

  for (;;) {
    const key = await nextKey();
    if (key.name === KEY.ENTER) {
      if (!value.trim()) return { skipped: true };
      verify = true;
      error = null;
      paintScreen();
      let res;
      try {
        res = await submit(value);
      } catch (e) {
        res = { ok: false, message: (e && e.message) || String(e) };
      }
      verify = false;
      if (res && res.ok === false) {
        error = res.message || 'that key was refused';
        paintScreen();
        continue;
      }
      return { key: value, result: res };
    }
    if (key.name === KEY.ESC) return { skipped: true };
    if (key.name === KEY.CTRL_C || key.name === KEY.CTRL_D) return { exit: true };
    if (key.name === KEY.BACKSPACE) {
      value = value.slice(0, -1);
      error = null;
      paintScreen();
      continue;
    }
    if (key.name === 'char') {
      const ch = key.ch;
      if (ch && ch >= ' ') {
        value += ch;
        error = null;
        paintScreen();
      }
      continue;
    }
    // A paste arrives as its own event (events.js rushes multi-char reads);
    // without this a pasted key is dropped on the floor.
    if (key.name === 'paste' && key.text) {
      value = (value + String(key.text)).replace(/\s+/g, '');
      error = null;
      paintScreen();
    }
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
 * @param {() => boolean} [o.needsKey] true when no account key is configured —
 *                                 the key screen is shown only then
 * @param {(key:string)=>Promise<object>} [o.submitKey] verify + persist a key
 * @returns {Promise<{ok:boolean, firstRun:boolean, themeIndex:number,
 *          key:{set:boolean, skipped:boolean}}>} `ok` is false when the user
 *          declined the trust check or asked to exit.
 */
async function runOnboarding(ctx, o = {}) {
  const seen = o.seen || configExists;
  const save = o.save || updateConfig;
  // Injectable so the *sequence* — which screens run, in what order, and what is
  // persisted — can be asserted without a terminal. The screens themselves are
  // tested directly through their pure line-builders.
  const ui = {
    showTrustCheck,
    showThemePicker,
    showWelcome,
    requestApiKey: (c, opts) =>
      requestApiKey(c, { submit: o.submitKey || (async () => ({ ok: true })), ...opts }),
    // An injected `ui` overrides the screens it names and inherits the rest, so
    // a caller testing the sequence does not have to supply a key screen it
    // never wants to exercise.
    ...(o.ui || {}),
  };
  // No key is the one state where the session cannot do anything at all, so it
  // is asked for in-band rather than left to a shell export the user has to
  // discover. Default reads the credential store so a caller that forgets to
  // pass it still gets the right behaviour.
  const needsKey = o.needsKey || (() => !credentials.hasApiKey());
  // …but only where a question can actually be asked. Without this a library
  // caller with no TTY reaches a screen that waits on a key queue nothing will
  // ever feed — a hang instead of a missing credential.
  const canPrompt = o.canPrompt || (() => !!(process.stdin && process.stdin.isTTY));
  // Declared out here because both the sequence and its key step report on it.
  const key = { set: false, skipped: false };
  if (o.continue) return { ok: true, firstRun: false, themeIndex: ctx.themeIndex, key: { set: false, skipped: false } };

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
      if (!trusted) return { ok: false, firstRun: true, themeIndex: ctx.themeIndex, key };
      await ui.showThemePicker(ctx);
      save({ themeIndex: ctx.themeIndex, light: ctx.light });
      if (await askKey()) return { ok: false, firstRun: true, themeIndex: ctx.themeIndex, key };
      const welcome = await ui.showWelcome(ctx, true);
      if (welcome && welcome.exit) return { ok: false, firstRun: true, themeIndex: ctx.themeIndex, key };
      return { ok: true, firstRun: true, themeIndex: ctx.themeIndex, key };
    }

    if (await askKey()) return { ok: false, firstRun: false, themeIndex: ctx.themeIndex, key };
    const welcome = await ui.showWelcome(ctx, false);
    if (welcome && welcome.exit) return { ok: false, firstRun: false, themeIndex: ctx.themeIndex, key };
    return { ok: true, firstRun: false, themeIndex: ctx.themeIndex, key };
  }

  /** @returns {Promise<boolean>} true when the user asked to exit. */
  async function askKey() {
    if (!needsKey() || !canPrompt()) return false;
    const res = await ui.requestApiKey(ctx);
    if (res && res.exit) return true;
    if (res && res.key) key.set = true;
    else key.skipped = true;
    return false;
  }
}

module.exports = {
  PRODUCT,
  TIPS,
  WHATS_NEW,
  trustLines,
  themePickerLines,
  keyLines,
  applyTheme,
  welcomeLines,
  boxes,
  boxLines,
  centered,
  wrapped,
  wrapPlain,
  showTrustCheck,
  showThemePicker,
  requestApiKey,
  showWelcome,
  runOnboarding,
  KEY_URL,
};
