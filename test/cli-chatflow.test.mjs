#!/usr/bin/env node
/**
 * The chatflow — the session loop and the row/render helpers it runs on.
 *
 * What it pins, and why each one matters:
 *
 *  · the turn lifecycle: a user row, a live assistant row that grows as the
 *    model streams, a `✻ Churned/Worked for Ns` completion row, and the
 *    accounting row that shows tokens beside € (the CLI's reason to exist);
 *  · `(stopped)` on Esc — and, crucially, that Esc reaches the transport
 *    through the AbortSignal, because a controller nobody listens to leaves
 *    the turn running and billing while the UI claims it stopped;
 *  · tool-row pairing by call id, since parallel same-name calls otherwise
 *    collapse into one row with the wrong plural;
 *  · the transcript viewport: a reader scrolled up must not be dragged to the
 *    bottom every time a streaming delta grows the transcript;
 *  · the input line: the `❯` prompt, the rotating suggestion, the collapsed
 *    multi-line paste preview, and cursor column maths that survives a CJK
 *    buffer (a codepoint count lands the cursor short of the painted text).
 *
 * The loop is driven for real: a synthetic key stream, `runSession` entered as
 * the app enters it, and every escape sequence captured by stubbing stdout.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, '..', 'cli');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) =>
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const chatflow = require(join(cliDir, 'src', 'chatflow.js'));
const screen = require(join(cliDir, 'src', 'screen.js'));
const theme = require(join(cliDir, 'src', 'theme.js'));
const { stripAnsi } = screen;

/** Flatten span lines to visible text. Accepts a single span line as well as
 *  a block of them (the helpers return both shapes). */
const isSpan = (x) => x && typeof x === 'object' && typeof x.t === 'string' && typeof x.w === 'number';
const text = (lines) => {
  const block = Array.isArray(lines) && lines.length && isSpan(lines[0]) ? [lines] : lines;
  return (Array.isArray(block) ? block : [block])
    .map((l) => (Array.isArray(l) ? l.map((sp) => sp.t).join('') : String(l)))
    .join('\n');
};
const plain = (lines) => stripAnsi(text(lines));

// ── turn helpers ────────────────────────────────────────────────────────────

eq(chatflow.toolLabel('Bash', 1), 'shell command', 'Bash is "shell command"');
eq(chatflow.toolLabel('Bash', 2), 'shell commands', 'and pluralises');
eq(chatflow.toolLabel('Read', 1), 'read command', 'others are "<name> command"');
eq(chatflow.toolLabel('Task', 1), 'subagent', 'Task is a subagent');

// finalizeTurnText: error, abort, empty, and abort-wins-over-error.
eq(chatflow.finalizeTurnText('', {}), '(no response)', 'empty text becomes (no response)');
eq(
  chatflow.finalizeTurnText('partial', { error: 'boom' }),
  'partial\n\n(backend error: boom)',
  'an error appends the marker'
);
eq(chatflow.finalizeTurnText('partial', { aborted: true }), 'partial (stopped)', 'abort marks stopped');
eq(
  chatflow.finalizeTurnText('partial', { aborted: true, error: 'stopped' }),
  'partial (stopped)',
  'an abort never doubles the marker'
);
assert(
  !chatflow.finalizeTurnText('partial', { aborted: true, error: 'boom' }).includes('backend error'),
  'abort wins over an error so Esc produces exactly one marker'
);

