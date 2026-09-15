#!/usr/bin/env node
'use strict';

/**
 * chatflow-tap.mjs — see what the aegiscode chatflow is actually working with.
 *
 * The CLI's chatflow is Claude Code's: one system prompt, one tool registry,
 * a growing message list, and a streamed answer that calls tools in a loop.
 * This tool shows that flow as data — the exact bytes on the wire, in the
 * order the model receives them — for the CLI in this repo.
 *
 * Four subcommands:
 *
 *   mimic    (default) Rebuild the payload the CLI *would* send for one turn,
 *            offline, from the CLI's own builders (`buildSystemPrompt` from
 *            desktop/lib/local/prompt.js, the tool schemas from
 *            desktop/lib/local/tools.js) and render it. No network, no key.
 *            This is the "what is it working with" view.
 *
 *   run      Spawn cli/bin/aegiscode.js with tools/chatflow-tap.cjs preloaded
 *            (NODE_OPTIONS=--require …), inherit the terminal so the real TUI
 *            runs untouched, then render every round the tap captured.
 *            Add `--watch` to print each round as it lands, after exiting.
 *
 *   report   Render a capture file written by the tap
 *            (default: the newest under ~/.aegiscodex/chatflow/).
 *
 *   watch    Follow a capture file and render each round as it completes —
 *            run this in a second terminal while `run` drives the CLI.
 *
 *   node tools/chatflow-tap.mjs mimic --prompt "why is greet slow?" --cwd /repo
 *   node tools/chatflow-tap.mjs mimic --json > payload.json
 *   node tools/chatflow-tap.mjs run -- --yolo
 *   node tools/chatflow-tap.mjs report
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const CLI = path.join(REPO, 'cli');
const CAPTURE_DIR = process.env.AEGIS_CHATFLOW_TAP || path.join(os.homedir(), '.aegiscodex', 'chatflow');
const DEFAULT_SYSTEM = 'nexus-brain';

// ── palette (copied from cli/src/theme.js, which pins itself to aegiscodex-dev)

const RGB = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const C = {
  gold: RGB(255, 193, 7),
  coral: RGB(215, 119, 87),
  lavender: RGB(177, 185, 249),
  blue: RGB(120, 160, 250),
  green: RGB(78, 186, 101),
  red: RGB(220, 90, 90),
  gray: RGB(153, 153, 153),
  dim: RGB(80, 80, 80),
  white: RGB(255, 255, 255),
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (inline !== undefined) opts[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
      else opts[key] = true;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'mimic';
const opts = parseArgs(argv);
const useColor = !opts.noColor && process.stdout.isTTY;
const WIDTH = Math.max(60, Math.min(Number(opts.width) || process.stdout.columns || 96, 200));
const MAX_PROMPT_LINES = opts.maxPrompt === undefined ? 400 : Number(opts.maxPrompt);

const paint = (s, color) => (useColor && color ? `${color}${s}${RESET}` : String(s));
const bold = (s) => (useColor ? `${BOLD}${s}${RESET}` : String(s));
const dim = (s) => (useColor ? `${DIM}${s}${RESET}` : String(s));

// ── formatting helpers ──────────────────────────────────────────────────────

/** ~4 chars per token: the estimate Claude Code's own counters use. */
const toks = (chars) => Math.ceil(chars / 4);
const num = (n) => Number(n || 0).toLocaleString('en-US');

function rule(label = '', char = '─') {
  const head = label ? `── ${label} ` : '';
  return paint(head + char.repeat(Math.max(0, WIDTH - head.length)), C.dim);
}

function frame(label) {
  const head = `╭─ ${label} `;
  return paint(head + '─'.repeat(Math.max(0, WIDTH - head.length - 1)), C.gold) + paint('╮', C.gold);
}

function wrap(text, width) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    if (!raw) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of raw.split(' ')) {
      if (!line.length) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

function boxed(text, width, maxLines) {
  const lines = wrap(text, width - 4);
  const shown = maxLines && lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  const out = shown.map((l) => `${paint('│', C.dim)} ${l}`);
  if (shown.length < lines.length) {
    out.push(`${paint('│', C.dim)} ${dim(`… ${num(lines.length - shown.length)} more lines (--max-prompt 0 for all)`)}`);
  }
  return out;
}

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

function sizeRow(label, chars, share, width = 26) {
  const p = String(label).padEnd(width);
  return `  ${paint(p, C.gray)} ${num(chars).padStart(9)} ${dim('chars')} ${dim('~')}${num(toks(chars)).padStart(8)} ${dim('tok')}  ${pct(chars, share)}`;
}

function preview(text, limit) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > limit ? one.slice(0, limit - 1) + '…' : one;
}

// ── the shape both producers emit, and its renderer ─────────────────────────

/**
 * A turn is:
 *   { source, url, method, model, status, ms, error, stream, flags,
 *     system, tools, messages, text, reasoning, toolCalls, usage, body }
 */
