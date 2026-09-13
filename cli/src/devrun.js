'use strict';

/**
 * /run support: sniff the project's dev command and run it in a captured
 * sub-shell. Output streams to the transcript as it happens; the session loop
 * can stop the process (Esc) via the returned job handle.
 *
 * Ported from aegiscodex-dev/src/devrun.js (ESM → CommonJS).
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_STREAM_LINES = 40;

/** Detect the most likely dev command for a project, or null. */
function detectDevCommand(cwd = process.cwd()) {
  const pkg = path.join(cwd, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts || {};
      for (const name of ['dev', 'start', 'watch', 'serve']) {
        if (typeof scripts[name] === 'string' && scripts[name].trim()) return `npm run ${name}`;
      }
    } catch {}
    return 'npm start';
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go run .';
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo run';
  if (fs.existsSync(path.join(cwd, 'Makefile'))) return 'make';
  if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) return 'python -m <module>'; // honest: user picks
  return null;
}

/**
 * Run a shell command, streaming stdout/stderr lines to onLine. Returns a job:
 *   { stop(), done: Promise<{ code, stopped }> }
 * The child is killed (SIGTERM) when stop() is called.
 */
function runDevServer(command, { onLine, signal, cwd } = {}) {
  // detached + kill(-pid) so the whole process group dies (shell + child),
  // otherwise a stopped dev server leaks its grandchildren.
  const child = spawn(command, { shell: true, cwd: cwd || process.cwd(), env: process.env, detached: true });
  let buffer = '';
  let stopped = false;
  let code = null;
  let nLines = 0;
  // Settle-once guard shared by every completion path. The job's `done` MUST
  // resolve: the session loop's streamJob guard — which swallows every key
  // while a /run job is live — is only cleared by job.done settling. If
  // 'close' never fires (a detached grandchild escaped the group kill and
  // still holds the stdout pipe), 'exit' + the stop fallback cover it.
  let doneResolved = false;
  let resolveDone = null;

  const deliver = (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '').trimEnd();
      buffer = buffer.slice(idx + 1);
      if (line && nLines++ < MAX_STREAM_LINES && onLine) onLine(line);
    }
  };
  child.stdout && child.stdout.on('data', deliver);
  child.stderr && child.stderr.on('data', deliver);
  if (buffer.trim() && onLine) onLine(buffer.trim()); // trailing partial line

  const killGroup = () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  };
  const onAbort = () => { stopped = true; killGroup(); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const settle = (patch) => {
    if (doneResolved) return;
    doneResolved = true;
    if (signal) signal.removeEventListener('abort', onAbort);
    resolveDone(patch);
  };

  const done = new Promise((resolve) => { resolveDone = resolve; });
  child.on('error', () => settle({ code: code ?? 1, stopped }));
  child.on('close', (c) => {
    code = c;
    settle({ code, stopped });
  });
  // 'close' waits for the stdio pipes; a grandchild that escaped the group
  // keeps the write end open and 'close' never fires. Settle shortly after
  // the shell itself exits, whatever the pipes do.
  child.on('exit', () => setTimeout(() => settle({ code: code ?? 0, stopped }), 1000));

  return {
    stop: () => {
      stopped = true;
      killGroup();
      // Pipe-holding survivors can still delay 'close' — force the job to
      // settle so the session loop's streamJob guard can't swallow keys.
      setTimeout(() => settle({ code: code ?? null, stopped: true }), 5000);
    },
    done,
  };
}

module.exports = {
  MAX_STREAM_LINES,
  detectDevCommand,
  runDevServer,
};
