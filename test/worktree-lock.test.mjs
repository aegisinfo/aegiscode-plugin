// Cross-process working-tree lock (src/worktree-lock.js).
//
// The point of this module is that a SECOND PROCESS is excluded, so the
// load-bearing tests spawn one. Everything else is ownership and reclaim.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// Ported from aegiscodex-dev/tests/worktree-lock.test.js. The module under
// test is the plugin's CommonJS copy, and the dev-repo test's ESM import is
// replaced by a require of that same file.
const require = createRequire(import.meta.url);
const {
  acquireWorktreeLock, releaseWorktreeLock, worktreeLockDir, worktreeLockPath,
  worktreeLockHolder, isWorktreeLocked, withWorktreeLock, WorktreeBusyError,
} = require('../desktop/lib/local/worktree-lock.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(__dirname, '..', 'desktop', 'lib', 'local', 'worktree-lock.js');

const tmpDirs = [];
const children = [];

/** Isolate the lock dir per test, the way sessionlock.test.js does: a shared
 * lock dir would make these tests order-dependent. */
const isolate = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-wtlock-'));
  tmpDirs.push(dir);
  // This repo's data dir is $AEGISCODE_HOME; the dev engine's $AEGISCODEX_HOME
  // is also honoured by the module, so pin BOTH away from the real home and
  // clear every override — otherwise these tests share one lock dir.
  process.env.AEGISCODE_HOME = dir;
  delete process.env.AEGISCODE_WORKTREE_LOCK_DIR;
  delete process.env.AEGISCODEX_WORKTREE_LOCK_DIR;
  delete process.env.AEGISCODEX_HOME;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-wtlock-repo-'));
  tmpDirs.push(repo);
  return { home: dir, repo };
};

after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.AEGISCODE_HOME;
  delete process.env.AEGISCODEX_HOME;
});

test('acquire then release frees the tree', async () => {
  const { repo } = isolate();
  assert.equal(isWorktreeLocked(repo), false);

  const token = await acquireWorktreeLock(repo);
  assert.ok(token, 'acquire should return a token');
  assert.equal(isWorktreeLocked(repo), true);
  const holder = worktreeLockHolder(repo);
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.root, fs.realpathSync(repo));

  releaseWorktreeLock(repo, token);
  assert.equal(isWorktreeLocked(repo), false);
  assert.equal(worktreeLockHolder(repo), null);
});

test('a second claimant waits and then gives up rather than racing', async () => {
  const { repo } = isolate();
  const first = await acquireWorktreeLock(repo);
  const started = Date.now();
  const second = await acquireWorktreeLock(repo, { waitMs: 300, pollMs: 50 });
  assert.equal(second, null, 'second claimant must not get the lock');
  assert.ok(Date.now() - started >= 250, 'it should have actually waited');
  assert.equal(isWorktreeLocked(repo), true, 'first holder still owns it');
  releaseWorktreeLock(repo, first);
  assert.equal(isWorktreeLocked(repo), false);
});

test('two claimants inside ONE process still exclude each other', async () => {
  // Ownership is a random token, not the pid: keying on pid alone would let a
  // same-process caller mistake a live lock for "mine already".
  const { repo } = isolate();
  const first = await acquireWorktreeLock(repo);
  const second = await acquireWorktreeLock(repo, { waitMs: 100, pollMs: 25 });
  assert.equal(second, null);
  releaseWorktreeLock(repo, first);
});

test('releasing with the wrong token cannot free somebody else', async () => {
  const { repo } = isolate();
  const token = await acquireWorktreeLock(repo);
  releaseWorktreeLock(repo, 'not-the-token');
  assert.equal(isWorktreeLocked(repo), true, 'stolen release must be a no-op');
  releaseWorktreeLock(repo, token);
  assert.equal(isWorktreeLocked(repo), false);
});

test('a lock left by a dead process is reclaimed, with no staleness window', async () => {
  const { repo } = isolate();
  fs.mkdirSync(worktreeLockDir(), { recursive: true });
  // 0x7fffffff is not a valid pid on Linux, so process.kill(pid, 0) throws.
  fs.writeFileSync(worktreeLockPath(repo), JSON.stringify({
    pid: 0x7fffffff, token: 'dead', since: Date.now(), root: repo,
  }));
  assert.equal(isWorktreeLocked(repo), false, 'stale lock reads as unlocked');
  assert.equal(fs.existsSync(worktreeLockPath(repo)), false, 'and is cleared');

  const token = await acquireWorktreeLock(repo, { waitMs: 100 });
  assert.ok(token, 'and can be taken immediately');
  releaseWorktreeLock(repo, token);
});

