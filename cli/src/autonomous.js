'use strict';

/**
 * `aegiscode autonomous …` — the unattended host of the work queue.
 *
 * The queue itself (desktop/lib/local/queue.js) is a file, and the worker
 * (desktop/lib/local/autonomous.js) drives the SAME engine the chat surfaces
 * use. What is left for this module is the host: a subcommand surface a human
 * or a timer can call, with the exit codes a script needs.
 *
 * Why the terminal is the unattended home rather than the GUI: a cron job, a
 * systemd timer and `ssh box 'aegiscode autonomous proceed'` all need a process
 * that starts, drains, and exits with a status — not a window somebody has to
 * click. The desktop host can drain too, but only when the user asks it to.
 *
 * Reused, never reimplemented: the model call is cli/src/engine.js's
 * createEngine (same tool loop as the GUI, confirm gate FORCED OFF), the task
 * list is deps.queue (the file the GUI writes), and the commit rule is
 * git-scope.js's scopedCommit. This file is argv → those calls, and the honest
 * report of what came back.
 *
 * Exit codes (they are the point of a headless host):
 *   0  everything asked for happened
 *   1  a task failed, or another drain holds the lock
 *   2  usage error, or no credential to run an unattended turn with
 */

const path = require('node:path');

const { queue, autonomous } = require('./deps.js');
const { createEngine } = require('./engine.js');
const { fmtElapsed } = require('./format.js');

const SUBCOMMANDS = new Set([
  'add', 'list', 'run', 'proceed', 'reconcile', 'clear', 'retry', 'help',
]);

/**
 * Parse the subcommand's own argv. Deliberately its own tiny parser rather than
 * bin/aegiscode.js's: the top-level parser owns the one-shot/session flags, and
 * a queue task's text must survive untouched (`aegiscode autonomous add "fix
 * --json in the parser"` is a task, not a flag).
 */
function parseFlags(argv) {
  const opts = { terms: [], json: false, flags: {} };
  const takesValue = new Set(['cwd', 'model', 'effort', 'workers', 'max', 'max-rounds', 'source']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      opts.json = true;
      continue;
    }
    if (a.startsWith('--')) {
      const [rawName, inline] = a.slice(2).split('=');
      const name = rawName.trim();
      const bools = new Set(['commit', 'all', 'auto', 'stop-on-error', 'single-pass', 'help']);
      if (bools.has(name)) {
        opts.flags[name] = true;
        continue;
      }
      if (!takesValue.has(name)) throw new Error(`unknown option: --${name}`);
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      opts.flags[name] = value;
      continue;
    }
    opts.terms.push(a);
  }
  return opts;
}

