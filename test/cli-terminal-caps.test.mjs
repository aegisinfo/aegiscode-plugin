/**
 * Terminal-capability tests — the matrix that replaces `process.platform`.
 *
 * Referenced by `cli/src/art.js` ("test/cli-terminal-caps.test.mjs pins all of
 * it"), so this file is the guard on the whole capability layer: `caps.js` is
 * the single probe, `art.js` and `theme.js` are the single consumers, and the
 * headline property below — PowerShell in Windows Terminal and zsh render the
 * SAME welcome screen — is asserted by rendering both and comparing bytes.
 *
 * The bugs this exists to prevent, all of which shipped at some point:
 *
 *   1. `process.platform` deciding the art. PowerShell inside Windows Terminal
 *      draws █▓▒░▐▛▜▌▝▘ and ✦ exactly as zsh does, but `win32` handed it the
 *      hyphen-and-hash ASCII mark.
 *   2. A second copy of the stencil table. `theme.js` carried its own
 *      `✦ → *` rule while `art.js` carried the pass, so a stencil edit could
 *      leave the star wide on macOS or the whale untinted on Windows.
 *   3. A *cached frame*. `caps()` memoised `stdout.columns`, so a resized
 *      terminal — and any test that installs a fake size after the modules load
 *      — was pinned to the width reported at module-evaluation time.
 *
 * Everything runs in-process: no subprocess, no TTY, no real terminal. The
 * probe is a pure function of `(env, stdout, platform)`, which is the reason
 * this matrix is testable at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, '..', 'cli');
const require = createRequire(import.meta.url);

const caps = require(join(cliDir, 'src', 'caps.js'));
const art = require(join(cliDir, 'src', 'art.js'));
const theme = require(join(cliDir, 'src', 'theme.js'));
const render = require(join(cliDir, 'src', 'render.js'));
const screen = require(join(cliDir, 'src', 'screen.js'));

const { detect, cells, describe: describeCaps, setCaps, resetCaps } = caps;

// ── the platforms this file exists to compare ────────────────────────────────

/** A TTY of a given size, as `detect()` expects to see it. */
const tty = (cols = 100, rows = 30) => ({ isTTY: true, columns: cols, rows });
const pipe = (cols = 100, rows = 30) => ({ isTTY: false, columns: cols, rows });

/**
 * Windows Terminal hosting PowerShell. `WT_SESSION` is what Windows Terminal
 * sets for every shell it hosts; `COLORTERM` is there because ConPTY hosts set
 * it. Nothing about this environment is "ASCII".
 */
const PWSH_ENV = {
  WT_SESSION: '8a1f9c3e-0000-0000-0000-000000000000',
  WT_PROFILE_ID: '{574e775e-4f2a-5b96-ac1e-a2962a402336}',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
};

/** zsh in a modern Linux/macOS terminal — the behaviour to match. */
const ZSH_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' };

/** The classic Windows console: no ConPTY marker, only 16 colours. */
const LEGACY_ENV = { TERM_PROGRAM: '', TERM: '' };

const pwsh = (env = PWSH_ENV, out = tty()) => detect(env, out, 'win32');
const zsh = (env = ZSH_ENV, out = tty()) => detect(env, out, 'linux');

/** Plain text of a rendered banner (the renderers return strings). */
const frameText = (lines) => lines.map((l) => (Array.isArray(l) ? l.map((sp) => sp.t).join('') : String(l)));
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Render the welcome banner as a given capability class. */
function bannerFor(c) {
  setCaps(c);
  const lines = render.renderBanner({}, { width: c.cols, version: '9.9.9' });
  return frameText(lines).map(stripAnsi);
}

// ── 1. the headline property ────────────────────────────────────────────────

