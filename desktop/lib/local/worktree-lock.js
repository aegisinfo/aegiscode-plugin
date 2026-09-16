'use strict';

/**
 * Cross-process lock on a git working tree.
 *
 * Ported from aegiscodex-dev/src/worktree-lock.js (ESM → CommonJS).
 *
 * Bug this exists for: nothing keyed on *the working tree*. A session-scoped
 * lock only stops two processes resuming the SAME transcript, so three
 * different sessions in one checkout are three different ids and therefore
 * all legal. A queue-worker lock only serialises queue drains. An interactive
 * session took no lock at all.
 *
 * So N agents editing one checkout was, by every existing lock, correct
 * behaviour — and it is destructive. It happened for real: one session ran
 * `git checkout HEAD --` against a file a second session was mid-edit on
 * (destroying it), a third ran `git stash` and parked everybody's tree, and a
 * test run on that shared tree reported failures belonging to a half-built
 * feature that was not the caller's. Git has no advisory locking, so none of
 * it produced an error — just unexplained file changes, which is exactly the
 * kind of evidence that gets misread as "my tool lied to me".
 *
 * Fix: a lock keyed on the repository root — the resource actually contended
 * — taken by every host that runs a turn (the desktop app and the CLI both
 * reach this file through desktop/lib/local/engine.js). Same atomic-marker +
 * PID-liveness pattern as the session lock, so a crashed holder is reclaimed
 * with no staleness window to tune and no manual cleanup.
 *
 * This lock is advisory and cooperative: it cannot stop a writer that does
 * not take it (a plain `git` in a terminal, another harness, an editor). Its
 * value is that our own hosts stop racing each other, and that a caller
 * receiving `null` knows to back off instead of writing blind.
 *
 * The stronger fix is one worktree per agent (`git worktree add`), which
 * removes the shared mutable tree entirely. This lock is what makes the
 * single-tree case safe when that is not available.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

/**
 * Where lock files live.
 *
 * The plugin's data dir is ~/.aegiscode ($AEGISCODE_HOME), per config.js's
 * `aegisDir()` convention — but the dev engine's ~/.aegiscodex is honoured
 * too, and either `*_WORKTREE_LOCK_DIR` override points every host at ONE
 * directory. That override is the interlock: two separate tools disagreeing
 * about where the lock file goes is the same as having no lock, so operators
 * running the GUI, the CLI and the dev engine against one checkout should set
 * AEGISCODE_WORKTREE_LOCK_DIR (or AEGISCODEX_WORKTREE_LOCK_DIR) to a shared
 * path. Within this repo the desktop and CLI hosts always agree, because both
 * resolve this same helper.
 */
function worktreeLockDir() {
  if (process.env.AEGISCODE_WORKTREE_LOCK_DIR) return process.env.AEGISCODE_WORKTREE_LOCK_DIR;
  if (process.env.AEGISCODEX_WORKTREE_LOCK_DIR) return process.env.AEGISCODEX_WORKTREE_LOCK_DIR;
  const home = process.env.AEGISCODE_HOME
    || process.env.AEGISCODEX_HOME
    || path.join(os.homedir(), '.aegiscode');
  return path.join(home, 'worktree-locks');
}

/** Default wait: a live holder is bounded by its own turn watchdog, so
 * waiting slightly past that lets a legitimate queued turn run once the
 * holder's deadline fires, rather than failing right as the tree is about to
 * free up. */
const DEFAULT_WORKTREE_WAIT_MS = 11 * 60 * 1000;

/** Sentinel token for the "not in a repo" no-op path — always truthy, never
 * matches a real acquisition, so a stray release() can't release anything. */
const NOOP_TOKEN = '(no-worktree)';

/**
 * Canonicalise the root so two paths to one repo — a symlink, a trailing
 * slash, a relative path, `/tmp/../repo` — agree on a single lock file.
 * Falls back to the resolved path when realpath fails.
 */
function canonical(root) {
  if (!root) return null;
  const abs = path.resolve(String(root));
  try { return fs.realpathSync(abs); } catch { return abs; }
}

/** The lock file for `root`. The path is hashed so an arbitrarily long or
 * awkward root maps to one flat, safe filename; the root itself is written
 * inside the file for humans reading the lock dir. */
