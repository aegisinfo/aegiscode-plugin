'use strict';

/**
 * The CLI application: session state, the ask/stream path, and the command
 * dispatcher.
 *
 * Split from `bin/aegiscode.js` so the whole app is constructible with injected
 * IO (`out`, `err`, `readline`) and a stub client — the tests drive real turns,
 * real streaming and real command dispatch without a TTY and without a child
 * process. Bin entry = argument parsing and process lifecycle; everything else
 * lives here.
 *
 * Commands come from `./commands.js`. Each entry is either handler-backed
 * (`cmd.handler(c, args)`, the reference aegiscodex-dev contract), tool-backed
 * (`cmd.tool` + `cmd.build`), a generic escape hatch (`cmd.generic`, `/tool`),
 * or `unavailable` (a Claude Code auth-loop command this client cannot honour).
 * Handlers run against the FROZEN command context built below; the tool path
 * and the `/tool` escape hatch are unchanged from the previous revision.
 */

const readline = require('node:readline');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createTools, createClient, usageTokens } = require('./deps.js');
const { createEngine } = require('./engine.js');
const { GLYPH, VERBS, themeOf, RESET } = require('./theme.js');
const { LiveRegion, termWidth, w } = require('./screen.js');
const { parseLine, COMMANDS, visibleCommands } = require('./commands.js');
const { updateConfig, loadPermissions } = require('./config.js');
const { readSessionTranscript } = require('./history.js');
const chatflow = require('./chatflow.js');
const overlays = require('./overlays.js');
const render = require('./render.js');
const { fmtTokens, fmtEur, maskKey } = require('./format.js');

const VERSION = require('../package.json').version;

