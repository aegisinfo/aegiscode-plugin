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
const { createTools, createClient, usageTokens, buildSystemPrompt } = require('./deps.js');
const { createEngine } = require('./engine.js');
const { GLYPH, VERBS, themeOf, RESET, THEME_TABLE } = require('./theme.js');
const { LiveRegion, termWidth, w } = require('./screen.js');
const { parseLine, COMMANDS, visibleCommands } = require('./commands.js');
const { updateConfig, loadPermissions, loadConfig, configExists } = require('./config.js');
const credentials = require('./credentials.js');
const cloudsync = require('./cloudsync.js');
const { readSecret } = require('./secret.js');
const { normalizeModelCatalog, pickerEntries, catalogIds } = require('./models.js');
const { appendHistory, readSessionTranscript, readOwnSessions } = require('./history.js');
const { snapshotCheckpoint } = require('./checkpoint.js');
const screens = require('./screens.js');
const chatflow = require('./chatflow.js');
const overlays = require('./overlays.js');
const render = require('./render.js');
const { fmtTokens, fmtEur, maskKey } = require('./format.js');

const VERSION = require('../package.json').version;

/**
 * The persona for a turn this host did not get an explicit system prompt for.
 *
 * Built once and cached: it is the stable head of every request, and a prompt
 * that changed between turns would defeat the provider's prompt cache for the
 * whole conversation behind it.
 */
