#!/usr/bin/env node
/**
 * Regression tests for the chatflow key bindings that the gap analysis found
 * unreachable or divergent from the reference (aegiscodex-dev/src/main.js):
 *
 *   · a bare '/' on an idle line opens the command palette (it used to insert a
 *     literal '/'), and a bare '?' opens the shortcuts grid on the keystroke;
 *   · '/m' + Enter runs /model, not a literal /m;
 *   · Esc clears a non-empty input line;
 *   · every finished turn is persisted through host.persistTurn;
 *   · the shortcuts grid advertises only bindings this CLI handles.
 *
 * The loop is driven for real, like cli-chatflow.test.mjs: a synthetic key
 * stream, runSession entered as the app enters it, and every stdout write
 * captured so a frame can be reconstructed and inspected row by row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, '..', 'cli');
const require = createRequire(import.meta.url);

const chatflow = require(join(cliDir, 'src', 'chatflow.js'));
const screen = require(join(cliDir, 'src', 'screen.js'));
const { stripAnsi } = screen;

const isSpan = (x) => x && typeof x === 'object' && typeof x.t === 'string' && typeof x.w === 'number';
const text = (lines) => {
  const block = Array.isArray(lines) && lines.length && isSpan(lines[0]) ? [lines] : lines;
  return (Array.isArray(block) ? block : [block])
    .map((l) => (Array.isArray(l) ? l.map((sp) => sp.t).join('') : String(l)))
    .join('\n');
};
const plain = (lines) => stripAnsi(text(lines));

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

/** Run `runSession` with stdout captured and a scripted key sequence.
 *  Returns the transcript, notes, reconstructed full-frame paints (as row
 *  arrays) and the raw captured output. `rows`/`cols` size the fake terminal. */
