'use strict';

/**
 * Minimal git worktree introspection: where the repo root is, and what is
 * dirty right now with a content hash per path.
 *
 * Ported from aegiscodex-dev/src/git-scope.js (ESM → CommonJS). Only the two
 * functions `turn-guard.js` needs are carried over — `gitRoot` and
 * `gitStatusSnapshot` (plus their `contentHash` helper). The source file's
 * `foreignChanges` and `scopedCommit` belong to the autonomous queue's
 * commit path, which the plugin does not host, so they are deliberately not
 * vendored: a copy of code nothing calls is a copy that drifts unnoticed.
 *
 * The "dirty before AND byte-identical now" definition lives in
 * `gitStatusSnapshot`'s hashes; `turn-guard.js` is the only consumer.
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

module.exports = { gitRoot, contentHash, gitStatusSnapshot };