function renderTurn(turn, index) {
  const out = [];
  const totalMsgs = Array.isArray(turn.messages) ? turn.messages.length : 0;
  const systemChars = typeof turn.system === 'string' ? turn.system.length : 0;
  const toolsChars = turn.tools ? JSON.stringify(turn.tools).length : 0;
  const msgsChars = turn.messages ? JSON.stringify(turn.messages).length : 0;
  const parts = systemChars + toolsChars + msgsChars;

  const state = turn.error
    ? paint('error', C.red)
    : turn.status
      ? `${paint(String(turn.status), turn.status >= 400 ? C.red : C.green)}`
      : dim('not sent');

  out.push('');
  out.push(frame(`aegis chatflow ${turn.source === 'mimic' ? '· mimic' : ''}`));
  out.push(
    `  ${paint('❯', C.lavender)} ${bold(`TURN ${index}`)}  ${paint(turn.method || 'POST', C.gray)} ${turn.url || ''}` +
      `  ${state}${turn.ms ? dim(` · ${turn.ms}ms`) : ''}`,
  );

  const flags = [];
  if (turn.model) flags.push(['model', turn.model]);
  flags.push(['stream', turn.stream === false ? 'false' : 'true' + (turn.includeUsage ? ' · usage' : '')]);
  for (const [k, v] of Object.entries(turn.flags || {})) if (v !== undefined && v !== null && v !== false) flags.push([k, v]);
  for (const [k, v] of flags) {
    out.push(`  ${paint(k.padEnd(13), C.gray)} ${v === true ? 'true' : typeof v === 'object' ? JSON.stringify(v) : v}`);
  }

  out.push('');
  out.push(rule('what the model is working with'));
  out.push(sizeRow('system prompt', systemChars, parts));
  out.push(sizeRow(`tool schemas (${(turn.tools || []).length})`, toolsChars, parts));
  out.push(sizeRow(`messages (${totalMsgs})`, msgsChars, parts));
  out.push('  ' + paint('─'.repeat(58), C.dim));
  const wire = turn.body ? JSON.stringify(turn.body).length : parts;
  out.push(
    `  ${bold('wire body'.padEnd(26))} ${num(wire).padStart(9)} ${dim('chars')} ${dim('~')}${num(toks(wire)).padStart(8)} ${dim('tok')}   ${dim('(parts ' + num(parts) + ')')}`,
  );

  // system prompt
  if (systemChars) {
    out.push('');
    out.push(rule('system prompt', '─'));
    out.push(...boxed(turn.system, WIDTH, MAX_PROMPT_LINES || undefined));
  }

  // tool schemas
  if ((turn.tools || []).length) {
    out.push('');
    out.push(rule('tool schemas — the surface the model may call', '─'));
    const rows = turn.tools.map((t) => {
      const fn = t.function || t;
      const chars = JSON.stringify(t).length;
      const desc = preview((fn.description || '').split('\n')[0], Math.max(20, WIDTH - 46));
      return { name: fn.name, chars, desc };
    });
    const nameW = Math.max(...rows.map((r) => r.name.length), 4);
    for (const r of rows) {
      out.push(`  ${paint(r.name.padEnd(nameW), C.lavender)}  ${dim('~' + num(toks(r.chars)).padStart(6) + ' tok')}  ${r.desc}`);
    }
  }

  // messages
  if (totalMsgs) {
    out.push('');
    out.push(rule('messages — in the order the model reads them (serialized size)', '─'));
    turn.messages.forEach((m, i) => {
      const chars = JSON.stringify(m).length;
      const role = String(m.role || '?');
      let bodyText = '';
      if (typeof m.content === 'string') bodyText = m.content;
      else if (Array.isArray(m.content)) bodyText = m.content.map((c) => (typeof c === 'string' ? c : c.text || `[${c.type}]`)).join(' ');
      else if (m.content) bodyText = JSON.stringify(m.content);
      const extras = [];
      if (m.tool_calls) extras.push(`tool_calls: ${m.tool_calls.map((c) => (c.function && c.function.name) || '?').join(', ')}`);
      if (m.tool_call_id) extras.push(`tool_call_id: ${m.tool_call_id}`);
      const tag = m.role === 'system' ? 'system' : m.tool_call_id ? 'tool' : m.role;
      out.push(
        `  ${dim('[' + String(i).padStart(2) + ']')} ${paint(tag.padEnd(10), m.role === 'system' ? C.gold : m.role === 'assistant' ? C.green : C.blue)}` +
          `${dim(num(chars).padStart(9) + ' chars')}  ${preview(bodyText, Math.max(20, WIDTH - 40))}`,
      );
      if (extras.length) out.push(`       ${dim(extras.join(' · '))}`);
    });
  }

  // the answer
  if (turn.error) {
    out.push('');
    out.push(rule('error', '─'));
    out.push(...boxed(turn.error, WIDTH, 20));
  } else if (turn.reasoning || turn.text || (turn.toolCalls || []).length || turn.source === 'capture') {
    out.push('');
    out.push(rule('answer — what came back', '─'));
    if (turn.reasoning) {
      out.push(`  ${paint('✻ reasoning', C.gold)} ${dim(num(turn.reasoning.length) + ' chars')}`);
      out.push(...boxed(preview(turn.reasoning, 1200), WIDTH, 12));
    }
    if ((turn.toolCalls || []).length) {
      out.push(`  ${paint('⏺ tool calls', C.green)} ${dim(String(turn.toolCalls.length))}`);
      for (const call of turn.toolCalls) {
        out.push(`      ${paint(call.name || '?', C.lavender)} ${preview(call.arguments || '', Math.max(20, WIDTH - 20))}`);
      }
    }
    if (turn.text) {
      out.push(`  ${paint('⏺ text', C.green)} ${dim(num(turn.text.length) + ' chars')}`);
      out.push(...boxed(turn.text, WIDTH, 24));
    }
    if (!turn.reasoning && !turn.text && !(turn.toolCalls || []).length) {
      out.push(`  ${dim('(no content — tool-only turn, or the stream was cut)')}`);
    }
  }

  if (turn.usage) {
    const u = turn.usage;
    const bits = ['prompt_tokens', 'completion_tokens', 'total_tokens']
      .filter((k) => u[k] != null)
      .map((k) => `${k.replace('_tokens', '')} ${num(u[k])}`);
    if (bits.length) {
      out.push('');
      out.push(`  ${paint('usage'.padEnd(13), C.gray)} ${bits.join(dim(' · '))}`);
    } else {
      out.push('');
      out.push(`  ${paint('usage'.padEnd(13), C.gray)} ${preview(JSON.stringify(u), WIDTH - 16)}`);
    }
  }

  return out;
}