function worktreeLockPath(root) {
  if (!root) return null;
  const key = crypto.createHash('sha1').update(canonical(root)).digest('hex').slice(0, 16);
  return path.join(worktreeLockDir(), key + '.lock');
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readHolder(root) {
  try { return JSON.parse(fs.readFileSync(worktreeLockPath(root), 'utf8')); } catch { return null; }
}

/**
 * The current holder of `root`'s lock, or null. Never throws and never
 * clears a stale lock — use `isWorktreeLocked` for the reclaiming check.
 */
function worktreeLockHolder(root) {
  if (!root) return null;
  const h = readHolder(root);
  if (!h) return null;
  return {
    pid: h.pid, token: h.token, since: h.since,
    root: h.root || canonical(root), session: h.session || null,
  };
}

/**
 * True if `root` is held by a live process (any process, including this one
 * — two concurrent callers inside one process must still queue behind each
 * other). A lock file whose PID is dead or unparsable is stale and cleared as
 * a side effect, so callers never special-case it.
 */
function isWorktreeLocked(root) {
  if (!root) return false;
  const holder = readHolder(root);
  // `Number(null)` is 0 and `process.kill(0, 0)` targets the caller's process
  // GROUP, so it succeeds — a missing lock file would otherwise read as a live
  // holder forever. Require a real pid. (The session lock has the same latent
  // trap; it never surfaced there only because it is called after EEXIST.)
  const pid = Number(holder && holder.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) {
    try { fs.unlinkSync(worktreeLockPath(root)); } catch {}
    return false;
  }
  return true;
}

/** Exclusive-create the lock file for `token`. Returns true on success.
 * Best-effort: a data-dir failure other than "already exists" fails OPEN so a
 * broken filesystem can never block a turn that would otherwise run fine. */
function tryAcquire(root, token, meta) {
  try {
    fs.mkdirSync(worktreeLockDir(), { recursive: true });
    const fd = fs.openSync(worktreeLockPath(root), 'wx');
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      token,
      since: Date.now(),
      root: canonical(root),
      session: (meta && meta.session) || null,
    }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    return true;
  }
}

/** Release `root`'s lock — only if `token` matches the current holder, so
 * releasing a lock you don't (or no longer) own can never clobber whoever
 * holds it now. No-op on a falsy root/token or any filesystem error
 * (best-effort, like the rest of this repo's persistence helpers). */
function releaseWorktreeLock(root, token) {
  if (!root || !token || token === NOOP_TOKEN) return;
  const holder = readHolder(root);
  if (holder && holder.token === token) {
    try { fs.unlinkSync(worktreeLockPath(root)); } catch {}
  }
}

/**
 * Acquire `root`'s lock, waiting out a live holder instead of racing it.
 * Resolves a truthy opaque token once acquired — pass it back to
 * `releaseWorktreeLock` — or `null` if `waitMs` elapses or `signal` aborts
 * first; either way the caller must not write. A falsy `root` (not inside a
 * git work tree — nothing shared to collide over) resolves the sentinel
 * immediately with no file touched.
 */
async function acquireWorktreeLock(root, {
  waitMs = DEFAULT_WORKTREE_WAIT_MS, pollMs = 200, signal, session = null,
} = {}) {
  if (!root) return NOOP_TOKEN;
  const token = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (signal && signal.aborted) return null;
    if (tryAcquire(root, token, { session })) return token;
    // Was stale, just reclaimed by clearing — retry now.
    if (!isWorktreeLocked(root)) continue;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Run `fn` holding `root`'s lock, releasing it on every exit path. Throws
 * `WorktreeBusyError` (rather than running unprotected) if the lock can't be
 * taken, because proceeding without it is the bug this module exists to
 * prevent.
 */
class WorktreeBusyError extends Error {
  constructor(root, holder) {
    super(`working tree ${root} is locked by pid ${holder ? holder.pid : '?'}`);
    this.name = 'WorktreeBusyError';
    this.root = root;
    this.holder = holder || null;
  }
}

async function withWorktreeLock(root, opts, fn) {
  const token = await acquireWorktreeLock(root, opts);
  if (!token) throw new WorktreeBusyError(root, worktreeLockHolder(root));
  try {
    return await fn();
  } finally {
    releaseWorktreeLock(root, token);
  }
}

module.exports = {
  DEFAULT_WORKTREE_WAIT_MS,
  worktreeLockDir,
  worktreeLockPath,
  worktreeLockHolder,
  isWorktreeLocked,
  releaseWorktreeLock,
  acquireWorktreeLock,
  WorktreeBusyError,
  withWorktreeLock,
};