let _defaultSystem = null;
function defaultSystemPrompt() {
  if (_defaultSystem === null) {
    try {
      _defaultSystem = buildSystemPrompt({
        platform: process.platform,
        arch: process.arch,
        homedir: os.homedir(),
        cwd: process.cwd(),
      });
    } catch {
      _defaultSystem = ''; // never let persona construction break a turn
    }
  }
  return _defaultSystem || undefined;
}

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
  // The key comes from the credential store (env → credentials.json →
  // config.json) rather than from the environment alone: an export does not
  // survive a new shell, and until it is *stored* every one of those launches
  // is "no key" with no in-band way to set one. An injected client keeps
  // whatever key it was built with.
  const client = options.client || createClient(credentials.clientOptions());
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
    // `null` = "auto": send no effort, so the server sizes the turn from the
    // ask. This is the *budget* control on the pooled class (aegis1 sizes the
    // token ladder from it), which is why it is not defaulted to a rung here —
    // pinning one would make every turn cost what that rung grants.
    effort: null,
    thinking: false,
    themeIndex: opts.light ? 2 : 1,
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

  // ── the AEGIS account key ─────────────────────────────────────────────────
  //
  // Set/forget at runtime, for `/key` and `aegiscode login`. Both paths are the
  // same three steps — persist, apply to the live client, invalidate the model
  // catalog — because a key that is stored but not applied leaves the current
  // session failing, and one that is applied but not stored is gone next launch.

  /**
   * Persist an account key and start using it immediately.
   *
   * `verify` spends one `/api/verify-api-key` round trip to catch a bad key at
   * the moment it is entered rather than at the first prompt, and is also how
   * the memory token (cloud sync's credential) is obtained — so a successful
   * login leaves both credentials in the store.
   */
  async function setApiKey(raw, { verify = true } = {}) {
    const saved = credentials.saveApiKey(raw);
    if (!saved.ok) return saved;
    client.setApiKey(saved.key);
    modelCache.models = [];
    modelCache.at = 0;
    let account = null;
    let error = null;
    if (verify) {
      try {
        const info = (await client.verifyApiKey()) || {};
        account = info;
        const patch = { verifiedAt: new Date().toISOString() };
        if (info.memory_token) patch.memoryToken = info.memory_token;
        if (info.plan) patch.plan = info.plan;
        patch.account = { plan: info.plan || null, email: info.email || null, valid: info.valid !== false };
        credentials.writeCredentials(patch);
        if (info.plan) session.plan = info.plan;
        if (info.email) session.account = { ...(session.account || {}), email: info.email };
      } catch (e) {
        error = e;
      }
    }
    return { ...saved, account, error };
  }

  /** Drop the stored key and stop authenticating this session. */
  function forgetApiKey() {
    const res = credentials.clearApiKey();
    client.setApiKey('');
    modelCache.models = [];
    modelCache.at = 0;
    return res;
  }

  function cloudSyncEnabled() {
    try {
      return loadConfig().cloudSync === true;
    } catch {
      return false;
    }
  }

  function setCloudSync(on) {
    return updateConfig({ cloudSync: on === true });
  }

  /**
   * Copy a key found in config.json into the 0600 store, once, so the next run
   * reads the tight copy. Never deletes the original — that file belongs to
   * another product and holds the user's key.
   */
  function adoptLegacyKeyOnce() {
    try {
      const resolved = credentials.resolveApiKey();
      if (resolved.source !== 'config') return [];
      return credentials.adoptLegacy().adopted;
    } catch {
      return [];
    }
  }

  // ── the AEGIS Cloud model catalog ──────────────────────────────────────────
  //
  // `/model` (and the alt+p chord that dispatches it) reads the pinnable ids
  // from the server, and `state().models` is where it looks. That path had no
  // source at all: `commands.js` calls `c.loadModels()` inside a `try {} catch
  // {}`, `c.loadModels` was never defined on either command context, and
  // `buildState()` hardcoded `models: []` — so the TypeError was swallowed and
  // both `/model` and the picker reported "no models advertised" on a perfectly
  // healthy account, forever. The ids themselves are the server's (see
  // models.js), fetched here and cached, because the pool adds and retires
  // providers without a client release.
  const MODEL_CACHE_MS = 5 * 60_000;
  const modelCache = { at: 0, models: [] };

  /**
   * Fetch (or return the cached) model catalog. Rejects when the account cannot
   * read it at all — no key, offline, or a server error — which callers treat as
   * "nothing to offer" rather than retrying per keystroke.
   * @returns {Promise<Array<{id:string,label:string,note:string}>>}
   */
  async function loadModels({ force = false } = {}) {
    const fresh = modelCache.models.length && Date.now() - modelCache.at < MODEL_CACHE_MS;
    if (!force && fresh) return modelCache.models;
    const data = await client.listModels();
    modelCache.models = normalizeModelCatalog(data && data.models);
    modelCache.at = Date.now();
    return modelCache.models;
  }

  /**
   * A pinned model id the server does not advertise is a *silent* fallback: the
   * pool answers from its own default with no error, so the pin looks honoured
   * while the reply came from another model — and the cost is attributed to the
   * model that was pinned. Two shipped defaults did exactly that: `sonnet`
   * (written into config.json by onboarding, merged in from DEFAULT_CONFIG, and
   * never advertised by AEGIS Cloud) and any `provider/model` spelling a user
   * typed by hand. Clears such a pin once, says so, and leaves the server's own
   * default in its place.
   *
   * Best-effort and offline-safe: a catalog that cannot be read clears nothing.
   */
  async function validatePinnedModel() {
    const pinned = commandCtx.model;
    if (!pinned) return null;
    let models;
    try {
      models = await loadModels();
    } catch {
      return null;
    }
    if (!models.length) return null;
    if (catalogIds(models).has(String(pinned).toLowerCase())) return null;
    commandCtx.model = null;
    updateConfig({ model: null, currentModelId: null });
    emit(
      render.renderNotice(
        ctx(),
        'warn',
        `pinned model "${pinned}" is not advertised by AEGIS Cloud — pin cleared, ` +
          'the pool will choose; /models lists what you can pin.'
      )
    );
    return pinned;
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
          // A caller-supplied system wins; otherwise the shared persona. Sent
          // explicitly rather than left to the server, because the pooled
          // route takes the system prompt from the request and the CLI was
          // sending none — the model got tool schemas and no rule about when
          // to use them.
          system: opts.system || defaultSystemPrompt(),
          maxTokens: opts.maxTokens,
          // `effort` is the pooled budget control, and it travels on every turn
          // — this host only ever runs the 'aegis' class, whose calls are sized
          // server-side from it (aegis1 services/pool_brain.py). It used to be
          // held in the session state and rendered in the status line without
          // ever reaching the wire, so /effort changed the display and nothing
          // about what the turn cost. `null` (auto) is omitted so the server
          // infers the rung from the ask.
          effort: commandCtx.effort || undefined,
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
          `no AEGIS account key — ${credentials.HOW_TO_SET} (or set $${credentials.KEY_ENV})`
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
      persistTurn(prompt, { text: '', error: e.message }, 'error');
      emit(render.renderTurn(ctx(), { role: 'error', text: e.message }, width()));
      return;
    }

    if (res.text) transcript.push({ role: 'assistant', text: res.text });

    const tokens = recordTurn(res);
    persistTurn(prompt, res, res.interrupted ? 'stopped' : res.error ? 'error' : 'done');

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
      throw new Error(`no AEGIS account key — ${credentials.HOW_TO_SET}`);
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
      // The selectable (pickable) catalog, not the raw payload: alias tiers are
      // dropped, live ids only (see models.js pickerEntries).
      models: pickerEntries(modelCache.models),
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

  /**
   * The theme picker. On a real terminal this is the onboarding screen; anywhere
   * else (`/theme` in a pipe, a test with no TTY) it stays the light/dark toggle
   * it has always been, so a non-interactive caller never blocks on a key.
   */
  async function showThemePicker() {
    if (options.readline || !process.stdin.isTTY || !process.stdout.isTTY || options.chatflow === false) {
      commandCtx.light = !commandCtx.light;
      commandCtx.themeIndex = commandCtx.light ? 2 : 1;
      emit(render.renderNotice(ctx(), 'ok', `theme: ${commandCtx.light ? 'light' : 'dark'}`));
      return commandCtx.themeIndex;
    }
    return screens.showThemePicker(commandCtx);
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
      // The AEGIS catalog fetch `/model` and alt+p expect (see loadModels).
      // Wired on the app's context so the chatflow's `Object.assign`-based
      // context inherits it too — one definition, both hosts.
      loadModels: (o) => loadModels(o),
      refreshSpend: () => refreshSpend(),
      state: () => buildState(),
      setInput: () => {},
      exit: () => { wantExit = true; },
      client,
      TOOLS,
      saveConfig: (patch) => updateConfig(patch),
      showThemePicker: () => showThemePicker(),
      // Credential + cloud-sync surface for the /key, /cloud and /sync commands.
      // Defined here on the app's context so the chatflow's Object.assign-based
      // context inherits them too — one definition, both hosts.
      keyStatus: () => credentials.keyStatus(),
      setApiKey: (raw, o) => setApiKey(raw, o),
      forgetApiKey: () => forgetApiKey(),
      readSecret: (text) => readSecret(text, { stdin: process.stdin, stdout: out }),
      cloudsync,
      cloudSyncEnabled: () => cloudSyncEnabled(),
      setCloudSync: (on) => setCloudSync(on),
      adoptLegacyKey: () => adoptLegacyKeyOnce(),
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
        const key = await askSecret(`provider key for ${args.provider}: `);
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

  /**
   * Ask for a secret on this session's streams.
   *
   * The prompt loop itself lives in secret.js, shared with `aegiscode login` in
   * the bin — one implementation, so the terminal host and the non-interactive
   * entry point cannot differ in whether a key is echoed or masked. Only the
   * prompt's colouring is the session's business.
   */
  function askSecret(promptText) {
    const t = themeOf(ctx());
    return readSecret(t.gray + promptText + RESET, { stdin: process.stdin, stdout: out });
  }

  // --- entry points ---------------------------------------------------------

  /** Non-interactive: one prompt, plain output, exit code. */
  async function runOnce(prompt, { json = false } = {}) {
    adoptLegacyKeyOnce();
    if (!client.apiKey) {
      err.write(`aegiscode: no AEGIS account key. ${credentials.HOW_TO_SET}, or set $${credentials.KEY_ENV}.\n`);
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

  /**
   * Persist one finished exchange: the history row and a transcript checkpoint.
   *
   * `appendHistory` and `snapshotCheckpoint` were both dead code — nothing ever
   * called them, so `history.jsonl` was never created. Every consumer of it
   * degraded silently rather than loudly: `/resume` could never find a stored
   * session, `/cost` summed zero rows, `/clear`'s prune was a no-op, and
   * `/rewind` always answered "No checkpoints yet". The session loop is the only
   * place that sees the prompt *and* its reply, so it is the place that writes.
   *
   * Best-effort by construction: the two writers swallow their own failures, and
   * accounting must never be able to break a turn.
   */
  function persistTurn(prompt, res, status = 'done', costEur = null) {
    try {
      const usage = res && res.usage;
      // What the POOL charged, straight from the ledger — margin and
      // prompt-cache discount already applied. Stored so /cost can report the
      // real bill instead of recomputing from provider rates it cannot see.
      // (The history field is historically named `costUsd`; the value here is
      // EUR, which is what every surface in this client displays.)
      const settled = typeof costEur === 'number' && Number.isFinite(costEur) ? costEur : null;
      appendHistory({
        sessionId: commandCtx.sessionId,
        prompt,
        reply: (res && res.text) || '',
        status,
        usage: usage
          ? {
              input: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0,
              output: Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0,
              cacheRead: Number(usage.cache_read_input_tokens ?? 0) || 0,
              cacheWrite: Number(usage.cache_creation_input_tokens ?? 0) || 0,
              ...(settled != null ? { costUsd: settled } : {}),
            }
          : settled != null
            ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: settled }
            : null,
      });
      snapshotCheckpoint(commandCtx.sessionId, transcript);
    } catch {
      /* persistence is best-effort */
    }
    // Auto-sync hook: one place, reached by both the linear REPL and the
    // chatflow's session loop, and only when the user turned it on. Off by
    // default because a push is billed against the plan's synced-token ceiling
    // (aegis1 charges the *growth* of a session), so uploading is a choice.
    if (cloudSyncEnabled()) autoSync();
  }

  /**
   * Push after a turn, in the background.
   *
   * Deliberately not awaited and deliberately quiet on success: this runs after
   * every turn, and a line per turn would be noise. Failures are reported once
   * per session per session-cycle — a quota refusal that repeats forever is a
   * wall of text, not information — and never thrown, because the user's turn
   * already succeeded by the time this runs.
   */
  let autoSyncNotes = new Set();
  function autoSync() {
    if (!client.apiKey) return;
    Promise.resolve()
      .then(() => cloudsync.push(client))
      .then((res) => {
        if (res && res.failed && res.failed.length) {
          const f = res.failed[0];
          if (autoSyncNotes.has(f.kind)) return;
          autoSyncNotes.add(f.kind);
          const hint = f.hint ? ` — ${f.hint}` : '';
          emit(render.renderNotice(ctx(), f.kind === 'quota' ? 'warn' : 'error', `cloud sync: ${f.message}${hint}`));
        }
      })
      .catch(() => {
        /* offline is not worth interrupting a session over */
      });
  }

  /** One line of session accounting, for ctrl+t and the meta row. */  function tokenSummary() {
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
      loadModels: (o) => loadModels(o),
      buildState: () => buildState(),
      dispatchLine: (line, c) => handleLine(line, c),
      refreshSpend: () => refreshSpend(),
      updateConfig: (patch) => updateConfig(patch),
      showThemePicker: () => showThemePicker(),
      persistTurn: (prompt, res, status) => persistTurn(prompt, res, status),
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
   * Restore persisted preferences into the live context. The reference does this
   * at startup (`main.js:290-296`); this client never called `loadConfig()` on
   * launch at all, so a model or effort chosen in a previous session was written
   * to disk and then ignored on the next run.
   *
   * An explicit CLI flag always wins over the stored value — `aegiscode -m x`
   * must mean `x`, not "x unless the config disagrees".
   */
  function restorePrefs() {
    // An embedded/injected readline is a programmatic caller: it gets a
    // deterministic context rather than whatever happens to be on disk.
    if (options.readline) return;
    // A fresh install has no expressed preference to restore. Applying
    // DEFAULT_CONFIG here would silently pin the user to a model they never
    // chose, which is the opposite of "remember what I picked".
    if (!configExists()) return;
    let cfg;
    try {
      cfg = loadConfig();
    } catch {
      return;
    }
    if (!opts.model && cfg.model) commandCtx.model = cfg.model;
    // `null` in the config is "auto" and is deliberately not assigned over the
    // default — there is nothing to restore, because nothing is pinned.
    if (cfg.effort) commandCtx.effort = cfg.effort;
    if (typeof cfg.vim === 'boolean') commandCtx.vim = cfg.vim;
    if (cfg.lastRecap) commandCtx.lastRecap = cfg.lastRecap;
    // THEME_TABLE lives in theme.js, not screens.js: reading it off the screens
    // module yielded undefined, and only on a *second* launch (the first has no
    // config to restore, so this branch never ran) — so the very first run
    // appeared to work and every run after it died on startup.
    if (!opts.light && typeof cfg.themeIndex === 'number' && THEME_TABLE[cfg.themeIndex]) {
      commandCtx.themeIndex = cfg.themeIndex;
      commandCtx.light = !!THEME_TABLE[cfg.themeIndex].light;
    }
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
      restorePrefs();
      adoptLegacyKeyOnce();
      // Onboarding runs in the normal buffer, before the session takes the
      // alternate screen — the reference's order. A declined trust check must
      // abort: the reference returns without ever reaching `session(ctx)`.
      const onboard = await screens.runOnboarding(commandCtx, {
        continue: !!options.continue,
        seen: options.seen || configExists,
        save: (patch) => updateConfig(patch),
        // With no key the session can do nothing, so ask for it here where the
        // user is already answering questions — verified on submit, and saved
        // 0600 so the next launch (and every script) has it.
        needsKey: () => !client.apiKey,
        submitKey: (key) => setApiKey(key),
      });
      if (!onboard.ok) return 0;
      if (onboard.key && onboard.key.set) {
        emit(
          render.renderNotice(
            ctx(),
            'info',
            `key saved to ${credentials.credentialsPath()} — no export needed from now on`
          )
        );
      }
      if (onboard.key && onboard.key.skipped && !client.apiKey) {
        emit(
          render.renderNotice(
            ctx(),
            'warn',
            `no key saved — /key <api_key> or \`aegiscode login\` whenever you are ready`
          )
        );
      }
      // A stored pin the platform does not advertise routes elsewhere in
      // silence (see validatePinnedModel) — checked once, here, where the user
      // can act on it. Not on `-p`: a network round-trip ahead of the first
      // token would be a startup cost bought for a warning no script watches.
      await validatePinnedModel();
      // `--continue` must load the last session *before* the loop starts, and
      // it has to be read here rather than captured at construction: the
      // history file is written by the loop itself.
      if (options.continue) {
        const last = readOwnSessions(1)[0];
        if (last) {
          commandCtx.continueSession = last.id;
          await resumeSession({ id: last.id });
        }
      }
      await chatflow.runSession(makeHost());
      return 0;
    }
    restorePrefs();
    adoptLegacyKeyOnce();
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
    loadModels,
    validatePinnedModel,
    recordTurn,
    persistTurn,
    restorePrefs,
    setApiKey,
    forgetApiKey,
    adoptLegacyKeyOnce,
    cloudSyncEnabled,
    setCloudSync,
    cloudsync,
    keyStatus: () => credentials.keyStatus(),
    sessionId: () => commandCtx.sessionId,
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