function renderBody(turn) {
  return JSON.stringify(turn.body, null, 2);
}

// ── the shell chatflow ──────────────────────────────────────────────────────
//
// For a coding agent the chatflow that matters is not the HTTP envelope, it is
// the shell commands: the model emits `exec({command})`, the CLI hands that
// string to one long-lived bash session, and the output comes back as a tool
// message. The tap records every one of those ({t:'sh'}), so this is the list
// of what actually ran — with the model's own tool_call next to it.

/** Pair the tap's start/end records into one object per command. */
function assembleShell(events) {
  const order = [];
  const byId = new Map();
  for (const ev of events) {
    if (ev.t !== 'sh') continue;
    if (ev.phase === 'open') continue;
    const id = ev.id || '(no-id)';
    if (!byId.has(id)) {
      byId.set(id, {
        id, ts: ev.ts, command: '', mode: 'session', cwd: null, sessionCwd: null,
        working_directory: null, timeout: null, ms: null, exit: null, isError: false,
        output: '', bytes: 0, truncated: false, error: null, declared: null,
      });
      order.push(id);
    }
    const c = byId.get(id);
    if (ev.phase === 'start') {
      c.ts = ev.ts;
      c.command = ev.command || '';
      c.mode = ev.mode || 'session';
      c.cwd = ev.cwd || ev.sessionCwd || null;
      c.sessionCwd = ev.sessionCwd || null;
      c.working_directory = ev.working_directory || null;
      c.timeout = ev.timeout ?? null;
    } else {
      c.ms = ev.ms ?? null;
      c.exit = typeof ev.exit === 'number' ? ev.exit : null;
      c.isError = !!ev.isError;
      c.output = ev.output || '';
      c.bytes = ev.bytes ?? c.output.length;
      c.truncated = !!ev.truncated;
      c.error = ev.error || null;
    }
  }
  return order.map((id) => byId.get(id));
}

/** The child processes the host spawned that were not `exec` commands. */
function assembleSpawns(events) {
  const SHELLS = new Set(['/bin/bash', '/bin/sh', 'bash', 'sh', 'zsh', '/bin/zsh', 'cmd.exe', 'powershell.exe', process.env.SHELL || '']);
  return events
    .filter((e) => e.t === 'spawn')
    .map((e) => ({ command: e.command, args: e.args || [], cwd: e.cwd, shell: !!e.shell }))
    .filter((s) => !SHELLS.has(s.command) || s.args.length);
}

/** What the model asked for, parsed out of a round's tool_calls. */
function declaredCommands(toolCalls) {
  const out = [];
  for (const call of toolCalls || []) {
    const name = call.name || '';
    if (name !== 'exec' && name !== 'execute_tool' && name !== 'Bash') continue;
    let args = call.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    if (args && typeof args.command === 'string') {
      out.push({ name, command: args.command, cwd: args.cwd, timeout: args.timeout });
    }
  }
  return out;
}

const pad = (s, n) => String(s).padEnd(n);
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, Math.max(1, n - 1)) + '…' : String(s));

