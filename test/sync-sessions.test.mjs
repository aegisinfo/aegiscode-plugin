#!/usr/bin/env node
/** Unit tests for desktop/lib/sync/sessions.js (plan P1 §5.1 / P3 §7). */
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  sessionsFile,
  upsertSession,
  appendMessage,
  listSessions,
  getSession,
  deleteSession,
  markSynced,
  markPending,
  listPending,
  mergeRemoteSessions,
} = require('../desktop/lib/sync/sessions.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const dir = mkdtempSync(join(tmpdir(), 'aegis-sessions-'));

// upsert + append round-trip
const created = upsertSession(dir, { id: 's1', title: 'ollama chat' });
assert(created.id === 's1', 'upsert returns the id');
assert(created.title === 'ollama chat', 'upsert merges fields');

appendMessage(dir, 's1', { role: 'user', content: 'hello' });
appendMessage(dir, 's1', { role: 'assistant', content: 'world' });

const got = getSession(dir, 's1');
assert(got.messages.length === 2, 'two messages appended');
assert(got.messages[1].content === 'world', 'second message preserved');
assert(typeof got.updatedAt === 'number', 'updatedAt stamped');

// crash-safe write: file exists, no temp file left behind
assert(existsSync(sessionsFile(dir)), 'sessions.json written');

// list ordering by updatedAt (newest first)
upsertSession(dir, { id: 's2', title: 'newer' });
const list = listSessions(dir);
assert(list[0].id === 's2', 'newest session first');

// delete
deleteSession(dir, 's1');
assert(getSession(dir, 's1') === null, 'deleted session gone');

// load() on a missing file returns {} without throwing
const { load } = require('../desktop/lib/sync/sessions.js');
assert(Object.keys(load(join(dir, 'nope'))).length === 0, 'missing file -> {}');

// pending-queue + markSynced round-trip (plan P3 §7 cloud sync).
const pdir = mkdtempSync(join(tmpdir(), 'aegis-sessions-pending-'));
const p1 = upsertSession(pdir, { id: 'p1', title: 'first' });
assert(p1.pending === true, 'a new session starts pending');
appendMessage(pdir, 'p2', { role: 'user', content: 'hi' });
assert(listPending(pdir).length === 2, 'both sessions are pending after local writes');

const synced = markSynced(pdir, 'p1', { remoteId: 'remote-p1' });
assert(synced.pending === false, 'markSynced clears the pending flag');
assert(synced.remoteId === 'remote-p1', 'markSynced stashes the remote id');
assert(typeof synced.lastSyncedAt === 'number', 'markSynced stamps lastSyncedAt');
assert(listPending(pdir).length === 1, 'only the un-synced session remains pending');
assert(listPending(pdir)[0].id === 'p2', 'p2 is still queued');

appendMessage(pdir, 'p1', { role: 'assistant', content: 'more' });
assert(listPending(pdir).length === 2, 'a fresh local write re-marks a synced session pending');

const repending = markPending(pdir, 'p2');
assert(repending.pending === true, 'markPending forces a session back into the queue');
assert(markSynced(pdir, 'missing') === null, 'markSynced on an unknown id is a no-op, not a throw');
assert(markPending(pdir, 'missing') === null, 'markPending on an unknown id is a no-op, not a throw');

// mergeRemoteSessions: remote wins when there is no local copy or no local
// pending edits; a locally-pending session is left alone (it will push instead).
markSynced(pdir, 'p1');
const merged = mergeRemoteSessions(pdir, [
  { session_id: 'r1', title: 'remote only', messages: [{ role: 'user', content: 'x' }], updated_at: Date.now() },
  { session_id: 'p2', title: 'should be skipped', messages: [], updated_at: Date.now() + 10000 },
]);
assert(merged === 1, 'only the non-conflicting remote session is merged');
assert(getSession(pdir, 'r1').title === 'remote only', 'new remote session rehydrated locally');
assert(getSession(pdir, 'r1').pending === false, 'a merged remote session is not itself pending');
assert(getSession(pdir, 'p2').title !== 'should be skipped', 'a locally-pending session is not overwritten by a stale-looking remote copy');
assert(mergeRemoteSessions(pdir, []) === 0, 'merging an empty list is a no-op');
assert(mergeRemoteSessions(pdir, [{ title: 'no id' }]) === 0, 'a remote record with no session_id/id is skipped');

console.log('sessions tests passed');
