'use strict';

/**
 * Minimal git worktree introspection: where the repo root is, and what is
 * dirty right now with a content hash per path.
 *
 * Ported from aegiscodex-dev/src/git-scope.js (ESM → CommonJS). `turn-guard.js`
 * uses `gitRoot` and `gitStatusSnapshot`; the queue now hosts the commit path
 * too, so `foreignChanges` and `scopedCommit` are carried over as well — they
 * were deliberately absent while nothing here queued work, because a copy of
 * code nothing calls is a copy that drifts unnoticed.
 *
 * ATTRIBUTION IS TWO CONDITIONS, NOT ONE. "Dirty before AND byte-identical
 * now" only excludes work that nobody touched — it cannot see a concurrent
 * writer who edits a file *during* the task window, because that file is no
 * longer byte-identical and so looks like ours. Commit 96fb64f swept exactly
 * such a file (desktop/electron-builder.yml, edited by another live session)
 * into an unrelated commit that way. So `scopedCommit` also requires positive
 * attribution: a path is staged only if the caller reports that THIS task's own
 * tool layer wrote it (`written`). Everything else dirty — foreign, or merely
 * unattributed — is left alone and reported.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

/** The repo root for `cwd`, or null if it isn't inside a git work tree. */
function gitRoot(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Hash a path's worktree content, so "already dirty before the task ran" can
 * be told apart from "this task changed it". `absent` covers deletions;
 * non-files (a submodule, a directory) compare by kind.
 */
function contentHash(cwd, rel) {
  try {
    const st = fs.lstatSync(path.join(cwd, rel));
    if (!st.isFile()) return st.isDirectory() ? 'nonfile:dir' : 'nonfile:other';
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(cwd, rel))).digest('hex');
  } catch {
    return 'absent';
  }
}

/**
 * Every path git reports as dirty right now, mapped to its content hash.
 * `--no-renames` matters: in `-z` porcelain a rename emits the old name as a
 * second NUL-terminated token, which we would otherwise hash as a change.
 * Untracked files are included, since that is exactly how concurrent work
 * usually arrives. Returns null if `cwd` is not a usable git repo.
 */
function gitStatusSnapshot(cwd) {
  // Run from the repo root: porcelain reports paths root-relative, so hashing
  // must resolve them against the same directory.
  const root = gitRoot(cwd);
  if (!root) return null;
  const r = spawnSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) return null;
  const snap = new Map();
  for (const rec of r.stdout.split('\0')) {
    if (rec.length < 4) continue;
    const p = rec.slice(3);
    snap.set(p, contentHash(root, p));
  }
  return snap;
}

/**
 * Paths that were dirty *before* and are byte-identical now: another agent's
 * in-flight work, not ours. These must never be committed.
 *
 * Byte-identical is the test, not "was dirty": a path that was dirty before and
 * that this task then EDITED has a different hash, so it is ours to commit. Only
 * untouched foreign work is excluded.
 */
function foreignChanges(cwd, before) {
  if (!before) return [];
  const now = gitStatusSnapshot(cwd);
  if (!now) return [];
  const out = [];
  for (const [p, hash] of now) {
    if (before.has(p) && before.get(p) === hash) out.push(p);
  }
  return out;
}

/**
 * A path the caller reported writing, as repo-root-relative POSIX text.
 *
 * The tool layer reports what the MODEL asked for (`file_path` as typed), which
 * may be absolute or relative to the task's own working directory — not
 * necessarily this process's `cwd`. Returns '' for anything outside the repo:
 * a write that cannot be attributed to a path git reports is not something this
 * function may guess about.
 */
function toRepoRelative(root, base, p) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw) return '';
  const abs = path.isAbsolute(raw) ? raw : path.resolve(base || root, raw);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.split(path.sep).join('/');
}

/** The repo-relative set of paths the task's own tool layer reported writing. */
function writtenSet(root, base, written) {
  const out = new Set();
  for (const p of written || []) {
    const rel = toRepoRelative(root, base, p);
    if (rel) out.add(rel);
  }
  return out;
}

