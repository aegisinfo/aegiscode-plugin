'use strict';

/**
 * The chatflow — the full-screen session loop, and the row/render helpers it
 * runs on.
 *
 * This is the aegiscodex-dev session loop: an alternate-screen frame of
 *
 *     ╭──── AEGIS Code v6.2.0 ────╮      header rule
 *     …transcript viewport…              user rows, assistant markdown, tool rows
 *     ✻ Tempering… (3s · ↓412 tokens)    spinner, or the effort line when idle
 *     ─────────────────────────────
 *     ❯ what should I fix?               input line, with history + completion
 *     ─────────────────────────────
 *     ⏸ manual mode on · ? for shortcuts  status line
 *
 * driven by a raw key stream, with the turn lifecycle of the reference: a user
 * row, a live assistant row that grows as the model streams, tool rows that
 * resolve from "Running 1 shell command…" to "Ran 1 shell command", a
 * `✻ Churned/Worked for Ns` completion row, `(stopped)` on Esc and
 * `(backend error: …)` on failure.
 *
 * The split from `app.js` is the reference's split: this module owns the frame,
 * the rows, the keys and the turn; `app.js` owns the transport, the tool
 * registry, the command table and the session tallies. Everything this module
 * needs from the app arrives through the small `host` interface documented on
 * `runSession` — which is what lets the whole loop be driven from a test with a
 * stub host and no TTY.
 *
 * Pure helpers are exported at module scope (`resolveToolDone`,
 * `finalizeTurnText`, `transcriptLines`, …) so a regression test can drive the
 * exact pairing, marker and viewport logic without a terminal.
 */

const {
  getSize, span, padLine, paint, w, wrapBlock,
  hideCursor, showCursor, moveTo, clearScreen,
  enterAltScreen, leaveAltScreen,
  enableBracketedPaste, disableBracketedPaste,
  enableMouseTracking, disableMouseTracking,
} = require('./screen.js');
const {
  KEY, attachKeyStream, nextKey, nextKeyTimeout, requeueKeys, resetKeyStream,
  isKeyStreamSuspended,
} = require('./events.js');
const { GLYPH, VERBS, DONE_VERBS, BOLD, BOLD_OFF, themeOf } = require('./theme.js');
const { LineEditor } = require('./input.js');
const { renderMarkdown } = require('./markdown.js');
const overlays = require('./overlays.js');
const fuzzy = require('./fuzzy.js');
const { fmtTokens, fmtEur, fmtElapsed } = require('./format.js');

/** The rotating placeholder shown on an empty input line. */
const SUGGESTIONS = [
  'edit <filepath> to...',
  'refactor <filepath>',
  'how do I log an error?',
  'write a test for <filepath>',
  'create a util logging.py that...',
];

/** Terminal title spinner while a turn runs (the reference's frames). */
const TITLE_SPIN = ['⠐', '⠂', '⠄', '⠆', '⠈', '⠠', '⠰', '⠁'];

const FRAME_MS = 33; // ~30fps cap for streaming repaints

// ── pure turn helpers ───────────────────────────────────────────────────────

/** The noun a tool row uses: "shell command", "subagent", "read command"… */
function toolLabel(name, n) {
  const base =
    name === 'Bash' ? 'shell command'
      : name === 'Task' ? 'subagent'
        : `${String(name).toLowerCase()} command`;
  return n > 1 ? base + 's' : base;
}

/**
 * Resolve a tool "done" event to its running transcript row.
 *
 * Ids pair events exactly (parallel same-name calls, nested subagent rows);
 * id-less streams fall back to name + agent matching. Mutates and returns the
 * row, or null when nothing matches.
 */
function resolveToolDone(transcript, t) {
  let idx = -1;
  if (t.id !== undefined) {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const m = transcript[i];
      if (m.role === 'tool' && m.phase === 'run' && m.id === t.id) {
        idx = i;
        break;
      }
    }
  }
  if (idx === -1) {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const m = transcript[i];
      if (m.role === 'tool' && m.phase === 'run' && m.name === t.name && m.agent === t.agent) {
        idx = i;
        break;
      }
    }
  }
  if (idx === -1) return null;
  const m = transcript[idx];
  const n = transcript.filter(
    (x, i) => x.role === 'tool' && x.name === t.name && x.agent === t.agent && i <= idx
  ).length;
  m.phase = 'done';
  m.elapsed = t.elapsed;
  m.ok = t.ok;
  m.label = `Ran ${n} ${m.agent ? `${m.agent} ▸ ` : ''}${toolLabel(t.name, n)}`;
  return m;
}

/**
 * Finalize an assistant message's text: append a "(backend error: …)" marker
 * when the turn failed mid-stream, a single "(stopped)" marker on abort, and
 * fall back to "(no response)" for empty text. An abort wins over an error so
 * Esc-cancel never produces the doubled marker.
 */
function finalizeTurnText(text, { aborted, error } = {}) {
  let t = String(text == null ? '' : text);
  if (error && !aborted && error !== 'stopped') {
    const err = `(backend error: ${error})`;
    t = t.trim() ? `${t.trimEnd()}\n\n${err}` : err;
  }
  if (aborted) t = t.trim() ? `${t.trimEnd()} (stopped)` : '(stopped)';
  if (!t.trim()) t = '(no response)';
  return t;
}

/** Every prior user/assistant pair, for the engine's conversation history. */
function historyPairs(rows) {
  return rows
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.text }));
}

/**
 * Palette ranking query for a typed command line: "/memory tiers" must keep
 * ranking on "memory" so the command stays listed while the user finishes the
 * line; the ENTER branch passes the remainder as args. Single words unchanged.
 */
function paletteQuery(q) {
  const t = String(q || '').trim();
  return t.includes(' ') ? t.split(/\s+/)[0] : t;
}

// ── the frame ───────────────────────────────────────────────────────────────

/** The rounded header rule: `╭──── AEGIS Code v6.2.0 ────╮`. */
function headerLine(version, cols, ctx) {
  const t = themeOf(ctx);
  const label = ` AEGIS Code v${version} `;
  const fill = Math.max(0, cols - [...label].length - 2);
  const left = Math.floor(fill / 2);
  return [span(t.coral, `╭${'─'.repeat(left)}${label}${'─'.repeat(fill - left)}╮`)];
}

const separatorLine = (cols, ctx) => [span(themeOf(ctx).dim, '─'.repeat(cols))];

/** The idle bottom-left line: which effort level the next turn runs at. */
function effortLine(ctx, cols) {
  const t = themeOf(ctx);
  const txt = `● ${ctx.effort || 'high'} · /effort`;
  const pad = ' '.repeat(Math.max(0, cols - [...txt].length - 4));
  return [span(t.gray, pad + txt)];
}

