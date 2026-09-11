'use strict';

/**
 * tools.js — the local tool layer for the desktop agent loop (client half of
 * aegiscodex-dev's tool calling).
 *
 * Two jobs, mirroring aegiscodex-dev/src/tools.js:
 *   1. Tool schemas in the wire format each API family expects — Anthropic's
 *      `{name, description, input_schema}` vs OpenAI-compatible
 *      `{type:'function', function:{name, description, parameters}}`.
 *   2. Local execution of the builtin tools (readFile, writeFile, editFile,
 *      listDir, glob, grep, exec), so a chat turn in the desktop app can
 *      actually touch the machine instead of only talking about it.
 *
 * `exec` runs in a persistent shell session (shell.js) when the caller
 * supplies `ctx.getShell` — cd/export/env state then carries across calls
 * within one turn, same as the CLI's Bash tool. `task` is advertised here
 * (SUBAGENT_TOOL) but has no local executor: it needs to run the model, so
 * engine.js's chat loop handles it directly as a nested subagent turn.
 *
 * Path note: this lives under desktop/lib/local/ (not desktop/lib/) because
 * the CI thin-shell guard (.github/workflows/ci.yml, step 4) allowlists only
 * `desktop/lib/local/`, `desktop/lib/sync/` and `desktop/lib/settings.js` as
 * transport paths — a new file directly under desktop/lib/ fails that guard.
 *
 * Everything here is self-contained (node:child_process + node:fs + node:path
 * only, no new dependencies) and NEVER throws: each executor resolves either
 * `{ ok: true, output }` or `{ ok: false, error }`, so a bad path, a dead
 * command or a hostile arg string can only ever become a tool error handed
 * back to the model — never a rejected IPC call or a crashed main process.
 *
 * SECURITY: this is a deliberate widening of the app's sandbox. The renderer
 * stays contextIsolated + sandboxed with no fs/child_process of its own; the
 * executor lives in the MAIN process and is reachable from the renderer only
 * through the whitelisted `tools:` IPC surface (see main.js/preload.js and
 * docs/desktop-tools.md). There is no path jail: the tools deliberately run
 * with the user's own privileges, exactly like the CLI does. Treat any future
 * renderer-side input that reaches these args as privileged.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { agentRoles } = require('./agents.js');

const OUTPUT_CAP = 30_000; // chars fed back to the model per tool result
const READ_LINE_CAP = 2000; // default line limit for readFile
const MATCH_CAP = 100; // max glob/grep hits per call
// readFileSync loads the whole file before `limit` ever truncates — refuse
// oversized reads outright instead of freezing the turn on a multi-GB log.
const READ_SIZE_CAP = 25 * 1024 * 1024;
const GREP_SIZE_CAP = 10 * 1024 * 1024; // grep silently skips files above this
const EXEC_TIMEOUT_DEFAULT = 120_000;
const EXEC_TIMEOUT_CAP = 600_000; // 10 minutes, matches the CLI's cap
const EXEC_MAX_BUFFER = 1_048_576; // 1 MB of combined stdout+stderr

/** Truncate oversized tool output (the model never needs the whole log). */
function cap(s) {
  const text = String(s == null ? '' : s);
  return text.length > OUTPUT_CAP
    ? `${text.slice(0, OUTPUT_CAP)}\n… (truncated)`
    : text;
}

const ok = (output) => ({ ok: true, output: cap(output) });
const fail = (error) => ({ ok: false, error: cap(error) });

// ── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Canonical descriptions + parameters, in one place per tool. The two wire
 * formats below are pure projections of this map, so a schema can never drift
 * between providers (see the conversion test in test/local-tools.test.mjs).
 */
