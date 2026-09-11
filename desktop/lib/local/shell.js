'use strict';

/**
 * shell.js — a persistent shell session for the `exec` tool, ported from
 * aegiscodex-dev's src/shell.js (client half of the same design).
 *
 * The desktop `exec` tool used to spawn ONE process per call: `cd /foo` in
 * one turn had no effect on the next call, so a model that wanted to work
 * inside a subdirectory had to prefix every single command with `cd X &&`.
 * This keeps ONE long-lived shell per chat turn — bash on macOS/Linux,
 * PowerShell on Windows (no bash there by default) — feeding it commands over
 * stdin and framing each command's output with a per-session random sentinel
 * printed alongside the exit code. On bash, stderr is merged into stdout
 * (`exec 2>&1`) so ordering is preserved; PowerShell's stderr pipe is merged
 * the same way by listening on both streams.
 *
 * Self-contained (node:child_process + node:crypto only) and never throws:
 * run() always resolves { content, isError }. If the session can't start or
 * dies, run() falls back to a one-shot spawn so `exec` keeps working.
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const IS_WIN32 = process.platform === 'win32';
const OUTPUT_CAP = 30_000;
const MAX_TIMEOUT = 600_000;
const DEFAULT_TIMEOUT = 120_000;

function cap(s) {
  return s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n… (truncated)` : s;
}

/** One-shot fallback — the pre-session behavior, used when no live session. */
function oneShotShell({ command, timeout = DEFAULT_TIMEOUT, working_directory } = {}) {
  return new Promise((resolve) => {
    const cmd = IS_WIN32 ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
    const arg = IS_WIN32 ? '/d /s /c' : '-c';
    const child = spawn(cmd, [arg, String(command || '')], {
      cwd: working_directory || process.cwd(),
      timeout: Math.min(Number(timeout) || DEFAULT_TIMEOUT, MAX_TIMEOUT),
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ content: `error: ${e.message}`, isError: true }));
    child.on('close', (code) => {
      const body = `${out}${err ? `\n${err}` : ''}`.trim() || `(exit ${code})`;
      resolve({ content: cap(body), isError: code !== 0 });
    });
  });
}

class ShellSession {
  constructor({ cwd } = {}) {
    this.sentinel = `__AEGIS_SH_${crypto.randomBytes(8).toString('hex')}__`;
    this.marker = `${this.sentinel}EXIT:`;
    this.buf = '';
    this.alive = false;
    this._pending = null; // resolver-scan for the in-flight command
    this._start(cwd);
  }