/**
 * Split the current dirty set by attribution. `ours` is what this task wrote
 * and changed; `left` is everything else git reports as dirty — a peer's
 * in-flight work, plus our own changes we cannot positively attribute (a file a
 * shell command created names no path in the tool call, so it is reported, not
 * assumed).
 *
 * @returns {null|{root:string, ours:string[], left:string[], written:Set<string>}}
 */
function attributedChanges(cwd, { before, written } = {}) {
  const root = gitRoot(cwd);
  if (!root) return null;
  const now = gitStatusSnapshot(cwd);
  if (!now) return null;
  const mine = writtenSet(root, cwd, written);
  const ours = [];
  const left = [];
  for (const [p, hash] of now) {
    // "Differs from the pre-task snapshot": new since then, or the bytes moved.
    const changed = !(before && before.has(p) && before.get(p) === hash);
    if (changed && mine.has(p)) ours.push(p);
    else left.push(p);
  }
  return { root, ours, left, written: mine };
}

/**
 * Commit only the changes this task is known to have made.
 *
 * The rule, in one line: stage a dirty path only if it DIFFERS from the
 * pre-task snapshot AND this task's tool layer reports writing it. Two
 * conditions, because either alone is unsafe: "changed since the snapshot"
 * sweeps a concurrent writer who edits mid-run, and "was dirty before and is
 * byte-identical now" cannot be the only exclusion because it sees only the
 * writer who stopped.
 *
 * `before` is the `gitStatusSnapshot(cwd)` taken immediately before the task
 * ran and `written` the paths the caller's tool layer wrote during it; without
 * either there is no basis for attribution, and the only safe move is to refuse
 * (or stage nothing) — `git add -A` here would commit a concurrent agent's
 * half-finished edit under this task's message.
 *
 * @returns {{ok?:boolean,skipped?:boolean,reason?:string,error?:string,
 *            message?:string,staged?:number,paths?:string[],foreign?:string[],
 *            identicalForeign?:string[]}}
 */
function scopedCommit(cwd, { message, before, written } = {}) {
  if (!gitRoot(cwd)) return { skipped: true, reason: 'not a git repo' };

  // No basis for attribution — refuse rather than sweep.
  if (!before) {
    return { ok: false, error: 'no pre-task snapshot; refusing to sweep the working tree' };
  }

  const attributed = attributedChanges(cwd, { before, written });
  if (!attributed) return { skipped: true, reason: 'not a git repo' };
  const { root, ours, left } = attributed;

  if (!ours.length) {
    const untouched = foreignChanges(cwd, before);
    return {
      ok: true,
      skipped: true,
      foreign: left,
      identicalForeign: untouched,
      reason: left.length
        ? `no changes of our own (left ${left.length} change(s) this task did not write)`
        : 'no changes',
    };
  }

  // pathspec-from-file keeps an arbitrarily long (or space/NUL-bearing) list
  // safe — a 400-file commit is fine, a path with a newline in it is not.
  const add = spawnSync('git', ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    cwd: root,
    encoding: 'utf8',
    input: ours.join('\0'),
  });
  if (add.status !== 0) return { ok: false, error: add.stderr || 'git add failed' };

  const commit = spawnSync('git', ['commit', '-m', message], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) {
    // "nothing to commit" is a success for our purposes: the changes we staged
    // were already committed by somebody else, and the task's work is done.
    if (/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) {
      return { ok: true, skipped: true, foreign: left, reason: 'no changes' };
    }
    return { ok: false, error: commit.stderr || commit.stdout };
  }
  return { ok: true, message, foreign: left, paths: ours, staged: ours.length };
}

module.exports = {
  gitRoot,
  contentHash,
  gitStatusSnapshot,
  foreignChanges,
  toRepoRelative,
  writtenSet,
  attributedChanges,
  scopedCommit,
};