/**
 * The working line: the `✻`-family spinner with a shimmering verb, the elapsed
 * time and a token estimate — the reference's
 * `✻ Tempering… (3s · ↓412 tokens)`.
 */
function spinnerLine(state, ctx) {
  const t = themeOf(ctx);
  const secs = Math.max(1, Math.round((state.elapsedMs || 0) / 1000));
  const shimmer = [...(state.verb || VERBS[0])];
  const frame = Math.floor((state.frame || 0) / 2) % 3;
  const tinted = shimmer.map((ch, i) =>
    span((i + frame) % 3 === 0 ? t.coral : t.gray, ch)
  );
  const tail = state.streamed
    ? span(t.gray, ` (${secs}s · ↓${fmtTokens(state.streamed)} tokens)`)
    : span(t.gray, ` (${secs}s · thinking)`);
  const glyph = GLYPH.spin[(state.frame || 0) % GLYPH.spin.length];
  return [span(t.coral, glyph), ...tinted, span(t.white, '… '), tail];
}

/** The idle/modifier status line at the bottom of the frame. */
function statusLine(state, cols, ctx) {
  const t = themeOf(ctx);
  let left;
  if (state.inputPrompt) {
    left = [span(t.gray, 'enter to confirm · esc to cancel')];
  } else if (state.working) {
    left = [span(t.gray, ` ${GLYPH.bullet} esc to interrupt ${GLYPH.bullet} ${GLYPH.leftarrow} for agents`)];
  } else if (state.streamJob) {
    left = [span(t.gray, `${GLYPH.bullet} esc to stop ${GLYPH.bullet} ${GLYPH.leftarrow} for agents`)];
  } else if (state.yolo) {
    left = [span(t.gray, `${GLYPH.bullet} YOLO mode on ${GLYPH.bullet} ? for shortcuts ${GLYPH.bullet} ${GLYPH.leftarrow} for agents`)];
  } else {
    left = [span(t.gray, `${GLYPH.pause} manual mode on ${GLYPH.bullet} ? for shortcuts ${GLYPH.bullet} ${GLYPH.leftarrow} for agents`)];
  }
  return padLine(left, cols);
}

/**
 * The `?` shortcuts grid. Every row advertised here is a key this CLI actually
 * handles — the reference sheet also lists chords this host never wired up
 * (shift+tab, `\`+return, `@`, ctrl+z/v/g…), and a cheat-sheet of dead keys is
 * worse than none. Add a row only alongside its handler in `handleKey`.
 */
function shortcutsGrid(cols, ctx) {
  const t = themeOf(ctx);
  const cell = (a, b, c, d) => [
    span('', '  '), span(t.white, a), span(t.gray, ' ' + b),
    span('', '  '), span(t.white, c), span(t.gray, ' ' + d),
  ];
  return [
    cell('/', 'for commands', '?', 'for shortcuts'),
    cell('ctrl + c', 'to quit', 'ctrl + o', 'for permissions'),
    cell('alt + p', 'to switch model', 'alt + t', 'to toggle thinking'),
    cell('esc', 'to interrupt a turn', 'ctrl + l', 'to clear the screen'),
    cell('ctrl + t', 'to show tokens', 'ctrl + r', 'to resume a session'),
    cell('↑ / ↓', 'for history', 'tab', 'to complete a command'),
  ];
}

/** The tool-approval dialog body. */
function confirmLines(overlay, cols, ctx) {
  const t = themeOf(ctx);
  const lines = [];
  lines.push([span(t.gray, '─'.repeat(Math.min(Math.max(10, cols - 4), 80)))]);
  lines.push([span(t.white, `${overlay.name} command`)]);
  lines.push([span('', '')]);
  const subject =
    overlay.name === 'Bash'
      ? String((overlay.args && overlay.args.command) || '')
      : String((overlay.args && (overlay.args.file_path || overlay.args.pattern)) || '');
  for (const l of wrapBlock(subject, Math.max(8, cols - 4))) lines.push([span(t.gray, l)]);
  lines.push([span('', '')]);
  lines.push([span(t.white, 'Do you want to proceed?')]);
  const opt = (i, label) => {
    const active = overlay.sel === i;
    const left = active ? span(t.lavender, GLYPH.cursor) : span('', ' ');
    return [left, span(t.gray, ` ${i + 1}. `), span(active ? t.lavender : t.white, label)];
  };
  lines.push(opt(0, 'Yes'));
  lines.push(opt(1, 'No'));
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'Esc to cancel')]);
  return lines;
}

