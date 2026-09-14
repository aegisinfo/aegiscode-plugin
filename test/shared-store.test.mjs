#!/usr/bin/env node
/**
 * One local session store for every host.
 *
 * Before this change the repo kept two private stores — the terminal host's
 * `~/.aegiscode/history.jsonl` and the desktop's `<userData>/sessions.json` —
 * so a conversation typed in one host only reached the other after a cloud
 * round trip, and could not reach it at all offline or on an account with no
 * key. `client/session-store.js` is now the single store both read and write.
 *
 * Every section below is a property of *that* claim, exercised through the real
 * modules (never a copy of the logic):
 *
 *   A  the desktop writes, the CLI reads it back (cross-host, no cloud)
 *   B  the CLI writes, the desktop reads it back
 *   C  /resume lists a session once, not once per store
 *   D  a pre-unification userData store is adopted, one way, once
 *   E  the desktop's session dir IS the shared dir ($AEGISCODE_HOME)
 *   F  store invariants: 0600, bounded, no bookkeeping key leaking as a session
 */
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, statSync, existsSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// AEGISCODE_HOME must be set before any module resolves a path.
const home = mkdtempSync(join(tmpdir(), 'aegis-shared-home-'));
const legacy = mkdtempSync(join(tmpdir(), 'aegis-shared-legacy-'));
process.env.AEGISCODE_HOME = home;

const store = require('../client/session-store.js');
const desktopSessions = require('../desktop/lib/sync/sessions.js');
const credentials = require('../client/credentials.js');

// ── A. desktop writes → the CLI sees it ────────────────────────────────────
desktopSessions.upsertSession(home, { id: 'gui-1', title: 'typed in the GUI' });
desktopSessions.appendMessage(home, 'gui-1', { role: 'user', content: 'hello from the window' });
desktopSessions.appendMessage(home, 'gui-1', { role: 'assistant', content: 'and back' });

// history.js reads the shared store for sessions its own ledger has never seen.
const history = require('../cli/src/history.js');
const fromCli = history.readSessionTranscript('gui-1');
assert(fromCli.length === 2, `CLI reads the desktop transcript, got ${fromCli.length} rows`);
assert(fromCli[0].text === 'hello from the window', `user turn carried over: ${fromCli[0].text}`);
assert(fromCli[1].text === 'and back', `assistant turn carried over: ${fromCli[1].text}`);

const resume = history.readResumeList(8);
assert(resume.some((r) => r.id === 'gui-1'), `a desktop session is resumable from the CLI: ${JSON.stringify(resume)}`);

// ── B. CLI writes → the desktop sees it ────────────────────────────────────
history.appendHistory({
  sessionId: 'cli-1',
  prompt: 'typed in the terminal',
  reply: 'answer',
  status: 'done',
  usage: { input: 100, output: 20, real: true },
});

const listed = desktopSessions.listSessions(home);
const mirrored = listed.find((s) => s.id === 'cli-1');
assert(mirrored, `the desktop store lists a CLI session: ${listed.map((s) => s.id)}`);
assert(mirrored.messages.length === 2, `mirrored as a user/assistant pair, got ${mirrored.messages.length}`);
assert(mirrored.messages[0].content === 'typed in the terminal', 'mirrored user turn');
assert(mirrored.origin === 'aegiscode-cli', `origin recorded, got ${mirrored.origin}`);
// Deliberate: the CLI keeps its own sync ledger, so a terminal turn must not
// enrol itself in the desktop's push queue (and spend synced-token quota).
assert(mirrored.pending === false, 'a mirrored CLI session is not a desktop push candidate');
assert(mirrored.messages[1].tokens && mirrored.messages[1].tokens.input === 100, 'live usage carried into the store');