test('PowerShell in Windows Terminal resolves to the same capability class as zsh', () => {
  const p = pwsh();
  const z = zsh();
  assert.equal(p.glyphs, z.glyphs, 'mark palette');
  assert.equal(p.face, z.face, 'face edges');
  assert.equal(p.star, z.star, 'star');
  assert.equal(p.depth, z.depth, 'colour depth');
  assert.equal(p.vt, z.vt, 'control sequences');
  assert.equal(p.eol, z.eol, 'line ending on a TTY');
  assert.equal(p.cols, z.cols, 'columns');
  assert.equal(p.rows, z.rows, 'rows');
  // The *reason* differs — that is how a support paste tells the two apart —
  // but no reason may be a downgrade.
  assert.match(p.reasons.glyphs, /Windows VT host/);
  assert.equal(p.glyphs, 'unicode');
});

test('the welcome screen is byte-identical on PowerShell-in-Windows-Terminal and zsh', () => {
  const p = bannerFor(pwsh());
  const z = bannerFor(zsh());
  assert.equal(p.length, z.length, 'the two frames must have the same row count');
  assert.deepEqual(p, z, 'the PowerShell welcome screen must be the zsh welcome screen');
  // …and it is the real mark, not a fallback that happens to match.
  assert.ok(p.join('\n').includes('▐▛███▜▌'), 'the mascot face must be the native block palette');
  assert.ok(p.join('\n').includes('✦'), 'the star must be native, not stencilled to *');
  assert.ok(p.join('\n').includes('━'), 'the banner rule must be the heavy box rune');
  assert.ok(!p.join('\n').includes('#'), 'no cell of the ASCII pass may survive on a VT host');
});

test('every glyph the UI draws is identical on PowerShell-in-Windows-Terminal and zsh', () => {
  assert.deepEqual(
    theme.glyphsFor(pwsh()),
    theme.glyphsFor(zsh()),
    'the glyph table must not be platform-keyed: PowerShell must get ❯/⎿/✻ like zsh'
  );
  const g = theme.glyphsFor(pwsh());
  assert.equal(g.cursor, '❯');
  assert.equal(g.hook, '⎿');
  assert.equal(g.ruleHeavy, '━');
  assert.equal(g.err, '✗');
  assert.equal(g.warn, '⚠');
  assert.deepEqual(g.spin, ['✢', '·', '✻', '*', '✽', '✶']);
});

test('the same environment over a pipe yields the same classes (only the line ending differs)', () => {
  const p = pwsh(PWSH_ENV, pipe());
  const z = zsh(ZSH_ENV, pipe());
  assert.equal(p.glyphs, z.glyphs);
  assert.equal(p.depth, z.depth);
  assert.equal(p.vt, z.vt);
  // A redirected run on Windows writes CRLF — correct for a Windows text file,
  // and the one intentional divergence. It never reaches a TTY, so it cannot
  // affect the welcome screen.
  assert.equal(p.eol, '\r\n');
  assert.equal(z.eol, '\n');
  assert.equal(pwsh().eol, '\n', 'a Windows TTY must not get CRLF');
});

// ── 2. the terminals that genuinely cannot draw the mark ────────────────────

test('a legacy Windows console gets the full ASCII pass', () => {
  const c = pwsh(LEGACY_ENV);
  assert.equal(c.glyphs, 'ascii');
  assert.equal(c.face, 'edges');
  assert.equal(c.star, 'narrow');
  assert.equal(c.depth, 4, 'a classic console has 16 colours');
  const g = theme.glyphsFor(c);
  assert.equal(g.cursor, '>');
  assert.equal(g.err, 'x');
  assert.equal(g.warn, '!');
  assert.equal(g.hook, '_|');
  assert.deepEqual(g.spin, ['|', '/', '-', '\\', '*', '-']);
  // The frame is still a frame — the mark is stencilled, not dropped.
  const frame = bannerFor(c).join('\n');
  assert.ok(frame.includes('#'), 'the block palette must be stencilled');
  assert.ok(!frame.includes('█'), 'no block rune may reach a console that lacks them');
  assert.ok(!frame.includes('▐'), 'no face-edge rune may survive the ASCII pass');
  assert.ok(!frame.includes('✦'), 'no star rune may survive the ASCII pass');
});