/** Render one transcript row to span lines. */
function rowLines(msg, cols, ctx, now = Date.now()) {
  const t = themeOf(ctx);
  const out = [];
  if (msg.role === 'tool') {
    if (msg.phase === 'run') {
      const secs = msg.start ? Math.max(1, Math.round((now - msg.start) / 1000)) : 0;
      out.push([span(t.white, GLYPH.block), span(t.gray, ` ${msg.label} · ${secs}s…`)]);
    } else {
      out.push([span(t.gray, msg.label)]);
    }
    const argsStr =
      typeof msg.args === 'string'
        ? msg.args
        : msg.args && typeof msg.args === 'object'
          ? msg.args.command ?? msg.args.file_path ?? msg.args.description ??
            Object.values(msg.args).find((v) => typeof v === 'string') ?? ''
          : '';
    if (argsStr) out.push([span(t.gray, `  ${GLYPH.hook}  $ ${String(argsStr)}`)]);
    return out;
  }
  if (msg.role === 'note') {
    out.push([span(t.gray, `· ${msg.text}`)]);
    return out;
  }
  if (msg.role === 'tip') {
    for (const l of wrapBlock(String(msg.text), cols)) out.push([span(t.gray, l)]);
    return out;
  }
  if (msg.role === 'done') {
    // Real 2.1.211: "✻ Churned for 6s" — bloom glyph + gray text.
    out.push([span(t.gray, GLYPH.bloom), span(t.gray, ` ${msg.text}`)]);
    return out;
  }
  if (msg.role === 'meta') {
    // Deliberate divergence from the reference: this client's reason to exist
    // is showing what a turn consumed, so the accounting line is a transcript
    // row rather than something only /cost can reveal.
    const m = msg.meta || {};
    const bits = [];
    if (m.model) bits.push(span(t.blue, m.model));
    if (m.tokens != null) bits.push(span(t.white, `${fmtTokens(m.tokens)} tok`));
    if (m.input != null || m.output != null) {
      bits.push(span(t.gray, `${fmtTokens(m.input || 0)}/${fmtTokens(m.output || 0)}`));
    }
    if (m.eur != null) bits.push(span(m.eur > 0 ? t.coral : t.green, fmtEur(m.eur)));
    if (m.ms != null) bits.push(span(t.gray, fmtElapsed(m.ms)));
    if (m.calls > 1) bits.push(span(t.gray, `${m.calls} calls`));
    if (bits.length) {
      const line = [span(t.dim, `${GLYPH.hook}  `)];
      bits.forEach((b, i) => {
        if (i) line.push(span(t.dim, ` ${GLYPH.bullet} `));
        line.push(b);
      });
      out.push(line);
    }
    return out;
  }
  if (msg.role === 'panel') {
    for (const l of msg.lines || []) out.push(padLine(l, cols));
    out.push([span('', '')]);
    return out;
  }
  if (msg.role === 'error') {
    out.push([span(t.red, `✗ ${msg.text}`)]);
    return out;
  }
  if (msg.role === 'user') {
    const body = wrapBlock(String(msg.text), Math.max(8, cols - 2));
    body.forEach((l, i) => {
      if (i === 0) out.push([span(t.gray, GLYPH.cursor), span('', ' '), span(t.white, l)]);
      else out.push([span('', '  '), span(t.white, l)]);
    });
    return out;
  }
  // assistant (and anything else textual)
  const rendered = msg.role === 'assistant'
    ? renderMarkdown(String(msg.text == null ? '' : msg.text), cols, ctx)
    : wrapBlock(String(msg.text == null ? '' : msg.text), cols).map((l) => [span(t.white, l)]);
  const segment = rendered.length ? rendered : [[span('', '')]];
  for (let i = 0; i < segment.length; i++) {
    const line = segment[i].slice();
    if (i === 0) line.unshift(span(t.white, GLYPH.block), span('', ' '));
    out.push(line);
  }
  if (msg.streaming) {
    const last = out[out.length - 1];
    if (last) last.push(span(t.white, GLYPH.block));
  }
  return out;
}

/**
 * Build the visible transcript window.
 *
 * Two things here are load-bearing:
 *
 *  · finished rows are cached by identity + text + cols, because re-running
 *    markdown over the whole transcript on every frame during a streaming burst
 *    is an O(transcript) reparse up to 30x/sec and freezes input;
 *  · while scrolled up the window anchors to an ABSOLUTE line index
 *    (`anchorEnd`) rather than a bottom-relative offset, so rows appended below
 *    the window (streaming deltas, tool rows — `total` grows every frame) leave
 *    the reader's position alone instead of sliding it toward the bottom.
 *
 * @returns {{lines:Array, scroll:number, anchorEnd:number|null}}
 */
function transcriptLines(rows, view, ctx, now = Date.now(), cache = null) {
  const { cols, rows: termRows } = view;
  const avail = Math.max(1, termRows - 6);
  const out = [];
  for (const msg of rows) {
    const key = cache || null;
    const isGrower = msg.role === 'assistant' && msg.streaming;
    if (key && !isGrower) {
      const hit = key.get(msg);
      if (hit && hit.text === msg.text && hit.cols === cols) {
        for (const l of hit.segment) out.push(l);
        continue;
      }
      const segment = rowLines(msg, cols, ctx, now);
      key.set(msg, { text: msg.text, cols, segment });
      for (const l of segment) out.push(l);
      continue;
    }
    for (const l of rowLines(msg, cols, ctx, now)) out.push(l);
  }

  let scroll = view.scroll || 0;
  let anchorEnd = view.anchorEnd == null ? null : view.anchorEnd;
  const total = out.length;
  const maxScroll = Math.max(0, total - avail);
  if (scroll > maxScroll) scroll = maxScroll;
  let end;
  if (scroll === 0) {
    anchorEnd = null;
    end = total;
  } else {
    if (anchorEnd === null) anchorEnd = Math.max(0, total - scroll);
    end = Math.min(anchorEnd, total);
  }
  if (total <= avail) {
    scroll = 0;
    anchorEnd = null;
    end = total;
  }
  const start = Math.max(0, end - avail);
  return { lines: out.slice(start, end), scroll, anchorEnd };
}

// ── the input line ──────────────────────────────────────────────────────────

/**
 * The visible text of the input row. A pasted multi-line buffer collapses to a
 * one-line preview ("head … (+N lines)") while `editor.buf` keeps the full
 * text, so submit still sends everything — a raw '\n' painted into a one-row
 * input would move the terminal to a new line mid-paint.
 */
function inputPreviewText(buf) {
  const nl = buf.indexOf('\n');
  if (nl === -1) return buf;
  const n = buf.split('\n').length - 1;
  return `${buf.slice(0, nl)} … (+${n} line${n === 1 ? '' : 's'})`;
}

/** Cells available to the input buffer (2 for "❯ ", 1 spare). */
const inputRowCells = (cols) => Math.max(1, cols - 3);

const bufCells = (buf) => [...buf].reduce((a, ch) => a + w(ch), 0);

function cursorCells(buf, cursor) {
  const arr = [...buf];
  let n = 0;
  for (let i = 0; i < Math.min(cursor, arr.length); i++) n += w(arr[i]);
  return n;
}

/**
 * Horizontal viewport for the input row, so the buffer scrolls once it is wider
 * than the row instead of running off the right edge while the user types.
 */
function inputScroll(buf, cursor, cols) {
  const avail = inputRowCells(cols);
  const bw = bufCells(buf);
  if (bw <= avail) return 0;
  // The '…' indicator occupies a cell, so the visible window is one narrower
  // once scrolling starts; without this the cursor parks past the last glyph.
  const vis = avail - 1;
  return Math.max(0, Math.min(cursorCells(buf, cursor) - vis, bw - vis));
}

/** First codepoint index of the visible window for a scroll offset. */
function inputStart(buf, scroll) {
  const arr = [...buf];
  let cells = 0;
  for (let i = 0; i < arr.length; i++) {
    if (cells >= scroll) return i;
    cells += w(arr[i]);
  }
  return arr.length;
}

/**
 * The input row as span lines.
 * @returns {{line:Array, cursorCol:number}}
 */
