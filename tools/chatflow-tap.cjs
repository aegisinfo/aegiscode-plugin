'use strict';

/**
 * chatflow-tap.cjs — the wire tap behind `node tools/chatflow-tap.mjs run`.
 *
 * Preloaded into any aegiscode host with
 *
 *     NODE_OPTIONS="--require $REPO/tools/chatflow-tap.cjs"
 *
 * It replaces `globalThis.fetch` before the host's transport module is
 * required (client/aegis.js calls the global at call time, so the shim is
 * picked up with no change to the shipped code) and appends every chatflow
 * round to a JSONL capture:
 *
 *     {t:'req'}    the exact request — url, method, headers, JSON body
 *     {t:'delta'}  one SSE chunk's worth of text / reasoning / tool_calls
 *     {t:'res'}    a non-streamed JSON answer
 *     {t:'end'}    the assembled answer: text, reasoning, tool calls, usage
 *     {t:'net'}    a network-level failure
 *     {t:'sh'}     a shell command the `exec` tool actually ran — two records,
 *                  phase:'start' (command, cwd, timeout, session) and
 *                  phase:'end' (ms, exit code, output). THIS is the chatflow
 *                  for a coding agent: the model's tool_calls become real
 *                  shell commands, and this is the list of them.
 *     {t:'spawn'}  any other child_process.spawn the host made (dev servers,
 *                  git, claude -p …) — command line + cwd, no output tee
 *
 * Nothing is written to stdout or stderr by default: the CLI paints a
 * full-screen alternate-screen frame, and a stray write would tear it. The
 * capture file is the only output; `chatflow-tap.mjs report` renders it.
 * Set AEGIS_CHATFLOW_TAP_LIVE=1 to echo one line per round to stderr anyway
 * (useful for a headless `-p` run, where there is no frame to corrupt).
 *
 * Env:
 *   AEGIS_CHATFLOW_TAP        file or directory to write into
 *                             (default ~/.aegiscodex/chatflow/)
 *   AEGIS_CHATFLOW_TAP_LIVE   '1' to echo to stderr
 *   AEGIS_CHATFLOW_TAP_QUIET  '1' to disable the tap entirely
 *
 * The tap never changes behaviour: every hook is inside a try/catch, the
 * original fetch is always called, and the response the host receives is the
 * untouched one (the SSE copy is read from a `res.clone()` tee). The shell tap
 * wraps `ShellSession.prototype.run` (and the class itself, to learn each
 * session's starting cwd) and always returns the original promise.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const SECRET_HEADER = /^(authorization|x-provider-key|x-api-key|api-key|cookie|set-cookie)$/i;
const CHAT_PATH = /\/api\/v1\/(byok\/)?chat\/completions/;

// ── capture file ────────────────────────────────────────────────────────────

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function resolveCapturePath() {
  const root = process.env.AEGIS_CHATFLOW_TAP || path.join(os.homedir(), '.aegiscodex', 'chatflow');
  let target = root;
  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch {
    /* does not exist yet */
  }
  if (stat && stat.isDirectory()) {
    target = path.join(root, `session-${stamp()}-${process.pid}.jsonl`);
  } else if (!stat && !path.extname(root)) {
    // A bare path with no extension is read as a directory to create.
    fs.mkdirSync(root, { recursive: true });
    target = path.join(root, `session-${stamp()}-${process.pid}.jsonl`);
  }
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  return path.resolve(target);
}

function createSink() {
  const file = resolveCapturePath();
  let fd;
  try {
    fd = fs.openSync(file, 'a');
  } catch {
    return null;
  }
  // A stable pointer so `report` with no argument finds the newest session.
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(file), 'latest'), file + '\n');
  } catch {
    /* the pointer is a convenience, never a requirement */
  }
  let seq = 0;
  const live = process.env.AEGIS_CHATFLOW_TAP_LIVE === '1';
  return {
    file,
    write(rec) {
      try {
        fs.writeSync(fd, JSON.stringify({ seq: seq++, ts: Date.now(), ...rec }) + '\n');
      } catch {
        /* a full disk must never break the host's turn */
      }
      if (live) {
        let note = null;
        if (rec.t === 'sh') {
          if (rec.phase === 'start') note = `sh $ ${String(rec.command).split('\n')[0].slice(0, 120)}`;
          else if (rec.phase === 'end') note = `sh · exit ${rec.exit} · ${rec.ms}ms`;
        } else if (rec.t !== 'delta' && rec.t !== 'spawn') {
          note = `${rec.t} ${rec.url || rec.id || ''}`;
        }
        if (note) {
          try {
            process.stderr.write(`[chatflow-tap] ${note}\n`);
          } catch {
            /* stderr closed */
          }
        }
      }
    },
    close() {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    },
  };
}