function createApp(options = {}) {
  const opts = {
    model: null,
    stream: true,
    light: false,
    maxTokens: undefined,
    system: undefined,
    interactive: true,
    ...options,
  };
  const out = options.out || process.stdout;
  const err = options.err || process.stderr;
  const client = options.client || createClient();
  const { TOOLS, toolList } = options.tools || createTools(client);

  // Tool-approval gate (exec/writeFile/editFile confirm before running).
  // Read per call, so /permissions and /yolo take effect on the very next tool
  // round rather than needing a restart. The mode is read LIVE from the
  // permission store rather than from a boolean captured at construction:
  // `/yolo` and `/confirm` write the store, so a captured flag made both
  // commands cosmetic — the panel changed while the engine kept asking.
  let confirmMode = options.confirmMode !== false;
  const engine =
    options.engine ||
    createEngine({
      client,
      getConfirmMode: () => {
        if (options.confirmMode !== undefined) return confirmMode;
        try {
          return loadPermissions().defaultMode !== 'allow';
        } catch {
          return confirmMode;
        }
      },
    });
  // Set by runInteractive: a question/answer channel for the engine's
  // tool-approval requests. Left null in one-shot (-p) runs, where there is
  // no one to ask — see the approval branch in ask() below.
  let approvalPrompter = null;

  const width = () => (options.width ? options.width() : termWidth());

  // ── live session/command state ─────────────────────────────────────────────
  // `commandCtx` is the FROZEN `c.ctx` a handler receives: the mutable slice of
  // session state a command may set (model, effort, thinking, theme, vim, stream,
  // cwd, lastRecap). The renderers read their colours from it via ctx().
  const commandCtx = {
    light: opts.light,
    model: opts.model,
    effort: 'high',
    thinking: false,
    themeIndex: opts.light ? 0 : 1,
    vim: false,
    stream: opts.stream,
    cwd: process.cwd(),
    lastRecap: null,
    sessionId: randomUUID(),
  };
  // The transcript rows a handler reads/pushes (user/assistant/note/panel/…).
  // It is also the source of the engine's conversation history, so /clear and
  // /new genuinely reset context.
  const transcript = [];
  let wantExit = false;

  const ctx = () => ({ light: commandCtx.light });

  const session = {
    turns: 0,
    calls: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0, // € spent, from ledger rows observed this session
    balance: null,
    lastLedgerAt: null,
    startedAt: Date.now(),
  };

  let activeSessionId = null;
  let closed = false;

  // --- helpers --------------------------------------------------------------

  /** Refresh the balance and fold any *new* usage row into the session tally.
   *  Best-effort: an accounting refresh must never break a turn.
   *  @returns {Promise<{balance:number, lastCost:number|null}|null>} */
  async function refreshSpend() {
    try {
      const data = await client.tokenBankBalance();
      session.balance = Number(data.balance_eur || 0);
      let lastCost = null;
      const row = (data.ledger || [])[0];
      if (row && row.kind === 'usage' && row.created_at && row.created_at !== session.lastLedgerAt) {
        session.lastLedgerAt = row.created_at;
        // amount_eur is signed from the user's side (negative = spent); the
        // ledger fallback inverts the raw micros column, which has the
        // opposite sign.
        const eur = Math.abs(
          Number(row.amount_eur != null ? row.amount_eur : -Number(row.charged_micros || 0) / 1e6)
        );
        session.cost += eur;
        lastCost = eur;
      }
      return { balance: session.balance, lastCost };
    } catch {
      return null; // no balance rights / offline: keep showing tokens
    }
  }

  function bannerLines() {
    return render.renderBanner(ctx(), {
      width: width(),
      version: VERSION,
      model: commandCtx.model || 'server default',
      base: client.apiBase,
      key: maskKey(client.apiKey),
      stream: commandCtx.stream,
    });
  }

  /**
   * Write lines out. Accepts a single line as well as a block — a bare string
   * would otherwise be iterated as characters, which renders a notice one
   * character per line.
   */
  function emit(lines) {
    const block = typeof lines === 'string' ? [lines] : lines;
    for (const l of block) out.write(l + '\n');
  }

  // --- the ask path ---------------------------------------------------------

  /**
   * One turn through the agent-loop engine (persistent-shell exec,
   * readFile/writeFile/editFile/listDir/glob/grep, Task subagents), streamed
   * into the live region. `history` is every prior turn's user/assistant pair
   * — never that turn's own tool-call scratchpad, which the engine keeps
   * internally and never returns (see engine.js's `chat()`).
   * @returns {Promise<{text:string, usage:object|null, model:string|null, ms:number, interrupted:boolean}>}
   */
  async function ask(prompt, { history = [], presenter = null, signal = null } = {}) {
    const started = Date.now();
    // A presenter takes over ALL presentation (the chatflow's frame paints the
    // streaming answer into a transcript row), so the linear/inline live region
    // is only built when there is none.
    const live =
      !presenter && opts.interactive && opts.stream && out.isTTY ? new LiveRegion(out) : null;
    let tick = 0;
    let chars = 0;
    let partial = '';
    let reasoning = 0;
    let verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    let sawReasoning = false;
    let usedTools = false;

    const paint = () => {
      if (!live) return;
      live.update([
        render.renderWorking(ctx(), {
          tick: tick++,
          verb,
          elapsedMs: Date.now() - started,
          streamed: chars,
        }),
      ]);
    };

    const timer = live ? setInterval(paint, 90) : null;
    if (timer && timer.unref) timer.unref();
    paint();

    // Presentation hooks. With no presenter these reproduce the linear
    // behaviour exactly (live-region spinner, tool rows written to scrollback).
    const p = presenter || {};
    const present = {
      text: (d) => {
        if (p.text) return p.text(d);
        if (live && tick % 2 === 0) paint();
        return undefined;
      },
      reasoning: (r) => {
        if (p.reasoning) return p.reasoning(r);
        return undefined;
      },
      tool: (tool) => {
        if (p.tool) return p.tool(tool);
        if (live) live.clear();
        emit(
          render.renderTurn(
            ctx(),
            { role: 'tool', label: tool.name, args: tool.args, ok: tool.ok },
            width()
          )
        );
        paint();
        return undefined;
      },
    };

    const sessionId = randomUUID();
    activeSessionId = sessionId;
    let interrupted = false;
    // One cancel path for both callers: a SIGINT from the process, and the
    // chatflow's Esc, which aborts the controller it handed in. Without this
    // second source the full-screen loop's Esc had nothing listening to it —
    // the turn kept running and billing while the UI said "stopped".
    const cancel = () => {
      interrupted = true;
      engine.cancel(sessionId);
    };
    const onSigint = () => cancel();
    process.once('SIGINT', onSigint);
    if (signal) {
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    }

    // A denial with no one to ask it of: -p and any other run with no
    // approvalPrompter set. Fails safe (deny) rather than hanging the tool
    // round forever waiting for an answer nobody can give.
    const denyNoPrompter = (info) => {
      err.write(
        `aegiscode: ${info.tool} needs confirmation but this run has no prompt for it — denied ` +
          '(pass --yolo to auto-approve mutating tools).\n'
      );
      return Promise.resolve('deny');
    };

    const onDelta = (chunk) => {
      if (!chunk) return;
      if (chunk.reasoning) {
        reasoning += w(chunk.reasoning);
        // The pool's worker findings arrive on the reasoning channel before
        // the answer; say so rather than looking stalled.
        if (!sawReasoning) {
          sawReasoning = true;
          verb = 'Reasoning';
          paint();
        }
        present.reasoning(chunk.reasoning);
      }
      if (chunk.delta) {
        chars += w(chunk.delta);
        partial += chunk.delta;
        present.text(chunk.delta);
      }
      if (chunk.tool) {
        usedTools = true;
        present.tool(chunk.tool);
      }
      if (chunk.approval) {
        const info = chunk.approval;
        if (live) live.clear();
        const decide = p.approval || approvalPrompter || denyNoPrompter;
        Promise.resolve(decide(info))
          .catch(() => 'deny')
          .then((decision) => engine.respondApproval(info.id, decision));
      }
    };

    try {
      const res = await engine.chat(
        {
          prompt,
          messages: history,
          model: commandCtx.model || undefined,
          system: opts.system,
          maxTokens: opts.maxTokens,
          // false asks the engine for the buffered (non-stream) wire form, so
          // `--no-stream` and piped runs get a single body rather than SSE.
          stream: commandCtx.stream !== false,
          sessionId,
        },
        onDelta
      );

      const choice = (res.choices && res.choices[0]) || {};
      const text = (choice.message && choice.message.content) || partial;
      return {
        text,
        usage: res.usage || null,
        model: res.model || commandCtx.model || null,
        ms: Date.now() - started,
        interrupted,
        reasoningChars: reasoning,
        usedTools,
      };
    } catch (e) {
      // A user interrupt is not a failure: keep what already streamed.
      if (interrupted && partial) {
        return {
          text: partial,
          usage: null,
          model: commandCtx.model || null,
          ms: Date.now() - started,
          interrupted: true,
          reasoningChars: reasoning,
          usedTools,
        };
      }
      throw e;
    } finally {
      if (timer) clearInterval(timer);
      process.removeListener('SIGINT', onSigint);
      if (signal) signal.removeEventListener('abort', cancel);
      if (live) live.clear();
      activeSessionId = null;
    }
  }

  /** Print a completed turn: role block, then the accounting line. */
  function printTurn(turn) {
    emit(render.renderTurn(ctx(), turn, width()));
  }

  /** Prior user/assistant pairs from the live transcript, for the engine. */
  function historyPairs() {
    return transcript
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.text }));
  }

  /** Ask, then account for it. Shared by plain prompts and `/ask`. */
  async function runPrompt(prompt, { label = 'you' } = {}) {
    if (!prompt) {
      emit(render.renderNotice(ctx(), 'warn', 'nothing to ask — give /ask a prompt'));
      return;
    }
    if (!client.apiKey) {
      emit(
        render.renderNotice(
          ctx(),
          'error',
          'no AEGIS_API_KEY set — export one (https://aegiscloud.org) or run /byok-set'
        )
      );
      return;
    }

    const history = historyPairs();
    printTurn({ role: 'user', text: prompt, label });
    transcript.push({ role: 'user', text: prompt });

    let res;
    try {
      res = await ask(prompt, { history });
    } catch (e) {
      emit(render.renderTurn(ctx(), { role: 'error', text: e.message }, width()));
      return;
    }

    if (res.text) transcript.push({ role: 'assistant', text: res.text });

    const tokens = recordTurn(res);

    const spend = await refreshSpend();

    printTurn({
      role: 'assistant',
      text: res.text || '(the pool returned no text — see /balance for what it charged)',
      meta: {
        model: res.model,
        tokens,
        usage:
          res.usage == null
            ? null
            : {
                input: res.usage.input_tokens ?? res.usage.prompt_tokens,
                output: res.usage.output_tokens ?? res.usage.completion_tokens,
              },
        // What this call settled at, from the ledger row it produced — the
        // number that has to agree with the token count beside it.
        eur: spend && spend.lastCost != null ? spend.lastCost : null,
        ms: res.ms,
        calls: 1,
      },
    });

    if (res.interrupted) {
      emit(render.renderNotice(ctx(), 'warn', 'interrupted — the pool may still be running and billing this call'));
    }
  }

  // --- command dispatch -----------------------------------------------------

  async function runTool(name, args) {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`unknown tool: ${name}`);
    if (!client.apiKey) {
      throw new Error('no AEGIS_API_KEY set — export one (https://aegiscloud.org)');
    }
    const text = await tool.run(args || {});
    emit(render.renderToolResult(ctx(), name, text, width()));
  }

  /**
   * The nearest routable name to a mistyped one: a prefix of it, or a name it
   * is a prefix of. Deliberately simple — `cli/src/fuzzy.js` is a separate
   * workstream and may not exist, so this must not depend on it.
   */
  function nearest(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    let best = null;
    for (const c of COMMANDS) {
      for (const cand of [c.name, ...(c.aliases || [])]) {
        if (cand === n) continue;
        if (cand.startsWith(n) || n.startsWith(cand)) {
          if (best == null || Math.abs(cand.length - n.length) < Math.abs(best.length - n.length)) {
            best = cand;
          }
        }
      }
    }
    return best;
  }

  /** Tokenize one argument string, honouring single/double quotes. */
  function tokenize(s) {
    const out = [];
    let cur = '';
    let quote = null;
    let has = false;
    for (const ch of String(s || '')) {
      if (quote) {
        if (ch === quote) quote = null;
        else cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
      if (/\s/.test(ch)) {
        if (cur || has) { out.push(cur); cur = ''; has = false; }
        continue;
      }
      cur += ch;
      has = true;
    }
    if (cur || has) out.push(cur);
    return out;
  }

  /** Positional args keyed by the entry's `args` names, plus `_rest`. */
  function parseArgs(cmd, arg) {
    const raw = String(arg == null ? '' : arg);
    const names = Array.isArray(cmd.args) ? cmd.args : [];
    const tokens = tokenize(raw);
    const out = { _rest: raw.trim() };
    names.forEach((n, i) => { if (tokens[i] !== undefined) out[n] = tokens[i]; });
    return out;
  }

  /** A fresh snapshot for panels.js (the frozen `c.state()` shape). */
  function buildState() {
    const rules = loadPermissions();
    return {
      version: VERSION,
      model: commandCtx.model || 'server default',
      effort: commandCtx.effort,
      thinking: commandCtx.thinking,
      theme: commandCtx.light ? 'light' : 'dark',
      themeIndex: commandCtx.themeIndex,
      vim: commandCtx.vim,
      stream: commandCtx.stream,
      cwd: commandCtx.cwd,
      home: os.homedir(),
      sessionId: commandCtx.sessionId,
      base: client.apiBase,
      keyMask: maskKey(client.apiKey),
      online: !!client.apiKey,
      turns: session.turns,
      calls: session.calls,
      startedAt: session.startedAt,
      tokens: { input: session.inputTokens, output: session.outputTokens, total: session.tokens },
      costEur: session.cost,
      balance: session.balance,
      plan: session.plan || null,
      account: session.account || null,
      permissions: { mode: rules.defaultMode, rules },
      models: [],
      commands: visibleCommands(),
      transcript: transcript.slice(),
      sessions: [],
      memory: {},
      lastRecap: commandCtx.lastRecap,
      backend: 'aegis',
      url: client.apiBase,
    };
  }

  /** Flatten a span line (panels.js/overlays.js output) back to an ANSI row. */
  function flattenSpans(line) {
    if (!Array.isArray(line)) return String(line == null ? '' : line);
    return line.map((sp) => (sp && (sp.s || '') + (sp.t == null ? '' : sp.t)) || '').join('');
  }

  /**
   * Push one transcript row. `c.push(row)`/`c.note`/`c.panel` land here; the
   * linear CLI prints each row once to scrollback (there is no alt-screen).
   */
  function pushRow(row) {
    if (!row || typeof row !== 'object') return;
    const W = width();
    switch (row.role) {
      case 'panel': {
        const lines = Array.isArray(row.lines) ? row.lines : [];
        for (const line of lines) emit(flattenSpans(line));
        return;
      }
      case 'note': emit(render.renderNotice(ctx(), 'info', row.text)); return;
      case 'tip': emit(render.renderNotice(ctx(), 'info', row.text)); return;
      case 'done': emit(render.renderNotice(ctx(), 'ok', row.text)); return;
      case 'error': emit(render.renderNotice(ctx(), 'error', row.text)); return;
      case 'user': emit(render.renderTurn(ctx(), { role: 'user', text: row.text, label: row.label }, W)); return;
      case 'assistant': emit(render.renderTurn(ctx(), { role: 'assistant', text: row.text }, W)); return;
      case 'tool':
        emit(render.renderTurn(ctx(), { role: 'tool', label: row.label || row.name, args: row.args, ok: row.ok }, W));
        return;
      default: emit(render.renderNotice(ctx(), 'info', row.text == null ? '' : String(row.text))); return;
    }
  }

  /** A static (non-interactive) print of an overlay's contents. */
  function openOverlay(o) {
    if (!o || typeof o !== 'object') return;
    const W = width();
    const rows = Math.max(5, (process.stdout && process.stdout.rows) || 24);
    let lines = null;
    if (o.type === 'panel') lines = o.lines;
    else if (o.type === 'palette') lines = overlays.renderPalette(visibleCommands(), { query: o.query || '', sel: o.sel || 0 }, W, rows);
    else if (o.type === 'model') lines = overlays.renderModelPicker(o.items || [], o.sel || 0, W, rows, o.current != null ? o.current : commandCtx.model);
    else if (o.type === 'effort') lines = overlays.renderEffortPicker(o.sel || 0, W, commandCtx.effort);
    else if (o.type === 'resume') lines = overlays.renderResumeList(o.items || [], o.sel || 0, W, rows);
    else if (o.type === 'confirm') lines = render.renderApproval(ctx(), o.info || {}, W).map((s) => [spanRow(s)]);
    if (!lines) return;
    for (const line of lines) emit(flattenSpans(line));
  }

  /** A single-span row for a pre-styled string (renderApproval output). */
  function spanRow(s) {
    return { t: s, s: '', w: w(s) };
  }

  /** Run `fn(signal)` with the spinner up (interactive TTY only). */
  async function withWorking(fn) {
    const controller = new AbortController();
    const live = opts.interactive && out.isTTY ? new LiveRegion(out) : null;
    let timer = null;
    if (live) {
      let tick = 0;
      const started = Date.now();
      const paint = () => live.update([render.renderWorking(ctx(), { tick: tick++, verb: VERBS[0], elapsedMs: Date.now() - started })]);
      paint();
      timer = setInterval(paint, 90);
      if (timer.unref) timer.unref();
    }
    try {
      return await fn(controller.signal);
    } finally {
      if (timer) clearInterval(timer);
      if (live) live.clear();
    }
  }

  async function showThemePicker() {
    commandCtx.light = !commandCtx.light;
    commandCtx.themeIndex = commandCtx.light ? 0 : 1;
    emit(render.renderNotice(ctx(), 'ok', `theme: ${commandCtx.light ? 'light' : 'dark'}`));
  }

  /** Build the FROZEN command context `c` a handler runs against. */
  function makeCommandContext() {
    const c = {
      ctx: commandCtx,
      transcript,
      push: (row) => pushRow(row),
      note: (text) => pushRow({ role: 'note', text }),
      panel: (lines) => pushRow({ role: 'panel', lines }),
      render: () => {},
      openOverlay: (o) => openOverlay(o),
      closeOverlay: () => {},
      askInput: () => Promise.resolve(null),
      withWorking: (fn) => withWorking(fn),
      runPrompt: (text) => runPrompt(text),
      ask: (text) => ask(text),
      runTool: (name, args) => runTool(name, args),
      refreshSpend: () => refreshSpend(),
      state: () => buildState(),
      setInput: () => {},
      exit: () => { wantExit = true; },
      client,
      TOOLS,
      saveConfig: (patch) => updateConfig(patch),
      showThemePicker: () => showThemePicker(),
    };
    Object.defineProperty(c, 'sessionId', {
      enumerable: true,
      get: () => commandCtx.sessionId,
      set: (v) => { commandCtx.sessionId = v; },
    });
    return c;
  }

  /**
   * Handle one line of input. Returns false when the session should end.
   *
   * `cOverride` lets the chatflow supply the context it owns (its own `push`,
   * `render`, `openOverlay`, `askInput`, `runPrompt`) instead of the linear
   * defaults — the handlers are identical either way, which is the point.
   */
  async function handleLine(line, cOverride = null) {
    const parsed = parseLine(line);

    if (parsed.kind === 'empty') return true;
    if (parsed.kind === 'prompt') {
      await runPrompt(parsed.text);
      return true;
    }
    if (parsed.kind === 'unknown') {
      const alt = nearest(parsed.name);
      emit(
        render.renderNotice(
          ctx(),
          'error',
          `unknown command: /${parsed.name}${alt ? ` — did you mean /${alt}?` : ` — try /help`}`
        )
      );
      return true;
    }
    if (parsed.kind === 'unavailable') {
      const c = parsed.command;
      emit(render.renderNotice(ctx(), 'warn', `/${c.name} is not available in aegiscode — ${c.unavailable}`));
      if (c.alt) emit(render.renderNotice(ctx(), 'info', `try ${c.alt} instead`));
      else {
        const alt = nearest(c.name);
        if (alt) emit(render.renderNotice(ctx(), 'info', `try /${alt} instead`));
      }
      return true;
    }

    const cmd = parsed.command;
    const arg = parsed.arg;

    // The generic escape hatch (/tool <name> [json]).
    if (cmd.generic) {
      let built;
      try {
        built = cmd.build(arg);
      } catch (e) {
        emit(render.renderNotice(ctx(), 'error', e.message));
        return true;
      }
      const { tool, args } = built;
      if (!tool) {
        emit(render.renderNotice(ctx(), 'error', '/tool needs a tool name — see /help'));
        return true;
      }
      try {
        await runTool(tool, args);
      } catch (e) {
        emit(render.renderNotice(ctx(), 'error', e.message));
      }
      return true;
    }

    // Handler-backed (the reference aegiscode-dev contract).
    if (typeof cmd.handler === 'function') {
      const args = parseArgs(cmd, arg);
      const c = cOverride || makeCommandContext();
      try {
        const keep = await cmd.handler(c, args);
        return keep === false ? false : true;
      } catch (e) {
        emit(render.renderNotice(ctx(), 'error', e && e.message ? e.message : String(e)));
        return true;
      }
    }

    // Tool-backed command.
    try {
      let args = cmd.build(arg);
      if (cmd.secret) {
        const key = await readSecret(`provider key for ${args.provider}: `);
        if (!key) {
          emit(render.renderNotice(ctx(), 'warn', 'empty key — nothing sent'));
          return true;
        }
        args = { ...args, api_key: key };
      }
      if (cmd.tool === 'aegis_ask') return await runPrompt(args.prompt);
      await runTool(cmd.tool, args);
    } catch (e) {
      emit(render.renderNotice(ctx(), 'error', e.message));
    }
    return true;
  }

  /** Read a secret without echoing it (raw mode; falls back to plain input). */
  function readSecret(promptText) {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      return Promise.resolve('');
    }
    return new Promise((resolve) => {
      const t = themeOf(ctx());
      out.write(t.gray + promptText + RESET);
      const stdin = process.stdin;
      let buf = '';
      stdin.setRawMode(true);
      stdin.resume();
      const onData = (chunk) => {
        for (const ch of chunk.toString('utf8')) {
          if (ch === '\r' || ch === '\n') {
            stdin.setRawMode(false);
            stdin.removeListener('data', onData);
            out.write('\n');
            return resolve(buf);
          }
          if (ch === '\x03') {
            // ctrl+c
            stdin.setRawMode(false);
            stdin.removeListener('data', onData);
            out.write('\n');
            return resolve('');
          }
          if (ch === '\u007f') {
            buf = buf.slice(0, -1);
            out.write('\b \b');
            continue;
          }
          buf += ch;
          out.write('•');
        }
      };
      stdin.on('data', onData);
    });
  }

  // --- entry points ---------------------------------------------------------

  /** Non-interactive: one prompt, plain output, exit code. */
  async function runOnce(prompt, { json = false } = {}) {
    if (!client.apiKey) {
      err.write('aegiscode: no AEGIS_API_KEY set. Export your key first (https://aegiscloud.org).\n');
      return 2;
    }
    const res = await ask(prompt);
    await refreshSpend();
    const tokens = usageTokens(res.usage);
    if (json) {
      out.write(
        JSON.stringify(
          {
            text: res.text,
            model: res.model,
            usage: res.usage,
            tokens,
            ms: res.ms,
            interrupted: res.interrupted,
            balance_eur: session.balance,
          },
          null,
          2
        ) + '\n'
      );
    } else {
      out.write(res.text + '\n');
      if (tokens != null) {
        const t = themeOf(ctx());
        out.write(
          t.dim + GLYPH.hook + '  ' + t.blue + (res.model || 'aegis') + RESET +
            t.dim + ' ' + GLYPH.bullet + ' ' + RESET +
            t.white + `${fmtTokens(tokens)} tok` + RESET + '\n'
        );
      }
    }
    return res.interrupted ? 130 : 0;
  }

  /** Fold one completed turn's usage into the session tallies.
   *  @returns {number|null} the total token count for the turn, when known. */
  function recordTurn(res) {
    session.turns++;
    session.calls += Number((res && res.calls) || 1) || 1;
    const usage = res && res.usage;
    const tokens = usageTokens(usage);
    if (tokens != null) {
      session.tokens += tokens;
      session.inputTokens += Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
      session.outputTokens += Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
    }
    return tokens;
  }

  /** One line of session accounting, for ctrl+t and the meta row. */
  function tokenSummary() {
    return (
      `${fmtTokens(session.tokens)} tok ` +
      `(${fmtTokens(session.inputTokens)} in / ${fmtTokens(session.outputTokens)} out) · ` +
      `${session.calls} call${session.calls === 1 ? '' : 's'} · ${fmtEur(session.cost)}` +
      (session.balance == null ? '' : ` · balance ${fmtEur(session.balance)}`)
    );
  }

  /** Load a stored session back into the live transcript. */
  async function resumeSession(item) {
    if (!item || !item.id) return;
    const rows = readSessionTranscript(item.id);
    if (!rows.length) {
      emit(render.renderNotice(ctx(), 'warn', `no stored turns for ${item.id}`));
      return;
    }
    // Replace, rather than append: "resume" means continue THIS conversation,
    // and appending would put two sessions' turns in one context window.
    transcript.length = 0;
    for (const r of rows) transcript.push(r);
    commandCtx.sessionId = item.id;
    emit(render.renderNotice(ctx(), 'ok', `resumed ${item.id} — ${rows.length} turn(s)`));
  }

  /**
   * The host the chatflow drives. Everything the loop needs from the app, with
   * no layering of its own — the loop owns the frame and the keys, this owns
   * the transport, the tools, the command table and the tallies.
   */
  function makeHost() {
    return {
      ctx: commandCtx,
      version: VERSION,
      transcript,
      session,
      client,
      TOOLS,
      ask: (prompt, o) => ask(prompt, o),
      makeCommandContext: () => makeCommandContext(),
      buildState: () => buildState(),
      dispatchLine: (line, c) => handleLine(line, c),
      refreshSpend: () => refreshSpend(),
      updateConfig: (patch) => updateConfig(patch),
      visibleCommands: () => visibleCommands(),
      tokensFor: (usage) => usageTokens(usage),
      recordTurn: (res) => recordTurn(res),
      tokenSummary: () => tokenSummary(),
      resumeSession: (item) => resumeSession(item),
      requestExit: () => {
        wantExit = true;
      },
      wantsExit: () => wantExit,
      isYolo: () => {
        try {
          return loadPermissions().defaultMode === 'allow';
        } catch {
          return false;
        }
      },
    };
  }

  /** The plain (non-alt-screen) REPL: readline, one turn written to scrollback. */
  async function runLinearRepl() {
    emit(bannerLines());
    await refreshSpend();
    out.write('\n');

    const rl = options.readline || readline.createInterface({ input: process.stdin, output: out, terminal: true });
    const promptStr = themeOf(ctx()).gold + GLYPH.cursor + ' ' + RESET;
    rl.setPrompt(promptStr);
    rl.prompt();

    return new Promise((resolve) => {
      rl.on('line', async (line) => {
        rl.pause();
        let keep = true;
        try {
          keep = await handleLine(line);
        } catch (e) {
          emit(render.renderNotice(ctx(), 'error', e.message));
        }
        if (!keep || wantExit) {
          closed = true;
          rl.close();
          return;
        }
        rl.resume();
        rl.prompt();
      });
      rl.on('close', () => {
        if (!closed) out.write('\n');
        resolve(0);
      });
    });
  }

  /**
   * Interactive entry point. On a real terminal this is the full chatflow
   * (alternate screen, header, transcript viewport, spinner, effort line,
   * input line, status line, overlays). Anywhere else — a pipe, a test with an
   * injected readline, `--print` — it stays the linear loop, so output remains
   * pipeable and scriptable.
   */
  async function runInteractive() {
    const tty =
      !options.readline &&
      options.chatflow !== false &&
      process.stdin.isTTY &&
      process.stdout.isTTY;
    if (tty) {
      await chatflow.runSession(makeHost());
      return 0;
    }
    return runLinearRepl();
  }

  return {
    opts,
    session,
    client,
    TOOLS,
    toolList,
    ctx: commandCtx,
    transcript,
    ask,
    runPrompt,
    handleLine,
    runOnce,
    runInteractive,
    runLinearRepl,
    refreshSpend,
    bannerLines,
    makeHost,
    recordTurn,
    tokenSummary,
    resumeSession,
    makeCommandContext,
    buildState,
    get aborted() {
      return false;
    },
  };
}

module.exports = { createApp, VERSION };