function inputLine(state, cols, ctx) {
  const t = themeOf(ctx);
  const line = [span(t.gray, GLYPH.cursor), span('', ' '), span('', ' ')];
  if (state.inputPrompt) {
    line.push(span(t.white, `${state.inputPrompt.title}: `));
    for (const ch of [...state.inputPrompt.buf]) line.push(span(t.white, ch));
    const col = Math.min(3 + w(state.inputPrompt.title) + 2 + w(state.inputPrompt.buf), cols);
    return { line: padLine(line, cols), cursorCol: col };
  }
  if (state.working) {
    // During generation the input line stays empty (the spinner lives above).
    return { line: padLine(line, cols), cursorCol: 3 };
  }
  const buf = state.buf || '';
  if (!buf.length) {
    if (state.insertMode) return { line: padLine(line, cols), cursorCol: 3 };
    const sug = SUGGESTIONS[(state.suggestionIdx || 0) % SUGGESTIONS.length];
    line.push(span(t.white + BOLD, `Try "${sug}"`), span(BOLD_OFF, ''));
    return { line: padLine(line, cols), cursorCol: 3 };
  }
  if (buf.includes('\n')) {
    const preview = inputPreviewText(buf);
    for (const ch of [...preview]) line.push(span(t.white, ch));
    return { line: padLine(line, cols), cursorCol: Math.min(3 + w(preview), cols) };
  }
  const scroll = inputScroll(buf, state.cursor, cols);
  const start = inputStart(buf, scroll);
  if (scroll > 0) line.push(span(t.dim, '…'));
  const chars = [...buf];
  for (let i = start; i < chars.length; i++) line.push(span(t.white, chars[i]));
  const visBefore = chars.slice(start, Math.min(state.cursor, chars.length)).join('');
  const col = Math.min(3 + (scroll > 0 ? 1 : 0) + w(visBefore), cols);
  return { line: padLine(line, cols), cursorCol: col };
}

// ── the session ─────────────────────────────────────────────────────────────

/**
 * Drive a full-screen chat session.
 *
 * `host` — the app's side of the contract:
 *   ctx                     live mutable session context ({model, effort, vim, light, …})
 *   version                 string
 *   transcript              the shared row array (also the engine's history source)
 *   session                 live tallies ({turns, calls, tokens, inputTokens, outputTokens, cost, balance})
 *   client                  the thin transport
 *   ask(prompt, {history, presenter}) -> Promise<{text, usage, model, ms, interrupted}>
 *   makeCommandContext()    -> the frozen `c` (this loop overrides the IO fields)
 *   buildState()            -> a snapshot for panels.js
 *   dispatchLine(line, c)   -> Promise<false|void>; false ends the session
 *   refreshSpend()          -> Promise<{balance, lastCost}|null>
 *   updateConfig(patch)
 *   wantsExit()             -> bool (set by a handler's c.exit())
 *
 * @returns {Promise<number>} exit code
 */
