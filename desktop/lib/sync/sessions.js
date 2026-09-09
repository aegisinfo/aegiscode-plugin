'use strict';

/**
 * sessions.js — local conversation persistence (plan P1 §5.1 / P3 §7).
 * Every session (any model class) persists to <dir>/sessions.json on each
 * message with a crash-safe temp-file rename. Pure Node + injectable dir,
 * so it unit-tests without Electron.
 */

const fs = require('node:fs');
const path = require('node:path');

function sessionsFile(dir) {
  return path.join(dir, 'sessions.json');
}

function load(dir) {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile(dir), 'utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * Monotonic write counter stored in the file's `__seq` field. Every mutation
 * bumps it, so sessions written in the same millisecond still order
 * deterministically (listSessions sorts by updatedAt, then by seq).
 */
function nextSeq(sessions) {
  const seq = (typeof sessions.__seq === 'number' ? sessions.__seq : 0) + 1;
  sessions.__seq = seq;
  return seq;
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function save(dir, sessions) {
  atomicWrite(sessionsFile(dir), sessions);
}

/**
 * Create or merge a full session record. Any local write (`upsertSession` /
 * `appendMessage`) marks the session `pending: true` — it has local content
 * the cloud hasn't seen yet. Only `markSynced()` clears the flag, so a push
 * that fails (offline/no key) never silently drops the session from the
 * retry queue.
 */
function upsertSession(dir, session) {
  const id = session && session.id;
  if (!id) throw new Error('session.id is required');
  const sessions = load(dir);
  const prev = sessions[id] || { messages: [] };
  sessions[id] = { ...prev, ...session, id, pending: true };
  if (!sessions[id].updatedAt) sessions[id].updatedAt = Date.now();
  sessions[id].seq = nextSeq(sessions);
  save(dir, sessions);
  return sessions[id];
}

/** Append one message to a session (crash-safe). */
function appendMessage(dir, sessionId, message) {
  if (!sessionId) throw new Error('sessionId is required');
  const sessions = load(dir);
  const session = sessions[sessionId] || { id: sessionId, messages: [] };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  session.messages = messages.concat(message);
  session.updatedAt = Date.now();
  session.pending = true;
  session.seq = nextSeq(sessions);
  sessions[sessionId] = session;
  save(dir, sessions);
  return session;
}

function listSessions(dir) {
  const sessions = load(dir);
  return Object.values(sessions)
    .filter((s) => s && s.id)
    .sort(
      (a, b) =>
        (b.updatedAt || 0) - (a.updatedAt || 0) ||
        (b.seq || 0) - (a.seq || 0)
    );
}

function getSession(dir, id) {
  return load(dir)[id] || null;
}

function deleteSession(dir, id) {
  const sessions = load(dir);
  delete sessions[id];
  save(dir, sessions);
  return { ok: true };
}

/** Clear the pending flag after a successful cloud push. `remote.remoteId`,
 *  when the server assigns its own conversation id, is stashed alongside. */
function markSynced(dir, id, remote) {
  const sessions = load(dir);
  const session = sessions[id];
  if (!session) return null;
  session.pending = false;
  session.lastSyncedAt = Date.now();
  if (remote && remote.remoteId) session.remoteId = remote.remoteId;
  session.seq = nextSeq(sessions);
  sessions[id] = session;
  save(dir, sessions);
  return session;
}

/** Force a session back into the retry queue (e.g. a push that partially failed). */
function markPending(dir, id) {
  const sessions = load(dir);
  const session = sessions[id];
  if (!session) return null;
  session.pending = true;
  session.seq = nextSeq(sessions);
  sessions[id] = session;
  save(dir, sessions);
  return session;
}

/** Sessions with local content the cloud hasn't confirmed yet (including
 *  sessions predating this field, which default to pending). */
function listPending(dir) {
  return listSessions(dir).filter((s) => s.pending !== false);
}

/**
 * Merge remote conversation-sync records into the local store (pull half of
 * sync). Last-write-wins by `updatedAt`, but a local session with unsynced
 * edits (`pending`) always wins over the remote copy — it will overwrite the
 * remote copy on the next push instead.
 */
function mergeRemoteSessions(dir, remoteSessions) {
  const list = Array.isArray(remoteSessions) ? remoteSessions : [];
  const sessions = load(dir);
  let merged = 0;
  for (const remote of list) {
    const id = remote && (remote.session_id || remote.id);
    if (!id) continue;
    const local = sessions[id];
    const remoteUpdatedAt = remote.updated_at || remote.updatedAt || 0;
    if (local && (local.pending || (local.updatedAt || 0) >= remoteUpdatedAt)) {
      continue;
    }
    sessions[id] = {
      id,
      title: remote.title || (local && local.title) || '',
      messages: Array.isArray(remote.messages) ? remote.messages : [],
      updatedAt: remoteUpdatedAt || Date.now(),
      pending: false,
      lastSyncedAt: Date.now(),
      remoteId: remote.session_id || remote.id,
    };
    sessions[id].seq = nextSeq(sessions);
    merged += 1;
  }
  if (merged) save(dir, sessions);
  return merged;
}

module.exports = {
  sessionsFile,
  load,
  save,
  upsertSession,
  appendMessage,
  listSessions,
  getSession,
  deleteSession,
  markSynced,
  markPending,
  listPending,
  mergeRemoteSessions,
};
