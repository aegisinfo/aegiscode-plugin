#!/usr/bin/env node
/**
 * The queue spine (`desktop/lib/local/queue.js`) and the desktop half of the
 * autonomous worker (`desktop/lib/local/autonomous.js`).
 *
 * WHY THIS FILE EXISTS: the CLI half is covered end to end by
 * test/cli-autonomous.test.mjs, but that test drives the binary — it never
 * looks at the invariants the whole design leans on, and it cannot, because
 * they are about *hostile* interleavings: a second drain, a pid that no longer
 * exists, a mid-drain `add`, a torn line in the file. Each of those is a
 * correctness promise the queue makes out loud in its own comments, and every
 * one of them is silently violable by a later edit:
 *
 *   - `upsert` (not write) is the only way a drain persists, so an `add` that
 *     lands while a task is running is not erased by a stale in-memory copy.
 *   - A `running` item whose pid is gone returns to `pending`; one whose pid is
 *     ALIVE is left alone. Getting this backwards either loses a task forever
 *     or runs it twice.
 *   - The lock is held by a live pid, and a dead holder is reclaimed at once —
 *     no staleness window.
 *   - `clear` never removes pending/running work.
 *
 * Everything runs against a throwaway $AEGISCODE_HOME, so the user's real
 * ~/.aegiscode is never read or written. No network, no Electron, no model.
 *
 * Every liveness decision is driven through the injected `isAliveFn` seam rather
 * than by racing a real process, EXCEPT the one check that has to be real: that
 * `isAlive` reports false for a pid that has actually exited.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const queue = require('../desktop/lib/local/queue.js');
const autonomous = require('../desktop/lib/local/autonomous.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const tmp = fs.mkdtempSync(join(os.tmpdir(), 'aegis-autonomous-queue-'));
const home = join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });

/** A throwaway environment: its own queue, runs log and lock, under tmp/. */
function envFor(extra = {}) {
  return { AEGISCODE_HOME: home, ...extra };
}