  _start(cwd) {
    try {
      this.child = IS_WIN32
        // -Command - reads the script from stdin as a non-interactive session,
        // so there are no prompts to pollute output, but state still persists.
        ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
          cwd: cwd || process.cwd(),
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        // No args → the shell reads commands from stdin as a non-interactive
        // script, so there are no prompts to pollute output, but state persists.
        : spawn(process.env.SHELL || '/bin/bash', [], {
          cwd: cwd || process.cwd(),
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch {
      this.alive = false;
      return;
    }
    this.alive = true;
    const onData = (d) => { this.buf += d.toString(); if (this._pending) this._pending(); };
    this.child.stdout.on('data', onData);
    this.child.stderr.on('data', onData);
    this.child.on('exit', () => { this.alive = false; if (this._pending) this._pending(true); });
    this.child.on('error', () => { this.alive = false; if (this._pending) this._pending(true); });
    // Merge stderr into stdout for the whole session so output ordering is
    // faithful and the sentinel (printed to fd1) always lands after it.
    // PowerShell errors already arrive on the stderr pipe onData folds in
    // above, so only bash needs the explicit redirect.
    if (!IS_WIN32) {
      try { this.child.stdin.write('exec 2>&1\n'); } catch { this.alive = false; }
    }
  }

  /**
   * Run one command in the session. Resolves { content, isError }. A dead or
   * unstartable session (or a working_directory that must not persist)
   * degrades gracefully. `working_directory` is scoped to this one command (a
   * subshell on bash, Push-Location/Pop-Location on PowerShell) so it doesn't
   * move the session's cwd.
   */
  run(command, { timeout = DEFAULT_TIMEOUT, working_directory } = {}) {
    if (!this.alive || !this.child) {
      return oneShotShell({ command, timeout, working_directory });
    }
    let cmd = String(command || '');

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._pending = null;
        resolve(result);
      };

      const timer = setTimeout(() => {
        // A hung command (e.g. one that reads stdin) can never reach the
        // sentinel — kill the poisoned session and report what we have.
        const partial = cap(this.buf.trim());
        this.dispose();
        finish({ content: `${partial}${partial ? '\n' : ''}(timed out after ${timeout}ms)`, isError: true });
      }, Math.min(Number(timeout) || DEFAULT_TIMEOUT, MAX_TIMEOUT));

      this._pending = (died) => {
        if (died && !this.buf.includes(this.marker)) {
          finish({ content: cap(this.buf.trim()) || '(shell session ended)', isError: true });
          return;
        }
        const idx = this.buf.indexOf(this.marker);
        if (idx === -1) return; // sentinel not here yet — wait for more data
        const after = this.buf.slice(idx + this.marker.length);
        const nl = after.indexOf('\n');
        if (nl === -1) return; // exit-code line still arriving
        const code = parseInt(after.slice(0, nl), 10);
        const output = this.buf.slice(0, idx).replace(/\n+$/, '');
        this.buf = after.slice(nl + 1); // leftover for the next command (usually '')
        finish({ content: cap(output || `(exit ${code})`), isError: code !== 0 });
      };

      // Send the command, then print the sentinel + exit code on its own line.
      let script;
      if (IS_WIN32) {
        // Push-Location/Pop-Location scope working_directory to this one
        // command without moving the session's persistent cwd. $__c captures
        // the real exit status before Pop-Location's own success would
        // otherwise overwrite $?/$LASTEXITCODE.
        const body = cmd.trim() ? cmd : 'Write-Output $null';
        const exitCapture =
          '$__c = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }';
        script = working_directory
          ? `Push-Location -LiteralPath ${pshq(working_directory)}\ntry {\n${body}\n${exitCapture}\n} finally {\nPop-Location\n}\n`
          : `${body}\n${exitCapture}\n`;
        script += `Write-Output ("${this.marker}" + $__c)\n`;
      } else {
        // The command runs in a brace group with its stdin redirected from
        // /dev/null: a group (not a subshell) keeps cd/export state
        // persisting, and `</dev/null` stops the command from consuming the
        // control channel. Without this, any stdin-reading command (cat,
        // read, a REPL, ssh, a y/n prompt) swallows the sentinel line that
        // follows it — hanging the whole session until the timeout, and
        // echoing commands (cat) even splice the sentinel into their output
        // and mis-resolve with garbage. working_directory runs in a subshell
        // (parens, not the brace group) so it doesn't move the session's cwd.
        if (working_directory) cmd = `( cd ${shq(working_directory)} && ${cmd} )`;
        const body = cmd.trim() ? cmd : ':';
        script = `{ ${body}\n} </dev/null\nprintf '\\n%s%d\\n' '${this.sentinel}EXIT:' "$?"\n`;
      }
      try {
        this.child.stdin.write(script);
      } catch {
        this.alive = false;
        oneShotShell({ command, timeout, working_directory }).then(finish);
        return;
      }
      // Data may already be buffered (fast commands) — scan once now.
      if (this._pending) this._pending();
    });
  }

  dispose() {
    this.alive = false;
    if (this.child) {
      try { this.child.stdin.end(); } catch { /* already gone */ }
      try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
      this.child = null;
    }
  }
}

// Minimal single-quote shell-escape for a path.
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Minimal single-quote escape for a PowerShell -LiteralPath (double up ').
function pshq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

module.exports = { ShellSession, oneShotShell, IS_WIN32 };