function renderShell(commands, { title = 'shell chatflow', maxOutput = 12 } = {}) {
  const out = [];
  if (!commands.length) return out;
  const failed = commands.filter((c) => c.exit !== 0 && c.exit !== null);
  const totalMs = commands.reduce((a, c) => a + (c.ms || 0), 0);
  const bytes = commands.reduce((a, c) => a + (c.bytes || 0), 0);
  const slowest = commands.slice().sort((a, b) => (b.ms || 0) - (a.ms || 0))[0];

  out.push('');
  out.push(
    rule(
      `${title} — ${commands.length} command(s)${failed.length ? ` · ${failed.length} failed` : ''} · ${num(totalMs)}ms · ${num(bytes)} chars out`,
      '─',
    ),
  );

  const exitW = Math.max(...commands.map((c) => String(c.exit === null ? '—' : c.exit).length), 4);
  const cwdW = Math.min(34, Math.max(12, ...commands.map((c) => String(c.working_directory || c.cwd || '').length)));
  const cmdIndent = 2 + 3 + 1 + exitW + 2 + 8 + cwdW + 2;

  commands.forEach((c, i) => {
    const code = c.exit === null ? '—' : String(c.exit);
    const bad = c.exit !== null && c.exit !== 0;
    const tag = paint(pad(bad ? `exit ${code}` : `ok ${code}`, exitW + 3), bad ? C.red : C.green);
    const shellCwd = String(c.working_directory || c.cwd || '?');
    const cwd = paint(pad(clip(shellCwd, cwdW), cwdW), C.gray);
    const ms = paint(pad(c.ms === null ? '—' : `${c.ms}ms`, 8), C.dim);
    const lines = String(c.command).split('\n');
    out.push(`  ${paint(pad(i + 1, 3), C.gray)} ${tag} ${ms}${cwd}  ${bold(clip(lines[0], Math.max(20, WIDTH - cmdIndent - 2)))}`);
    for (const extra of lines.slice(1)) out.push(`${' '.repeat(cmdIndent + 2)}${paint(clip(extra, Math.max(20, WIDTH - cmdIndent - 2)), C.dim)}`);

    const notes = [];
    if (c.mode && c.mode !== 'session') notes.push(`${c.mode} (${c.mode === 'one-shot' ? 'no state kept' : 'session'})`);
    if (c.working_directory) notes.push('cwd scoped to this call');
    if (c.timeout) notes.push(`timeout ${c.timeout}ms`);
    if (c.declared && c.declared.command !== c.command) notes.push('≠ what the model asked for');
    if (notes.length) out.push(`${' '.repeat(cmdIndent + 2)}${dim(notes.join(' · '))}`);

    if (c.error) out.push(`${' '.repeat(cmdIndent + 2)}${paint('error: ' + clip(c.error, WIDTH - cmdIndent - 12), C.red)}`);

    if (c.output) {
      const outLines = String(c.output).split('\n');
      const cap = maxOutput > 0 ? maxOutput : outLines.length;
      const shown = outLines.slice(0, cap);
      for (const l of shown) out.push(`${' '.repeat(cmdIndent)}${paint('│ ', C.dim)}${clip(l, Math.max(20, WIDTH - cmdIndent - 4))}`);
      if (shown.length < outLines.length) {
        out.push(`${' '.repeat(cmdIndent)}${dim(`└ … ${num(outLines.length - shown.length)} more line(s) — --max-output 0 for all`)}`);
      }
    } else if (!c.error) {
      out.push(`${' '.repeat(cmdIndent)}${dim('│ (no output)')}`);
    }
  });

  if (commands.length > 1) {
    out.push(
      `  ${dim(
        `total ${num(totalMs)}ms${slowest && slowest.ms ? ` · slowest #${commands.indexOf(slowest) + 1} (${slowest.ms}ms)` : ''}` +
          ` · failing ${failed.length}/${commands.length}`,
      )}`,
    );
  }
  return out;
}

/** Lines of the system prompt that govern the shell — pulled, never hardcoded. */
function shellGuidance(system) {
  return String(system || '')
    .split('\n')
    .filter((l) => /\b(exec|shell|command|terminal)\b/i.test(l));
}

function execToolOf(tools) {
  for (const t of tools || []) {
    const fn = t.function || t;
    if (fn && fn.name === 'exec') return fn;
  }
  return null;
}

/**
 * The mimic view of the shell: what the model is told about `exec`, the tool
 * schema it may call, and the path that call takes to a real command.
 */
function renderShellSurface(turn) {
  const out = [];
  const exec = execToolOf(turn.tools);
  out.push('');
  out.push(rule(`the shell surface — ${exec ? 'exec' : 'no exec tool'} ${exec ? 'in the tool list' : 'advertised'}`, '─'));

  if (exec) {
    const props = (exec.parameters && exec.parameters.properties) || {};
    const required = new Set((exec.parameters && exec.parameters.required) || []);
    out.push(`  ${paint('execute_tool'.padEnd(14), C.gray)} ${dim('the loop calls one of these; exec is the shell one')}`);
    out.push('');
    const nameW = Math.max(...Object.keys(props).map((k) => k.length), 6);
    for (const [k, v] of Object.entries(props)) {
      const type = v.type || (v.items && `array<${v.items.type || 'any'}>`) || 'any';
      out.push(
        `  ${paint(pad(k, nameW), C.lavender)}  ${paint(pad(type, 8), C.blue)} ${required.has(k) ? paint('required ', C.gold) : dim('optional ')} ${dim(clip(v.description || '', Math.max(20, WIDTH - nameW - 34)))}`,
      );
    }
    if (exec.description) {
      out.push('');
      out.push(...boxed(exec.description, WIDTH, 14));
    }
  }

  const guidance = shellGuidance(turn.system);
  if (guidance.length) {
    out.push('');
    out.push(rule('what the system prompt says about the shell', '─'));
    out.push(...boxed(guidance.join('\n'), WIDTH, 24));
  }

  out.push('');
  out.push(rule('what happens to one exec call', '─'));
  const steps = [
    ['model', 'streams tool_call  exec  {"command":"git status --short","timeout":120000}'],
    ['engine.js', "dispatch → tools.executeTool('exec', args, { getShell, signal })"],
    ['tools.js', 'execInShell(shell, { command, cwd, timeout })'],
    ['shell.js', "ShellSession.run(command, { timeout, working_directory }) → stdin of ONE bash"],
    ['bash', "{ git status --short\n} </dev/null  →  __AEGIS_SH_<rand>__EXIT:0"],
    ['loop', 'output becomes the `tool` message, cd/export from it carry to the next call'],
  ];
  const swW = Math.max(...steps.map((s) => s[0].length));
  for (const [who, what] of steps) out.push(`  ${paint(pad(who, swW), C.lavender)}  ${clip(what, Math.max(20, WIDTH - swW - 6))}`);
  out.push('');
  out.push(
    `  ${dim('every one of these is recorded by the tap — see `node tools/chatflow-tap.mjs shell`')}`,
  );
  return out;
}