let passed = 0;
const failures = [];
// Async on purpose: the runner must await, or an assertion failing inside an
// async test body would be reported as "ok" and surface later as an unhandled
// rejection instead of a named failure.
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  FAIL ${name}\n       ${e && e.message}`);
  }
}

try {
  // ── where the queue lives ────────────────────────────────────────────────
  await test('AEGISCODE_HOME and the generic AEGIS_HOME are the same directory', () => {
    const a = queue.dataDir({ AEGISCODE_HOME: '/tmp/one' });
    const b = queue.dataDir({ AEGIS_HOME: '/tmp/one' });
    assert(a === b, `two spellings must not mean two queues: ${a} vs ${b}`);
    assert(a === '/tmp/one', `resolved as given: ${a}`);
    assert(queue.dataDir({}) === join(os.homedir(), '.aegiscode'), 'the default is ~/.aegiscode');
  });

  await test('the three files are overridable independently', () => {
    const env = envFor({ AEGIS_QUEUE_FILE: '/tmp/q.jsonl', AEGIS_RUNS_FILE: '/tmp/r.jsonl', AEGIS_QUEUE_LOCK: '/tmp/l' });
    assert(queue.queuePath(env) === '/tmp/q.jsonl', 'queue file override');
    assert(queue.runsPath(env) === '/tmp/r.jsonl', 'runs file override');
    assert(queue.lockPath(env) === '/tmp/l', 'lock override');
    assert(queue.queuePath(envFor()) === join(home, 'queue.jsonl'), 'and the default sits in AEGISCODE_HOME');
  });

  // ── adding, ids, and the mid-drain upsert ───────────────────────────────
  await test('addTask assigns increasing ids and sane defaults', () => {
    const env = envFor({ AEGIS_QUEUE_FILE: join(tmp, 'add', 'queue.jsonl') });
    const first = queue.addTask(env, { task: 'first', cwd: root });
    const second = queue.addTask(env, { task: 'second', cwd: root });
    assert(first.id === 1 && second.id === 2, `ids increment: ${first.id}, ${second.id}`);
    assert(first.status === 'pending' && first.attempts === 0, 'new tasks are pending with no attempts');
    assert(first.model === null && first.commit === false, 'model defaults to null, commit to false');
    assert(queue.loadQueue(env).length === 2, 'both persisted');
    let threw = false;
    try {
      queue.addTask(env, { task: '   ' });
    } catch {
      threw = true;
    }
    assert(threw, 'a blank task is rejected rather than queued');
  });

  await test('ids increase within a queue, and only `clear --all` resets them', () => {
    const env = envFor({ AEGIS_QUEUE_FILE: join(tmp, 'ids', 'queue.jsonl') });
    queue.addTask(env, { task: 'a' });
    queue.addTask(env, { task: 'b' });
    queue.clearQueue(env);
    const next = queue.addTask(env, { task: 'c' });
    assert(next.id === 3, `a plain clear drops finished rows but keeps the counter: got #${next.id}`);

    // Documented, not accidental: an explicit `--all` empties the file, so the
    // next id starts over. That is why the runs log carries the task text.
    queue.clearQueue(env, { all: true });
    assert(queue.addTask(env, { task: 'd' }).id === 1, 'clear --all starts a fresh generation at #1');
  });

  await test('a drain that re-reads before writing preserves a concurrent add', () => {
    const env = envFor({ AEGIS_QUEUE_FILE: join(tmp, 'upsert', 'queue.jsonl') });
    const mine = queue.addTask(env, { task: 'mine' });

    // The worker claims its item the way autonomous.js does: load, mutate,
    // write — with the load immediately before the write (autonomous.js:476).
    // Anything another host added before that read is still in the file.
    queue.addTask(env, { task: 'added by someone else mid-drain' });
    const claiming = queue.loadQueue(env);
    queue.markRunning(claiming, mine.id, { pid: 4242 });
    queue.saveQueue(env, claiming);

    // ...and settles it the same way (autonomous.js:483-497).
    const settling = queue.loadQueue(env);
    queue.settle(settling, mine.id, { status: 'done', result: { ok: true } });
    queue.saveQueue(env, settling);

    const after = queue.loadQueue(env);
    assert(after.length === 2, `the concurrent add survived: ${JSON.stringify(after.map((i) => i.task))}`);
    assert(queue.findTask(after, 1).status === 'done', 'our own item settled across both writes');
    assert(!('pid' in queue.findTask(after, 1)), 'and holds no worker once finished');
    assert(queue.findTask(after, 2).status === 'pending', 'the other task is untouched and still workable');
  });

  await test('upsert merges by id instead of replacing wholesale', () => {
    const items = [{ id: 1, task: 't', cwd: '/w', status: 'pending' }];
    const merged = queue.upsert(items, { id: 1, status: 'done' });
    assert(merged.length === 1, 'no duplicate row');
    assert(merged[0].task === 't' && merged[0].cwd === '/w', 'fields not named in the patch are kept');
    assert(merged[0].status === 'done', 'the patch wins');
  });

  // ── the task lifecycle ──────────────────────────────────────────────────
  await test('markRunning stamps the owner and counts the attempt', () => {
    const items = [{ id: 1, task: 't', status: 'pending', attempts: 0 }];
    const item = queue.markRunning(items, 1, { pid: 4242, now: 1000 });
    assert(item.status === 'running' && item.pid === 4242, 'claimed by the calling worker');
    assert(item.attempts === 1, 'attempts incremented');
    assert(item.startedAt === 1000, 'start time recorded');
    assert(queue.markRunning(items, 99) === null, 'an unknown id claims nothing');
  });

  await test('settle drops the pid and keeps the result verbatim', () => {
    const items = [{ id: 1, task: 't', status: 'running', pid: 4242 }];
    queue.settle(items, 1, { status: 'done', result: { ok: true, files: ['a.js'] }, now: 2000 });
    assert(items[0].status === 'done', 'settled');
    assert(!('pid' in items[0]), 'a finished task holds no worker');
    assert(items[0].result.files[0] === 'a.js', 'the result is stored as given');
    assert(items[0].finishedAt === 2000, 'finished stamp');

    const bad = [{ id: 2, task: 't', status: 'running' }];
    queue.settle(bad, 2, { status: 'exploded' });
    assert(bad[0].status === 'error', 'an unknown status degrades to error, never into the file');
  });

  await test('settle records a failure, and a later success clears it', () => {
    const items = [{ id: 1, task: 't', status: 'running' }];
    queue.settle(items, 1, { status: 'error', error: 'boom', result: null });
    assert(items[0].error === 'boom', 'the error is kept for the runs log');
    queue.settle(items, 1, { status: 'done', result: { ok: true } });
    assert(!('error' in items[0]), 'a retry that works must not carry the old error');
  });

  await test('retryTask re-pends a task and keeps its attempt count', () => {
    const env = envFor({ AEGIS_QUEUE_FILE: join(tmp, 'retry', 'queue.jsonl') });
    queue.addTask(env, { task: 'retry me' });
    const items = queue.loadQueue(env);
    queue.markRunning(items, 1, { pid: 1 });
    queue.settle(items, 1, { status: 'error', error: 'nope' });
    queue.saveQueue(env, items);

    const item = queue.retryTask(env, 1, { now: 3000 });
    assert(item.status === 'pending', 'back in the queue');
    assert(!('error' in item) && !('pid' in item), 'error and pid cleared');
    assert(item.attempts === 1, 'the attempt count is the record of how hard this was tried');
    assert(queue.retryTask(env, 99) === null, 'an unknown id is reported, not invented');
  });

  await test('clear refuses to drop pending or running work', () => {
    const env = envFor({ AEGIS_QUEUE_FILE: join(tmp, 'clear', 'queue.jsonl') });
    queue.addTask(env, { task: 'waiting' });
    const items = queue.loadQueue(env);
    queue.markRunning(items, 1, { pid: 1 });
    const running = { ...items[0] };
    queue.saveQueue(env, items);
    queue.addTask(env, { task: 'also waiting' });

    // A finished task for clear to actually remove.
    const withDone = queue.loadQueue(env);
    queue.settle(withDone, 1, { status: 'done' });
    queue.saveQueue(env, withDone);

    const res = queue.clearQueue(env);
    const after = queue.loadQueue(env);
    assert(res.removed === 1, `only the finished task is removed: ${JSON.stringify(res)}`);
    assert(after.length === 1 && after[0].task === 'also waiting', 'the waiting task survives a clear');
    assert(queue.pendingCount(after) === 1, 'and is still pending');

    const all = queue.clearQueue(env, { all: true });
    assert(all.removed === 1 && queue.loadQueue(env).length === 0, '--all is the explicit empty');
    void running;
  });

  // ── liveness, recovery, and the double-execution guard ──────────────────
  await test('isAlive is true for this process and false for a pid that exited', () => {
    assert(queue.isAlive(process.pid), 'our own pid is alive');
    assert(!queue.isAlive(0) && !queue.isAlive(-1) && !queue.isAlive('x'), 'garbage pids are not alive');
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert(child.pid > 0, 'spawned a real child');
    assert(!queue.isAlive(child.pid), `a pid that has exited is not alive (pid ${child.pid})`);
  });

  await test('recoverStale re-pends a dead worker and leaves a live one alone', () => {
    const dead = [
      { id: 1, task: 'a', status: 'running', pid: 111 },
      { id: 2, task: 'b', status: 'running', pid: 222 },
      { id: 3, task: 'c', status: 'pending' },
      { id: 4, task: 'd', status: 'done', pid: 333 },
    ];
    const recovered = queue.recoverStale(dead, { isAliveFn: (pid) => pid === 222, now: 4000 });
    assert(recovered.length === 1 && recovered[0] === 1, `only the dead one recovered: ${JSON.stringify(recovered)}`);
    assert(dead[0].status === 'pending' && !('pid' in dead[0]), 'the orphaned task is workable again');
    assert(dead[0].recoveredAt === 4000, 'recovery is stamped');
    assert(dead[1].status === 'running' && dead[1].pid === 222, 'a LIVE worker keeps its claim — re-pending it would run it twice');
    assert(dead[2].status === 'pending' && dead[3].status === 'done', 'other statuses are untouched');
  });

  await test('a running task that never recorded a pid is recovered', () => {
    const items = [{ id: 1, task: 'a', status: 'running' }];
    const recovered = queue.recoverStale(items, { isAliveFn: () => true });
    assert(recovered.length === 1 && items[0].status === 'pending', 'no pid means no owner');
  });

  // ── the single-worker lock ──────────────────────────────────────────────
  await test('a second drain backs off a live holder, and steals a dead one at once', () => {
    const env = envFor({ AEGIS_QUEUE_LOCK: join(tmp, 'lock', 'queue.lock') });
    fs.mkdirSync(dirname(env.AEGIS_QUEUE_LOCK), { recursive: true });

    const first = queue.acquireLock(env, { pid: 1000, isAliveFn: () => true });
    assert(first.ok, 'the first drain takes it');

    const second = queue.acquireLock(env, { pid: 2000, isAliveFn: () => true });
    assert(!second.ok, 'a live holder is respected, not raced');
    assert(second.holder.pid === 1000, `and named: ${JSON.stringify(second.holder)}`);

    // The holder is SIGKILLed: no staleness window — the next caller reclaims.
    const stolen = queue.acquireLock(env, { pid: 3000, isAliveFn: (pid) => pid !== 1000 });
    assert(stolen.ok, 'a dead holder does not block the queue forever');
    assert(queue.lockHolder(env).pid === 3000, 'and the lock records the new owner');
  });

  await test('releaseLock never frees a lock held by someone else', () => {
    const env = envFor({ AEGIS_QUEUE_LOCK: join(tmp, 'lock2', 'queue.lock') });
    fs.mkdirSync(dirname(env.AEGIS_QUEUE_LOCK), { recursive: true });
    queue.acquireLock(env, { pid: 1000, isAliveFn: () => true });

    const refused = queue.releaseLock(env, { pid: 2000 });
    assert(!refused.ok, 'a non-holder cannot release it');
    assert(queue.lockHolder(env).pid === 1000, 'the holder is still recorded');

    const mine = queue.releaseLock(env, { pid: 1000 });
    assert(mine.ok, 'the holder releases its own');
    assert(queue.lockHolder(env) === null, 'the lock is gone');
    assert(queue.releaseLock(env, { pid: 1000 }).ok, 'releasing twice is not an error');
  });

  // ── durability of the files ─────────────────────────────────────────────
  await test('readQueue skips a torn line instead of losing the whole queue', () => {
    const file = join(tmp, 'torn', 'queue.jsonl');
    queue.ensureDir(dirname(file));
    fs.writeFileSync(file, '{"id":1,"task":"good"}\n{"id":2,"task":"tor\n{"id":3,"task":"also good"}\n');
    const items = queue.readQueue(file);
    assert(items.length === 2, `the two intact lines survive: ${JSON.stringify(items.map((i) => i.id))}`);
    assert(items[0].id === 1 && items[1].id === 3, 'and keep their order');
    assert(queue.readQueue(join(tmp, 'torn', 'missing.jsonl')).length === 0, 'a missing queue is not an error');
  });

  await test('the queue file is written atomically and privately', () => {
    const env = envFor({ AEGIS_QUEUE_FILE: join(tmp, 'atomic', 'queue.jsonl') });
    queue.addTask(env, { task: 'secret' });
    const mode = fs.statSync(queue.queuePath(env)).mode & 0o777;
    assert(mode === 0o600, `the queue is 0600, got 0${mode.toString(8)}`);
    const leftovers = fs.readdirSync(dirname(queue.queuePath(env))).filter((f) => f.includes('.tmp'));
    assert(leftovers.length === 0, `the temp file was renamed away: ${JSON.stringify(leftovers)}`);
    assert(fs.readFileSync(queue.queuePath(env), 'utf8').endsWith('\n'), 'one JSON object per line, newline-terminated');
  });

  await test('the runs log is append-only and reads back newest-last', () => {
    const env = envFor({ AEGIS_RUNS_FILE: join(tmp, 'runs', 'runs.jsonl') });
    queue.appendRun(env, { id: 1, status: 'done', tokens: 10 });
    queue.appendRun(env, { id: 2, status: 'error' });
    queue.appendRun(env, { id: 3, status: 'done', tokens: 30 });
    const all = queue.readRuns(env);
    assert(all.length === 3 && all[2].id === 3, 'history is kept in order');
    const tail = queue.readRuns(env, { limit: 2 });
    assert(tail.length === 2 && tail[0].id === 2 && tail[1].id === 3, `limit keeps the newest: ${JSON.stringify(tail.map((r) => r.id))}`);
    assert(queue.readRuns(envFor({ AEGIS_RUNS_FILE: join(tmp, 'runs', 'none.jsonl') })).length === 0, 'no runs yet reads as empty');

    // A torn final line (killed mid-append) must not poison the history.
    fs.appendFileSync(queue.runsPath(env), '{"id":4,"stat');
    assert(queue.readRuns(env).length === 3, 'a torn run line is skipped');
  });

  // ── reconcile: PLAN.md → the next phase ─────────────────────────────────
  const plan = [
    '# Plan',
    '',
    'Status:',
    '- [x] Phase 1 — done thing',
    '- [ ] Phase 2 — open thing',
    '',
    '---',
    '',
    '## Phase 1 ✅ — done thing',
    '',
    'shipped',
    '',
    '## Phase 2 — open thing',
    '',
    'not shipped',
    '',
    '## Phase 3 ✅ — later',
    '',
    'shipped',
    '',
  ].join('\n');

  await test('parsePlanStatus reads both the checklist and the headings', () => {
    const parsed = queue.parsePlanStatus(plan);
    assert(parsed.statusDone.get(1) === true && parsed.statusDone.get(2) === false, 'the checklist is read');
    assert(parsed.headerDone.has(1) && parsed.headerDone.has(3), 'the ✅ headings are read');
    assert(!parsed.headerDone.has(2), 'an unmarked heading is open');
    assert([...parsed.headerNums].sort().join(',') === '1,2,3', 'every phase heading is known');
  });

  await test('a ✅ anywhere on the heading counts, and never leaks into the title', () => {
    // The convention is `## Phase 7 ✅ — title`; a trailing ✅ still means shipped.
    const trailing = 'Status:\n- [ ] Phase 1 — t\n\n## Phase 1 — t ✅\n';
    assert(queue.parsePlanStatus(trailing).headerDone.has(1), 'a trailing ✅ is read as done');
    const canonical = 'Status:\n- [ ] Phase 1 — t\n\n## Phase 1 ✅ — t\n';
    assert(queue.parsePlanStatus(canonical).headerDone.has(1), 'the canonical placement is read');
    assert(queue.extractPhaseTitle(canonical, 1) === 't', 'the ✅ is stripped from the title');
    assert(queue.extractPhaseTitle(trailing, 1) === 't', 'trailing ✅ too');
    assert(queue.extractPhaseTitle('## Phase 2 — open thing', 2) === 'open thing', 'a plain title is unchanged');
  });

  await test('a ✅ heading with no checklist line is healed, not re-queued', () => {
    // Phase 3 shipped (✅) but the Status list never got its line — the drift
    // this parser documents. Re-queueing it would redo shipped work.
    const parsed = queue.parsePlanStatus(plan);
    const healed = queue.healPlanStatus(plan, parsed);
    assert(healed.changed, 'the drift is detected');
    assert(healed.added.join(',') === '3', `only Phase 3 is added: ${JSON.stringify(healed.added)}`);
    assert(/- \[x\] Phase 3 — later/.test(healed.text), `healed with the heading's title:\n${healed.text}`);
    assert(queue.parsePlanStatus(healed.text).statusDone.get(3) === true, 'and the healed text now agrees with itself');

    const clean = queue.healPlanStatus(healed.text, queue.parsePlanStatus(healed.text));
    assert(!clean.changed, 'healing is idempotent');
  });

  await test('reconcilePlan returns the first unfinished phase', () => {
    const dir = join(tmp, 'plan');
    queue.ensureDir(dir);
    fs.writeFileSync(join(dir, 'PLAN.md'), plan);
    const res = queue.reconcilePlan(dir);
    assert(res.ok, 'a PLAN.md is read');
    assert(res.next === 2, `Phase 2 is next, got ${res.next}`);
    assert(res.title === 'open thing', `the title is carried for the task text: ${res.title}`);
    assert(res.healed.changed && res.healed.added.join(',') === '3', 'the Phase 3 drift is reported');
    assert(fs.readFileSync(join(dir, 'PLAN.md'), 'utf8') === plan, 'a read never writes');
  });

  await test('reconcilePlan heals on request, and reports a missing PLAN.md', () => {
    const dir = join(tmp, 'plan-write');
    queue.ensureDir(dir);
    fs.writeFileSync(join(dir, 'PLAN.md'), plan);
    const res = queue.reconcilePlan(dir, { write: true });
    assert(res.healed.changed, 'the drift was found');
    assert(/- \[x\] Phase 3/.test(fs.readFileSync(join(dir, 'PLAN.md'), 'utf8')), 'and written to disk');
    assert(res.next === 2, 'healing the checklist does not change what is next');

    const none = queue.reconcilePlan(join(tmp, 'no-plan'));
    assert(!none.ok && none.next === null, 'no PLAN.md is a clean "nothing to do"');
    assert(/no PLAN\.md/.test(none.reason), `and says why: ${none.reason}`);
  });

  await test('a fully-completed plan queues nothing', () => {
    const dir = join(tmp, 'plan-done');
    queue.ensureDir(dir);
    fs.writeFileSync(join(dir, 'PLAN.md'), 'Status:\n- [x] Phase 1 — a\n\n## Phase 1 ✅ — a\n');
    const res = queue.reconcilePlan(dir);
    assert(res.ok && res.next === null, `nothing left to queue: ${JSON.stringify(res.next)}`);
  });

  // ── the worker's pure helpers (autonomous.js) ───────────────────────────
  await test('resolveModel runs Aegis Cloud or the pooled brain, never a foreign id', () => {
    assert(autonomous.resolveModel({ model: 'nexus-brain-smart', env: { AEGIS_AUTONOMOUS_MODEL: 'x' } }) === 'nexus-brain-smart', 'an explicit Aegis pick wins');
    // A pick from the TASK is returned verbatim even when wrong: substituting a
    // correct model for a stated one is how a queue "runs on nexus-brain" while
    // the file says something else. The refusal is the caller's job (next test).
    assert(autonomous.resolveModel({ model: 'claude-sonnet-4', env: {} }) === 'claude-sonnet-4', 'a wrong task pick is reported, not rewritten');
    assert(autonomous.resolveModel({ env: { AEGIS_AUTONOMOUS_MODEL: 'nexus-brain' } }) === 'nexus-brain', 'an Aegis environment pin is honoured');
    assert(autonomous.resolveModel({ env: { AEGIS_MODEL: 'aegis-brain-neo' } }) === 'aegis-brain-neo', 'in the generic spelling too');
    // AEGIS_MODEL is shared with the interactive surfaces, which DO run direct
    // providers, so a stray value there is not a statement about the queue: it
    // is skipped rather than allowed to put a non-pool model on the wire.
    assert(autonomous.resolveModel({ env: { AEGIS_AUTONOMOUS_MODEL: 'deepseek-v4-flash' } }) === 'nexus-brain', 'a foreign environment pin is skipped');
    assert(autonomous.resolveModel({ env: { AEGIS_MODEL: 'claude-opus-4' } }) === 'nexus-brain', 'in the generic spelling too');
    assert(autonomous.resolveModel({ env: {} }) === autonomous.DEFAULT_MODEL, 'then the default');
    assert(autonomous.DEFAULT_MODEL === 'nexus-brain', 'which is the pooled brain tier');
    assert(autonomous.resolveModel({ model: '  ', env: {} }) === 'nexus-brain', 'blank is not a choice');
  });

  await test('a model the pool does not serve is refused by name, at the door', () => {
    for (const id of ['nexus-brain', 'nexus-brain-smart', 'nexus-brain-neo', 'aegis-brain', 'aegis-brain-smart', 'nexus-brain-neo ']) {
      assert(autonomous.isAegisModel(id), `should be accepted: ${id}`);
      assert(autonomous.modelRefusal(id) === '', `and not refused: ${id}`);
    }
    // `nexus-fast` is the id that made this necessary: it looks like a cheaper
    // tier of the same family, and the catalog has never served it.
    for (const id of ['nexus-fast', 'claude-sonnet-4', 'gpt-5', 'anthropic', 'deepseek-v4-pro', 'nexus', '']) {
      assert(!autonomous.isAegisModel(id), `should not be accepted: ${JSON.stringify(id)}`);
    }
    const why = autonomous.modelRefusal('  claude-sonnet-4  ');
    assert(/claude-sonnet-4/.test(why), `the refusal names the offending model: ${why}`);
    assert(/Aegis Cloud/.test(why) && /nexus-brain/.test(why), `and the pool plus an allowed id: ${why}`);
    assert(autonomous.modelRefusal('') === '' && autonomous.modelRefusal(null) === '', 'blank is not a refusal — it is "no pick"');

    const ignored = autonomous.ignoredEnvModel({ env: { AEGIS_AUTONOMOUS_MODEL: 'deepseek-v4-flash' } });
    assert(/AEGIS_AUTONOMOUS_MODEL/.test(ignored) && /deepseek-v4-flash/.test(ignored), `the skipped pin is reported, not silent: ${ignored}`);
    assert(/nexus-brain/.test(ignored), 'and it says what ran instead');
    assert(/AEGIS_MODEL=/.test(autonomous.ignoredEnvModel({ env: { AEGIS_MODEL: 'anthropic' } })), 'the generic spelling is named too');
    assert(autonomous.ignoredEnvModel({ env: { AEGIS_MODEL: 'nexus-brain' } }) === '', 'an Aegis pin is nothing to report');
    assert(autonomous.ignoredEnvModel({ model: 'nexus-brain', env: { AEGIS_MODEL: 'anthropic' } }) === '', 'nor is one the task overrode');

    // The door: queue.addTask holds the CLI, the card and a hand-written file
    // to the same accept-list.
    let threw = null;
    try {
      queue.addTask(envFor(), { task: 'x', cwd: tmp, model: 'nexus-fast' });
    } catch (e) {
      threw = e;
    }
    assert(threw && /nexus-fast/.test(threw.message), `addTask refuses a foreign model: ${threw && threw.message}`);
    assert(queue.loadQueue(envFor()).length === 0, 'and nothing was written to the queue');
    assert(queue.addTask(envFor(), { task: 'x', cwd: tmp, model: 'nexus-brain' }).model === 'nexus-brain', 'an Aegis pick is stored as given');
    queue.clearQueue(envFor());
  });

  await test('the fan-out is opt-in, because it is the cost multiplier', () => {
    assert(autonomous.resolveFanout({}, {}) === false, 'a plain queued task runs one pass');
    assert(autonomous.resolveFanout({ singlePass: true }, {}) === false, 'singlePass stays single');
    assert(autonomous.resolveFanout({ autonomous: true }, {}) === true, 'a task can ask for the fan-out');
    assert(autonomous.resolveFanout({ singlePass: false }, {}) === true, 'the queue field can too');
    assert(autonomous.resolveFanout({}, { AEGIS_AUTONOMOUS_FANOUT: '1' }) === true, 'so can the environment');
    assert(autonomous.resolveFanout({}, { AEGIS_AUTONOMOUS_FANOUT: 'yes' }) === true, 'in any true spelling');
    assert(autonomous.resolveFanout({}, { AEGIS_AUTONOMOUS_FANOUT: 'no' }) === false, 'and "no" is not one of them');
  });

  await test('effort follows the task shape and the round horizon is overridable', () => {
    assert(autonomous.resolveEffort({ env: {} }) === 'medium', 'a single-pass task runs the medium rung, not the priciest one');
    assert(autonomous.resolveEffort({ env: {}, fanout: true }) === 'high', 'the fan-out keeps the high rung it needs for synthesis');
    assert(autonomous.resolveEffort({ effort: 'low', env: {} }) === 'low', 'the caller can lower it');
    assert(autonomous.resolveEffort({ env: { AEGIS_AUTONOMOUS_EFFORT: 'medium' } }) === 'medium', 'and so can the environment');
    assert(autonomous.resolveEffort({ effort: 'high', env: {}, fanout: false }) === 'high', 'an explicit pick beats the shape default');

    assert(autonomous.maxRounds({}, undefined) === autonomous.DEFAULT_ROUNDS, 'the default horizon');
    assert(autonomous.maxRounds({}, 7) === 7, 'a stated horizon wins');
    assert(autonomous.maxRounds({ AEGIS_AUTONOMOUS_MAX_ROUNDS: '9' }) === 9, 'the environment is read');
    assert(autonomous.maxRounds({ AEGIS_AUTONOMOUS_MAX_ROUNDS: 'nonsense' }) === autonomous.DEFAULT_ROUNDS, 'garbage falls back');
  });

  // The cost knobs are only real if they reach the wire, and the refusal is only
  // real if it happens BEFORE the turn. Both are asserted on the payload the
  // engine actually receives, with a fake engine — no network, no model.
  await test('the worker sends one plain pooled turn unless the task asks to fan out', async () => {
    const seen = [];
    const engine = {
      chat: async (payload) => {
        seen.push(payload);
        return { choices: [{ message: { content: 'done' } }], usage: { total_tokens: 1 } };
      },
    };
    const events = [];
    const worker = autonomous.createQueueWorker({ engine, env: envFor(), log: (e) => events.push(e) });

    const plain = await worker.runTask({ id: 1, task: 'rename the flag', cwd: tmp }, { commit: false });
    assert(plain.ok, `the plain task ran: ${plain.error || ''}`);
    assert(seen[0].class === 'aegis', 'the turn is billed to the Aegis pool');
    assert(seen[0].model === 'nexus-brain', `on the pooled brain: ${seen[0].model}`);
    assert(seen[0].autonomous === false, 'the cost multiplier is OFF by default — this is the whole point of the change');
    assert(seen[0].workers === undefined, 'and it carries no worker count to size a fan-out with');
    assert(seen[0].effort === 'medium', `a single pass runs the medium rung: ${seen[0].effort}`);
    const start = events.find((e) => e.type === 'start');
    assert(start && start.fanout === false && start.effort === 'medium', 'the card is told the shape it is paying for');

    const fanned = await worker.runTask({ id: 2, task: 'investigate the regression', cwd: tmp, autonomous: true, workers: 3 }, { commit: false });
    assert(fanned.ok, 'the fan-out task ran');
    assert(seen[1].autonomous === true, 'the fan-out travels when the task asked for it');
    assert(seen[1].workers === 3, 'with its worker count');
    assert(seen[1].effort === 'high', 'and the high rung it needs for synthesis');
    assert(seen[1].model === 'nexus-brain', 'still on the same tier — the tier is not what made it expensive');

    // The pre-flight: a foreign id is refused before any turn, so a bad row in a
    // drain costs nothing instead of failing at the server minutes later.
    const before = seen.length;
    const refused = await worker.runTask({ id: 3, task: 'x', cwd: tmp, model: 'deepseek-v4-flash' }, { commit: false });
    assert(!refused.ok && /deepseek-v4-flash/.test(refused.error), `refused by name: ${refused.error}`);
    assert(seen.length === before, 'and no turn was made');
    assert(refused.ms === 0, 'the refusal is not billed work');
    const finish = events.filter((e) => e.type === 'finish').pop();
    assert(finish && finish.ok === false && finish.taskId === 3, 'the card gets a failed row, not a hang');

    // An ignored environment pin is reported rather than obeyed in silence.
    const noisy = [];
    const pinned = autonomous.createQueueWorker({ engine, env: envFor({ AEGIS_AUTONOMOUS_MODEL: 'deepseek-v4-flash' }), log: (e) => noisy.push(e) });
    await pinned.runTask({ id: 4, task: 'x', cwd: tmp }, { commit: false });
    const note = noisy.find((e) => e.type === 'note');
    assert(note && /deepseek-v4-flash/.test(note.note), `the skip is announced: ${note && note.note}`);
    assert(seen[seen.length - 1].model === 'nexus-brain', 'and the turn still went to the pool');
  });

  await test('withRoundHorizon sets the engine knob and always puts it back', async () => {
    // engine.js reads AEGIS_AUTONOMOUS_MAX_ROUNDS from process.env at turn time.
    const before = process.env.AEGIS_AUTONOMOUS_MAX_ROUNDS;
    const env = {};
    const seen = [];
    autonomous.withRoundHorizon(5, env, () => {
      seen.push(process.env.AEGIS_AUTONOMOUS_MAX_ROUNDS, env.AEGIS_AUTONOMOUS_MAX_ROUNDS);
    });
    assert(seen.join(',') === '5,5', `both the process and the caller's env see it: ${JSON.stringify(seen)}`);
    assert(process.env.AEGIS_AUTONOMOUS_MAX_ROUNDS === before, 'restored after a sync call');
    assert(!('AEGIS_AUTONOMOUS_MAX_ROUNDS' in env), 'and removed from the caller env it did not own');

    // The async case is the real one: a turn reads the knob many rounds later.
    let during = null;
    await autonomous.withRoundHorizon(6, env, async () => {
      await new Promise((r) => setTimeout(r, 5));
      during = process.env.AEGIS_AUTONOMOUS_MAX_ROUNDS;
    });
    assert(during === '6', `the knob is live for the whole turn: ${during}`);
    assert(process.env.AEGIS_AUTONOMOUS_MAX_ROUNDS === before, 'restored after an async call');

    let threw = false;
    try {
      autonomous.withRoundHorizon(7, env, () => {
        throw new Error('turn blew up');
      });
    } catch {
      threw = true;
    }
    assert(threw && process.env.AEGIS_AUTONOMOUS_MAX_ROUNDS === before, 'and after a throw');
  });

  await test('isAutonomousRequest recognises the phrases that mean "unattended"', () => {
    for (const text of ['do it autonomously', 'work on your own', 'without asking, just do it', 'end-to-end please', 'no more questions', 'queue it']) {
      assert(autonomous.isAutonomousRequest(text), `should match: ${text}`);
    }
    assert(!autonomous.isAutonomousRequest('what does this function do?'), 'a plain question is not a request to run unattended');
    assert(!autonomous.isAutonomousRequest(''), 'empty is not a request');
    assert(!autonomous.isAutonomousRequest(null), 'null is not a request');
  });

  await test('only file-writing tools are attributed, and exec deliberately is not', () => {
    assert(autonomous.WRITE_TOOLS.has('writeFile') && autonomous.WRITE_TOOLS.has('editFile'), 'the writers are known');
    assert(!autonomous.WRITE_TOOLS.has('exec'), 'a shell command names no path, so it cannot be attributed');
    assert(autonomous.writtenPath({ args: { file_path: '/w/a.js' } }) === '/w/a.js', 'file_path spelling');
    assert(autonomous.writtenPath({ args: { path: '/w/b.js' } }) === '/w/b.js', 'path spelling');
    assert(autonomous.writtenPath({ args: {} }) === '', 'no path is empty, not undefined');
    assert(autonomous.writtenPath(null) === '', 'a missing tool is empty');
  });

  await test('the task prompt carries the directive, the briefing, then the task', () => {
    const prompt = autonomous.taskPrompt(
      { task: 'Fix the parser' },
      { carry: '- #1 ✓ did a thing', rounds: 12 }
    );
    assert(prompt.includes('up to 12 tool rounds'), 'the horizon is in the directive the model reads');
    assert(prompt.includes('# Earlier tasks in this run') && prompt.includes('did a thing'), 'the briefing is included');
    assert(prompt.trimEnd().endsWith('Fix the parser'), 'the task is last, where it is read');
    assert(!autonomous.taskPrompt({ task: 'x' }).includes('# Earlier tasks'), 'no briefing when there is nothing to brief');
  });

  await test('the digest stays tiny and keeps only the last few tasks', () => {
    const line = autonomous.digestLine({ id: 3, task: 'a'.repeat(200) }, { ok: true, files: ['a.js', 'b.js'] });
    assert(line.startsWith('- #3 ✓ '), `the outcome is a mark: ${line.slice(0, 20)}`);
    assert(line.includes('touched: a.js, b.js'), 'files are reported');
    assert(line.length < 300, `the line is clipped, got ${line.length} chars`);
    assert(autonomous.digestLine({ id: 4, task: 'nope' }, { ok: false, error: 'boom' }).includes('boom'), 'a failure says why');

    let carry = '';
    for (let i = 1; i <= 9; i++) carry = autonomous.appendDigest(carry, `- #${i} ✓ t`);
    assert(carry.split('\n').length === 6, `the briefing is bounded to 6 lines: ${carry.split('\n').length}`);
    assert(carry.includes('#9') && !carry.includes('#1 '), 'and it is the NEWEST that are kept');
  });

  await test('the commit message is one line, labelled and clipped', () => {
    const msg = autonomous.commitMessage({ task: 'Add the queue\nwith a second line' });
    assert(msg === 'autonomous: Add the queue', `one line, first only: ${JSON.stringify(msg)}`);
    const long = autonomous.commitMessage({ task: 'x'.repeat(300) });
    assert(long.length <= 'autonomous: '.length + 67 && long.endsWith('…'), `clipped with an ellipsis: ${long.length}`);
    assert(autonomous.commitMessage({}).startsWith('autonomous: '), 'a task with no text still labels itself');
  });

  await test('assistant text and error text are read out of either engine shape', () => {
    assert(autonomous.assistantText({ choices: [{ message: { content: 'hi' } }] }) === 'hi', 'OpenAI shape');
    assert(autonomous.assistantText({ content: 'hi' }) === 'hi', 'flat shape');
    assert(autonomous.assistantText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, 'b'] } }] }) === 'ab', 'content parts');
    assert(autonomous.assistantText(null) === '', 'nothing is empty, not a throw');
    assert(autonomous.errorText(new Error('boom')) === 'boom', 'an Error reports its message');
    assert(autonomous.errorText('plain') === 'plain', 'a string passes through');
  });

  if (failures.length) {
    console.log(`\n# autonomous-queue tests FAILED (${failures.length} of ${passed + failures.length})`);
    for (const f of failures) console.log(`  - ${f.name}: ${f.error && f.error.message}`);
    process.exitCode = 1;
  } else {
    console.log(`# autonomous-queue tests passed (${passed})`);
    console.log('  spine: ids/upsert/lifecycle · liveness + lock · atomic files · runs log · reconcile · worker helpers');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