const SCHEMAS = {
  readFile: {
    name: 'readFile',
    description:
      'Reads a file from the local filesystem. The file_path parameter must be an absolute path. ' +
      'Returns line-numbered content.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to read' },
        offset: { type: 'number', description: 'The line number to start reading from (0-based)' },
        limit: { type: 'number', description: `The number of lines to read (max 10000, default ${READ_LINE_CAP})` },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  writeFile: {
    name: 'writeFile',
    description:
      'Writes a file to the local filesystem. Parent directories are created automatically. ' +
      'Use it to create or replace a whole file; it overwrites whatever was there.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to write' },
        content: { type: 'string', description: 'The full contents of the file' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  },
  editFile: {
    name: 'editFile',
    description:
      'Performs an exact string replacement in a file. old_string must be unique in the file ' +
      'unless replace_all is true. Use this instead of writeFile when changing part of an ' +
      'existing file — it fails loudly on a non-unique or missing match instead of guessing.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to modify' },
        old_string: { type: 'string', description: 'The text to replace (must be unique unless replace_all is true)' },
        new_string: { type: 'string', description: 'The text to replace it with' },
        replace_all: { type: 'boolean', description: 'If true, replace all occurrences of old_string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  listDir: {
    name: 'listDir',
    description:
      'Lists one directory (non-recursive). Directories are marked with a trailing slash. ' +
      'Skips node_modules, .git and dist.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The directory to list (default: the working directory)' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  glob: {
    name: 'glob',
    description:
      'Find files matching a glob pattern. Supports **, * and ?. Skips node_modules, .git and dist by default.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern to match, e.g. "**/*.test.js"' },
        path: { type: 'string', description: 'The directory to search from (default: the working directory)' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  grep: {
    name: 'grep',
    description:
      'Search file contents using a regular expression. Returns file:line matches. ' +
      'Skips node_modules, .git and dist by default.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regular expression to search for' },
        path: { type: 'string', description: 'The directory to search in (default: the working directory)' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  exec: {
    name: 'exec',
    description:
      'Executes a shell command in a persistent shell session and returns its combined ' +
      'stdout+stderr plus the exit code. State (cd, exported env vars) carries across calls ' +
      'within the same turn — it is a real session, not a fresh process each time. ' +
      'Use for system operations, git commands and package management.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        cwd: { type: 'string', description: 'Run this one command in a different directory without moving the session (the session cwd is unchanged for later calls)' },
        timeout: { type: 'number', description: `Timeout in milliseconds (max ${EXEC_TIMEOUT_CAP}, default ${EXEC_TIMEOUT_DEFAULT})` },
        description: { type: 'string', description: 'A brief description of what the command does (for display)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  task: {
    name: 'task',
    description:
      'Spawn a specialized subagent to autonomously handle a focused, multi-step sub-task. ' +
      'The subagent runs its own tool loop (readFile/writeFile/editFile/listDir/glob/grep/exec) ' +
      'on the same model and returns a final report as the tool result. Use it to delegate work ' +
      'like scanning for vulnerabilities, reviewing code, planning a refactor, or scaffolding a ' +
      'component — give it a complete, self-contained prompt since it cannot ask follow-up ' +
      'questions. Subagents can delegate further with task, so a large job can be split ' +
      'hierarchically as deep as useful.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short (3-5 word) description of the sub-task' },
        subagent_type: {
          type: 'string',
          enum: [...agentRoles(), 'general'],
          description: 'Which specialist preset to spawn (general = a capable all-purpose agent)',
        },
        prompt: { type: 'string', description: 'The full, self-contained task instructions for the subagent' },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
  },
};

// task is executed by the chat loop (it needs to run the model), not by the
// local executors below — advertised in the schemas but handled in
// engine.js's chat(). Subagents get task too, so delegation can nest —
// engine.js drops it (via includeSubagent) once the delegation chain passes
// MAX_SUBAGENT_DEPTH, hard-bounding runaway recursion.
const SUBAGENT_TOOL = 'task';

/** Tool names in advertisement order. `includeSubagent: false` drops task (depth cap). */
function toolNames({ includeSubagent = true } = {}) {
  return schemaList(includeSubagent).map((s) => s.name);
}

function schemaList(includeSubagent) {
  return Object.values(SCHEMAS).filter((s) => includeSubagent || s.name !== SUBAGENT_TOOL);
}

/** Anthropic Messages API tool definitions ({name, description, input_schema}). */
function anthropicTools({ includeSubagent = true } = {}) {
  return schemaList(includeSubagent).map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.parameters,
  }));
}

