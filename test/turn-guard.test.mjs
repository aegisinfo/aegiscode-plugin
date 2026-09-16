// Turn-start foreign-write detection (src/turn-guard.js).
//
// Every case here is drawn from the incident the module exists for: a session
// reverted a file a second session was mid-edit on, a third ran `git stash`
// and parked everyone's tree. The tests that matter are the ones that show
// the guard firing ONLY when a peer's work is really at risk — a guard that
// also blocks a solo session's own git commands gets switched off.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Ported from aegiscodex-dev/tests/turn-guard.test.js. `commitBasis` is
// deliberately absent here: it exists to hand the dev engine's git-scope
// commit sweep the snapshot it took, and this repo hosts no commit sweep, so
// neither the export nor its two cases were ported.
const require = createRequire(import.meta.url);
const {
  classifyDestructive, beginTurnGuard, recordWrite, foreignSince,
  concurrentSince, blocksDestructive,
} = require('../desktop/lib/local/turn-guard.js');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-guard-'));
  tmpDirs.push(dir);
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'base.js'), 'original\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return dir;
}

// ── classification ────────────────────────────────────────────────────
// Parsed as argv, not matched as text: a message ABOUT a destructive command
// is not one, and that distinction is the whole reason for tokenizing.

test('tree-scoped destructive git operations are recognised', () => {
  for (const cmd of [
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git stash',
    'git stash pop',
    'git stash push -m wip',
    'git clean -fd',
    'git clean --force',
    'git checkout .',
    'cd /repo && git reset --hard',
    'ls -la; git reset --hard',
    'git -C /repo reset --hard',
  ]) {
    const v = classifyDestructive(cmd);
    assert.equal(v.destructive, true, `should be destructive: ${cmd}`);
    assert.equal(v.scope, 'tree', `should be tree-scoped: ${cmd}`);
    assert.ok(v.what, `should name the operation: ${cmd}`);
  }
});

test('a command that only names paths is scoped to those paths', () => {
  const explicit = classifyDestructive('git checkout HEAD -- base.py');
  assert.equal(explicit.destructive, true);
  assert.equal(explicit.scope, 'paths');
  assert.deepEqual(explicit.paths, ['base.py']);

  const restore = classifyDestructive('git restore services/app.py');
  assert.equal(restore.destructive, true);
  assert.equal(restore.scope, 'paths');
  assert.deepEqual(restore.paths, ['services/app.py']);
});

test('harmless git commands are not destructive', () => {
  for (const cmd of [
    'git status',
    'git diff --stat',
    'git stash list',
    'git stash show',
    'git log --oneline -5',
    'git add -A',
    'git checkout -b feature',
    'git checkout main',
    'git commit -m "base"',
    'git worktree list',
    'ls -la',
    'npm test',
    'node --test tests/',
  ]) {
    assert.equal(classifyDestructive(cmd).destructive, false, `should be harmless: ${cmd}`);
  }
});

test('a message mentioning a destructive command is not that command', () => {
  // The reason this parses argv instead of matching regexes: the unquoted
  // form of each of these IS destructive, the quoted form is a commit.
  for (const cmd of [
    'git commit -m "fix stash handling"',
    'git commit -m "reset --hard is dangerous"',
    'git commit -m "stop running git clean -fd"',
    'git commit -m "guard git checkout -- ."',
  ]) {
    assert.equal(classifyDestructive(cmd).destructive, false, `should be harmless: ${cmd}`);
  }
});

// ── guarding ──────────────────────────────────────────────────────────

test('a non-repo yields an inert guard rather than an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-norepo-'));
  tmpDirs.push(dir);
  const guard = beginTurnGuard(dir);
  assert.equal(guard.active, false);
  assert.equal(guard.root, null);
  assert.deepEqual(foreignSince(guard), []);
  assert.deepEqual(concurrentSince(guard), []);
  assert.equal(blocksDestructive(guard, 'git reset --hard').ok, true);
});