// ── producer 1: the offline mimic ───────────────────────────────────────────

function buildMimic(opts) {
  const require = createRequire(import.meta.url);
  const deps = require(path.join(CLI, 'src', 'deps.js'));
  const VERSION = require(path.join(CLI, 'package.json')).version;
  const promptModule = require(deps.paths.prompt);
  // The registry the agent loop advertises is the desktop's tools.js (engine.js
  // requires it relatively); deps.paths.tools is the MCP plugin's own registry,
  // which is a different module with a different export shape.
  const toolsModule = require(deps.resolveShared(path.join('desktop', 'lib', 'local', 'tools.js')));

  const cwd = path.resolve(opts.cwd || process.cwd());
  const model = opts.model || DEFAULT_SYSTEM;
  const wire = opts.wire === 'anthropic' ? 'anthropic' : 'openai';
  const includeSubagent = opts.noSubagent ? false : true;

  const env = {
    platform: process.platform,
    arch: process.arch,
    homedir: os.homedir(),
    cwd,
    appVersion: `aegiscode v${VERSION}`,
    ...(opts.roots ? { roots: String(opts.roots).split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    model,
  };
  const system = promptModule.buildSystemPrompt(env);
  const tools = toolsModule.toolsFor(wire, { includeSubagent });

  const history = [];
  if (opts.history) {
    const raw = fs.readFileSync(path.resolve(opts.history), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw.split('\n').filter(Boolean).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
    }
    const list = Array.isArray(parsed) ? parsed : parsed.messages || [];
    for (const m of list) if (m && m.role && m.role !== 'system') history.push(m);
  }

  const prompt = opts.prompt === undefined ? 'hey' : String(opts.prompt);
  // Mirrors aegis.js buildMessages(): the system prompt leads, and the prompt
  // is appended as a user turn unless the history already ends with it.
  const messages = [{ role: 'system', content: system }, ...history];
  if (prompt !== '') messages.push({ role: 'user', content: prompt });

  const effort = opts.effort || 'medium';
  const brain = opts.autonomous ? true : false;
  const maxTokens = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : null;

  // Mirrors engine.js dispatch('aegis') -> aegis.js chatCompletion(): the extra
  // fields travel inside the body, and `tools` rides along in that same bag.
  const body = {
    messages,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    model,
    stream: true,
    stream_options: { include_usage: true },
    aegis_memory: true,
    session: opts.session || '«session-id assigned by the CLI»',
    ...(brain === undefined ? {} : { brain }),
    ...(brain === false ? { mode: 'brain' } : {}),
    ...(effort ? { effort } : {}),
    ...(brain === true && opts.workers ? { workers: Number(opts.workers) } : {}),
    ...(tools.length ? { tools } : {}),
  };

  return {
    source: 'mimic',
    url: `${opts.apiBase || 'https://api.aegiscloud.org'}/api/v1/chat/completions`,
    method: 'POST',
    model,
    status: null,
    stream: true,
    includeUsage: true,
    flags: {
      effort,
      brain: brain === undefined ? undefined : brain,
      mode: brain === false ? 'brain' : undefined,
      'aegis_memory': true,
      session: body.session,
      'tool count': tools.length,
      'subagent tool': includeSubagent ? 'advertised' : 'dropped (depth cap)',
    },
    system,
    tools,
    messages,
    body,
  };
}

// ── producer 2: a capture file ──────────────────────────────────────────────

const EMPTY = () => ({ text: '', reasoning: '', toolCalls: [], deltaCount: 0 });

function assemble(events) {
  const order = [];
  const byId = new Map();
  for (const ev of events) {
    const id = ev.id || '(no-id)';
    if (!byId.has(id)) {
      byId.set(id, { id, deltas: EMPTY(), first: ev.ts, req: null, result: null, error: null });
      order.push(id);
    }
    const t = byId.get(id);
    if (ev.t === 'req') t.req = ev;
    else if (ev.t === 'delta') {
      t.deltas.deltaCount++;
      if (ev.channel === 'text') t.deltas.text += ev.value;
      else if (ev.channel === 'reasoning') t.deltas.reasoning += ev.value;
      else if (ev.channel === 'tool_calls') {
        const idx = typeof ev.index === 'number' ? ev.index : 0;
        const slot = t.deltas.toolCalls[idx] || { index: idx, name: '', arguments: '' };
        const v = ev.value || {};
        if (v.id) slot.id = v.id;
        if (v.function && v.function.name) slot.name += v.function.name;
        if (v.function && typeof v.function.arguments === 'string') slot.arguments += v.function.arguments;
        t.deltas.toolCalls[idx] = slot;
      }
    } else if (ev.t === 'end' || ev.t === 'res') t.result = ev;
    else if (ev.t === 'net') t.error = ev.error;
  }

  return order.map((id) => {
    const t = byId.get(id);
    const body = t.req && t.req.body ? t.req.body : {};
    const res = t.result || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const systemMsg = messages.find((m) => m && m.role === 'system');
    const resultBody = res.body && res.body.choices ? res.body : null;
    const choice = resultBody ? resultBody.choices[0] : null;
    const jsonText =
      choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : res.text || t.deltas.text || '';
    const jsonCalls =
      choice && Array.isArray(choice.message && choice.message.tool_calls)
        ? choice.message.tool_calls.map((c) => ({ name: c.function && c.function.name, arguments: c.function && c.function.arguments }))
        : [];
    const tools = body.tools || [];
    const flags = {};
    for (const key of ['effort', 'workers', 'brain', 'mode', 'aegis_memory', 'session', 'tool_choice', 'max_tokens']) {
      if (body[key] !== undefined) flags[key] = body[key];
    }
    return {
      source: 'capture',
      id,
      ts: t.first,
      url: t.req ? t.req.url : '',
      method: t.req ? t.req.method : 'POST',
      headers: t.req ? t.req.headers : null,
      model: body.model,
      status: res.status,
      ms: res.ms,
      error: t.error || (res.ok === false ? JSON.stringify(res.body).slice(0, 2000) : null),
      stream: body.stream,
      includeUsage: !!(body.stream_options && body.stream_options.include_usage),
      flags,
      system: systemMsg ? String(systemMsg.content) : '',
      tools,
      messages,
      text: jsonText,
      reasoning: res.reasoning || t.deltas.reasoning,
      toolCalls: jsonCalls.length ? jsonCalls : t.deltas.toolCalls.filter((c) => c && c.name),
      usage: (res.usage && Object.keys(res.usage).length && res.usage) || resultBody?.usage || null,
      body,
    };
  });
}

function readCapture(file) {
  const text = fs.readFileSync(file, 'utf8');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* a half-written last line: ignore until it is complete */
    }
  }
  return events;
}