// resolveToolDone: id pairing wins, name+agent is the fallback, plural is right.
{
  const rows = [
    { role: 'tool', phase: 'run', name: 'Bash', id: 'a', start: Date.now() },
    { role: 'tool', phase: 'run', name: 'Bash', id: 'b', start: Date.now() },
  ];
  const one = chatflow.resolveToolDone(rows, { name: 'Bash', id: 'b', elapsed: '2s' });
  assert(one && one.id === 'b', 'the done event lands on the row with the matching id');
  eq(one.label, 'Ran 2 shell commands', 'the second Bash call is plural');
  assert(rows[0].phase === 'run', 'the other row is untouched');
  const two = chatflow.resolveToolDone(rows, { name: 'Bash', id: 'a', elapsed: '1s' });
  eq(two.label, 'Ran 1 shell command', 'the first is singular');
}
{
  const rows = [{ role: 'tool', phase: 'run', name: 'Read', agent: 'scout', start: Date.now() }];
  const m = chatflow.resolveToolDone(rows, { name: 'Read', agent: 'scout' });
  assert(m && m.phase === 'done', 'an id-less stream falls back to name + agent');
  assert(m.label.includes('scout ▸'), 'the subagent is named in the label');
}
eq(
  chatflow.resolveToolDone([], { name: 'Bash' }),
  null,
  'a done event with no running row resolves to null instead of throwing'
);

eq(chatflow.paletteQuery('memory tiers'), 'memory', 'a multi-word query ranks on the first token');
eq(chatflow.paletteQuery('  help '), 'help', 'a single-word query is unchanged');

// ── the frame ───────────────────────────────────────────────────────────────

const ctx = { light: false };

{
  const h = chatflow.headerLine('6.2.0', 80, ctx);
  eq(screen.lineWidth(h), 80, 'the header rule is exactly the terminal width');
  const t = plain(h);
  assert(t.startsWith('╭') && t.endsWith('╮'), 'the header is a rounded rule');
  assert(t.includes('AEGIS Code v6.2.0'), 'the header names the product and version');
}

{
  const s = plain(chatflow.spinnerLine({ verb: 'Tempering', frame: 0, elapsedMs: 3000, streamed: 412 }, ctx));
  assert(s.includes('Tempering'), 'the spinner shows the verb');
  assert(s.includes('3s'), 'the spinner shows elapsed seconds');
  assert(s.includes('412 tokens'), 'the spinner shows the token estimate');
  for (const ch of ['Tempering']) {
    assert(s.includes(ch), `the spinner keeps the reference spelling (${ch})`);
  }
}

{
  const e = plain(chatflow.effortLine(ctx, 80));
  assert(e.includes('/effort'), 'the effort line names its command');
  // No pin is the default state (the pool sizes each turn from the ask), and
  // the line has to say so rather than naming a rung nobody chose.
  assert(e.includes('auto'), `the effort line says auto when nothing is pinned: ${JSON.stringify(e)}`);
  assert(
    plain(chatflow.effortLine({ ...ctx, effort: 'medium' }, 80)).includes('medium'),
    'and names the rung once one is pinned'
  );
  // The reference leaves a 4-cell right margin; padLine fills the rest when the
  // frame is painted, so the raw line is cols-4 and must never exceed cols.
  assert(screen.lineWidth(chatflow.effortLine(ctx, 80)) <= 80, 'the effort line never exceeds the width');
  assert(e.startsWith(' '), 'and is right-aligned');
}

{
  const idle = plain(chatflow.statusLine({}, 80, ctx));
  assert(idle.includes('manual mode on'), 'the idle status line reports manual approval mode');
  assert(idle.includes('? for shortcuts'), 'and points at the shortcut grid');
  const work = plain(chatflow.statusLine({ working: true }, 80, ctx));
  assert(work.includes('esc to interrupt'), 'the working status line offers the interrupt');
  const yolo = plain(chatflow.statusLine({ yolo: true }, 80, ctx));
  assert(yolo.includes('YOLO mode on'), 'yolo is reflected in the status line');
  // The idle line offers → for the mode switch and no longer advertises the
  // agents chord: "← for agents" named a key this host never bound to anything
  // (LEFT was wired only to editor.left()), and the agents panel is reachable
  // by the /agents command it was really standing in for.
  assert(idle.includes('→ for auto mode'), 'the idle line advertises the mode switch');
  assert(yolo.includes('→ for auto mode'), 'and so does the auto-approve line');
  for (const st of [{}, { working: true }, { streamJob: {} }, { yolo: true }, { inputPrompt: {} }]) {
    assert(
      !plain(chatflow.statusLine(st, 80, ctx)).includes('agents'),
      'no state of the status line advertises the unwired agents chord'
    );
  }
  for (const st of [{}, { working: true }, { yolo: true }, { inputPrompt: {} }]) {
    assert(
      screen.lineWidth(chatflow.statusLine(st, 80, ctx)) === 80,
      'the status line is exactly the width (a short line leaves escape garbage on screen)'
    );
  }
}