async function drive(script, { ask, extra = {}, rows = 40, cols = 80 } = {}) {
  const stdin = fakeStdin();
  const chunks = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  const colsD = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rowsD = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true, writable: true });

  const transcript = [];
  const notes = [];
  const host = {
    ctx: { light: false, model: null, effort: 'high', vim: false, sessionId: 'keys-session' },
    version: '9.9.9',
    transcript,
    session: { turns: 0, calls: 0, tokens: 0 },
    client: {},
    ask:
      ask ||
      (async (prompt, { presenter }) => {
        presenter.text('the answer');
        return { text: 'the answer', model: 'nexus', ms: 12, usage: { total_tokens: 5, input_tokens: 3, output_tokens: 2 } };
      }),
    makeCommandContext: () => ({
      ctx: host.ctx,
      transcript,
      push: () => {},
      note: (t) => notes.push(t),
      panel: () => {},
      render: () => {},
      openOverlay: () => {},
      closeOverlay: () => {},
      askInput: () => Promise.resolve(null),
      withWorking: (fn) => fn(new AbortController().signal),
      runPrompt: async () => {},
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

  const pump = async () => {
    for (const step of script) {
      if (typeof step === 'number') {
        await new Promise((r) => setTimeout(r, step));
        continue;
      }
      // A gap before each keystroke so a bare ESC (>60ms) is not swallowed into
      // an Alt chord, exactly as a human types.
      await new Promise((r) => setTimeout(r, 15));
      stdin.emit('data', step);
    }
  };
  await pump();
  for (let i = 0; i < 40 && !done; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (i >= 16 && i % 4 === 0) stdin.emit('data', '\x03');
  }

  const code = await Promise.race([run, new Promise((r) => setTimeout(() => r('TIMEOUT'), 2500))]);
  process.stdout.write = realWrite;
  if (colsD) Object.defineProperty(process.stdout, 'columns', colsD);
  if (rowsD) Object.defineProperty(process.stdout, 'rows', rowsD);

  const captured = chunks.join('');
  // paint() writes one chunk per frame, prefixed with a cursor-home; split each
  // into its rows so a caller can read a specific row (e.g. the input line).
  const frames = chunks.filter((c) => c.startsWith('\x1b[H')).map((c) => c.split('\n'));
  return { code, transcript, notes, captured, chunks, frames, host, rows };
}

/** The visible text of the input row within a reconstructed frame. The frame is
 *  header(1) + transcript(avail) + spinner/effort + rule + input + rule + status
 *  = rows, so the input line is the 0-based row `rows - 3`. */
const inputRowText = (frame, rows) => stripAnsi(frame[rows - 3] || '');

// (a) '/' on an empty line opens the palette and does NOT insert a '/'.
test("typing '/' on an empty line opens the palette, not a literal '/'", async () => {
  const { captured, frames, rows } = await drive(['/', 220]);
  assert.match(stripAnsi(captured), /type to filter/, 'the palette rendered');
  const pal = frames.find((f) => stripAnsi(f.join('\n')).includes('type to filter'));
  assert.ok(pal, 'a full palette frame was painted');
  const input = inputRowText(pal, rows);
  assert.ok(
    !input.includes('/'),
    `the input line must not hold a literal "/" (got ${JSON.stringify(input)})`
  );
});

// (b) '/m' + Enter runs /model, not a literal /m.
test("'/m' + Enter runs /model, not a literal /m", async () => {
  const { notes } = await drive(['/m\r', 260]);
  const cmds = notes.filter((n) => n.startsWith('cmd:'));
  assert.ok(notes.includes('cmd:/model'), `expected /model to run (ran ${JSON.stringify(cmds)})`);
  assert.ok(!notes.includes('cmd:/m'), 'never runs the half-typed literal /m');
});

// (c) '?' on an empty line opens the shortcuts grid on the keystroke.
test("typing '?' on an empty line opens the shortcuts grid", async () => {
  const { captured } = await drive(['?', 220]);
  const p = stripAnsi(captured);
  assert.ok(
    p.includes('to toggle thinking') && p.includes('for permissions'),
    'the shortcuts grid painted its bindings'
  );
});

// (d) Esc clears a non-empty buffer (so a following Enter submits nothing).
test('Esc clears a non-empty buffer', async () => {
  const { transcript, frames, rows } = await drive(['abc', 140, '\x1b', 170, '\r', 220]);
  assert.ok(
    frames.some((f) => inputRowText(f, rows).includes('abc')),
    'the typed text reached the input line before Esc'
  );
  assert.ok(
    !transcript.some((r) => r.role === 'user' && r.text === 'abc'),
    'Esc cleared the buffer, so Enter submitted nothing'
  );
});

// (e) Each finished turn is persisted once, with the prompt and a status.
test('host.persistTurn is called once per turn with the prompt and a status', async () => {
  const calls = [];
  const { transcript } = await drive(['hello\r', 260], {
    extra: {
      persistTurn: (prompt, res, status) => calls.push([prompt, res, status]),
    },
  });
  assert.ok(transcript.some((r) => r.role === 'assistant'), 'the turn actually ran');
  assert.equal(calls.length, 1, 'exactly one persisted turn');
  assert.equal(calls[0][0], 'hello', 'the prompt is recorded');
  assert.ok(
    ['done', 'stopped', 'error'].includes(calls[0][2]),
    `a status is recorded (got ${JSON.stringify(calls[0][2])})`
  );
});

// (f) The shortcuts grid no longer advertises unimplemented chords.
test('the shortcuts grid advertises only bindings this CLI handles', () => {
  const grid = plain(chatflow.shortcutsGrid(80, { light: false }));
  assert.ok(
    !grid.includes('shift + tab') && !grid.includes('to auto-accept'),
    'the inert shift+tab row is gone'
  );
  assert.ok(
    !grid.includes('for file paths') && !grid.includes('for newline'),
    'the dead @ / backslash-return rows are gone'
  );
  assert.ok(
    grid.includes('for permissions') && grid.includes('to toggle thinking'),
    'the live bindings are listed'
  );
});