/** OpenAI-compatible /chat/completions tool definitions ({type:'function', function}). */
function openaiTools({ includeSubagent = true } = {}) {
  return schemaList(includeSubagent).map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));
}

/**
 * The advertised tool list for one wire format. `wire` is 'anthropic' or
 * anything else (treated as OpenAI-compatible) — the same split the transport
 * layer uses. `includeSubagent: false` drops the task tool (subagent depth cap).
 */
function toolsFor(wire, { includeSubagent = true } = {}) {
  return wire === 'anthropic' ? anthropicTools({ includeSubagent }) : openaiTools({ includeSubagent });
}

/**
 * Convert an OpenAI-format tool list into Anthropic's. Exported because it is
 * the exact transformation the loop depends on (and it is unit-tested as
 * such): an endpoint that speaks Anthropic must never be handed
 * `{type:'function', function:{…}}`.
 */
function openaiToAnthropicTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      const fn = (t && t.function) || t || {};
      if (!fn.name) return null;
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} },
      };
    })
    .filter(Boolean);
}

/** Reverse projection (Anthropic → OpenAI), for symmetry/completeness. */
function anthropicToOpenaiTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      if (!t || !t.name) return null;
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      };
    })
    .filter(Boolean);
}

// ── Executors ───────────────────────────────────────────────────────────────

function readFile({ file_path, offset = 0, limit } = {}) {
  try {
    if (!file_path) return fail('file_path is required');
    const stat = fs.statSync(file_path);
    if (stat.isDirectory()) return fail(`${file_path} is a directory (use listDir)`);
    if (stat.size > READ_SIZE_CAP) {
      const mb = (stat.size / 1048576).toFixed(1);
      return fail(
        `${file_path} is ${mb} MB — too large to read (limit ${READ_SIZE_CAP / 1048576} MB). ` +
          'Use exec with grep/head to inspect it instead.'
      );
    }
    const lines = fs.readFileSync(file_path, 'utf8').split('\n');
    const start = Math.max(0, Number(offset) || 0);
    const count = Math.max(1, Math.min(Number(limit) || READ_LINE_CAP, 10_000));
    const picked = lines.slice(start, start + count);
    const numbered = picked.map((l, i) => `${i + start + 1}| ${l}`).join('\n');
    const tail =
      start + picked.length < lines.length
        ? `\n… (${lines.length - start - picked.length} more lines)`
        : '';
    return ok(numbered + tail);
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  }
}

function writeFile({ file_path, content } = {}) {
  try {
    if (!file_path) return fail('file_path is required');
    fs.mkdirSync(path.dirname(file_path), { recursive: true });
    fs.writeFileSync(file_path, String(content == null ? '' : content), 'utf8');
    return ok(`Wrote ${String(content == null ? '' : content).length} bytes to ${file_path}`);
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  }
}

function editFile({ file_path, old_string, new_string, replace_all } = {}) {
  try {
    if (!file_path) return fail('file_path is required');
    if (old_string === undefined || old_string === '') {
      return fail('old_string is required and must be non-empty');
    }
    const src = fs.readFileSync(file_path, 'utf8');
    const count = src.split(old_string).length - 1;
    if (count === 0) return fail(`old_string not found in ${file_path}`);
    if (count > 1 && !replace_all) {
      return fail(`old_string is not unique (${count} matches) — use replace_all or more context`);
    }
    const next = replace_all
      ? src.split(old_string).join(new_string == null ? '' : new_string)
      : src.replace(old_string, new_string == null ? '' : new_string);
    fs.writeFileSync(file_path, next, 'utf8');
    return ok(`Edited ${file_path} (${count} occurrence${count > 1 ? 's' : ''} replaced)`);
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  }
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.aegiscode']);

function listDir({ path: dir } = {}) {
  try {
    const base = dir || process.cwd();
    const entries = fs.readdirSync(base, { withFileTypes: true });
    const rows = entries
      .filter((e) => !IGNORED_DIRS.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b));
    return ok(rows.join('\n') || '(empty directory)');
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  }
}