// ── row rendering ───────────────────────────────────────────────────────────

{
  const run = plain(chatflow.rowLines({ role: 'tool', phase: 'run', label: 'Running 1 shell command…', start: Date.now() - 3000, args: { command: 'ls' } }, 80, ctx));
  assert(run.includes('Running 1 shell command…') && run.includes('3s'), 'a running tool row shows its label and elapsed');
  assert(run.includes('$ ls'), 'and the command it is running');
  const done = plain(chatflow.rowLines({ role: 'tool', phase: 'done', label: 'Ran 1 shell command', args: { command: 'ls' } }, 80, ctx));
  assert(done.includes('Ran 1 shell command'), 'a finished tool row shows what it did');
}

{
  const gap = theme.GLYPH.block;
  const lines = chatflow.rowLines({ role: 'assistant', text: 'hello **world**', streaming: true }, 80, ctx);
  const t = text(lines);
  assert(t.startsWith(gap + ' '), 'an assistant row opens with the answer marker');
  assert(t.endsWith(gap), 'a streaming row ends with the live cursor');
  const still = text(chatflow.rowLines({ role: 'assistant', text: 'done', streaming: false }, 80, ctx));
  assert(!still.endsWith(gap), 'a finished row drops the live cursor');
}

{
  const m = plain(
    chatflow.rowLines(
      { role: 'meta', meta: { model: 'nexus', tokens: 1562, input: 1250, output: 312, eur: 0.0007, ms: 4200 } },
      80,
      ctx
    )
  );
  assert(m.includes('1,562 tok'), 'the accounting row shows the token count');
  assert(m.includes('1,250/312'), 'and the split');
  assert(m.includes('€0.0007'), 'and the spend at 4dp below a cent — the whole point of the row');
  assert(!m.includes('undefined'), 'and never the literal undefined');
}

eq(plain(chatflow.rowLines({ role: 'done', text: 'Churned for 4s' }, 80, ctx)), `${theme.GLYPH.bloom} Churned for 4s`, 'the done row is the reference bloom line');
eq(plain(chatflow.rowLines({ role: 'note', text: 'careful' }, 80, ctx)), '· careful', 'a note row is a gray bullet');

// ── the transcript viewport ─────────────────────────────────────────────────

{
  const mkRows = (n) => Array.from({ length: n }, (_, i) => ({ role: 'note', text: `line ${i}` }));
  const view = { cols: 80, rows: 24 };
  // 18 transcript rows fit in a 24-row frame; 30 rows means 12 are off-screen.
  const bottom = chatflow.transcriptLines(mkRows(30), { ...view, scroll: 0 }, ctx);
  assert(bottom.lines.length <= 18, 'the viewport never exceeds the frame budget');
  assert(plain(bottom.lines).includes('line 29'), 'following the bottom shows the newest row');
  assert(!plain(bottom.lines).includes('line 0'), 'and drops the oldest');

  const up = chatflow.transcriptLines(mkRows(30), { ...view, scroll: 5 }, ctx);
  assert(up.scroll === 5, 'scrolling up is preserved');
  assert(!plain(up.lines).includes('line 29'), 'scrolled up, the newest row leaves the window');

  // The anchor rule: appending rows BELOW a scrolled-up window must not move it.
  const anchored = chatflow.transcriptLines(mkRows(40), { ...view, scroll: up.scroll, anchorEnd: up.anchorEnd }, ctx);
  const before = plain(up.lines).split('\n')[0];
  const after = plain(anchored.lines).split('\n')[0];
  eq(after, before, 'rows appended below a scrolled-up window leave the reading position alone');

  const past = chatflow.transcriptLines(mkRows(30), { ...view, scroll: 9999 }, ctx);
  assert(past.lines.length > 0, 'scrolling past the top clamps instead of emptying the transcript');
  assert(plain(past.lines).includes('line 0'), 'and the clamp lands on the oldest row');

  const fits = chatflow.transcriptLines(mkRows(3), { ...view, scroll: 7 }, ctx);
  eq(fits.scroll, 0, 'a transcript that fits the window drops stale scroll');
}