/** `--max-rounds` / `--max-rounds=`: both spellings, one number. */
function intFlag(flags, name) {
  const raw = flags[name];
  if (raw === undefined || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The row a human reads for one queued task. */
function taskLine(item) {
  const model = item.model || '(default)';
  const status = String(item.status || '?').padEnd(7);
  const at = `#${item.id}`.padEnd(4);
  const task = String(item.task || '').replace(/\s+/g, ' ').trim();
  const clipped = task.length > 72 ? `${task.slice(0, 71)}…` : task;
  return `${at} ${status} ${model} ${clipped}`;
}

function describeCounts(items) {
  const counts = { pending: 0, running: 0, done: 0, error: 0 };
  for (const i of items) if (counts[i.status] !== undefined) counts[i.status] += 1;
  return counts;
}

/**
 * Human summary of a drain, from the outcomes the worker returned. Reported per
 * task, because the one thing a timer's log has to answer is "which task
 * failed, and why".
 */
function printRunReport(ran, io) {
  for (const r of ran) {
    const mark = r.ok ? '✓' : '✗';
    io.stdout.write(`aegiscode: ${mark} #${r.id} ${r.ok ? 'done' : 'failed'} (${fmtElapsed(r.ms)})`);
    if (r.commit && r.commit.ok && r.commit.staged) {
      io.stdout.write(` — committed ${r.commit.staged} path(s)`);
    } else if (r.commit && r.commit.skipped && r.commit.reason) {
      io.stdout.write(` — no commit (${r.commit.reason})`);
    }
    io.stdout.write('\n');
    if (!r.ok && r.error) io.stderr.write(`aegiscode: #${r.id}: ${r.error}\n`);
    if (r.ok && r.output) {
      const text = String(r.output).trim();
      // The report the task wrote, kept to a readable length: a drain's log is
      // read by a human deciding whether to trust the run.
      io.stdout.write(`${text.length > 4000 ? `${text.slice(0, 4000)}\n… [output clipped]` : text}\n`);
    }
  }
}

/**
 * The engine for an unattended turn: the CLI's own engine wrapper, with the
 * approval gate pinned OFF.
 *
 * Not a nicety — a requirement of the task. There is nobody to click a card in
 * a drain, and the engine's own answer to an unanswered card is to refuse the
 * tool, so a gated drain would either hang the task or silently do nothing.
 * `autonomous.js` still watches for an approval frame and fails the task
 * loudly, which is how a future caller who forgets this gets told.
 */
function buildEngine({ io, quiet = false }) {
  const credentials = require('./credentials.js');
  const client = require('./deps.js').createClient(credentials.clientOptions());
  if (!client.apiKey) {
    return { error: `no AEGIS account key — ${credentials.HOW_TO_SET}, or set $${credentials.KEY_ENV}` };
  }
  const engine = createEngine({ client, getConfirmMode: () => false });
  return { client, engine };
}

/** A progress sink for a headless drain: one line per step, never a chat delta. */
function progressSink(io, { json }) {
  if (json) return () => {};
  return (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'start') {
      io.stdout.write(`aegiscode: #${event.taskId} running on ${event.model} in ${event.cwd}\n`);
      return;
    }
    if (event.type === 'tool' && event.tool && event.tool.phase === 'run') {
      const args = event.tool.args || {};
      const what = args.command || args.path || args.pattern || '';
      io.stderr.write(`  ⚙ ${event.tool.name} ${String(what).slice(0, 100)}\n`);
      return;
    }
    if (event.type === 'healed') {
      io.stdout.write(`aegiscode: PLAN.md status list healed for phase(s) ${event.phases.join(', ')}\n`);
      return;
    }
    if (event.type === 'recovered') {
      io.stdout.write(`aegiscode: re-queued task(s) ${event.ids.join(', ')} from a dead worker\n`);
    }
  };
}

/**
 * Run one queue subcommand.
 *
 * @param {string} command  add|list|run|proceed|reconcile|clear|retry
 * @param {string[]} argv   the subcommand's own arguments
 * @param {{stdout:any,stderr:any,json?:boolean}} io
 * @returns {Promise<number>} process exit code
 */
async function runQueueCommand(command, argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const out = { stdout, stderr };

  let args;
  try {
    args = parseFlags(argv || []);
  } catch (e) {
    stderr.write(`aegiscode autonomous: ${e.message}\n`);
    return 2;
  }
  const json = Boolean(io.json || args.json);
  const emit = (payload, text) => {
    if (json) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else if (text !== undefined) stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  };

  if (command === 'help' || !SUBCOMMANDS.has(command)) {
    stdout.write(usageText());
    return command === 'help' ? 0 : 2;
  }

  const cwd = args.flags.cwd ? path.resolve(String(args.flags.cwd)) : process.cwd();

  if (command === 'add') {
    const task = args.terms.join(' ').trim();
    if (!task) {
      stderr.write('aegiscode autonomous add: a task needs text — `aegiscode autonomous add "…"`\n');
      return 2;
    }
    let item;
    try {
      item = queue.addTask(process.env, {
        task,
        cwd,
        model: args.flags.model || null,
        effort: args.flags.effort || null,
        workers: intFlag(args.flags, 'workers'),
        maxRounds: intFlag(args.flags, 'max-rounds'),
        singlePass: Boolean(args.flags['single-pass']),
        commit: Boolean(args.flags.commit),
        source: args.flags.source || 'cli',
      });
    } catch (e) {
      stderr.write(`aegiscode autonomous add: ${e.message}\n`);
      return 2;
    }
    emit({ ok: true, id: item.id, item, queue: queue.queuePath(process.env) },
      `aegiscode: queued #${item.id} — ${queue.pendingCount(queue.loadQueue(process.env))} pending`);
    return 0;
  }

  if (command === 'list') {
    const items = queue.loadQueue(process.env);
    const counts = describeCounts(items);
    if (json) {
      emit({ ok: true, file: queue.queuePath(process.env), counts, tasks: items, runs: queue.readRuns(process.env, { limit: 10 }) });
    } else {
      stdout.write(`queue: ${queue.queuePath(process.env)}\n`);
      stdout.write(`tasks: ${items.length} (${counts.pending} pending, ${counts.running} running, ${counts.done} done, ${counts.error} error)\n`);
      for (const item of items) stdout.write(`${taskLine(item)}\n`);
      if (!items.length) stdout.write('(empty)\n');
    }
    return 0;
  }

  if (command === 'clear') {
    const res = queue.clearQueue(process.env, { all: Boolean(args.flags.all) });
    emit({ ok: true, ...res }, `aegiscode: removed ${res.removed} finished task(s); ${res.kept} kept`);
    return 0;
  }

  if (command === 'retry') {
    const id = args.terms[0];
    if (!id) {
      stderr.write('aegiscode autonomous retry: which task? `aegiscode autonomous retry <id>`\n');
      return 2;
    }
    const item = queue.retryTask(process.env, id);
    if (!item) {
      stderr.write(`aegiscode autonomous retry: no task #${id}\n`);
      return 1;
    }
    emit({ ok: true, id: item.id, item }, `aegiscode: #${item.id} is pending again`);
    return 0;
  }

  // ── the three commands that need a model ─────────────────────────────────
  const built = buildEngine({ io });
  if (built.error) {
    stderr.write(`aegiscode autonomous: ${built.error}\n`);
    return 2;
  }
  const worker = autonomous.createQueueWorker({
    engine: built.engine,
    env: process.env,
    log: progressSink(out, { json }),
  });
  const commit = args.flags.commit ? true : undefined;
  const onSigint = () => {
    // Ctrl-C stops the RUNNING turn, not the process: the task is settled back
    // to `error` with a reason, so the queue does not keep a `running` item
    // whose worker is gone.
    const items = queue.loadQueue(process.env);
    const running = items.find((i) => i.status === 'running' && i.pid === process.pid);
    if (running) worker.cancel(running.id);
  };
  process.on('SIGINT', onSigint);

  try {
    if (command === 'reconcile') {
      const res = await worker.reconcile({
        cwd,
        auto: Boolean(args.flags.auto),
        commit,
        max: intFlag(args.flags, 'max') || 0,
        stopOnError: Boolean(args.flags['stop-on-error']),
      });
      if (!json) printRunReport(res.ran || [], out);
      emit(res, res.exhausted
        ? 'aegiscode: every phase in PLAN.md is done — nothing to queue'
        : `aegiscode: phase ${res.phase} queued${res.ran ? ` — ${res.ran.length} task(s) run` : ''}`);
      return res.ok ? 0 : 1;
    }

    if (command === 'proceed' || command === 'run') {
      const max = command === 'run' ? 1 : intFlag(args.flags, 'max') || 0;
      const res = await worker.proceed({
        commit,
        max,
        stopOnError: Boolean(args.flags['stop-on-error']),
      });
      if (res.locked) {
        stderr.write(
          `aegiscode autonomous: another drain holds the queue lock (pid ${res.holder && res.holder.pid})\n`
        );
        emit({ ok: false, locked: true, holder: res.holder }, undefined);
        return 1;
      }
      if (!json) printRunReport(res.ran, out);
      const failed = res.ran.filter((r) => !r.ok).length;
      emit(
        { ok: failed === 0, ran: res.ran.map((r) => ({ id: r.id, ok: r.ok, error: r.error || null, ms: r.ms })), failed },
        res.ran.length
          ? `aegiscode: ${res.ran.length} task(s) run${failed ? `, ${failed} failed` : ''}`
          : 'aegiscode: nothing pending'
      );
      return failed ? 1 : 0;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  stdout.write(usageText());
  return 2;
}

/** The one place this surface is documented, printed by `help` and on misuse. */
function usageText() {
  return [
    'aegiscode autonomous <command> — the unattended work queue',
    '',
    'Commands:',
    '  add "<task>"          queue a task (--cwd, --model, --effort, --commit,',
    '                        --single-pass, --workers N, --max-rounds N)',
    '  list                  show queued tasks and the tail of the runs log',
    '  run                   drain ONE task, then stop',
    '  proceed               drain every pending task (--max N, --stop-on-error, --commit)',
    '  reconcile             queue the next unfinished PLAN.md phase (--auto drains it)',
    '  retry <id>            put a finished task back in the queue',
    '  clear                 drop finished tasks (--all empties the queue)',
    '',
    'Options:',
    '  --json                emit JSON instead of text (also on add/list/clear/retry)',
    '',
    'A drain runs with tool approval DISABLED (nobody is there to click a card),',
    'one task at a time, and commits only the paths the task itself changed.',
  ].join('\n') + '\n';
}

module.exports = { runQueueCommand, parseFlags, taskLine, usageText, SUBCOMMANDS };
