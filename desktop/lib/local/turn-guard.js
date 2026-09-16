'use strict';

/**
 * Turn-start foreign-write detection.
 *
 * Ported from aegiscodex-dev/src/turn-guard.js (ESM → CommonJS).
 *
 * Bug this exists for: the commit-time scope check already knew how to tell
 * "my changes" from "somebody else's in-flight work" — but only *after* a
 * task had finished. The dangerous window is the opposite end: a session
 * reads a file, time passes, a second agent edits that file, and the first
 * session then acts on a stale mental model. That is how a live session
 * destroyed a peer's work — the content it reverted was real and correct,
 * just not the content it had read.
 *
 * `git checkout HEAD -- <file>`, `git reset --hard`, `git stash` and
 * `git clean` are the destructive operations, and their default scope is the
 * whole tree. Running any of them while a peer has uncommitted work is the
 * entire incident.
 *
 * Fix: snapshot the dirty set at turn start, record the paths this session
 * actually writes, then answer two questions on demand —
 *   `foreignSince()` / `concurrentSince()`   whose work is in the tree
 *   `blocksDestructive()`                    would a given command clobber it
 * The second is load-bearing: it turns "revert someone else's file" into a
 * refusal, which is the cheapest place to stop it.
 *
 * This is detection, not prevention — it cannot stop a writer outside the
 * host. Paired with worktree-lock.js it covers our own sessions.
 */

const { gitRoot, gitStatusSnapshot } = require('./git-scope.js');

/** Git's own flags that consume the *next* argv entry, so that token is not
 * the subcommand. Without this, `git -C /repo reset --hard` parses `reset`
 * as a flag argument and the whole command reads as harmless. */
const GIT_FLAGS_WITH_ARG = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path',
]);

/** Split a command line into shell segments and then argv, stripping quotes.
 * Segmenting on `&&`/`;`/`|` means `ls && git checkout -- a` is still caught,
 * while `git stash list` is judged on its own segment. */
function tokenize(command) {
  const out = [];
  for (const segment of String(command || '').split(/[|;&\n]+/)) {
    const argv = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(segment))) argv.push(m[1] ?? m[2] ?? m[3]);
    if (argv.length) out.push(argv);
  }
  return out;
}

/** The git subcommand and its arguments in one argv, or null if this argv
 * isn't a git invocation that has a subcommand. */
function gitInvocation(argv) {
  const i = argv.findIndex((t) => t === 'git' || t.endsWith('/git'));
  if (i === -1) return null;
  let j = i + 1;
  while (j < argv.length && argv[j].startsWith('-')) {
    j += GIT_FLAGS_WITH_ARG.has(argv[j]) ? 2 : 1;
  }
  if (j >= argv.length) return null;
  return { sub: argv[j], args: argv.slice(j + 1) };
}

/** Positional arguments (the paths a command names), dropping flags. Values
 * after `--` are always paths; before it, anything not starting with `-` is
 * taken as one, which is right for checkout/restore and harmlessly unused
 * elsewhere. */
function namedPaths(args) {
  const sep = args.indexOf('--');
  if (sep !== -1) return args.slice(sep + 1).filter((a) => !a.startsWith('-'));
  return args.filter((a) => !a.startsWith('-'));
}

const isTreeMark = (p) => p === '.' || p === './' || p === '*' || p === './*';
const hasForce = (args) => args.some((a) => a === '-f' || a === '--force' || /^-[a-zA-Z]*f/.test(a));

/** subcommand -> { what, scope } where scope is 'tree' (discards broadly) or
 * 'paths' (discards only the paths it names). Returns null when harmless. */