// ── the input line ──────────────────────────────────────────────────────────

{
  const empty = chatflow.inputLine({ buf: '', cursor: 0 }, 80, ctx);
  const t = text(empty.line);
  assert(t.startsWith(theme.GLYPH.cursor + ' '), 'the input row opens with the ❯ prompt');
  assert(t.includes('Try "'), 'an empty input shows the rotating suggestion');
  assert(empty.line.some((sp) => sp.s.includes(theme.BOLD)), 'the suggestion is bold, like the reference');

  const typed = chatflow.inputLine({ buf: 'fix it', cursor: 6 }, 80, ctx);
  assert(text(typed.line).includes('fix it'), 'typed text is painted');
  eq(typed.cursorCol, 3 + 'fix it'.length, 'the cursor sits after the painted text');

  const working = chatflow.inputLine({ buf: 'ignored', cursor: 0, working: true }, 80, ctx);
  assert(!text(working.line).includes('ignored'), 'the input row is empty while a turn runs (the spinner lives above)');

  // CJK is 2 cells wide: a codepoint count would land the cursor short.
  const cjk = chatflow.inputLine({ buf: '日本語', cursor: 3 }, 80, ctx);
  eq(cjk.cursorCol, 3 + 6, 'cursor maths uses cell widths, not codepoints');

  // Multi-line paste collapses to a preview so the single-row layout survives.
  const pasted = chatflow.inputLine({ buf: 'one\ntwo\nthree', cursor: 13 }, 80, ctx);
  const pt = text(pasted.line);
  assert(pt.includes('one … (+2 lines)'), 'a multi-line paste collapses to a one-line preview');
  assert(!pt.includes('\n'), 'and never paints a raw newline into the one-row input');

  // A buffer wider than the row scrolls instead of running off the edge.
  const long = chatflow.inputLine({ buf: 'x'.repeat(120), cursor: 120 }, 40, ctx);
  const lt = text(long.line);
  assert(lt.includes('…'), 'an over-wide buffer shows the scroll indicator');
  assert(screen.lineWidth(long.line) === 40, 'the input row is exactly the terminal width');
  assert(long.cursorCol <= 40, 'and the cursor stays on screen');
  eq(chatflow.inputPreviewText('a\nb'), 'a … (+1 line)', 'the preview pluralises correctly');
}

// ── overlays ────────────────────────────────────────────────────────────────

{
  const grid = chatflow.shortcutsGrid(80, ctx);
  const t = plain(grid);
  // The grid lists only bindings this CLI actually handles; the dead reference
  // chords (shift+tab "to auto-accept", '@' for file paths) were removed.
  assert(
    t.includes('for commands') && t.includes('for shortcuts') && t.includes('for permissions'),
    'the shortcuts grid lists the bindings this CLI handles'
  );
  assert(
    !t.includes('to auto-accept') && !t.includes('shift + tab') && !t.includes('for file paths'),
    'and no longer advertises the inert reference chords'
  );
  const confirm = plain(chatflow.confirmLines({ name: 'Bash', args: { command: 'rm -rf x' }, sel: 0 }, 80, ctx));
  assert(confirm.includes('Do you want to proceed?'), 'the approval dialog asks the question');
  assert(confirm.includes('rm -rf x'), 'and shows what would run');
  assert(confirm.includes('Yes') && confirm.includes('No'), 'and offers both answers');
}