test('TERM=dumb and a non-UTF-8 locale both fall back to ASCII', () => {
  assert.equal(zsh({ ...ZSH_ENV, TERM: 'dumb' }).glyphs, 'ascii');
  assert.equal(pwsh({ ...PWSH_ENV, TERM: 'dumb' }).glyphs, 'ascii', 'TERM=dumb outranks the VT marker');
  const c = zsh({ TERM: 'xterm-256color', LANG: 'C' });
  assert.equal(c.glyphs, 'ascii');
  assert.match(c.reasons.glyphs, /not UTF-8/);
  // An unset locale is the shipped default and must stay Unicode.
  assert.equal(zsh({ TERM: 'xterm-256color' }).glyphs, 'unicode');
});

test('Apple Terminal keeps its edge pass, and only its edge pass', () => {
  const c = detect({ TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Apple_Terminal' }, tty(), 'darwin');
  assert.equal(c.glyphs, 'unicode');
  assert.equal(c.face, 'edges', 'Apple fonts lack ▐▛▜▌▝▘');
  assert.equal(c.star, 'narrow', 'Apple renders ✦ through the wide emoji fallback');
  const frame = bannerFor(c).join('\n');
  assert.ok(!frame.includes('▐'), 'the face edges must be stencilled');
  assert.ok(frame.includes('█'), 'the block palette is native on Apple and must not be stencilled');
  assert.ok(!frame.includes('✦'), 'the star must be stencilled on Apple');
});

// ── 3. the stencil table itself ─────────────────────────────────────────────

test('the passes compose instead of being picked one-of-three', () => {
  // Nothing to do on a fully native terminal.
  assert.equal(art.stencilFor(zsh()), null, 'a native terminal needs no pass');
  assert.equal(art.stencilGlyph('✦', zsh()), '✦');
  assert.equal(art.stencilGlyph('█', zsh()), '█');

  // A Windows VT host needs no pass either (regression: it used to get `star`).
  assert.equal(art.stencilFor(pwsh()), null);
  assert.equal(art.stencilGlyph('✦', pwsh()), '✦', 'the star must be native on a VT host');

  // The ASCII pass subsumes every other pass — a terminal with no block glyphs
  // has no quartile edges and no ✦ either.
  const a = art.stencilFor(pwsh(LEGACY_ENV));
  for (const rune of ['█', '▓', '▒', '░', ...art.EDGE_RUNES, '✦']) {
    assert.ok(a.has(rune), `the ASCII pass must cover ${rune}`);
  }

  // `AEGIS_STAR=narrow` is the escape hatch for a font with a bad fallback.
  const narrow = pwsh({ ...PWSH_ENV, AEGIS_STAR: 'narrow' });
  assert.equal(narrow.glyphs, 'unicode', 'AEGIS_STAR must not downgrade the palette');
  assert.equal(art.stencilGlyph('✦', narrow), '*');
  assert.equal(art.stencilGlyph('█', narrow), '█', 'AEGIS_STAR must not touch the block palette');
});

test('every pass is width-preserving: each rune swaps 1:1', () => {
  for (const name of art.PASSES) {
    const target = {
      native: zsh(),
      star: pwsh({ ...PWSH_ENV, AEGIS_STAR: 'narrow' }),
      edges: detect({ TERM_PROGRAM: 'Apple_Terminal' }, tty(), 'darwin'),
      ascii: {
        glyphs: 'ascii',
        face: 'edges',
        star: 'narrow',
      },
    }[name];
    for (const block of [art.WELCOME_ART, art.WELCOME_ART_STACKED, art.FACE, art.MOON, art.WHALE, art.MOON_WHALE]) {
      const ported = art.portabilityFor(block, target);
      assert.equal(ported.length, block.length, `${name}: row count`);
      ported.forEach((row, i) => {
        assert.equal(cells(row), cells(block[i]), `${name}: row ${i} width must not move`);
        assert.equal(
          [...row].length,
          [...block[i]].length,
          `${name}: row ${i} codepoint count must not move (the passes are 1:1, not a re-render)`
        );
      });
    }
  }
});

test('the width invariant holds for the composed mark, not just the raw blocks', () => {
  for (const c of [pwsh(), zsh(), pwsh(LEGACY_ENV), detect({ TERM_PROGRAM: 'Apple_Terminal' }, tty(), 'darwin')]) {
    const parts = art.welcomeArtParts(c.cols);
    setCaps(c);
    const rows = art.portabilityFor(parts.rows, c);
    const widths = new Set(rows.map(cells));
    assert.equal(widths.size, 1, `every row of the mark must be one width, got ${[...widths].join(',')}`);
  }
});

// ── 4. colour ───────────────────────────────────────────────────────────────

test('colour depth is decided by the terminal, and NO_COLOR beats everything', () => {
  assert.equal(zsh().depth, 24);
  assert.equal(pwsh().depth, 24, 'a VT host gets truecolor');
  assert.equal(detect({ ...ZSH_ENV, NO_COLOR: '1' }, tty(), 'linux').depth, 0);
  // The standard is explicit that an EMPTY value does not count: "when present
  // and not an empty string (regardless of its value)" — no-color.org. Tools
  // that test mere presence (`'NO_COLOR' in env`) break `NO_COLOR= aegiscode`
  // and any launcher that exports the name with no value, so the empty case is
  // pinned here rather than left to taste.
  assert.equal(detect({ ...ZSH_ENV, NO_COLOR: '' }, tty(), 'linux').depth, 24, 'an empty NO_COLOR does not count');
  assert.equal(detect({ ...PWSH_ENV, NO_COLOR: '0' }, tty(), 'win32').depth, 0, 'any non-empty NO_COLOR value counts');
  assert.equal(detect({ ...ZSH_ENV, FORCE_COLOR: '2' }, tty(), 'linux').depth, 8);
  assert.equal(detect({ ...ZSH_ENV, AEGIS_COLOR: '1' }, tty(), 'linux').depth, 4);
  assert.equal(detect({ TERM: 'linux' }, tty(), 'linux').depth, 4, 'a Linux framebuffer console has 16 colours');
  assert.equal(detect({ TERM: 'vt100' }, tty(), 'linux').depth, 4);
});

test('a zero-depth terminal emits no escape text instead of literal SGR', () => {
  setCaps(detect({ ...ZSH_ENV, NO_COLOR: '1' }, tty(), 'linux'));
  assert.equal(caps.rgb(255, 0, 128), '', 'no colour must emit no escape at all');
  assert.equal(caps.bg(255, 0, 128), '');
  const frame = bannerFor(detect({ ...ZSH_ENV, NO_COLOR: '1' }, tty(), 'linux')).join('\n');
  assert.ok(!frame.includes('\x1b'), 'a NO_COLOR frame must carry no escape sequences');

  // 16-colour: the 24-bit triple must be downgraded to an ANSI slot, never
  // emitted raw (which prints escape text on a console that cannot read it).
  setCaps(detect({ TERM: 'linux' }, tty(), 'linux'));
  assert.match(caps.rgb(255, 0, 128), /^\x1b\[3[0-7]m$/, 'the 16-colour path must use an ANSI slot');
  assert.match(caps.bg(255, 0, 128), /^\x1b\[4[0-7]m$/);

  setCaps(detect({ ...ZSH_ENV, COLORTERM: 'truecolor' }, tty(), 'linux'));
  assert.match(caps.rgb(255, 0, 128), /^\x1b\[38;2;255;0;128m$/, 'truecolor must be exact');
});

test('the palette is identical on PowerShell-in-Windows-Terminal and zsh at truecolor', () => {
  setCaps(pwsh());
  const p = { ...theme.THEME };
  setCaps(zsh());
  const z = { ...theme.THEME };
  assert.deepEqual(Object.keys(p).sort(), Object.keys(z).sort(), 'the 11 roles must be the same set');
  for (const role of Object.keys(z)) {
    assert.equal(String(p[role]), String(z[role]), `role ${role} must be identical`);
  }
});

// ── 5. the frame is live, the axes are cached ───────────────────────────────

test('the size is read live; a resize after load is not frozen (regression)', () => {
  const colsD = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rowsD = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  try {
    resetCaps();
    Object.defineProperty(process.stdout, 'columns', { value: 133, configurable: true, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 44, configurable: true, writable: true });

    assert.equal(caps.caps().cols, 133, 'the first probe must see the fake size');
    assert.equal(screen.getSize().cols, 133, 'screen.getSize() must route through caps');

    // The bug: the size was memoised at module load, so a later change — a
    // SIGWINCH, or a test installing its fake TTY — was ignored forever.
    Object.defineProperty(process.stdout, 'columns', { value: 72, configurable: true, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 20, configurable: true, writable: true });
    assert.equal(caps.caps().cols, 72, 'a resize must be visible to the next frame');
    assert.equal(screen.getSize().rows, 20);
    assert.equal(screen.termWidth(), 72);
  } finally {
    resetCaps();
    if (colsD) Object.defineProperty(process.stdout, 'columns', colsD);
    if (rowsD) Object.defineProperty(process.stdout, 'rows', rowsD);
  }
});

test('AEGIS_WIDTH pins the frame above the reported size, and --width is that pin', () => {
  const colsD = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  try {
    resetCaps();
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true, writable: true });
    setCaps(null, { AEGIS_WIDTH: '66' });
    assert.equal(caps.caps().cols, 66, 'AEGIS_WIDTH outranks the reported width');
    assert.equal(caps.caps().reasons.size, 'AEGIS_WIDTH');
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true, writable: true });
    assert.equal(caps.caps().cols, 66, 'a pinned width must survive a resize');
  } finally {
    resetCaps();
    if (colsD) Object.defineProperty(process.stdout, 'columns', colsD);
  }
});

test('the reported size outranks COLUMNS, which bash stops updating on SIGWINCH', () => {
  assert.equal(detect({ COLUMNS: '200' }, tty(90), 'linux').cols, 90, 'the stream wins over a stale COLUMNS');
  assert.equal(detect({ COLUMNS: '200' }, pipe(0), 'linux').cols, 200, 'COLUMNS is the fallback when nothing is reported');
  const d = detect({}, { isTTY: false }, 'linux');
  assert.equal(d.cols, 80, 'a redirected run gets a stable 80 so PowerShell matches zsh');
  assert.equal(d.rows, 24);
});

test('the derived axes are still cached — the per-codepoint path stays cheap', () => {
  // `cells()` measures every row of every frame through `cellWidth()`. If that
  // path re-probed the environment per codepoint the CLI would crawl, so the
  // size became live without dragging `resolveSize` onto the hot path.
  resetCaps();
  const src = require('node:fs').readFileSync(join(cliDir, 'src', 'caps.js'), 'utf8');
  const body = src.slice(src.indexOf('function cellWidth'), src.indexOf('function cells'));
  // Comments are stripped before the grep: the doc comment on `cellWidth`
  // explains which accessor it must NOT use, so a raw `includes('caps()')` would
  // fail on the explanation rather than on the code. (It did.)
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(code.includes('axes()'), 'cellWidth must read the cached axes');
  assert.ok(!code.includes('caps()'), 'cellWidth must not resolve the frame');
  // Behavioural check: a size change does not disturb the width table.
  assert.equal(cells('ab'), 2);
  assert.equal(cells('日本語'), 6);
  setCaps({ ...zsh(), cols: 40 });
  assert.equal(cells('日本語'), 6);
});

test('AEGIS_WIDE_RUNES moves every width decision at once', () => {
  resetCaps();
  assert.equal(cells('✦'), 1, '✦ is single-width by default');
  assert.equal(screen.w('✦'), 1, 'screen.w and caps.cells must agree');
  setCaps(detect({ ...ZSH_ENV, AEGIS_WIDE_RUNES: '✦' }, tty(), 'linux'));
  assert.equal(cells('✦'), 2, 'the override must reach caps.cells');
  assert.equal(screen.w('✦'), 2, 'the override must reach the transcript');
  resetCaps();
});

// ── 6. the support surface ──────────────────────────────────────────────────

test('describe() has one shape on every platform, so a support paste reads the same', () => {
  const keys = describeCaps(zsh()).map(([k]) => k);
  for (const c of [pwsh(), pwsh(LEGACY_ENV), detect({ TERM_PROGRAM: 'Apple_Terminal' }, tty(), 'darwin'), detect({ TERM: 'dumb' }, pipe(), 'win32')]) {
    assert.deepEqual(describeCaps(c).map(([k]) => k), keys, 'the row labels must not vary by platform');
    for (const [, v] of describeCaps(c)) assert.equal(typeof v, 'string');
  }
  const rows = Object.fromEntries(describeCaps(pwsh()));
  assert.equal(rows.mark, 'unicode');
  assert.equal(rows.star, 'native');
  assert.equal(rows.color, 'truecolor');
  assert.equal(rows.control, 'ansi');
  assert.equal(rows.size, '100x30 (stdout.columns)');
  const legacy = Object.fromEntries(describeCaps(pwsh(LEGACY_ENV)));
  assert.equal(legacy.mark, 'ascii');
  assert.equal(legacy.color, '16');
});

// ── 7. the flags and the marker env vars are the same switch ────────────────

test('AEGIS_ART is the valued switch and outranks its boolean aliases', () => {
  const base = { WT_SESSION: 'x', TERM: 'xterm-256color' };
  assert.equal(detect({ ...base, AEGIS_ART: 'ascii' }, tty(), 'win32').glyphs, 'ascii');
  assert.equal(detect({ ...base, AEGIS_ASCII: '1' }, tty(), 'win32').glyphs, 'ascii');
  assert.equal(detect({ ...base, AEGIS_UNICODE: '0' }, tty(), 'win32').glyphs, 'ascii');
  // Precedence, documented in caps.js: AEGIS_ART takes a value, so it outranks
  // the boolean aliases it supersedes. The reverse would make
  // `AEGIS_ART=ascii aegiscode` unreachable for anyone whose profile exports
  // AEGIS_UNICODE=1.
  assert.equal(detect({ ...base, AEGIS_ART: 'ascii', AEGIS_UNICODE: '1' }, tty(), 'win32').glyphs, 'ascii');
  assert.equal(detect({ ...base, AEGIS_ART: 'unicode', AEGIS_ASCII: '1' }, tty(), 'win32').glyphs, 'unicode');
  // Among the aliases themselves the SAFE direction wins: any signal that says
  // "this terminal cannot do Unicode" is honoured, because the failure mode of
  // guessing unicode on a console that lacks the glyphs is worse than the
  // failure mode of drawing ASCII.
  assert.equal(detect({ ...base, AEGIS_ASCII: '1', AEGIS_UNICODE: '1' }, tty(), 'win32').glyphs, 'ascii');
  // An explicit request beats even a terminal that proves it cannot comply.
  assert.equal(detect({ ...base, TERM: 'dumb', AEGIS_ART: 'unicode' }, tty(), 'win32').glyphs, 'unicode');
  assert.equal(detect({ LANG: 'C', AEGIS_UNICODE: '1' }, tty(), 'linux').glyphs, 'unicode');
  // …and --ascii / --unicode from the entry point are the same thing, which is
  // asserted end-to-end in cli-package/cli-run rather than by re-reading bin/.
});

test('the ASCII mark stays inside the terminal at every width', () => {
  const c = pwsh(LEGACY_ENV);
  setCaps(c);
  for (const cols of [40, 60, 80, 100, 160]) {
    for (const line of bannerFor({ ...c, cols })) {
      assert.ok(
        cells(line) <= cols,
        `a ${cols}-column ASCII frame must not overflow: got ${cells(line)} in ${JSON.stringify(line.slice(0, 40))}`
      );
    }
  }
});