// ── masking ─────────────────────────────────────────────────────────────────

function maskToken(value) {
  const s = String(value == null ? '' : value).replace(/^Bearer\s+/i, '');
  if (s.length <= 8) return '«redacted»';
  return `Bearer ${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars)`;
}

function headerEntries(headers) {
  const out = [];
  try {
    if (!headers) return out;
    if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
      headers.forEach((v, k) => out.push([String(k), String(v)]));
      return out;
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) if (pair && pair.length === 2) out.push([String(pair[0]), String(pair[1])]);
      return out;
    }
    for (const [k, v] of Object.entries(headers)) out.push([String(k), String(v)]);
  } catch {
    /* an exotic header bag: report nothing rather than throw */
  }
  return out;
}

function maskHeaders(headers) {
  const out = {};
  for (const [k, v] of headerEntries(headers)) out[k] = SECRET_HEADER.test(k) ? maskToken(v) : v;
  return out;
}

// ── SSE parsing ─────────────────────────────────────────────────────────────

/**
 * Feed `onEvent` one object per SSE `data:` payload. Returns the assembled
 * answer so the caller does not have to re-walk the chunks.
 */
async function readSse(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  const calls = new Map();
  let usage = null;
  let id = null;
  let model = null;

  const handle = (payload) => {
    if (!payload || payload === '[DONE]') return false;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return true;
    }
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    const delta = (choice && choice.delta) || null;
    if (delta) {
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onEvent({ t: 'delta', channel: 'text', value: delta.content });
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onEvent({ t: 'delta', channel: 'reasoning', value: delta.reasoning_content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          const slot = calls.get(idx) || { index: idx, id: tc.id, name: '', arguments: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function && tc.function.name) slot.name += tc.function.name;
          if (tc.function && typeof tc.function.arguments === 'string') slot.arguments += tc.function.arguments;
          calls.set(idx, slot);
          onEvent({ t: 'delta', channel: 'tool_calls', value: tc, index: idx });
        }
      }
      const finish = choice && choice.finish_reason;
      if (finish) onEvent({ t: 'delta', channel: 'finish', value: finish });
    }
    return true;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        handle(line.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim());
  } catch (err) {
    onEvent({ t: 'net', error: `stream read failed: ${err && err.message ? err.message : String(err)}` });
  }

  return { id, model, text, reasoning, toolCalls: [...calls.values()].filter((c) => c.name), usage };
}

// ── the shell tap ───────────────────────────────────────────────────────────
//
// The interesting half of the chatflow is not the HTTP round trip, it is what
// the `exec` tool turns a tool_call into: a string handed to a persistent bash
// session (cli/vendor/desktop/lib/local/shell.js). We intercept the module as
// it is required and wrap `ShellSession.prototype.run` + the exported class —
// no edit to shipped code, no behaviour change (the original promise is the
// one returned; the tap only listens).

const SH_CAPTURE_CHARS = 6000; // per command, in the capture file
const SHELL_FILE = /(^|[\\/])shell\.js$/;

/** The exit code shell.js encodes, or a sensible stand-in. Never throws. */
function exitOf(result) {
  const content = String((result && result.content) || '');
  const m = /\(exit (\d+)\)\s*$/.exec(content.trim());
  if (m) return Number(m[1]);
  if (/\(timed out after \d+ms\)\s*$/.test(content.trim())) return 124;
  return result && result.isError ? 1 : 0;
}