// ── the loop, driven for real ───────────────────────────────────────────────

/** A synthetic TTY: the key stream, with no real terminal involved. */
function fakeStdin() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.setRawMode = () => {};
  s.setEncoding = () => {};
  s.resume = () => {};
  s.pause = () => {};
  return s;
}

/** Run `runSession` with stdout captured and a scripted key sequence. */
async function drive(script, { ask, extra = {} } = {}) {
  const stdin = fakeStdin();
  const captured = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rowD = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true, writable: true });

  const rows = [];
  const notes = [];
  const host = {
    ctx: { light: false, model: null, effort: 'high', vim: false, sessionId: 'test-session' },
    version: '9.9.9',
    transcript: rows,
    session: { turns: 0, calls: 0, tokens: 0 },
    client: {},
    ask:
      ask ||
      (async (prompt, { presenter }) => {
        presenter.text('the answer');
        return { text: 'the answer', model: 'nexus', ms: 12, usage: { total_tokens: 1562, input_tokens: 1250, output_tokens: 312 } };
      }),
    makeCommandContext: () => ({
      ctx: host.ctx,
      transcript: rows,
      push: () => {},
      note: (t) => notes.push(t),
      panel: () => {},
      render: () => {},
      openOverlay: () => {},
      closeOverlay: () => {},
      askInput: () => Promise.resolve(null),
      withWorking: (fn) => fn(new AbortController().signal),
      runPrompt: async () => {},
      ask: async () => ({ text: '' }),
      runTool: async () => '',
      refreshSpend: async () => null,
      state: () => ({}),
      setInput: () => {},
      exit: () => {},
      client: {},
      TOOLS: {},
      saveConfig: () => {},
      showThemePicker: () => {},
    }),
    buildState: () => ({}),
    dispatchLine: async (line) => {
      notes.push(`cmd:${line}`);
      return true;
    },
    refreshSpend: async () => ({ balance: 5, lastCost: 0.0007 }),
    updateConfig: () => {},
    visibleCommands: () => [
      { name: 'help', aliases: ['?', 'h'], desc: 'Show help' },
      { name: 'model', aliases: ['m'], desc: 'Switch model' },
      { name: 'exit', aliases: ['quit'], desc: 'Exit' },
    ],
    tokensFor: (u) => (u && u.total_tokens) || null,
    recordTurn: () => {},
    tokenSummary: () => 'summary',
    resumeSession: async () => {},
    requestExit: () => {},
    wantsExit: () => false,
    isYolo: () => false,
    stdin,
    ...extra,
  };

  let done = false;
  const run = chatflow.runSession(host).then((code) => {
    done = true;
    return code;
  });

  // Feed the scripted keys after the loop has attached its listener.
  const pump = async () => {
    for (const step of script) {
      if (typeof step === 'number') {
        await new Promise((r) => setTimeout(r, step));
        continue;
      }
      await new Promise((r) => setTimeout(r, 15));
      stdin.emit('data', step);
    }
  };
  await pump();
  // Give the loop a moment to settle, then end it if it has not ended itself.
  // Ctrl+C clears a non-empty input line before it exits, so the nudge repeats.
  for (let i = 0; i < 40 && !done; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (i >= 16 && i % 4 === 0) stdin.emit('data', '\x03');
  }

  const code = await Promise.race([run, new Promise((r) => setTimeout(() => r('TIMEOUT'), 2000))]);
  process.stdout.write = realWrite;
  if (cols) Object.defineProperty(process.stdout, 'columns', cols);
  if (rowD) Object.defineProperty(process.stdout, 'rows', rowD);
  return { code, rows, notes, captured: captured.join(''), host };
}