function latestCapture() {
  const pointer = path.join(CAPTURE_DIR, 'latest');
  try {
    const p = fs.readFileSync(pointer, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* fall through to a scan */
  }
  let best = null;
  try {
    for (const f of fs.readdirSync(CAPTURE_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(CAPTURE_DIR, f);
      const st = fs.statSync(full);
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs };
    }
  } catch {
    return null;
  }
  return best ? best.file : null;
}

// ── subcommands ─────────────────────────────────────────────────────────────

function cmdMimic() {
  const turn = buildMimic(opts);
  if (opts.json) {
    process.stdout.write(renderBody(turn) + '\n');
    return 0;
  }
  const lines = renderTurn(turn, 1);
  lines.push(...renderShellSurface(turn));
  if (opts.raw) lines.push('', rule('raw request body'), renderBody(turn));
  lines.push('');
  lines.push(
    dim(
      '  Mimic: rebuilt offline from the CLI\'s own prompt + tool builders — nothing was sent.\n' +
        (opts.noShell
          ? ''
          : '  The shell half is what the tap records live: `node tools/chatflow-tap.mjs run -- <cli args>`, then `shell`.\n'),
    ),
  );
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

/**
 * Walk the capture once and hand back both halves of the chatflow: the chat
 * rounds, and the shell commands, each attributed to the round that was in
 * flight when it ran (that is the order the model sees them: it called the
 * tool in round N, and the result arrives as a message in round N+1).
 */
function timeline(events) {
  const turns = assemble(events);
  const shell = assembleShell(events);
  const spawns = assembleSpawns(events);

  const starts = turns
    .map((t, i) => ({ i, ts: t.ts || 0 }))
    .sort((a, b) => a.ts - b.ts);
  const owner = new Map();
  const orphans = [];
  for (const cmd of shell) {
    let pick = null;
    for (const s of starts) if (s.ts <= cmd.ts) pick = s;
    if (pick) {
      if (!owner.has(pick.i)) owner.set(pick.i, []);
      owner.get(pick.i).push(cmd);
    } else {
      orphans.push(cmd);
    }
  }

  // Show the model's own tool_call next to the command it became, and flag an
  // exec the model asked for that never reached the shell (denied, aborted).
  turns.forEach((turn, i) => {
    const mine = owner.get(i) || [];
    const declared = declaredCommands(turn.toolCalls);
    const unclaimed = [];
    declared.forEach((d, k) => {
      if (mine[k]) mine[k].declared = d;
      else unclaimed.push(d);
    });
    turn.shell = mine;
    turn.declaredNotRun = unclaimed;
  });

  return { turns, shell, spawns, orphans };
}

function renderShellSection(shell, spawns, maxOutput) {
  const lines = [];
  lines.push(...renderShell(shell, { maxOutput }));
  if (spawns.length) {
    lines.push('');
    lines.push(rule(`other child processes — ${spawns.length}`, '─'));
    const cmdW = Math.min(30, Math.max(8, ...spawns.map((s) => s.command.length)));
    for (const s of spawns) {
      lines.push(
        `  ${paint(pad(clip(s.command, cmdW), cmdW), C.lavender)}  ${clip(s.args.join(' '), Math.max(20, WIDTH - cmdW - 10))}  ${dim(clip(s.cwd || '', 30))}`,
      );
    }
  }
  return lines;
}

function renderFile(file, { json, maxOutput }) {
  const events = readCapture(file);
  const { turns, shell, spawns, orphans } = timeline(events);
  if (json) {
    process.stdout.write(
      JSON.stringify({ rounds: turns.map((t) => t.body), shell, spawns }, null, 2) + '\n',
    );
    return 0;
  }
  const lines = [];
  lines.push('');
  lines.push(frame(`capture · ${path.basename(file)}`));
  lines.push(
    `  ${dim(num(events.length) + ' events · ' + num(turns.length) + ' chat round(s) · ' + num(shell.length) + ' shell command(s)')}`,
  );
  if (!turns.length && !shell.length) lines.push(`  ${dim('nothing captured in this file')}`);
  turns.forEach((t, i) => {
    lines.push(...renderTurn(t, i + 1));
    if (t.shell && t.shell.length) {
      lines.push(...renderShell(t.shell, { title: `shell after round ${i + 1}`, maxOutput }));
    }
    if (t.declaredNotRun && t.declaredNotRun.length) {
      lines.push('');
      lines.push(rule('declared but never ran — the model asked, the shell never saw it', '─'));
      for (const d of t.declaredNotRun) {
        lines.push(`  ${paint('exec', C.lavender)} ${clip(d.command, Math.max(20, WIDTH - 30))} ${dim('(denied, aborted, or the turn ended)')}`);
      }
    }
  });
  if (orphans.length) lines.push(...renderShell(orphans, { title: 'shell (no chat round in this capture)', maxOutput }));
  if (spawns.length) {
    lines.push('');
    lines.push(rule(`other child processes — ${spawns.length}`, '─'));
    const cmdW = Math.min(30, Math.max(8, ...spawns.map((s) => s.command.length)));
    for (const s of spawns) {
      lines.push(
        `  ${paint(pad(clip(s.command, cmdW), cmdW), C.lavender)}  ${clip(s.args.join(' '), Math.max(20, WIDTH - cmdW - 10))}  ${dim(clip(s.cwd || '', 34))}`,
      );
    }
  }
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

/** Resolve `[file]` or the newest capture, or explain why not and fail. */
function resolveCapture() {
  const file = opts._[0] ? path.resolve(opts._[0]) : latestCapture();
  if (!file || !fs.existsSync(file)) {
    process.stderr.write(`chatflow-tap: no capture found under ${CAPTURE_DIR}\n`);
    return null;
  }
  return file;
}

function cmdReport() {
  const file = resolveCapture();
  if (!file) return 1;
  return renderFile(file, { json: !!opts.json, maxOutput: maxOutputOpt() });
}

/** `shell` — only the shell half, which is the chatflow a coding agent runs. */
function cmdShell() {
  const file = resolveCapture();
  if (!file) return 1;
  const { turns, shell, spawns, orphans } = timeline(readCapture(file));
  const attributed = shell.filter((c) => !orphans.includes(c));
  const tag = new Map();
  turns.forEach((t, i) => {
    for (const c of t.shell || []) tag.set(c.id, i + 1);
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ shell, spawns }, null, 2) + '\n');
    return 0;
  }

  const picked = opts.last ? shell.slice(-Number(opts.last)) : shell;
  if (!picked.length) {
    process.stdout.write(
      `  ${dim('no shell commands in ' + path.basename(file) + ' — nothing called exec, or the capture predates the shell tap')}\n`,
    );
    return 0;
  }

  const maxOutput = maxOutputOpt();
  const lines = [];
  lines.push('');
  lines.push(frame(`shell chatflow · ${path.basename(file)}`));
  if (turns.length || attributed.length === picked.length) {
    lines.push(
      `  ${dim(num(picked.length) + ' exec command(s) across ' + num(turns.length) + ' chat round(s) · from ' + path.basename(file))}`,
    );
  }
  // Group by the round that issued them, so the report reads the way the turn
  // did: model → tool_call → command → output → next round.
  const groups = [];
  const byRound = new Map();
  for (const c of picked) {
    const round = tag.get(c.id) || 0;
    if (!byRound.has(round)) {
      byRound.set(round, []);
      groups.push({ round, cmds: byRound.get(round) });
    }
    byRound.get(round).push(c);
  }
  for (const g of groups) {
    const declared = (turns[g.round - 1] && turns[g.round - 1].toolCalls) || [];
    if (g.round) {
      const asked = declaredCommands(declared);
      lines.push(
        `  ${paint('❯', C.lavender)} ${bold('after round ' + g.round)} ${dim(asked.length ? `· model asked for ${asked.length} command(s)` : '')}`,
      );
    } else {
      lines.push(`  ${paint('❯', C.lavender)} ${bold('unattributed')} ${dim('· no chat round in this capture')}`);
    }
    lines.push(...renderShell(g.cmds, { title: g.round ? `round ${g.round} commands` : 'commands', maxOutput }));
  }
  if (spawns.length) {
    lines.push('');
    lines.push(rule(`other child processes — ${spawns.length}`, '─'));
    for (const s of spawns) lines.push(`  ${paint(s.command, C.lavender)} ${clip(s.args.join(' '), Math.max(20, WIDTH - 30))}`);
  }
  lines.push('');
  lines.push(dim('  the same view inline with each round: `node tools/chatflow-tap.mjs report`'));
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

function cmdWatch() {
  let file = opts._[0] ? path.resolve(opts._[0]) : latestCapture();
  if (!file) {
    // Wait for a session to appear — this is meant to run beside `run`.
    process.stderr.write(`chatflow-tap: waiting for a capture under ${CAPTURE_DIR}\n`);
    const started = Date.now();
    while (!file && Date.now() - started < 120000) {
      try {
        file = latestCapture();
      } catch {
        /* not yet */
      }
      if (!file) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
    if (!file) {
      process.stderr.write('chatflow-tap: gave up waiting\n');
      return 1;
    }
  }
  process.stdout.write(`  ${dim('watching ' + file)} — Ctrl-C to stop\n`);
  let offset = 0;
  let buffer = '';
  let pending = new Map();
  let order = 0;
  const flush = (events) => {
    const done = new Set();
    for (const ev of events) {
      const id = ev.id || '(no-id)';
      if (!pending.has(id)) pending.set(id, []);
      pending.get(id).push(ev);
      if (ev.t === 'end' || ev.t === 'res' || ev.t === 'net') done.add(id);
    }
    for (const id of done) {
      const group = pending.get(id) || [];
      pending.delete(id);
      const [turn] = assemble(group);
      if (turn) process.stdout.write(renderTurn(turn, ++order).join('\n') + '\n');
    }
  };
  const tick = () => {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    if (st.size < offset) {
      offset = 0;
      buffer = '';
      pending = new Map();
    }
    if (st.size === offset) return;
    const fd = fs.openSync(file, 'r');
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    offset = st.size;
    buffer += buf.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    const events = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* incomplete */
      }
    }
    if (events.length) flush(events);
  };
  setInterval(tick, 300);
  return null; // runs until Ctrl-C
}

function cmdRun() {
  const bin = path.join(CLI, 'bin', 'aegiscode.js');
  if (!fs.existsSync(bin)) {
    process.stderr.write(`chatflow-tap: cannot find ${bin}\n`);
    return 1;
  }
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const capture = opts.out
    ? path.resolve(opts.out)
    : path.join(CAPTURE_DIR, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  fs.writeFileSync(capture, '');

  const tap = path.join(HERE, 'chatflow-tap.cjs');
  const nodeOptions = [process.env.NODE_OPTIONS || '', `--require ${tap}`].filter(Boolean).join(' ');
  const env = { ...process.env, NODE_OPTIONS: nodeOptions, AEGIS_CHATFLOW_TAP: capture };

  process.stderr.write(
    `  ${dim('tap: ' + tap)}\n  ${dim('capture: ' + capture)}\n  ${dim('running: node ' + bin + ' ' + opts._.join(' '))}\n\n`,
  );

  const child = spawn(process.execPath, [bin, ...opts._], { stdio: 'inherit', env });
  child.on('exit', (code) => {
    if (opts.watch) return; // a watcher in another terminal is rendering
    const turns = assemble(readCapture(capture));
    process.stdout.write('\n' + frame(`capture · ${path.basename(capture)}`) + '\n');
    process.stdout.write(`  ${dim(num(turns.length) + ' chat round(s) captured')}\n`);
    turns.forEach((t, i) => process.stdout.write(renderTurn(t, i + 1).join('\n') + '\n'));
    process.stdout.write(`\n  ${dim('full capture: ' + capture)}\n`);
    process.exitCode = code || 0;
  });
  return null; // the child owns the lifecycle
}

// ── main ────────────────────────────────────────────────────────────────────

const COMMANDS = { mimic: cmdMimic, run: cmdRun, report: cmdReport, watch: cmdWatch };

if (opts.help || command === 'help' || !COMMANDS[command]) {
  process.stdout.write(
    [
      'usage: node tools/chatflow-tap.mjs <mimic|run|report|watch> [options]',
      '',
      '  mimic    rebuild the payload the CLI would send for one turn (offline)',
      '           --prompt "…"   --cwd DIR   --model ID   --effort low|medium|high',
      '           --autonomous   --workers N   --max-tokens N   --session ID',
      '           --history FILE   --no-subagent   --json (raw body only)',
      '           --raw (append the raw JSON body to the report)   --max-prompt N',
      '  run      spawn the real CLI with the tap preloaded, then render the rounds',
      '           everything after `--` goes to the CLI; --out FILE, --watch',
      '  report   render a capture file (default: the newest one)   --json',
      '  watch    follow a capture in a second terminal while `run` drives the CLI',
      '',
      '  global: --width N   --no-color',
      '',
    ].join('\n'),
  );
  process.exitCode = COMMANDS[command] ? 0 : 1;
} else {
  const code = COMMANDS[command]();
  if (typeof code === 'number') process.exitCode = code;
}