test('a clean tree never blocks, so a solo session is not wedged', () => {
  const repo = makeRepo();
  const guard = beginTurnGuard(repo);
  assert.equal(guard.active, true);
  assert.deepEqual(foreignSince(guard), []);
  for (const cmd of ['git reset --hard', 'git stash', 'git clean -fd', 'git checkout -- base.js']) {
    assert.equal(blocksDestructive(guard, cmd).ok, true, `clean tree should allow: ${cmd}`);
  }
});

test("a peer's uncommitted work blocks tree-wide operations", () => {
  const repo = makeRepo();
  // The peer had work in flight before this turn started — the case that
  // destroyed a real file (`git checkout HEAD -- base.py`).
  fs.writeFileSync(path.join(repo, 'peer.js'), 'peer in-flight work\n');

  const guard = beginTurnGuard(repo);
  assert.deepEqual(foreignSince(guard), ['peer.js']);
  assert.deepEqual(concurrentSince(guard), []);

  const blocked = blocksDestructive(guard, 'git reset --hard');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.scope, 'tree');
  assert.deepEqual(blocked.foreign, ['peer.js']);
  assert.match(blocked.reason, /peer\.js/);
  assert.match(blocked.reason, /another agent/);
  assert.match(blocked.reason, /worktree lock/);
});

test('work that appears DURING the turn also blocks — the real incident', () => {
  const repo = makeRepo();
  const guard = beginTurnGuard(repo);
  // Peer writes after the snapshot: nothing is in `before`, so the confident
  // signal is empty and only the weak one catches it. Blocking on the
  // confident signal alone would miss exactly this.
  fs.writeFileSync(path.join(repo, 'during.js'), 'appeared mid-turn\n');

  assert.deepEqual(foreignSince(guard), []);
  assert.deepEqual(concurrentSince(guard), ['during.js']);

  const blocked = blocksDestructive(guard, 'git checkout -- .');
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.unattributed, ['during.js']);
  assert.match(blocked.reason, /during\.js/);
  assert.match(blocked.reason, /not written by this session/);
});

test('a path this session wrote is never reported as foreign', () => {
  const repo = makeRepo();
  const guard = beginTurnGuard(repo);

  recordWrite(guard, path.join(repo, 'mine.js'));       // absolute, as a tool would
  fs.writeFileSync(path.join(repo, 'mine.js'), 'my work\n');
  recordWrite(guard, 'other.js');                        // relative also fine
  fs.writeFileSync(path.join(repo, 'other.js'), 'more of mine\n');

  assert.deepEqual(foreignSince(guard), []);
  assert.deepEqual(concurrentSince(guard), []);
  assert.equal(
    blocksDestructive(guard, 'git reset --hard').ok, true,
    'our own writes must not make the guard cry wolf',
  );
});

test('path-scoped operations are judged on the paths they name', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'peer.js'), 'peer work\n');

  const guard = beginTurnGuard(repo);

  // Reverting a file the peer is not touching stays allowed.
  assert.equal(
    blocksDestructive(guard, 'git checkout -- unrelated.js').ok, true,
    'a path-scoped op on an untouched path is safe',
  );

  // Reverting the peer's file is exactly what destroyed real work.
  const blocked = blocksDestructive(guard, 'git checkout HEAD -- peer.js');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.scope, 'paths');
  assert.deepEqual(blocked.foreign, ['peer.js']);

  // And a tree-wide form of the same command is still refused.
  assert.equal(blocksDestructive(guard, 'git checkout -- .').ok, false);
});

test('a peer committing removes the risk, so the guard stands down', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'peer.js'), 'peer work\n');
  const guard = beginTurnGuard(repo);
  assert.equal(blocksDestructive(guard, 'git stash').ok, false);

  // The peer commits: the work is safe in history, nothing left to discard.
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('add', '-A');
  git('commit', '-qm', 'peer commits their work');

  assert.deepEqual(foreignSince(guard), []);
  assert.deepEqual(concurrentSince(guard), []);
  assert.equal(blocksDestructive(guard, 'git stash').ok, true);
});