test('a corrupt lock file is treated as stale, not as a permanent block', async () => {
  const { repo } = isolate();
  fs.mkdirSync(worktreeLockDir(), { recursive: true });
  fs.writeFileSync(worktreeLockPath(repo), 'not json at all');
  assert.equal(isWorktreeLocked(repo), false);
  const token = await acquireWorktreeLock(repo, { waitMs: 100 });
  assert.ok(token);
  releaseWorktreeLock(repo, token);
});

test('every spelling of one repo maps to one lock file', () => {
  const { repo } = isolate();
  const a = worktreeLockPath(repo);
  assert.equal(worktreeLockPath(repo + path.sep), a, 'trailing slash');
  assert.equal(worktreeLockPath(path.join(repo, '.')), a, 'dot segment');
  assert.equal(worktreeLockPath(path.join(repo, '..', path.basename(repo))), a, 'up-and-back');
  const link = repo + '-link';
  fs.symlinkSync(repo, link);
  tmpDirs.push(link);
  assert.equal(worktreeLockPath(link), a, 'symlink resolves to the same tree');
});

test('a falsy root is a no-op, so a non-repo never blocks', async () => {
  isolate();
  const token = await acquireWorktreeLock(null);
  assert.ok(token, 'sentinel token, never null');
  releaseWorktreeLock(null, token);
  assert.equal(worktreeLockHolder(null), null);
  assert.equal(isWorktreeLocked(null), false);
  assert.equal(fs.existsSync(worktreeLockDir()), false, 'nothing was written');
});

test('withWorktreeLock throws when busy and releases on the way out', async () => {
  const { repo } = isolate();
  const held = await acquireWorktreeLock(repo);
  await assert.rejects(
    () => withWorktreeLock(repo, { waitMs: 100, pollMs: 25 }, async () => 'nope'),
    (e) => e instanceof WorktreeBusyError && e.root === fs.realpathSync(repo),
  );

  releaseWorktreeLock(repo, held);
  const out = await withWorktreeLock(repo, { waitMs: 100 }, async () => 'ran');
  assert.equal(out, 'ran');
  assert.equal(isWorktreeLocked(repo), false, 'released even on success');

  await assert.rejects(
    () => withWorktreeLock(repo, { waitMs: 100 }, async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(isWorktreeLocked(repo), false, 'and released after a throw');
});

test('an aborted signal returns null instead of blocking the turn', async () => {
  const { repo } = isolate();
  const token = await acquireWorktreeLock(repo);
  const ac = new AbortController();
  ac.abort();
  const got = await acquireWorktreeLock(repo, { waitMs: 5000, signal: ac.signal });
  assert.equal(got, null);
  releaseWorktreeLock(repo, token);
});

test('a live holder in ANOTHER process excludes this one', async () => {
  const { repo } = isolate();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const { acquireWorktreeLock } = require(process.env.LOCK_MODULE);
    const token = await acquireWorktreeLock(process.env.LOCK_ROOT, { waitMs: 200 });
    process.stdout.write(token ? 'HELD\\n' : 'FAILED\\n');
    setTimeout(() => process.exit(0), 10000);
  `], {
    env: { ...process.env, LOCK_ROOT: repo, LOCK_MODULE: modulePath },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);

  const held = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\n')) resolve(buf.trim());
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(`exited:${code}`));
  });
  assert.equal(held, 'HELD', 'child should acquire in its own process');
  assert.equal(worktreeLockHolder(repo).pid, child.pid);

  const mine = await acquireWorktreeLock(repo, { waitMs: 400, pollMs: 50 });
  assert.equal(mine, null, 'this process must not get a sibling-held tree');

  const died = new Promise((r) => child.on('exit', r));
  child.kill('SIGTERM');
  await died;
  const reclaimed = await acquireWorktreeLock(repo, { waitMs: 500, pollMs: 50 });
  assert.ok(reclaimed, 'a killed holder is reclaimed, not a deadlock');
  releaseWorktreeLock(repo, reclaimed);
});