async function runSession(host) {
  const ctx = host.ctx;

  const editor = new LineEditor();
  const transcript = host.transcript;
  const lineCache = new WeakMap();

  let overlay = null;
  let working = false;
  let abort = null;
  let spinnerFrame = 0;
  let spinnerTimer = null;
  let startedAt = 0;
  let verb = VERBS[0];
  let turnCount = 0;
  let toolSeq = 0;
  let suggestionIdx = 0;
  let scroll = 0;
  let anchorEnd = null;
  let insertMode = false;
  let hintUntil = 0;
  let hintText = '';
  let inputPrompt = null;
  let streamJob = null;
  let streamStartedAt = 0;
  let tabCycle = null;

  // ── rendering ──
  let renderPending = false;
  let lastPaintAt = 0;

  const setTitle = (text, spinning) => {
    const frame = spinning ? TITLE_SPIN[Math.floor(spinnerFrame / 2) % TITLE_SPIN.length] : '';
    try {
      process.stdout.write(`\x1b]0;${frame ? `${frame} ` : ''}${text}\x07`);
    } catch {
      /* not a TTY */
    }
  };

  const buildFrame = () => {
    const { cols, rows } = getSize();
    const lines = [];
    lines.push(headerLine(host.version, cols, ctx));
    const avail = Math.max(1, rows - 6);
    const view = transcriptLines(transcript, { cols, rows, scroll, anchorEnd }, ctx, Date.now(), lineCache);
    scroll = view.scroll;
    anchorEnd = view.anchorEnd;
    for (const l of view.lines) lines.push(l);
    // Exactly `avail` transcript rows, so the frame is exactly `rows` lines:
    // header(1) + transcript(avail) + spinner/effort + rule + input + rule +
    // status = rows. The input row's 1-based position is therefore rows - 2.
    while (lines.length < avail + 1) lines.push([span('', '')]);
    const t = themeOf(ctx);
    if (working) {
      lines.push(
        spinnerLine(
          { verb, frame: spinnerFrame, elapsedMs: Date.now() - startedAt, streamed: streamedCells() },
          ctx
        )
      );
    } else if (Date.now() < hintUntil) {
      lines.push([span(t.gray, ` ${hintText}`)]);
    } else if (streamJob) {
      const secs = Math.max(1, Math.round((Date.now() - streamStartedAt) / 1000));
      lines.push([span(t.gray, ` ${streamJob.label || 'running'}… (${secs}s · esc to stop)`)]);
    } else {
      lines.push(effortLine(ctx, cols));
    }
    lines.push(separatorLine(cols, ctx));
    const inp = inputLine(
      { buf: editor.buf, cursor: editor.cursor, working, insertMode, suggestionIdx, inputPrompt },
      cols,
      ctx
    );
    lines.push(inp.line);
    lines.push(separatorLine(cols, ctx));
    lines.push(statusLine({ working, inputPrompt, streamJob, yolo: host.isYolo && host.isYolo() }, cols, ctx));
    return { lines, inputCol: inp.cursorCol, rows, inputRow: rows - 2 };
  };

  const render = () => {
    if (isKeyStreamSuspended()) return;
    const cols = getSize().cols;
    const { lines, inputCol, rows, inputRow } = buildFrame();
    if (overlay) applyOverlay(lines, rows, cols);
    paint(lines);
    lastPaintAt = Date.now();
    if (overlay) {
      hideCursor();
      return;
    }
    if (inputPrompt || !working) {
      moveTo(inputRow, inputCol);
      showCursor();
    } else {
      hideCursor();
    }
  };

  const scheduleRender = () => {
    if (renderPending) return;
    renderPending = true;
    const wait = Math.max(0, FRAME_MS - (Date.now() - lastPaintAt));
    setTimeout(() => {
      renderPending = false;
      render();
    }, wait);
  };

  const applyOverlay = (lines, termRows, cols) => {
    if (!overlay) return;
    let ol = null;
    if (overlay.type === 'palette') {
      ol = overlays.renderPalette(host.visibleCommands(), { query: paletteQuery(overlay.query), sel: overlay.sel }, cols, termRows);
    } else if (overlay.type === 'model') {
      ol = overlays.renderModelPicker(overlay.items || [], overlay.sel || 0, cols, termRows, overlay.current);
    } else if (overlay.type === 'effort') {
      ol = overlays.renderEffortPicker(overlay.sel || 0, cols, ctx.effort);
    } else if (overlay.type === 'resume') {
      ol = overlays.renderResumeList(overlay.items || [], overlay.sel || 0, cols, termRows);
    } else if (overlay.type === 'shortcuts') {
      ol = shortcutsGrid(cols, ctx);
    } else if (overlay.type === 'confirm') {
      ol = confirmLines(overlay, cols, ctx);
    } else if (overlay.type === 'panel') {
      ol = overlay.lines || [];
    }
    if (!ol) return;
    if (overlay.type === 'shortcuts') {
      const start = Math.max(2, termRows - ol.length - 1);
      for (let i = 0; i < ol.length; i++) lines[start + i] = padLine(ol[i], cols);
      hideCursor();
      return;
    }
    const start = Math.max(2, Math.floor((termRows - ol.length) / 2));
    for (let i = 0; i < ol.length; i++) lines[start + i] = padLine(ol[i], cols);
    hideCursor();
  };

  // ── transcript rows ──

  const push = (msg, o) => {
    transcript.push(msg);
    if (!o || o.follow !== false) {
      scroll = 0;
      anchorEnd = null;
    }
    return msg;
  };

  const note = (text) => push({ role: 'note', text }, { follow: false });

  let streamedChars = 0;
  const streamedCells = () => streamedChars;

  // ── the turn ──

  const confirmTool = (info) =>
    new Promise((resolve) => {
      overlay = { type: 'confirm', name: info.tool || info.name || 'tool', args: info.args || {}, sel: 0, info };
      render();
      (async () => {
        for (;;) {
          const key = await nextKey();
          if (key.name === KEY.UP || key.name === KEY.DOWN || key.name === KEY.TAB) {
            overlay.sel = 1 - overlay.sel;
            render();
          } else if (key.name === KEY.ENTER) {
            const yes = overlay.sel === 0;
            overlay = null;
            render();
            resolve(yes ? 'allow' : 'deny');
            return;
          } else if (key.name === KEY.ESC || key.name === KEY.CTRL_C) {
            overlay = null;
            render();
            resolve('deny');
            return;
          } else if (key.name === 'char') {
            const ch = String(key.ch).trim();
            if (ch === '1') {
              overlay = null;
              render();
              resolve('allow');
              return;
            }
            if (ch === '2') {
              overlay = null;
              render();
              resolve('deny');
              return;
            }
          }
        }
      })();
    });

  const startResponse = async (prompt) => {
    working = true;
    spinnerFrame = 0;
    startedAt = Date.now();
    streamedChars = 0;
    toolSeq = 0;
    verb = VERBS[turnCount % VERBS.length];
    abort = new AbortController();
    spinnerTimer = setInterval(() => {
      spinnerFrame++;
      setTitle('AEGIS Code', true);
      if (spinnerFrame % 3 === 0) render();
    }, 100);
    if (spinnerTimer.unref) spinnerTimer.unref();

    push({ role: 'user', text: prompt });
    const msg = push({ role: 'assistant', text: '', streaming: true });

    const presenter = {
      text: (delta) => {
        msg.text += delta;
        streamedChars += w(delta);
        scheduleRender();
      },
      reasoning: () => {},
      tool: (tool) => {
        if (tool.phase === 'run') {
          const n = ++toolSeq;
          const prefix = tool.agent ? `${tool.agent} ▸ ` : '';
          push(
            {
              role: 'tool',
              phase: 'run',
              name: tool.name,
              args: tool.args,
              agent: tool.agent,
              id: tool.id,
              label: `Running ${n} ${prefix}${toolLabel(tool.name, n)}…`,
              start: Date.now(),
            },
            { follow: false }
          );
        } else {
          resolveToolDone(transcript, tool);
        }
        scheduleRender();
      },
      approval: (info) => confirmTool(info),
    };

    let result = null;
    try {
      result = await host.ask(prompt, {
        history: historyPairs(transcript),
        presenter,
        signal: abort.signal,
      });
    } catch (err) {
      result = { error: (err && err.message) || String(err) };
    } finally {
      msg.streaming = false;
      working = false;
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      setTitle('AEGIS Code', false);
      const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const abortedFlag = !!(abort && abort.signal.aborted);
      msg.text = finalizeTurnText(msg.text, { aborted: abortedFlag, error: result && result.error });
      push({ role: 'done', text: `${toolSeq > 0 ? DONE_VERBS[1] : DONE_VERBS[0]} for ${secs}s` }, { follow: false });
      suggestionIdx = turnCount + 1;
      turnCount++;
      abort = null;

      // Accounting: fold the turn's usage into the session tallies, ask the
      // ledger what it settled at, and show both — tokens beside €.
      host.recordTurn(result);
      // Persist the finished exchange for /resume. Guarded: the test host stub
      // deliberately omits persistTurn, and the accounting below must still run.
      if (host.persistTurn) {
        host.persistTurn(prompt, result, abortedFlag ? 'stopped' : (result && result.error) ? 'error' : 'done');
      }
      let lastCost = null;
      try {
        const spend = await host.refreshSpend();
        lastCost = spend ? spend.lastCost : null;
      } catch {
        /* accounting must never break a turn */
      }
      const usage = result && result.usage;
      const tokens = host.tokensFor ? host.tokensFor(usage) : null;
      push(
        {
          role: 'meta',
          meta: {
            model: result && result.model,
            tokens,
            input: usage ? usage.input_tokens ?? usage.prompt_tokens : null,
            output: usage ? usage.output_tokens ?? usage.completion_tokens : null,
            eur: lastCost,
            ms: result && result.ms,
            calls: (result && result.calls) || 1,
          },
        },
        { follow: false }
      );
      render();
    }
  };

  // ── inline input (askInput) ──

  const askInput = (title) =>
    new Promise((resolve) => {
      inputPrompt = { title, buf: '' };
      render();
      (async () => {
        for (;;) {
          const key = await nextKey();
          if (!inputPrompt) {
            resolve(null);
            return;
          }
          if (key.name === KEY.ESC || key.name === KEY.CTRL_C || key.name === KEY.CTRL_D) {
            inputPrompt = null;
            render();
            resolve(null);
            return;
          }
          if (key.name === KEY.ENTER) {
            const value = inputPrompt.buf;
            inputPrompt = null;
            render();
            resolve(value);
            return;
          }
          if (key.name === KEY.BACKSPACE) {
            inputPrompt.buf = [...inputPrompt.buf].slice(0, -1).join('');
          } else if (key.name === 'char') {
            inputPrompt.buf += key.ch;
          } else if (key.name === 'paste') {
            inputPrompt.buf += String(key.text).replace(/\n/g, ' ');
          }
          render();
        }
      })();
    });

  const withWorking = async (fn) => {
    const prev = abort;
    working = true;
    spinnerFrame = 0;
    startedAt = Date.now();
    verb = VERBS[turnCount % VERBS.length];
    abort = new AbortController();
    spinnerTimer = setInterval(() => {
      spinnerFrame++;
      if (spinnerFrame % 3 === 0) render();
    }, 100);
    if (spinnerTimer.unref) spinnerTimer.unref();
    try {
      return await fn(abort.signal);
    } finally {
      working = false;
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      abort = prev;
      render();
    }
  };

  // ── the command context this loop owns ──

  const makeContext = () => {
    const c = host.makeCommandContext();
    Object.assign(c, {
      push: (row, o) => {
        push(row, o);
        render();
      },
      note: (text) => {
        push({ role: 'note', text });
        render();
      },
      panel: (lines) => {
        push({ role: 'panel', lines: lines || [] });
        render();
      },
      render: () => render(),
      openOverlay: (o) => {
        overlay = o;
        render();
      },
      closeOverlay: () => {
        overlay = null;
        showCursor();
        render();
      },
      askInput: (title) => askInput(title),
      withWorking: (fn) => withWorking(fn),
      runPrompt: async (text) => {
        await startResponse(text);
      },
      state: () => host.buildState(),
      setInput: (text) => {
        editor.buf = String(text == null ? '' : text);
        editor.end();
        render();
      },
      exit: () => host.requestExit(),
      openStream: (job) => {
        streamJob = job || null;
        streamStartedAt = Date.now();
        render();
      },
      closeStream: (job) => {
        if (!job || streamJob === job) streamJob = null;
        render();
      },
      showThemePicker: () => {
        // The app owns the real picker (the 7-row onboarding screen on a TTY,
        // the light/dark toggle off one). The loop only repaints after it — the
        // old inline toggle hardcoded themeIndex 0/1, which no longer names
        // Light/Dark in theme.js's THEME_TABLE (2 is "Light mode").
        if (host.showThemePicker) host.showThemePicker();
        render();
      },
    });
    return c;
  };

  // ── live scroll while a turn runs ──

  const applyLiveScroll = (key) => {
    let d = null;
    if (key.name === KEY.PAGE_UP) d = +5;
    else if (key.name === KEY.PAGE_DOWN) d = -5;
    else if (key.name === 'wheel') d = key.dir === 'up' ? +3 : -3;
    else if (key.name === 'char' && ctx.vim && !insertMode && !editor.buf) {
      if (key.ch === 'j') d = +1;
      else if (key.ch === 'k') d = -1;
    }
    if (d === null) return false;
    scroll = Math.max(0, scroll + d);
    anchorEnd = null;
    scheduleRender();
    return true;
  };

  // ── mid-turn key drain ──
  // The loop awaits a turn inline, so it is NOT parked on nextKey() while the
  // model works. drainWhileWorking keeps it alive by polling for keys: Esc /
  // Ctrl-C abort the active controller, scroll keys act live, everything else
  // is replayed into the queue afterwards so typed-ahead text still lands.
  const drainWhileWorking = (promise, getAbort) => {
    const replay = [];
    let settled = false;
    let result;
    let error;
    promise.then(
      (v) => {
        settled = true;
        result = v;
      },
      (e) => {
        settled = true;
        error = e;
      }
    );
    return (async () => {
      while (!settled) {
        if (!working || (overlay && overlay.type === 'confirm')) {
          await new Promise((r) => setTimeout(r, 60));
          continue;
        }
        const key = await nextKeyTimeout(120);
        if (key === null) continue;
        if (key.name === KEY.ESC || key.name === KEY.CTRL_C) {
          const controller = getAbort && getAbort();
          if (controller) controller.abort();
        } else if (!applyLiveScroll(key)) {
          replay.push(key);
        }
      }
      requeueKeys(replay);
      if (error) throw error;
      return result;
    })();
  };

  const runGuarded = async (fn, getAbort) => {
    try {
      return await drainWhileWorking(fn(), getAbort);
    } catch (err) {
      push({ role: 'note', text: `Error: ${(err && err.message) || String(err)}` }, { follow: false });
      render();
      return undefined;
    }
  };

  // ── key handling on the idle input line ──

  const completeTab = () => {
    const buf = editor.buf;
    if (!buf.startsWith('/') || buf.includes(' ')) return false;
    const q = buf.slice(1);
    const cands = host
      .visibleCommands()
      .flatMap((c) => [c.name, ...(c.aliases || [])])
      .filter((n) => n.startsWith(q))
      .sort();
    if (!cands.length) return false;
    if (!tabCycle || tabCycle.q !== q) tabCycle = { q, i: -1 };
    tabCycle.i = (tabCycle.i + 1) % cands.length;
    editor.buf = '/' + cands[tabCycle.i];
    editor.end();
    return true;
  };

  // The number of rows the active overlay currently renders, so DOWN can clamp
  // the highlight to the last row instead of running off the end of the list.
  const overlayRowCount = () => {
    if (!overlay) return 0;
    if (overlay.type === 'palette') {
      return fuzzy.fuzzyRankWithAliases(
        paletteQuery(overlay.query),
        host.visibleCommands(),
        (c) => c.name,
        (c) => c.aliases || []
      ).length;
    }
    if (overlay.type === 'model' || overlay.type === 'resume') return (overlay.items || []).length;
    if (overlay.type === 'effort') return 3;
    return 0;
  };

  const handleOverlayKey = async (key) => {
    const type = overlay.type;
    if (key.name === KEY.ESC || key.name === KEY.CTRL_C) {
      overlay = null;
      render();
      return;
    }
    if (type === 'shortcuts' || type === 'panel') {
      overlay = null;
      render();
      return;
    }
    if (key.name === KEY.TAB && type === 'palette') {
      // Tab completes the query to the highlighted command, ranking with the
      // same function the palette rendered with so the row completed is the
      // row Enter would run. Nothing highlighted (no matches) → do nothing.
      const list = fuzzy.fuzzyRankWithAliases(
        paletteQuery(overlay.query),
        host.visibleCommands(),
        (c) => c.name,
        (c) => c.aliases || []
      );
      const chosen = list[overlay.sel || 0];
      if (chosen) {
        overlay.query = chosen.name;
        overlay.sel = 0;
        render();
      }
      return;
    }
    if (key.name === KEY.ENTER) {
      if (type === 'palette') {
        // Rank with the same function the palette rendered with, so the row
        // highlighted is the row Enter runs.
        const list = fuzzy.fuzzyRankWithAliases(
          paletteQuery(overlay.query),
          host.visibleCommands(),
          (c) => c.name,
          (c) => c.aliases || []
        );
        const chosen = list[overlay.sel || 0];
        const arg = String(overlay.query || '').trim().split(/\s+/).slice(1).join(' ');
        overlay = null;
        render();
        if (chosen) {
          await dispatch(arg ? `/${chosen.name} ${arg}` : `/${chosen.name}`);
        }
        return;
      }
      if (type === 'model') {
        const chosen = (overlay.items || [])[overlay.sel || 0];
        overlay = null;
        if (chosen) {
          ctx.model = chosen.id;
          host.updateConfig({ model: chosen.id });
          note(`model: ${chosen.id}`);
        }
        render();
        return;
      }
      if (type === 'effort') {
        const levels = ['low', 'medium', 'high'];
        const chosen = levels[overlay.sel || 0];
        overlay = null;
        ctx.effort = chosen;
        host.updateConfig({ effort: chosen });
        note(`effort: ${chosen}`);
        render();
        return;
      }
      if (type === 'resume') {
        const chosen = (overlay.items || [])[overlay.sel || 0];
        overlay = null;
        render();
        if (chosen && host.resumeSession) await host.resumeSession(chosen);
        return;
      }
      overlay = null;
      render();
      return;
    }
    if (key.name === KEY.UP) {
      overlay.sel = Math.max(0, (overlay.sel || 0) - 1);
      render();
      return;
    }
    if (key.name === KEY.DOWN) {
      const max = Math.max(0, overlayRowCount() - 1);
      overlay.sel = Math.min(max, (overlay.sel || 0) + 1);
      render();
      return;
    }
    if (key.name === 'char') {
      if (type === 'palette') {
        overlay.query = (overlay.query || '') + key.ch;
        overlay.sel = 0;
        render();
        return;
      }
      if (type === 'model') {
        const idx = parseInt(key.ch, 10);
        const items = overlay.items || [];
        if (Number.isFinite(idx) && idx >= 1 && idx <= items.length) {
          overlay.sel = idx - 1;
          render();
        }
        return;
      }
      if (type === 'effort' || type === 'resume') {
        const idx = parseInt(key.ch, 10);
        if (Number.isFinite(idx) && idx >= 1) {
          overlay.sel = idx - 1;
          render();
        }
        return;
      }
    }
    if (key.name === KEY.BACKSPACE && type === 'palette') {
      overlay.query = String(overlay.query || '').slice(0, -1);
      render();
    }
  };

  const handleKey = async (key) => {
    if (overlay) {
      await handleOverlayKey(key);
      return;
    }
    // A bare '/' opens the palette and a bare '?' the shortcuts grid — the
    // reference opens both on the keystroke (main.js:1542-1543), not after
    // Enter. With text already in the line both insert literally, so '/model'
    // and 'why?' still type.
    if (key.name === 'char' && !editor.buf) {
      if (key.ch === '/') {
        overlay = { type: 'palette', query: '', sel: 0 };
        render();
        return;
      }
      if (key.ch === '?') {
        overlay = { type: 'shortcuts' };
        render();
        return;
      }
    }
    // vim normal-mode motions (only when the buffer is empty, so j/k do not
    // fight typed text).
    if (ctx.vim && !insertMode && !editor.buf && key.name === 'char') {
      const ch = key.ch;
      if (ch === 'i' || ch === 'a' || ch === 'o' || ch === 's' || ch === 'S') {
        if (ch === 's') editor.substChar();
        if (ch === 'S') editor.substLine();
        if (ch === 'a') editor.right();
        insertMode = true;
        render();
        return;
      }
      if (ch === 'h') {
        editor.left();
        render();
        return;
      }
      if (ch === 'l') {
        editor.right();
        render();
        return;
      }
      if (ch === '0') {
        editor.home();
        render();
        return;
      }
      if (ch === '$') {
        editor.end();
        render();
        return;
      }
      if (ch === 'x') {
        editor.delete();
        render();
        return;
      }
      if (ch === 'D') {
        editor.killToEnd();
        render();
        return;
      }
      if (ch === 'A') {
        editor.end();
        insertMode = true;
        render();
        return;
      }
      if (applyLiveScroll(key)) return;
    } else if (ctx.vim && insertMode && key.name === KEY.ESC) {
      insertMode = false;
      if (editor.cursor > 0) editor.cursor--;
      render();
      return;
    }

    if (key.name === KEY.ENTER) {
      const text = editor.submit();
      tabCycle = null;
      insertMode = false;
      if (!text) {
        render();
        return;
      }
      await dispatch(text);
      return;
    }
    if (key.name === 'paste') {
      if (ctx.vim) insertMode = true;
      editor.insert(String(key.text));
      render();
      return;
    }
    if (key.name === 'char') {
      if (ctx.vim && !insertMode) {
        // A printable key in normal mode is not typed text; ignore it (the
        // user must press i/a first), matching the reference keymap.
        render();
        return;
      }
      editor.insert(key.ch);
      render();
      return;
    }
    if (key.name === KEY.BACKSPACE) {
      editor.backspace();
      render();
      return;
    }
    if (key.name === KEY.DELETE) {
      editor.delete();
      render();
      return;
    }
    if (key.name === KEY.LEFT || key.name === KEY.CTRL_LEFT) {
      if (key.name === KEY.CTRL_LEFT) editor.wordBack();
      else editor.left();
      render();
      return;
    }
    if (key.name === KEY.RIGHT || key.name === KEY.CTRL_RIGHT) {
      editor.right();
      render();
      return;
    }
    if (key.name === KEY.HOME || key.name === KEY.CTRL_A) {
      editor.home();
      render();
      return;
    }
    if (key.name === KEY.END || key.name === KEY.CTRL_E) {
      editor.end();
      render();
      return;
    }
    if (key.name === KEY.UP) {
      editor.historyUp();
      render();
      return;
    }
    if (key.name === KEY.DOWN) {
      editor.historyDown();
      render();
      return;
    }
    if (key.name === KEY.TAB) {
      // completeTab cycles command names; when it finds nothing, flash the
      // reference's hint in the idle line — the alt+t nudge on an empty buffer,
      // a "Tab completes" reminder once text is typed (main.js:1598-1606).
      // hintUntil/hintText were declared and rendered but never set.
      if (!completeTab()) {
        hintText = editor.buf ? 'Tab completes commands' : 'Use alt+t to toggle thinking';
        hintUntil = Date.now() + 2500;
        setTimeout(() => {
          if (Date.now() >= hintUntil) render();
        }, 2600);
      }
      render();
      return;
    }
    if (key.name === KEY.CTRL_U) {
      editor.buf = '';
      editor.cursor = 0;
      render();
      return;
    }
    if (key.name === KEY.CTRL_K) {
      editor.killToEnd();
      render();
      return;
    }
    if (key.name === KEY.CTRL_W) {
      // Word-rubout: step the cursor back a word, no deletion — the reference's
      // Ctrl+W (main.js:1624). LineEditor.wordBack is the method that exists.
      editor.wordBack();
      render();
      return;
    }
    if (key.name === KEY.CTRL_L) {
      clearScreen();
      render();
      return;
    }
    if (key.name === KEY.CTRL_T) {
      note(host.tokenSummary ? host.tokenSummary() : 'no token usage yet this session');
      render();
      return;
    }
    if (key.name === KEY.CTRL_R) {
      await dispatch('/resume');
      return;
    }
    if (key.name === KEY.CTRL_O) {
      // Keybinding parity: Ctrl+O opens the permissions panel (main.js:1644),
      // which /permissions already renders in this CLI.
      await dispatch('/permissions');
      return;
    }
    if (key.name === KEY.PAGE_UP || key.name === KEY.PAGE_DOWN || key.name === 'wheel') {
      applyLiveScroll(key);
      return;
    }
    if (key.name === 'alt' && key.ch === 'p') {
      await dispatch('/model');
      return;
    }
    if (key.name === 'alt' && key.ch === 't') {
      // Toggle extended thinking, using the same shape/value as /thinking so
      // the chord and the command cannot disagree (commands.js: thinking).
      const want = !(ctx.thinking === true);
      ctx.thinking = want;
      host.updateConfig({ thinking: want });
      note(`Thinking blocks: ${want ? 'expanded' : 'collapsed'}`);
      render();
      return;
    }
    if (key.name === KEY.ESC) {
      // A bare Esc on an idle line clears it (readline's rule; the reference
      // clears the buffer, main.js:1675). The vim insert-mode Esc above is a
      // distinct motion and must not be shadowed by this.
      if (editor.buf) {
        editor.buf = '';
        editor.cursor = 0;
        render();
      }
      return;
    }
    if (key.name === KEY.CTRL_C) {
      if (editor.buf) {
        editor.buf = '';
        editor.cursor = 0;
        render();
        return;
      }
      await endSession();
      return;
    }
    if (key.name === KEY.CTRL_D) {
      // Ctrl+D is EOF: it ends the session only on an empty line. With text in
      // the buffer the reference never deletes-forward (main.js:1673), so a
      // stray Ctrl+D must neither drop a character nor kill the session.
      if (!editor.buf) await endSession();
      return;
    }
  };

  // ── dispatch ──

  const dispatch = async (line) => {
    const trimmed = String(line || '').trim();
    if (trimmed === '?') {
      overlay = { type: 'shortcuts' };
      render();
      return;
    }
    const keep = await runGuarded(async () => {
      if (trimmed.startsWith('/')) {
        const c = makeContext();
        return host.dispatchLine(trimmed, c);
      }
      await startResponse(trimmed);
      return true;
    }, () => abort);
    if (keep === false || host.wantsExit()) await endSession();
  };

  // ── lifecycle ──

  let ended = false;
  let resolveExit = null;
  const endSession = () => {
    if (ended) return;
    ended = true;
    if (resolveExit) resolveExit(0);
  };

  const cleanup = () => {
    hideCursor();
    // Blank the alt screen so the shell we hand back is not left holding a
    // half-painted frame if the terminal ignores the leave sequence.
    paint([]);
    try {
      process.stdout.write('\x1b[0m');
    } catch {
      /* not a TTY */
    }
    try {
      process.stdout.write('\x1b]0;\x07');
    } catch {
      /* not a TTY */
    }
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* not a TTY */
    }
    disableBracketedPaste();
    disableMouseTracking();
    leaveAltScreen();
  };

  // Enter the alternate screen and take over the terminal. `host.stdin` exists
  // so the loop can be driven from a test with a synthetic key stream.
  const stdin = host.stdin || process.stdin;
  attachKeyStream(stdin);
  enableBracketedPaste();
  enableMouseTracking();
  enterAltScreen();
  clearScreen();
  hideCursor();
  setTitle('AEGIS Code', false);

  const onResize = () => render();
  if (process.platform !== 'win32') process.on('SIGWINCH', onResize);
  else process.stdout.on('resize', onResize);

  const onSigint = () => {
    if (working && abort) {
      abort.abort();
      return;
    }
    endSession();
  };
  process.on('SIGINT', onSigint);

  const crash = (err) => {
    cleanup();
    try {
      process.stderr.write(
        `\nAEGIS Code hit an unexpected error. Your transcript is saved; rerun to continue.\n${
          (err && err.stack) || err
        }\n`
      );
    } catch {
      /* ignore */
    }
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);

  render();

  try {
    const code = await new Promise((resolve) => {
      resolveExit = resolve;
      (async () => {
        while (!ended) {
          const key = await nextKey();
          if (ended) break;
          try {
            await handleKey(key);
          } catch (err) {
            push({ role: 'note', text: `Error: ${(err && err.message) || String(err)}` }, { follow: false });
            render();
          }
        }
      })();
    });
    return code;
  } finally {
    ended = true;
    process.off('SIGINT', onSigint);
    if (process.platform !== 'win32') process.off('SIGWINCH', onResize);
    else process.stdout.off('resize', onResize);
    process.off('uncaughtException', crash);
    process.off('unhandledRejection', crash);
    cleanup();
    resetKeyStream();
  }
}

module.exports = {
  // pure helpers (unit-testable without a TTY)
  SUGGESTIONS,
  TITLE_SPIN,
  FRAME_MS,
  toolLabel,
  resolveToolDone,
  finalizeTurnText,
  historyPairs,
  paletteQuery,
  headerLine,
  separatorLine,
  effortLine,
  spinnerLine,
  statusLine,
  shortcutsGrid,
  confirmLines,
  rowLines,
  transcriptLines,
  inputPreviewText,
  inputRowCells,
  inputScroll,
  inputStart,
  inputLine,
  // the loop
  runSession,
};