function judge(sub, args) {
  const paths = namedPaths(args);
  const treeWide = paths.length === 0 || paths.some(isTreeMark);
  switch (sub) {
    case 'checkout':
      if (args.includes('--') || hasForce(args)) {
        return { what: 'checkout of uncommitted changes', scope: treeWide ? 'tree' : 'paths', paths };
      }
      // `git checkout .` restores the whole tree; a bare branch switch is safe.
      if (treeWide && paths.length) return { what: 'checkout . (tree-wide restore)', scope: 'tree', paths };
      return null;
    case 'restore':
      return { what: 'restore (discards uncommitted changes)', scope: treeWide ? 'tree' : 'paths', paths };
    case 'reset':
      return args.includes('--hard') ? { what: 'reset --hard', scope: 'tree', paths: [] } : null;
    case 'clean':
      return hasForce(args) ? { what: 'clean -f (deletes untracked files)', scope: 'tree', paths: [] } : null;
    case 'stash': {
      const first = args.find((a) => !a.startsWith('-'));
      if (first === 'list' || first === 'show') return null;
      // pop/apply can conflict with, and push parks, every path in the tree.
      return { what: `stash ${first || 'push'} (uncommitted changes across the tree)`, scope: 'tree', paths: [] };
    }
    case 'worktree': {
      const first = args.find((a) => !a.startsWith('-'));
      return first === 'remove' || first === 'prune'
        ? { what: `worktree ${first}`, scope: 'tree', paths: [] }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Classify a shell command line. Returns
 * `{destructive:false}` or `{destructive:true, what, scope:'tree'|'paths', paths}`.
 *
 * Parsed as argv rather than matched as text, because a message *about* a
 * destructive command is not one: `git commit -m "fix stash handling"` must
 * not read as a stash. Quoting is handled, so the two are actually different.
 */
function classifyDestructive(command) {
  for (const argv of tokenize(command)) {
    const inv = gitInvocation(argv);
    if (!inv) continue;
    const verdict = judge(inv.sub, inv.args);
    if (verdict) return { destructive: true, ...verdict };
  }
  return { destructive: false };
}

/**
 * Begin guarding a turn in `cwd`. Costs one `git status`; a non-repo (or a
 * git failure) yields a guard that reports nothing, so callers never have to
 * branch on whether the guard is armed.
 */
function beginTurnGuard(cwd) {
  const root = gitRoot(cwd);
  const before = root ? gitStatusSnapshot(cwd) : null;
  return {
    root,
    cwd,
    before,
    startedAt: Date.now(),
    written: new Set(),
    active: Boolean(root && before),
  };
}

/** Normalise a written path to root-relative, so it can be compared against
 * porcelain output. Accepts absolute or relative paths. */
function toRel(guard, p) {
  let s = String(p || '');
  if (!s) return null;
  if (guard.root && s.startsWith(guard.root)) {
    s = s.slice(guard.root.length).replace(/^[/\\]/, '');
  }
  return s.split('\\').join('/');
}

/**
 * Record a path this session itself wrote. A recorded path is never reported
 * as foreign — this is what keeps the guard from crying wolf about the
 * caller's own edits, and it is why the host's file tools must call it.
 */
function recordWrite(guard, p) {
  if (!guard || !guard.active) return;
  const rel = toRel(guard, p);
  if (rel) guard.written.add(rel);
}

/**
 * Paths that are *unambiguously* a peer's in-flight work: dirty when the turn
 * started, byte-identical now, and never written by this session.
 *
 * "Dirty before and still identical" is what makes this confident — a path
 * nobody touched is dirty *because* it belongs to someone else. It is
 * git-scope's own definition, which is why the two modules agree.
 */
function foreignSince(guard) {
  if (!guard || !guard.active) return [];
  const now = gitStatusSnapshot(guard.cwd);
  if (!now) return [];
  const out = [];
  for (const [p, hash] of now) {
    if (guard.written.has(p)) continue;
    if (guard.before.has(p) && guard.before.get(p) === hash) out.push(p);
  }
  return out.sort();
}

/**
 * Paths clean at turn start and dirty now, excluding any this session
 * recorded writing.
 *
 * Weaker than `foreignSince` because attribution is incomplete: the host's
 * file tools call `recordWrite`, but a path a shell command creates
 * (`> out.txt`, `npm install`) is invisible here and can be mistaken for a
 * peer's. Still reported, and still consulted by `blocksDestructive` — see
 * the asymmetry note there.
 */
function concurrentSince(guard) {
  if (!guard || !guard.active) return [];
  const now = gitStatusSnapshot(guard.cwd);
  if (!now) return [];
  const out = [];
  for (const [p] of now) {
    if (guard.written.has(p)) continue;
    if (!guard.before.has(p)) out.push(p);
  }
  return out.sort();
}

/**
 * Would running `command` be unsafe right now? Returns `{ok:true}` or
 * `{ok:false, what, scope, reason, foreign, unattributed}`.
 *
 * Scope decides what has to be at risk:
 *  - a *tree-wide* op (`git reset --hard`, `git stash`, `git checkout .`) is
 *    refused whenever any peer work is present, because it cannot help but
 *    touch it;
 *  - a *path-scoped* op is refused only when one of the paths it names is
 *    actually foreign, so reverting your own file still works while a peer
 *    happens to be editing a different one.
 *
 * Both signals count, because the risk is asymmetric: a refusal costs the
 * caller one step (name the paths, or take the lock), while a miss destroys
 * work that may exist nowhere else. In the incident this module exists for,
 * the peer's files appeared *during* the turn, so the confident signal was
 * empty — blocking on it alone would have missed the exact case that
 * motivated the guard.
 *
 * A tree with nothing foreign is never blocked, so a solo session is never
 * wedged: the module is inert unless somebody else's work is present.
 */
function blocksDestructive(guard, command) {
  const verdict = classifyDestructive(command);
  if (!verdict.destructive) return { ok: true };
  if (!guard || !guard.active) return { ok: true };

  let foreign = foreignSince(guard);
  let unattributed = concurrentSince(guard).filter((p) => !foreign.includes(p));

  let atRisk = [];
  if (verdict.scope === 'tree') {
    atRisk = [...foreign, ...unattributed];
  } else {
    const named = new Set(verdict.paths.map((p) => p.replace(/^\.\//, '')));
    const hits = (list) => list.filter((p) => named.has(p) || named.has('./' + p));
    foreign = hits(foreign);
    unattributed = hits(unattributed);
    atRisk = [...foreign, ...unattributed];
  }
  if (!atRisk.length) return { ok: true, what: verdict.what };

  const parts = [];
  if (foreign.length) {
    parts.push(
      `${foreign.length} hold another agent's uncommitted work: `
      + foreign.slice(0, 8).join(', ') + (foreign.length > 8 ? ` (+${foreign.length - 8} more)` : ''),
    );
  }
  if (unattributed.length) {
    parts.push(
      `${unattributed.length} changed since this turn began and were not written by `
      + `this session: ${unattributed.slice(0, 8).join(', ')}`
      + (unattributed.length > 8 ? ` (+${unattributed.length - 8} more)` : ''),
    );
  }
  return {
    ok: false,
    what: verdict.what,
    scope: verdict.scope,
    foreign,
    unattributed,
    reason:
      `refusing \`${verdict.what}\` in ${guard.root}: `
      + (verdict.scope === 'tree'
        ? 'it is tree-scoped and would discard work it did not create — '
        : 'it targets a path that is not yours to discard — ')
      + parts.join('; ')
      + '. Name only the paths you mean, or take the worktree lock first.',
  };
}

module.exports = {
  classifyDestructive,
  beginTurnGuard,
  recordWrite,
  foreignSince,
  concurrentSince,
  blocksDestructive,
};
