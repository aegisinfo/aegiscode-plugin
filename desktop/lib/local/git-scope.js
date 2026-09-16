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
 * The "dirty before AND byte-identical now" definition lives in
 * `gitStatusSnapshot`'s hashes, and it is what makes an unattended commit safe
 * in a checkout somebody else is editing: another agent's in-flight edits are
 * excluded instead of swept into our commit.
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
 * Commit only the changes attributable to this run.
 *
 * The rule, in one line: stage every path that is dirty now EXCEPT the ones
 * that were already dirty before and are byte-identical now. `before` is the
 * `gitStatusSnapshot(cwd)` taken immediately before the task ran; without it
 * there is no basis for attribution, and the only safe move is to refuse —
 * `git add -A` here would sweep a concurrent agent's half-finished edit into
 * this task's commit under this task's message.
 *
 * @returns {{ok?:boolean,skipped?:boolean,reason?:string,error?:string,
 *            message?:string,staged?:number,foreign?:string[]}}
 */
function scopedCommit(cwd, { message, before } = {}) {
  const root = gitRoot(cwd);
  if (!root) return { skipped: true, reason: 'not a git repo' };

  // No basis for attribution — refuse rather than sweep.
  if (!before) {
    return { ok: false, error: 'no pre-task snapshot; refusing to sweep the working tree' };
  }

  const foreign = foreignChanges(cwd, before);
  const foreignSet = new Set(foreign);
  const now = gitStatusSnapshot(cwd) || new Map();
  const include = [...now.keys()].filter((p) => !foreignSet.has(p));

  if (!include.length) {
    return {
      ok: true,
      skipped: true,
      foreign,
      reason: foreign.length
        ? `no changes of our own (left ${foreign.length} concurrent change(s) alone)`
        : 'no changes',
    };
  }

  // pathspec-from-file keeps an arbitrarily long (or space/NUL-bearing) list
  // safe — a 400-file commit is fine, a path with a newline in it is not.
  const add = spawnSync('git', ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    cwd: root,
    encoding: 'utf8',
    input: include.join('\0'),
  });
  if (add.status !== 0) return { ok: false, error: add.stderr || 'git add failed' };

  const commit = spawnSync('git', ['commit', '-m', message], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) {
    // "nothing to commit" is a success for our purposes: the changes we staged
    // were already committed by somebody else, and the task's work is done.
    if (/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) {
      return { ok: true, skipped: true, foreign, reason: 'no changes' };
    }
    return { ok: false, error: commit.stderr || commit.stdout };
  }
  return { ok: true, message, foreign, staged: include.length };
}

module.exports = { gitRoot, contentHash, gitStatusSnapshot, foreignChanges, scopedCommit };