/** shell.js's one-line 'cd X && …' is the only cwd move that persists. */
function applyCd(cwd, command) {
  let out = cwd;
  for (const piece of String(command || '').split(/&&|;|\n/)) {
    const m = /^\s*cd\s+(?:-P\s+)?("([^"]*)"|'([^']*)'|([^\s&|]+))\s*$/.exec(piece);
    if (!m) continue;
    const target = m[2] ?? m[3] ?? m[4];
    if (!target || target === '-') continue;
    try {
      out = target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target) ? path.resolve(target) : path.resolve(out, target);
    } catch {
      /* an unresolvable path: keep the last known cwd */
    }
  }
  return out;
}

function installShellTap(sink, state) {
  if (state.shellPatched) return;
  const originalLoad = Module._load;

  const patch = (mod, resolved) => {
    if (!mod || typeof mod !== 'object') return false;
    const S = mod.ShellSession;
    if (typeof S !== 'function' || !S.prototype || S.prototype.__aegisChatflowTapped) return false;
    if (resolved && !SHELL_FILE.test(resolved)) return false;

    const sessions = state.sessions; // WeakMap: instance -> { cwd, id }
    let seq = 0;

    const tappedRun = function tappedRun(command, options) {
      const runOpts = options && typeof options === 'object' ? options : {};
      const session = sessions.get(this) || { cwd: process.cwd(), id: null };
      const id = `sh-${++seq}-${Date.now().toString(36)}`;
      const workingDirectory = runOpts.working_directory || null;
      // A dead session degrades to a one-shot spawn (shell.js run()); the
      // command is the same either way, but knowing which path ran is the
      // difference between "state persisted" and "it did not".
      const mode = this && this.alive ? 'session' : 'one-shot';
      const effectiveCwd = workingDirectory || session.cwd;
      const startedAt = Date.now();

      sink.write({
        t: 'sh',
        phase: 'start',
        id,
        command: String(command == null ? '' : command),
        mode,
        cwd: effectiveCwd,
        sessionCwd: session.cwd,
        working_directory: workingDirectory,
        timeout: runOpts.timeout,
      });
      if (!workingDirectory) session.cwd = applyCd(session.cwd, command);
      sessions.set(this, session);

      let promise;
      try {
        promise = S.prototype.__aegisOriginalRun.call(this, command, runOpts);
      } catch (err) {
        sink.write({ t: 'sh', phase: 'end', id, ms: Date.now() - startedAt, isError: true, exit: 1, error: String((err && err.message) || err), output: '', bytes: 0 });
        throw err;
      }
      // Listen on a branch: the host gets the untouched original promise.
      Promise.resolve(promise).then(
        (result) => {
          const content = String((result && result.content) || '');
          sink.write({
            t: 'sh',
            phase: 'end',
            id,
            ms: Date.now() - startedAt,
            isError: !!(result && result.isError),
            exit: exitOf(result),
            bytes: content.length,
            truncated: content.length > SH_CAPTURE_CHARS,
            output: content.slice(0, SH_CAPTURE_CHARS),
          });
        },
        (err) => sink.write({ t: 'sh', phase: 'end', id, ms: Date.now() - startedAt, isError: true, exit: 1, error: String((err && err.message) || err), output: '', bytes: 0 }),
      );
      return promise;
    };
    tappedRun.__aegisChatflowTapped = true;

    S.prototype.__aegisOriginalRun = S.prototype.run;
    S.prototype.run = tappedRun;
    S.prototype.__aegisChatflowTapped = true;

    // Wrap the class so every session reports the cwd it started in. Engine
    // code destructures this export immediately after require, so the swap is
    // in place before any session exists.
    class TappedShellSession extends S {
      constructor(options) {
        super(options);
        const opts = options && typeof options === 'object' ? options : {};
        sessions.set(this, { cwd: opts.cwd || process.cwd(), id: `sh-session-${Date.now().toString(36)}` });
        sink.write({ t: 'sh', phase: 'open', id: sessions.get(this).id, cwd: sessions.get(this).cwd });
      }
    }
    TappedShellSession.prototype.__aegisChatflowTapped = true;
    try {
      mod.ShellSession = TappedShellSession;
    } catch {
      /* a frozen export: prototype patching above is already enough */
    }
    state.shellPatched = true;
    return true;
  };

  Module._load = function tappedLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments);
    try {
      if (exported && typeof exported === 'object' && typeof exported.ShellSession === 'function' && !state.shellPatched) {
        let resolved = null;
        try {
          resolved = Module._resolveFilename(request, parent, isMain);
        } catch {
          resolved = null;
        }
        patch(exported, resolved);
      }
    } catch {
      /* the tap must never break a require */
    }
    return exported;
  };

  // Every other spawn the host makes (dev server, `claude -p` summarizer, git
  // helpers) is part of the same story — record the command line, not output.
  try {
    const cp = require('node:child_process');
    const originalSpawn = cp.spawn;
    cp.spawn = function tappedSpawn(command, args, options) {
      try {
        sink.write({
          t: 'spawn',
          command: String(command),
          args: Array.isArray(args) ? args.map(String) : [],
          cwd: (options && options.cwd) || process.cwd(),
          shell: !!(options && options.shell),
        });
      } catch {
        /* observation only */
      }
      return originalSpawn.apply(this, arguments);
    };
  } catch {
    /* no child_process (impossible in node, but the tap never assumes) */
  }
}