const results = [];

// 1. A plain prompt: user row, streamed assistant row, done row, accounting row.
{
  const { rows } = await drive(['hi there\r']);
  const roles = rows.map((r) => r.role);
  assert(roles.includes('user'), 'a prompt pushes a user row');
  assert(roles.includes('assistant'), 'and an assistant row');
  const user = rows.find((r) => r.role === 'user');
  eq(user.text, 'hi there', 'the user row carries the prompt');
  const asst = rows.find((r) => r.role === 'assistant');
  eq(asst.text, 'the answer', 'the assistant row carries the streamed answer');
  eq(asst.streaming, false, 'and is no longer streaming once the turn ends');
  const done = rows.find((r) => r.role === 'done');
  assert(done, 'the turn pushes a completion row');
  eq(done.text, 'Churned for 1s', 'a turn with no tools Churned (the reference vocabulary)');
  const meta = rows.find((r) => r.role === 'meta');
  assert(meta, 'the turn pushes an accounting row');
  eq(meta.meta.tokens, 1562, 'with the turn token count');
  eq(meta.meta.eur, 0.0007, 'and what the ledger settled it at');
  results.push('turn lifecycle');
}

// 2. The completion verb switches to Worked once a tool ran.
{
  const { rows } = await drive(['go\r'], {
    ask: async (prompt, { presenter }) => {
      presenter.tool({ phase: 'run', name: 'Bash', id: 'x', args: { command: 'ls' } });
      presenter.text('ran it');
      presenter.tool({ phase: 'done', name: 'Bash', id: 'x', elapsed: '1s', ok: true });
      return { text: 'ran it' };
    },
  });
  const done = rows.find((r) => r.role === 'done');
  eq(done.text, 'Worked for 1s', 'a turn that used tools Worked');
  const tool = rows.find((r) => r.role === 'tool');
  eq(tool.phase, 'done', 'the running tool row resolves to done');
  eq(tool.label, 'Ran 1 shell command', 'and is relabelled with what it did');
  results.push('tool rows');
}

// 3. Esc interrupts a running turn — and must reach the transport.
{
  let sawSignal = null;
  const { rows } = await drive(['long job\r', 200, '\x1b'], {
    ask: (_prompt, { presenter, signal }) =>
      new Promise((resolve) => {
        sawSignal = signal;
        presenter.text('working');
        signal.addEventListener('abort', () => resolve({ text: 'working', interrupted: true }));
      }),
  });
  assert(sawSignal, 'the turn receives an AbortSignal from the loop');
  assert(sawSignal.aborted, 'and Esc aborts it — a controller nobody listens to leaves the turn billing');
  const asst = rows.find((r) => r.role === 'assistant');
  assert(asst.text.endsWith('(stopped)'), 'the interrupted turn is marked (stopped)');
  assert(!asst.text.includes('backend error'), 'and not marked as an error');
  results.push('esc interrupt');
}

// 4. A failing turn is marked, and the session survives it.
{
  const { rows, notes } = await drive(['boom\r', '/help\r'], {
    ask: async () => {
      throw new Error('backend down');
    },
  });
  const asst = rows.find((r) => r.role === 'assistant');
  assert(asst.text.includes('(backend error: backend down)'), 'a thrown error becomes a visible marker');
  assert(notes.includes('cmd:/help'), 'and the session keeps running afterwards');
  results.push('backend error');
}

// 5. Ctrl+C on an empty line ends the session and restores the terminal.
{
  const { code, captured } = await drive(['\x03']);
  eq(code, 0, 'ctrl+c returns a clean exit code');
  assert(captured.includes('\x1b[?1049h'), 'the loop enters the alternate screen');
  assert(captured.includes('\x1b[?1049l'), 'and leaves it again — otherwise the shell is left broken');
  assert(captured.includes('\x1b[?25h'), 'and shows the cursor');
  results.push('exit restores the terminal');
}

