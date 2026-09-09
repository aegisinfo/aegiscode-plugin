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

/** Create or merge a full session record. */
function upsertSession(dir, session) {
  const id = session && session.id;
  if (!id) throw new Error('session.id is required');
  const sessions = load(dir);
  const prev = sessions[id] || { messages: [] };
  sessions[id] = { ...prev, ...session, id };
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

module.exports = {
  sessionsFile,
  load,
  save,
  upsertSession,
  appendMessage,
  listSessions,
  getSession,
  deleteSession,
};
