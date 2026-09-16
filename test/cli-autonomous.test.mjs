#!/usr/bin/env node
/**
 * `aegiscode autonomous …` — the terminal half of the local work queue.
 *
 * WHY THIS FILE EXISTS AT ALL: commit 96fb64f added the whole CLI surface
 * (bin/aegiscode.js parsed `autonomous` into opts.command, cli/src/autonomous.js
 * implemented every subcommand) and then shipped it unreachable — nothing
 * dispatched opts.command === 'autonomous', so `aegiscode autonomous list` fell
 * through to the interactive chat path and died on "no terminal and no prompt".
 * Nothing was ever run, so nothing noticed. Every check below drives the REAL
 * binary in a child process with piped stdio (no TTY anywhere), against a
 * throwaway AEGISCODE_HOME, so the user's own queue is never read or written.
 *
 * Also covered: the exit STATUS, which is the point of a headless host.
 * A systemd timer's `ExecStart=aegiscode autonomous proceed` is only useful if
 * a failed task makes the unit fail, so 0/1/2 are asserted per command rather
 * than "it printed something".
 *
 * The drain runs against a loopback stub of AEGIS Cloud (the pattern
 * test/local-engine.test.mjs and test/cli-package.test.mjs established): the
 * model asks for a real writeFile tool call, the engine executes it, and the
 * queue has to settle that task to `done` with a runs-log line. No network, no
 * Electron, no credentials.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { loadQueue, readRuns, queuePath } = require('../desktop/lib/local/queue.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bin = join(root, 'cli', 'bin', 'aegiscode.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const tmp = fs.mkdtempSync(join(os.tmpdir(), 'aegiscode-cli-autonomous-'));
const home = join(tmp, 'home');
const scratch = join(tmp, 'scratch');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(scratch, { recursive: true });

/** A second, disjoint queue file — proves $AEGIS_QUEUE_FILE is honoured. */
const altQueueFile = join(tmp, 'elsewhere', 'queue.jsonl');

/**
 * Run the real CLI. stdin is piped AND closed, and stdout/stderr are pipes:
 * this is the "cron job / systemd timer / ssh command" shape, and a subcommand
 * that only works on a TTY fails here.
 */