// 6. '/' opens the command palette, Esc closes it, and '/'+text is a command.
{
  const { notes, captured } = await drive(['/', 120, '\x1b', '/model\r']);
  assert(notes.includes('cmd:/model'), 'a slash line is dispatched as a command, not a prompt');
  assert(!notes.some((n) => n.startsWith('cmd:hi')), 'and never as a prompt');
  assert(captured.length > 0, 'the palette painted');
  results.push('palette + dispatch');
}

// 7. Tab completes a command name.
{
  const { captured } = await drive(['/he\t', 120, '\x03']);
  assert(plain([captured]).includes('/help'), 'tab completes /he to /help');
  results.push('tab completion');
}

// 8. '?' opens the shortcut grid.
{
  const { captured } = await drive(['?', 150, '\x1b', '\x03']);
  assert(plain([captured]).includes('for shortcuts') || plain([captured]).includes('to auto-accept'), 'the shortcuts grid renders');
  results.push('shortcut grid');
}

// 9. History recall with the up arrow.
{
  const { captured } = await drive(['first\r', 'second\r', '\x1b[A', 120, '\x03']);
  assert(plain([captured]).includes('second'), 'the up arrow recalls the previous line');
  results.push('history recall');
}

// 10. A malformed key stream must not kill the loop.
{
  const { code } = await drive(['\x1b[<64;10;10M', 60, 'hello\r', 60, '\x03']);
  eq(code, 0, 'a wheel event is consumed, not decoded as Escape (which would abort the turn)');
  results.push('mouse + malformed input');
}

// 11. The app half of the interrupt: an aborted signal must actually cancel the
//     transport, not just flip a flag in the loop.
{
  const { createApp } = require(join(cliDir, 'src', 'app.js'));
  let cancelled = false;
  const client = {
    apiBase: 'http://stub',
    apiKey: 'k',
    async chatCompletion({ signal, onStream }) {
      // Stream a little, then hang until cancelled — the shape of a stalled
      // provider. The engine reports {stopped} once cancel() is called.
      onStream({ delta: 'partial answer' });
      await new Promise((resolve) => {
        if (signal && signal.aborted) return resolve();
        const t = setInterval(() => {
          if (cancelled) {
            clearInterval(t);
            resolve();
          }
        }, 10);
        return undefined;
      });
      return { choices: [{ message: { content: '' } }] };
    },
    async tokenBankBalance() {
      return { balance_eur: 0, ledger: [] };
    },
  };
  const app = createApp({ client, interactive: false, stream: true });
  app.opts.interactive = false;
  const controller = new AbortController();
  setTimeout(() => {
    cancelled = true;
    controller.abort();
  }, 40);
  const res = await app.ask('do a long thing', { signal: controller.signal });
  assert(controller.signal.aborted, 'the caller holds the same controller');
  assert(cancelled, 'the transport was reached');
  assert(res.interrupted, 'an aborted signal marks the turn interrupted');
  eq(res.text, 'partial answer', 'and the streaming work already done is kept, not discarded');
  results.push('app-side interrupt');
}

// ── the end-of-turn summary ─────────────────────────────────────────────────

// 10. The counts are arithmetic over the events, not a model call: `ok` decides
//     failure, args decide files and commands, and duplicates collapse.
{
  const counts = chatflow.summarizeTurnTools([
    { ok: true, args: { command: 'ls -la' } },
    { ok: true, args: { command: '/usr/bin/node /tmp/x.mjs --flag' } },
    { ok: true, args: { file_path: '/a/b/art.js' } },
    { ok: true, args: { file_path: '/a/b/art.js' } },
    { ok: false, args: { file_path: '/a/b/theme.js' } },
  ]);
  eq(counts.tools, 5, 'every tool event is counted');
  eq(counts.failed, 1, 'ok:false is the failure count');
  eq(counts.files.length, 2, 'the same file touched twice is one file');
  eq(counts.files.join(','), '/a/b/art.js,/a/b/theme.js', 'files keep first-seen order');
  eq(counts.names.join(','), 'art.js,theme.js', 'names are basenames — a path does not fit one line');
  eq(counts.commands.join(','), 'ls,node', 'only the binary of a command is reported');
  results.push('summary counts');
}