// ── C. one session, listed once ────────────────────────────────────────────
const ids = history.readResumeList(20).map((r) => r.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
assert(dupes.length === 0, `no session listed twice: ${JSON.stringify(ids)}`);
assert(ids.includes('cli-1') && ids.includes('gui-1'), `both hosts represented: ${JSON.stringify(ids)}`);
// history.jsonl stays the CLI's own ledger, with the record /cost aggregates.
assert(existsSync(join(home, 'history.jsonl')), 'the CLI ledger is still written');
const cost = history.aggregateSessionUsage('cli-1');
assert(cost.entries === 1 && cost.usage.input === 100, 'the CLI ledger still carries token accounting');

// ── D. adopt a pre-unification store, one way, once ────────────────────────
const legacyDir = join(legacy, 'userData');
const freshDir = join(legacy, 'shared');
mkdirSync(legacyDir, { recursive: true });
writeFileSync(
  join(legacyDir, 'sessions.json'),
  JSON.stringify({ __seq: 7, 'old-1': { id: 'old-1', title: 'pre-upgrade', messages: [{ role: 'user', content: 'before' }], updatedAt: 1 } })
);

const adopted = store.adopt(freshDir, legacyDir);
assert(adopted.adopted === true, `legacy store adopted: ${JSON.stringify(adopted)}`);
assert(adopted.sessions === 1, `one legacy session adopted, got ${adopted.sessions}`);
assert(store.getSession(freshDir, 'old-1') !== null, 'the adopted session is readable');
assert(existsSync(join(legacyDir, 'sessions.json')), 'the legacy file is left in place for a downgrade');

// Adopting again is a no-op — it never merges over live sessions.
store.upsertSession(freshDir, { id: 'live-1', title: 'after upgrade' });
const again = store.adopt(freshDir, legacyDir);
assert(again.adopted === false, `second adopt refuses: ${JSON.stringify(again)}`);
assert(store.getSession(freshDir, 'live-1') !== null, 'the live store survives a re-adopt');

// ── E. the desktop's session dir is the shared dir ─────────────────────────
const resolved = desktopSessions.resolveStoreDir(join(legacy, 'userData'));
assert(resolved === home, `desktop sessions resolve to AEGISCODE_HOME, got ${resolved}`);
assert(
  desktopSessions.sessionsFile(resolved) === join(home, 'sessions.json'),
  'the desktop writes the shared sessions.json'
);
assert(
  credentials.credentialsPath() === join(home, 'credentials.json'),
  'credentials resolve to the same data dir (one account, one home)'
);

// ── F. store invariants ────────────────────────────────────────────────────
const mode = statSync(join(home, 'sessions.json')).mode & 0o777;
assert(mode === 0o600, `store is 0600, got 0${mode.toString(8)}`);
const raw = JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8'));
assert(typeof raw.__seq === 'number', 'the write counter is still maintained');
// The reader must not hand `__seq` back as if it were a session: a picker that
// iterates the file directly renders a row with no id and no summary.
assert(
  store.listSessions(home).every((s) => s && s.id),
  `no bookkeeping entry is exposed as a session: ${JSON.stringify(store.listSessions(home).map((s) => s.id))}`
);

// Bounded: a long session is trimmed rather than growing without limit.
const bigDir = mkdtempSync(join(tmpdir(), 'aegis-shared-big-'));
for (let i = 0; i < 60; i++) {
  store.recordExchange(bigDir, { sessionId: 'long', prompt: `p${i}`, reply: `r${i}`, origin: 'test' });
}
assert(store.getSession(bigDir, 'long').messages.length === 120, 'messages accumulate while under the cap');
const smallDir = mkdtempSync(join(tmpdir(), 'aegis-shared-small-'));
for (let i = 0; i < 1400; i++) {
  store.recordExchange(smallDir, { sessionId: 'huge', prompt: `p${i}`, reply: `r${i}`, origin: 'test' });
}
const capped = store.getSession(smallDir, 'huge');
assert(
  capped.messages.length === store.MAX_MESSAGES_PER_SESSION,
  `a runaway session is capped at ${store.MAX_MESSAGES_PER_SESSION}, got ${capped.messages.length}`
);
assert(capped.messages[capped.messages.length - 1].content === 'r1399', 'the newest turn survives the trim');

// A missing/corrupt store is {} — never a throw on a launch path.
writeFileSync(join(smallDir, 'sessions.json'), '{ not json');
assert(Object.keys(store.load(smallDir)).length === 0, 'a corrupt store loads as empty');

rmSync(home, { recursive: true, force: true });
rmSync(legacy, { recursive: true, force: true });

console.log('shared session store tests passed');