function cli(args, { env = {}, cwd = root, input = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

/** The env every invocation gets: a private home, so no user state is touched. */
function envFor(extra = {}) {
  return { AEGISCODE_HOME: home, ...extra };
}

// ── the stub AEGIS Cloud ────────────────────────────────────────────────────

let mode = 'tools';
let chatRequests = 0;
let toolPath = join(scratch, 'proof.txt');

const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/api/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ id: 'nexus-brain', label: 'NEXUS', hidden: false }] }));
      return;
    }
    if (req.url === '/api/v1/chat/completions') {
      chatRequests += 1;
      if (mode === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub upstream exploded' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ model: 'nexus-brain', choices: [{ index: 0, delta: { role: 'assistant' } }] });
      // Round 1 with tools: the model asks for a writeFile, exactly as a real
      // drain does. Round 2 (or `mode: 'text'`): the final answer.
      if (mode === 'tools' && chatRequests % 2 === 1) {
        send({
          model: 'nexus-brain',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'writeFile',
                      arguments: JSON.stringify({ file_path: toolPath, content: 'ok' }),
                    },
                  },
                ],
              },
            },
          ],
        });
        send({ model: 'nexus-brain', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({
          model: 'nexus-brain',
          choices: [{ index: 0, delta: { content: 'wrote the file' }, finish_reason: 'stop' }],
        });
      }
      send({ model: 'nexus-brain', choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // Anything else the client might probe (balance, memory, …): a benign 200.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;

const DRAIN_ENV = envFor({ AEGIS_API_KEY: 'aegis_test_key', AEGIS_API_BASE: base, AEGIS_AUTONOMOUS_MODEL: 'nexus-brain' });

try {
  // ── help, and the two ways to ask for it ──────────────────────────────────
  {
    const help = await cli(['autonomous', 'help'], { env: envFor() });
    assert(help.code === 0, `\`autonomous help\` must exit 0, got ${help.code} (${help.err})`);
    assert(
      help.out.includes('aegiscode autonomous <command>') && help.out.includes('proceed'),
      `help must print the usage text, got: ${JSON.stringify(help.out.slice(0, 120))}`
    );
    // Bare `autonomous` is help, not a prompt (see bin/aegiscode.js parseArgs).
    const bare = await cli(['autonomous'], { env: envFor() });
    assert(bare.code === 0 && bare.out.includes('aegiscode autonomous <command>'), 'a bare `autonomous` prints help');
  }

  // ── an unknown subcommand is a NON-ZERO exit (the reason this is dispatched
  //    instead of falling through to chat: a typo in a systemd unit has to fail
  //    the unit, not start a conversation) ───────────────────────────────────
  {
    const unknown = await cli(['autonomous', 'bogus'], { env: envFor() });
    assert(unknown.code === 2, `an unknown subcommand must exit 2, got ${unknown.code}`);
    assert(!/no terminal and no prompt/.test(unknown.err + unknown.out), 'it must not fall through to the chat path');
    const badFlag = await cli(['autonomous', 'list', '--nope'], { env: envFor() });
    assert(badFlag.code === 2, `an unknown option must exit 2, got ${badFlag.code}`);
    assert(/unknown option: --nope/.test(badFlag.err), `it says which flag: ${badFlag.err}`);
  }

  // ── add ───────────────────────────────────────────────────────────────────
  {
    const empty = await cli(['autonomous', 'add'], { env: envFor() });
    assert(empty.code === 2, `\`add\` with no text must exit 2, got ${empty.code}`);

    const added = await cli(['autonomous', 'add', 'write proof.txt containing ok, then stop', '--cwd', scratch], {
      env: envFor(),
    });
    assert(added.code === 0, `add must exit 0, got ${added.code} (${added.err})`);
    assert(added.out.includes('queued #1'), `add must print the new id, got ${JSON.stringify(added.out)}`);

    // A task's text is a task, not flags: the parser must not eat `--json` out
    // of a task body, and the queue must hold what the user typed.
    const quoted = await cli(['autonomous', 'add', 'fix --json in the parser'], { env: envFor(), cwd: scratch });
    assert(quoted.code === 0, `a task containing a flag name must still queue (${quoted.err})`);

    const json = await cli(['autonomous', 'add', 'a third task', '--json'], { env: envFor(), cwd: scratch });
    assert(json.code === 0, `add --json must exit 0 (${json.err})`);
    let parsed = null;
    try {
      parsed = JSON.parse(json.out);
    } catch {
      /* asserted below */
    }
    assert(parsed && parsed.ok === true && parsed.id === 3, `add --json emits {ok, id}: ${json.out}`);

    // Plain `list` reads the same file the additions went to.
    const list = await cli(['autonomous', 'list'], { env: envFor() });
    assert(list.code === 0, `list must exit 0, got ${list.code}`);
    assert(list.out.includes(`queue: ${queuePath(envFor())}`), `list names the queue file: ${list.out}`);
    assert(list.out.includes('write proof.txt containing ok, then stop'), 'list shows the queued task');
    assert(list.out.includes('3 pending'), `list counts pending tasks: ${list.out}`);

    const listJson = await cli(['autonomous', 'list', '--json'], { env: envFor() });
    const shape = JSON.parse(listJson.out);
    assert(shape.ok === true && shape.counts.pending === 3, `list --json reports counts: ${listJson.out}`);
    assert(shape.tasks.length === 3 && shape.tasks[0].cwd === scratch, 'list --json carries the tasks and their cwd');

    // $AEGIS_QUEUE_FILE wins over the data dir — two hosts can be kept apart.
    const alt = await cli(['autonomous', 'add', 'somewhere else', '--cwd', scratch], {
      env: envFor({ AEGIS_QUEUE_FILE: altQueueFile }),
    });
    assert(alt.code === 0 && alt.out.includes('queued #1'), `a second queue file starts its own ids: ${alt.out}`);
    assert(fs.existsSync(altQueueFile), '$AEGIS_QUEUE_FILE is where the task landed');
    assert(loadQueue(envFor()).length === 3, 'the real queue was not touched by the AEGIS_QUEUE_FILE run');
  }

  // ── the drain: a real turn through the engine, a real tool call ───────────
  const firstId = loadQueue(envFor())[0].id;
  {
    // Only task #1 is worked here, so the `--max` cap is exercised too.
    const drained = await cli(['autonomous', 'proceed', '--max', '1'], { env: DRAIN_ENV });
    assert(drained.code === 0, `a drained task must exit 0, got ${drained.code}\n${drained.out}\n${drained.err}`);
    assert(/1 task\(s\) run/.test(drained.out), `it reports the drain: ${drained.out}`);
    assert(
      (drained.out + drained.err).includes(join(scratch, 'proof.txt')),
      `it reports the tool it ran: ${drained.out}${drained.err}`
    );
    assert(fs.readFileSync(toolPath, 'utf8') === 'ok', 'the model\'s writeFile actually landed');

    const items = loadQueue(envFor());
    const done = items.find((i) => i.id === firstId);
    assert(done.status === 'done', `the queue settled to done, got ${done.status} (${done.error || ''})`);
    assert(done.result && typeof done.result.ms === 'number', 'the outcome is recorded on the item');
    assert(!done.pid, 'the running marker is cleared');
    const runs = readRuns(envFor(), { limit: 10 });
    assert(runs.length === 1 && runs[0].status === 'done' && runs[0].id === firstId, `runs log: ${JSON.stringify(runs)}`);
    assert(/wrote the file/.test(done.result.output || ''), 'the assistant text is kept in the outcome');
    assert(!fs.existsSync(join(home, 'queue.lock')), 'the drain lock is released on the way out');
  }

  // ── a failed task must fail the PROCESS (a timer sees the unit fail) ─────
  {
    mode = 'fail';
    chatRequests = 0;
    const failed = await cli(['autonomous', 'proceed', '--max', '1'], { env: DRAIN_ENV });
    assert(failed.code === 1, `a failed task must exit 1, got ${failed.code}\n${failed.out}`);
    assert(/failed/.test(failed.out), `the failure is reported: ${failed.out}`);
    const errored = loadQueue(envFor()).find((i) => i.status === 'error');
    assert(errored, `the task is marked error: ${JSON.stringify(loadQueue(envFor()))}`);
    // `retry` puts it back, and says so; an unknown id is a failure, not a no-op.
    const retried = await cli(['autonomous', 'retry', String(errored.id)], { env: envFor() });
    assert(retried.code === 0 && retried.out.includes(`#${errored.id} is pending again`), `retry: ${retried.out}`);
    assert(loadQueue(envFor()).find((i) => i.id === errored.id).status === 'pending', 'retry clears the error status');
    const noSuch = await cli(['autonomous', 'retry', '99999'], { env: envFor() });
    assert(noSuch.code === 1 && /no task #99999/.test(noSuch.err), `retry of an unknown id exits 1: ${noSuch.code}`);
    mode = 'text';
    chatRequests = 0;
  }

  // ── clear drops finished work and never drops waiting work ───────────────
  {
    const cleared = await cli(['autonomous', 'clear'], { env: envFor() });
    assert(cleared.code === 0, `clear must exit 0 (${cleared.err})`);
    assert(/removed 1 finished task\(s\); \d+ kept/.test(cleared.out), `clear reports what it did: ${cleared.out}`);
    const after = loadQueue(envFor());
    assert(after.length === 3, `three pending tasks survive a clear, got ${after.length}`);
    assert(!after.some((i) => i.status === 'done'), 'the finished task is gone');
    const emptied = await cli(['autonomous', 'clear', '--all'], { env: envFor() });
    assert(emptied.code === 0 && loadQueue(envFor()).length === 0, `clear --all empties the queue: ${emptied.out}`);
  }

  // ── reconcile: queue the next unfinished PLAN.md phase ───────────────────
  {
    const noPlan = await cli(['autonomous', 'reconcile', '--cwd', scratch], { env: DRAIN_ENV });
    assert(noPlan.code === 1, `reconcile with no PLAN.md must exit non-zero, got ${noPlan.code}`);
    assert(/no PLAN.md/.test(noPlan.out + noPlan.err), `and say why: ${noPlan.out}${noPlan.err}`);

    fs.writeFileSync(
      join(scratch, 'PLAN.md'),
      ['# Plan', '', 'Status:', '- [x] Phase 1 — done thing', '', '---', '', '## Phase 1 — done thing ✅', '', '## Phase 2 — the next thing', ''].join('\n')
    );
    const rec = await cli(['autonomous', 'reconcile', '--cwd', scratch, '--json'], { env: DRAIN_ENV });
    assert(rec.code === 0, `reconcile must exit 0 (${rec.err})`);
    const payload = JSON.parse(rec.out);
    assert(payload.ok === true && payload.phase === 2, `reconcile queues the next phase: ${rec.out}`);
    const queued = loadQueue(envFor());
    assert(queued.length === 1 && queued[0].source === 'reconcile', `the phase is queued: ${JSON.stringify(queued)}`);
    assert(queued[0].task.includes('Work Phase 2 from PLAN.md'), 'the task points at the spec rather than paraphrasing it');
    // Re-running does not queue the same phase twice.
    await cli(['autonomous', 'reconcile', '--cwd', scratch], { env: DRAIN_ENV });
    assert(loadQueue(envFor()).length === 1, 'reconcile is idempotent for a phase already queued');
  }

  // ── a full drain: everything pending, one lock, zero left ────────────────
  {
    // The AEGIS_QUEUE_FILE home is still untouched by this drain; use it as the
    // "drain everything" fixture so the real queue's reconcile item is not
    // worked by a stub model.
    const elsewhere = envFor({ AEGIS_QUEUE_FILE: altQueueFile, ...DRAIN_ENV });
    const proceeded = await cli(['autonomous', 'proceed'], { env: elsewhere });
    assert(proceeded.code === 0, `proceed must exit 0 (${proceeded.code})\n${proceeded.out}${proceeded.err}`);
    assert(/1 task\(s\) run/.test(proceeded.out), `proceed drains the pending task: ${proceeded.out}`);
    const settled = loadQueue(elsewhere);
    assert(settled.every((i) => i.status === 'done'), `the queue settled: ${JSON.stringify(settled.map((i) => i.status))}`);
    const again = await cli(['autonomous', 'proceed'], { env: elsewhere });
    assert(again.code === 0 && /nothing pending/.test(again.out), `an empty drain is a success: ${again.out}`);
  }

  // ── no key: a drain cannot run, and says so with exit 2 ──────────────────
  {
    const keyless = await cli(['autonomous', 'proceed'], {
      env: { AEGISCODE_HOME: join(tmp, 'keyless'), AEGIS_API_KEY: '', AEGIS_API_BASE: base },
    });
    assert(keyless.code === 2, `a drain with no credential must exit 2, got ${keyless.code}`);
    assert(/no AEGIS account key/.test(keyless.err), `and explain how to get one: ${keyless.err}`);
  }

  console.log('# cli-autonomous tests passed');
  console.log('  help/bare/unknown · add/list/retry/clear/reconcile · drain through a stub Cloud');
} finally {
  stub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
