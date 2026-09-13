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
 */

const readline = require('node:readline');
const { createTools, createClient, usageTokens } = require('./deps.js');
const { GLYPH, VERBS, themeOf, RESET, BOLD } = require('./theme.js');
const { LiveRegion, termWidth, EC, w } = require('./screen.js');
const { parseLine, findCommand, COMMANDS } = require('./commands.js');
const render = require('./render.js');
const { fmtTokens, fmtEur, maskKey, fmtElapsed } = require('./format.js');

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

  const ctx = () => ({ light: opts.light });
  const width = () => (options.width ? options.width() : termWidth());

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

  let abortController = null;
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
      model: opts.model || 'server default',
      base: client.apiBase,
      key: maskKey(client.apiKey),
      stream: opts.stream,
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
   * One pooled call, streamed into the live region.
   * @returns {Promise<{text:string, usage:object|null, model:string|null, ms:number, interrupted:boolean}>}
   */
  async function ask(prompt) {
    const started = Date.now();
    const live = opts.interactive && opts.stream && out.isTTY ? new LiveRegion(out) : null;
    let tick = 0;
    let chars = 0;
    let partial = '';
    let reasoning = 0;
    let verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    let sawReasoning = false;

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

    abortController = new AbortController();
    let interrupted = false;
    const onSigint = () => {
      interrupted = true;
      if (abortController) abortController.abort();
    };
    process.once('SIGINT', onSigint);

    try {
      const res = await client.chatCompletion({
        prompt,
        model: opts.model || undefined,
        system: opts.system,
        maxTokens: opts.maxTokens,
        stream: Boolean(opts.stream),
        // Ask the server for the token count on the streaming path: an
        // OpenAI-compatible SSE reply carries no usage unless asked, and this
        // is the same wire form the desktop sends.
        includeUsage: Boolean(opts.stream),
        signal: abortController.signal,
        onReasoning: (t) => {
          reasoning += w(t);
          // The pool's worker findings arrive on the reasoning channel before
          // the answer; say so rather than looking stalled.
          if (!sawReasoning) {
            sawReasoning = true;
            verb = 'Reasoning';
          }
        },
        onStream: ({ delta, reasoning: r }) => {
          if (r) reasoning += w(r);
          if (delta) {
            chars += w(delta);
            partial += delta;
            // Re-paint on every delta but coalesce to ~30fps through the frame
            // counter — a fast provider otherwise spends the CPU on escapes.
            if (live && tick % 2 === 0) paint();
          }
        },
      });

      const choice = (res.choices && res.choices[0]) || {};
      const text = (choice.message && choice.message.content) || partial;
      return {
        text,
        usage: res.usage || null,
        model: res.model || opts.model || null,
        ms: Date.now() - started,
        interrupted,
        reasoningChars: reasoning,
      };
    } catch (e) {
      // A user interrupt is not a failure: keep what already streamed.
      if (interrupted && partial) {
        return {
          text: partial,
          usage: null,
          model: opts.model || null,
          ms: Date.now() - started,
          interrupted: true,
          reasoningChars: reasoning,
        };
      }
      throw e;
    } finally {
      if (timer) clearInterval(timer);
      process.removeListener('SIGINT', onSigint);
      if (live) live.clear();
      abortController = null;
    }
  }

  /** Print a completed turn: role block, then the accounting line. */
  function printTurn(turn) {
    emit(render.renderTurn(ctx(), turn, width()));
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

    printTurn({ role: 'user', text: prompt, label });

    let res;
    try {
      res = await ask(prompt);
    } catch (e) {
      emit(render.renderTurn(ctx(), { role: 'error', text: e.message }, width()));
      return;
    }

    session.turns++;
    session.calls++;

    const tokens = usageTokens(res.usage);
    if (tokens != null) {
      session.tokens += tokens;
      session.inputTokens += Number(res.usage.input_tokens ?? res.usage.prompt_tokens ?? 0) || 0;
      session.outputTokens += Number(res.usage.output_tokens ?? res.usage.completion_tokens ?? 0) || 0;
    }

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

  // Category order and labels, matching aegiscodex-dev's palette.
  const CATEGORY_ORDER = ['aegis', 'model', 'session', 'data', 'auth', 'support', 'workspace'];
  const CATEGORY_LABEL = {
    aegis: 'Aegis plugin',
    model: 'Model & behavior',
    session: 'Session & context',
    data: 'Data',
    auth: 'Auth',
    support: 'Support',
    workspace: 'Workspace',
  };

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

  function printHelp() {
    const t = themeOf(ctx());
    emit([render.renderHeading(ctx(), 'commands', width())]);
    const rows = COMMANDS.filter((c) => !c.unavailable).map((c) => ({
      cat: c.category || 'other',
      usage: `/${c.name}${c.args ? ' ' + c.args : ''}`,
      desc: c.desc,
      aliases: (c.aliases || []).map((a) => `/${a}`).join(' '),
    }));
    const widest = rows.reduce((m, r) => Math.max(m, r.usage.length), 0);
    for (const cat of CATEGORY_ORDER) {
      const group = rows.filter((r) => r.cat === cat);
      if (!group.length) continue;
      emit(['', `${t.dim}${BOLD}${CATEGORY_LABEL[cat] || cat}${RESET}`]);
      for (const r of group) {
        const alias = r.aliases ? `${t.dim}  (${r.aliases})${RESET}` : '';
        emit([
          `  ${t.gold}${r.usage}${RESET}${' '.repeat(Math.max(1, widest - r.usage.length + 2))}` +
            `${t.white}${r.desc}${RESET}${alias}`,
        ]);
      }
    }
    const unavail = COMMANDS.filter((c) => c.unavailable).map((c) => `/${c.name}`);
    if (unavail.length) {
      emit(['', `${t.dim}not available in this client: ${unavail.join(' ')}${RESET}`]);
    }
    emit(['', render.renderNotice(ctx(), 'info', `plain text is a prompt ${GLYPH.bullet} /exit exits`)]);
  }

  /** Handle one line of input. Returns false when the session should end. */
  async function handleLine(line) {
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
      emit(render.renderNotice(ctx(), 'warn', `/${c.name} is not available in aegiscode — ${c.why}`));
      if (c.alt) emit(render.renderNotice(ctx(), 'info', `try ${c.alt} instead`));
      else {
        const alt = nearest(c.name);
        if (alt) emit(render.renderNotice(ctx(), 'info', `try /${alt} instead`));
      }
      return true;
    }

    const cmd = parsed.command;
    const arg = parsed.arg;

    if (cmd.local) {
      switch (cmd.local) {
        case 'exit':
          return false;
        case 'clear':
          out.write(EC.clearScreen);
          // aegiscodex-dev's /clear starts a new session with empty context, so
          // the session tallies reset too (the transcript is not persisted here).
          session.turns = 0;
          session.calls = 0;
          session.tokens = 0;
          session.inputTokens = 0;
          session.outputTokens = 0;
          session.cost = 0;
          session.startedAt = Date.now();
          emit(bannerLines());
          return true;
        case 'help':
          printHelp();
          return true;
        case 'version':
          emit(render.renderNotice(ctx(), 'info', `aegiscode v${VERSION}`));
          return true;
        case 'model':
          if (!arg) {
            emit(render.renderNotice(ctx(), 'info', `model: ${opts.model || 'server default'}`));
          } else if (arg === '-') {
            opts.model = null;
            emit(render.renderNotice(ctx(), 'ok', 'model pin cleared — the server will choose'));
          } else {
            opts.model = arg;
            emit(render.renderNotice(ctx(), 'ok', `pinned model: ${arg}`));
          }
          return true;
        case 'stream':
          opts.stream = arg ? !/^off|false|0$/i.test(arg) : !opts.stream;
          emit(render.renderNotice(ctx(), 'ok', `streaming ${opts.stream ? 'on' : 'off'}`));
          return true;
        case 'theme':
          opts.light = arg ? /^light/i.test(arg) : !opts.light;
          emit(render.renderNotice(ctx(), 'ok', `theme: ${opts.light ? 'light' : 'dark'}`));
          return true;
        case 'cost':
        case 'tokens': {
          const t = themeOf(ctx());
          emit([render.renderHeading(ctx(), 'session', width())]);
          emit([
            `  tokens   ${t.white}${fmtTokens(session.tokens)}${RESET}  ` +
              t.gray + `(${fmtTokens(session.inputTokens)} in / ${fmtTokens(session.outputTokens)} out)` + RESET,
            `  spend    ${t.green}${fmtEur(session.cost)}${RESET}`,
            `  calls    ${session.calls}`,
            `  balance  ${session.balance == null ? 'unknown' : fmtEur(session.balance)}`,
            `  elapsed  ${fmtElapsed(Date.now() - session.startedAt)}`,
          ]);
          return true;
        }
        default:
          emit(render.renderNotice(ctx(), 'error', `/${cmd.name} is not implemented`));
          return true;
      }
    }

    if (cmd.generic) {
      const { tool, args } = cmd.build(arg);
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

  /** Interactive REPL. */
  async function runInteractive() {
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
        if (!keep) {
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

  return {
    opts,
    session,
    client,
    TOOLS,
    toolList,
    ask,
    runPrompt,
    handleLine,
    runOnce,
    runInteractive,
    refreshSpend,
    bannerLines,
    get aborted() {
      return abortController != null;
    },
  };
}

module.exports = { createApp, VERSION };