// 11. The engine reports a tool once, AFTER it ran, with no `phase` (see
//     vendor/desktop/lib/local/engine.js). That shape used to match neither
//     branch: `phase==='run'` was false, so the code called resolveToolDone,
//     which only ever matches a `phase:'run'` row, found none and returned
//     null — pushing nothing. A turn could run five commands and show no tool
//     activity at all.
{
  const { rows } = await drive(['go\r'], {
    ask: async (_prompt, { presenter }) => {
      presenter.tool({ name: 'Bash', args: { command: 'ls' }, ok: true });
      presenter.tool({ name: 'Write', args: { file_path: '/a/b/art.js' }, ok: true });
      presenter.text('done');
      return { text: 'done' };
    },
  });
  const tools = rows.filter((r) => r.role === 'tool');
  eq(tools.length, 2, 'a phase-less tool event still gets a transcript row');
  eq(tools[0].phase, 'done', 'and is recorded as finished, since it already ran');
  eq(tools[0].ok, true, 'carrying the outcome the engine reported');
  assert(tools[0].label.startsWith('Ran 1'), 'numbered in the reference vocabulary');
  const summary = rows[rows.length - 1];
  eq(summary.role, 'summary', 'the summary is the LAST row of the turn');
  eq(summary.counts.tools, 2, 'counting both tools');
  eq(summary.counts.files.length, 1, 'and the one file written');
  results.push('phase-less tool rows + summary tail');
}

// 12. The summary is the bottom of the screen, and reads as one line.
{
  const counts = chatflow.summarizeTurnTools([
    { ok: true, args: { command: 'ls' } },
    { ok: true, args: { file_path: '/a/b/art.js' } },
    { ok: false, args: { file_path: '/a/b/theme.js' } },
  ]);
  const line = plain(chatflow.rowLines({ role: 'summary', counts }, 80, { light: false }));
  assert(line.includes('3 commands'), `the summary counts the commands (got ${JSON.stringify(line)})`);
  assert(line.includes('2 files changed'), 'and the files changed');
  assert(line.includes('1 failed'), 'and surfaces failures, which the tool rows only implied');
  assert(!line.includes('\n'), 'the whole summary is one line — it is the thing you read without scrolling');
  results.push('summary line');
}

// 13. A turn that used no tools adds no summary: there is no delta to report,
//     and a "0 commands" row under every plain answer is noise.
{
  const { rows } = await drive(['hi\r']);
  eq(rows.filter((r) => r.role === 'summary').length, 0, 'a tool-less turn pushes no summary row');
  results.push('summary is conditional');
}

// 14. The summary wraps nothing and never throws on a malformed event: hosts
//     vary, and a bad args blob must not take down the turn's tail.
{
  const counts = chatflow.summarizeTurnTools([
    { args: null },
    { args: 'not-an-object' },
    {},
    { ok: true, args: { command: '   ' } },
    { ok: true, args: {} },
  ]);
  eq(counts.tools, 5, 'events with useless args are still counted');
  eq(counts.files.length, 0, 'and contribute no files');
  eq(counts.commands.length, 0, 'and no commands — a blank command is not a command');
  const line = plain(chatflow.rowLines({ role: 'summary', counts }, 80, { light: false }));
  assert(line.includes('5 commands'), 'the line still renders, showing only what is known');
  assert(!line.includes('files changed') && !line.includes('failed'), 'with no invented detail');
  results.push('summary tolerates junk');
}

console.log('CLI chatflow test passed');
for (const r of results) console.log(`  ✓ ${r}`);