/** Translate a glob into a regex over '/'-separated relative paths. */
function globToRegex(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (/[.+^${}()|[\]\\]/.test(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(re + '$');
}

function walk(dir, fn, depth = 0) {
  if (depth > 12) return; // hard bound: never crawl an unbounded tree
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, fn, depth + 1);
    else fn(full);
  }
}

function glob({ pattern, path: root } = {}) {
  try {
    if (!pattern) return fail('pattern is required');
    const base = root || process.cwd();
    const re = globToRegex(String(pattern));
    const hits = [];
    walk(base, (full) => {
      if (hits.length >= MATCH_CAP) return;
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (re.test(rel)) hits.push(rel);
    });
    return ok(hits.join('\n') || '(no matches)');
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  }
}

function grep({ pattern, path: root } = {}) {
  try {
    if (!pattern) return fail('pattern is required');
    const re = new RegExp(pattern);
    const base = root || process.cwd();
    const hits = [];
    walk(base, (full) => {
      if (hits.length >= MATCH_CAP) return;
      let text;
      try {
        // Skip oversized files (logs, dumps, binaries) instead of slurping
        // them — a 10 GB log would otherwise stall the whole tool loop.
        if (fs.statSync(full).size > GREP_SIZE_CAP) return;
        text = fs.readFileSync(full, 'utf8');
      } catch {
        return;
      }
      const rel = path.relative(base, full).split(path.sep).join('/');
      for (const [i, line] of text.split('\n').entries()) {
        if (hits.length >= MATCH_CAP) return;
        if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.slice(0, 160)}`);
      }
    });
    return ok(hits.join('\n') || '(no matches)');
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  }
}

/** Shell to run `exec` in: cmd.exe on Windows, $SHELL (or /bin/sh) elsewhere. */
function shellSpec() {
  if (process.platform === 'win32') {
    return { cmd: process.env.ComSpec || 'cmd.exe', arg: '/d /s /c' };
  }
  return { cmd: process.env.SHELL || '/bin/sh', arg: '-c' };
}

/**
 * Run a shell command as a fresh one-shot process (no state carried to the
 * next call). Never rejects: spawn failures, a stalled child, a non-zero
 * exit and output overflow all resolve as `{ ok:false, error }` (a non-zero
 * exit is reported as an error so the model sees the failure, with whatever
 * the command printed attached).
 */
function execOneShot({ command, cwd, timeout, maxBuffer } = {}) {
  return new Promise((resolve) => {
    const limit = Math.min(Number(maxBuffer) || EXEC_MAX_BUFFER, EXEC_MAX_BUFFER);
    const ms = Math.min(Number(timeout) || EXEC_TIMEOUT_DEFAULT, EXEC_TIMEOUT_CAP);
    const { cmd, arg } = shellSpec();

    let child;
    try {
      child = spawn(cmd, [arg, command], {
        cwd: cwd || process.cwd(),
        timeout: ms,
        killSignal: 'SIGKILL',
        windowsHide: true,
      });
    } catch (e) {
      resolve(fail(`spawn failed: ${e && e.message ? e.message : e}`));
      return;
    }

    let out = '';
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, ms);

    const collect = (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        overflow = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        return;
      }
      out += chunk;
    };

    if (child.stdout) child.stdout.on('data', collect);
    if (child.stderr) child.stderr.on('data', collect);

    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    child.on('error', (e) => done(fail(`spawn failed: ${e && e.message ? e.message : e}`)));
    child.on('close', (code, signal) => {
      const body = out.trim();
      if (timedOut) {
        done(fail(`command timed out after ${ms}ms${body ? `\n${body}` : ''}`));
        return;
      }
      if (overflow) {
        // The buffer cap is what the model should see: trimming to OUTPUT_CAP
        // below would hide the fact that output was dropped.
        done(fail(`output exceeded ${limit} bytes and was truncated\n${body}`));
        return;
      }
      const label = `exit ${code == null ? `signal ${signal}` : code}`;
      if (code === 0) done(ok(body || `(${label}, no output)`));
      else done(fail(`${label}${body ? `\n${body}` : ''}`));
    });
  });
}

/**
 * Run a persistent-session command and translate the session's { content,
 * isError } shape into this file's { ok, output } / { ok:false, error }
 * convention. An abort signal disposes the session immediately instead of
 * waiting out the command's own timeout.
 */
function execInShell(shell, { command, cwd, timeout }, signal) {
  if (signal && signal.aborted) {
    shell.dispose();
    return Promise.resolve(fail('aborted'));
  }
  return new Promise((resolve) => {
    const onAbort = () => shell.dispose();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const release = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    shell.run(command, { timeout, working_directory: cwd }).then(
      (r) => { release(); resolve(r.isError ? fail(r.content) : ok(r.content)); },
      (e) => { release(); resolve(fail(`shell session failed: ${e && e.message ? e.message : e}`)); }
    );
  });
}

/**
 * Execute a shell command. When the caller supplies `ctx.getShell` (the
 * chat loop always does — see engine.js), the command runs in that turn's
 * persistent session so cd/export/env state carries to the next call. Without
 * one (e.g. a direct executeTool call in tests) it falls back to a one-shot
 * spawn — same output shape, no persisted state. Never rejects.
 */
function exec({ command, cwd, timeout, maxBuffer } = {}, ctx = {}) {
  if (!command || typeof command !== 'string') {
    return Promise.resolve(fail('command is required'));
  }
  const shell = typeof ctx.getShell === 'function' ? ctx.getShell() : null;
  if (shell) return execInShell(shell, { command, cwd, timeout }, ctx.signal);
  return execOneShot({ command, cwd, timeout, maxBuffer });
}

const EXECUTORS = { readFile, writeFile, editFile, listDir, glob, grep, exec };

/** True when `name` is a tool this layer can run (task is excluded — see SUBAGENT_TOOL). */
function isTool(name) {
  return Object.prototype.hasOwnProperty.call(EXECUTORS, name);
}

/**
 * Execute one tool call. Always resolves `{ ok, output }` or `{ ok, error }`
 * — an unknown tool name, a non-object args payload and an exploding executor
 * all land on the error branch rather than rejecting. `ctx` carries per-turn
 * state (getShell, signal); omit it and exec falls back to a one-shot spawn.
 */
async function executeTool(name, args, ctx) {
  if (!isTool(name)) return fail(`unknown tool "${name}" (known: ${toolNames().join(', ')})`);
  const input = args && typeof args === 'object' ? args : {};
  try {
    return await EXECUTORS[name](input, ctx || {});
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  }
}

/**
 * The string a tool result contributes to the conversation: the output on
 * success, `error: …` on failure — the same shape the CLI feeds back.
 */
function toolResultText(result) {
  if (!result) return 'error: tool produced no result';
  return result.ok ? String(result.output == null ? '' : result.output) : `error: ${result.error}`;
}

module.exports = {
  // schemas
  SCHEMAS,
  SUBAGENT_TOOL,
  toolNames,
  anthropicTools,
  openaiTools,
  toolsFor,
  openaiToAnthropicTools,
  anthropicToOpenaiTools,
  // execution
  executeTool,
  isTool,
  toolResultText,
  // limits (unit tests assert against them instead of hard-coding numbers)
  OUTPUT_CAP,
  READ_LINE_CAP,
  MATCH_CAP,
  READ_SIZE_CAP,
  GREP_SIZE_CAP,
  EXEC_TIMEOUT_DEFAULT,
  EXEC_TIMEOUT_CAP,
  EXEC_MAX_BUFFER,
};