// ── the tap ─────────────────────────────────────────────────────────────────

function install() {
  if (globalThis.__AEGIS_CHATFLOW_TAP__) return globalThis.__AEGIS_CHATFLOW_TAP__;
  if (process.env.AEGIS_CHATFLOW_TAP_QUIET === '1') return null;

  const sink = createSink();
  if (!sink) return null;

  const original = globalThis.fetch;
  const state = { file: sink.file, original, installed: true, requests: 0, sessions: new WeakMap(), shellPatched: false };
  globalThis.__AEGIS_CHATFLOW_TAP__ = state;

  // A last chance to flush the file handle before the host exits.
  try {
    process.on('exit', () => sink.close());
  } catch {
    /* no process hooks available */
  }

  // The shell half works even where there is no fetch to shim (a direct
  // executeTool call, a test harness) — so it is installed unconditionally.
  try {
    installShellTap(sink, state);
  } catch {
    /* a missing shell module is not a reason to lose the wire tap */
  }

  if (typeof original !== 'function') return state;

  globalThis.fetch = async function tappedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || 'GET';
    const isChat = CHAT_PATH.test(url);
    if (!isChat) return original(input, init);

    const id = `req-${++state.requests}-${Date.now().toString(36)}`;
    const started = Date.now();
    let body = null;
    try {
      body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body || null;
    } catch {
      body = init.body ? String(init.body).slice(0, 4000) : null;
    }
    sink.write({ t: 'req', id, url, method, headers: maskHeaders(init.headers), body });

    let res;
    try {
      res = await original(input, init);
    } catch (err) {
      const error = err && err.message ? err.message : String(err);
      sink.write({ t: 'net', id, url, error, ms: Date.now() - started });
      throw err;
    }

    const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    const meta = {
      status: res.status,
      ok: !!res.ok,
      contentType,
      brain: (res.headers && res.headers.get && res.headers.get('X-AEGIS-Brain')) || null,
    };

    if (contentType.includes('text/event-stream') && res.body) {
      let clone;
      try {
        clone = res.clone();
      } catch {
        clone = null;
      }
      if (clone) {
        // Fire-and-forget: the host reads the original branch, we drain ours.
        readSse(clone.body, (ev) => sink.write({ id, ...ev }))
          .then((assembled) => sink.write({ t: 'end', id, ms: Date.now() - started, ...meta, ...assembled }))
          .catch(() => {
            /* the tap is an observer; a failure here is not the host's */
          });
      }
    } else {
      try {
        const copy = res.clone();
        copy
          .text()
          .then((text) => {
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text.slice(0, 4000);
            }
            sink.write({ t: 'res', id, ms: Date.now() - started, ...meta, body: parsed });
          })
          .catch(() => {
            /* nothing to record */
          });
      } catch {
        sink.write({ t: 'res', id, ms: Date.now() - started, ...meta, body: null });
      }
    }

    return res;
  };

  return state;
}

install();

module.exports = { install, readSse, maskHeaders, resolveCapturePath, installShellTap, exitOf, applyCd };
