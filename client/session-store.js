'use strict';

/**
 * session-store.js — the ONE local session/memory store shared by every AEGIS
 * host.
 *
 * Before this module the repo had two private stores:
 *
 *   CLI      ~/.aegiscode/history.jsonl   one line per exchange
 *   desktop  <userData>/sessions.json     one record per session
 *
 * Both hosts pushed "the same wire shape" to the cloud, so a session started in
 * the GUI reached the terminal only after a network round trip — and a CLI
 * session could not reach the GUI at all unless the account had cloud sync on.
 * Offline, or on an account with no key, the two hosts simply could not see each
 * other's work.
 *
 * This module is the single store they now both read and write:
 *
 *   <dir>/sessions.json   { __seq, "<id>": { id, title, messages[], ... } }
 *
 * `dir` is resolved by `aegisHome()` (client/credentials.js) — `$AEGISCODE_HOME`
 * or `~/.aegiscode` — so the desktop's *sessions* now live beside the CLI's and
 * the MCP plugin's view of the same account, while the desktop keeps its
 * settings (safeStorage-encrypted key, window state) in Electron's userData
 * where they belong.
 *
 * The record shape is the desktop's, extended — not replaced. Every field the
 * existing store wrote (`pending`, `seq`, `updatedAt`, `remoteId`,
 * `lastSyncedAt`, `__seq`) keeps its meaning, because the sync surface and the
 * renderer's session list read them.
 *
 * Pure Node + injectable dir, so it unit-tests without Electron or a network.
 */

const fs = require('node:fs');
const path = require('node:path');
const { aegisHome } = require('./credentials.js');

const STORE_FILE = 'sessions.json';
const STORE_VERSION = 2;
/** Bound on a single session's transcript, so one runaway session cannot make
 *  every later load of the store O(huge). Oldest messages drop first. */
const MAX_MESSAGES_PER_SESSION = 2000;

/** Where the store lives when the caller doesn't name a dir. */
function storeDir(dir) {
  return dir || aegisHome();
}

function storeFile(dir) {
  return path.join(storeDir(dir), STORE_FILE);
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

/**
 * Normalize a remote `updated_at`/`updatedAt` to epoch milliseconds. The cloud
 * returns an ISO-8601 string (e.g. "2026-07-16T14:20:00"); the local store
 * uses `Date.now()` epoch-ms numbers. Comparing the two directly coerces the
 * string to NaN, which breaks last-write-wins ordering. ISO strings are
 * parsed; epoch-ms numbers pass through; anything else becomes 0.
 */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function load(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

/**
 * Sessions as a JSON object without the `__seq` bookkeeping key. Callers that
 * iterate the store (the renderer's list, `/resume`) must not meet `__seq` as
 * if it were a session with an undefined id.
 */
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  // 0600: a transcript is private conversation content, and this file now holds
  // every host's sessions in one place.
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

function save(dir, sessions) {
  atomicWrite(storeFile(dir), sessions);
}

function trimMessages(messages) {
  if (!Array.isArray(messages)) return [];
  if (messages.length <= MAX_MESSAGES_PER_SESSION) return messages;
  return messages.slice(messages.length - MAX_MESSAGES_PER_SESSION);
}

/**
 * Create or merge a full session record. Any local write (`upsertSession` /
 * `appendMessage` / `recordExchange`) marks the session `pending: true` — it has
 * local content the cloud hasn't seen yet. Only `markSynced()` clears the flag,
 * so a push that fails (offline/no key) never silently drops the session from
 * the retry queue.
 */
function upsertSession(dir, session) {
  const id = session && session.id;
  if (!id) throw new Error('session.id is required');
  const sessions = load(dir);
  const prev = sessions[id] || { messages: [] };
  sessions[id] = { ...prev, ...session, id, version: STORE_VERSION };
  if (session.pending !== false) sessions[id].pending = true;
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
  session.messages = trimMessages(messages.concat(message));
  session.updatedAt = Date.now();
  session.pending = true;
  session.seq = nextSeq(sessions);
  sessions[sessionId] = session;
  save(dir, sessions);
  return session;
}

/**
 * Record one finished exchange (the CLI's unit of work) as a session with a
 * user/assistant message pair. This is what makes a terminal turn visible to
 * the desktop, which lists sessions out of this same file.
 *
 * `pending` defaults to **false** here, unlike `appendMessage`: the CLI keeps
 * its own sync ledger (`cli/src/cloudsync.js` derives pending from
 * `sync-state.json`) and pushes through `/sync`. Marking these pending would
 * enrol every terminal session in the *desktop's* push queue as a side effect
 * of typing in a shell, spending the account's synced-token quota without being
 * asked. `origin` records which host wrote the record so either side can filter.
 *
 * @returns {object|null} the session record, or null on unwritable storage
 */
function recordExchange(dir, exchange) {
  const e = exchange || {};
  if (!e.sessionId) return null;
  const sessions = load(dir);
  const id = e.sessionId;
  const session = sessions[id] || { id, messages: [] };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const ts = e.ts || new Date().toISOString();
  const userMessage = { role: 'user', content: e.prompt == null ? '' : String(e.prompt), ts };
  const assistantMessage = { role: 'assistant', content: e.reply == null ? '' : String(e.reply), ts };
  if (e.tokens) assistantMessage.tokens = e.tokens;
  if (typeof e.costUsd === 'number') assistantMessage.costUsd = e.costUsd;
  if (e.status) assistantMessage.status = e.status;
  if (e.origin) {
    userMessage.origin = e.origin;
    assistantMessage.origin = e.origin;
  }
  session.messages = trimMessages(messages.concat([userMessage, assistantMessage]));
  session.title = session.title || String(e.prompt || '').slice(0, 60);
  if (e.cwd) session.cwd = e.cwd;
  session.origin = e.origin || session.origin || 'unknown';
  session.updatedAt = Date.now();
  // Explicit, not merely "leave it unset": `listPending` treats an absent flag
  // as pending (sessions predating the field default to queued), so an
  // undefined here would quietly enrol every terminal session in the desktop's
  // push queue — the exact thing the `pending: false` default is for.
  session.pending = e.pending === true ? true : false;
  session.seq = nextSeq(sessions);
  sessions[id] = session;
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
    const remoteUpdatedAt = toEpochMs(remote.updated_at ?? remote.updatedAt);
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
      origin: remote.source || (local && local.origin) || 'cloud',
      version: STORE_VERSION,
    };
    sessions[id].seq = nextSeq(sessions);
    merged += 1;
  }
  if (merged) save(dir, sessions);
  return merged;
}

/**
 * Compact listing for a picker (`/resume`, the desktop's session list). Same
 * field names `history.js`'s readOwnSessions produced, so the two can be
 * concatenated without either side having to know which store a row came from.
 */
function listSummaries(dir, limit = 8) {
  return listSessions(dir)
    .slice(0, limit)
    .map((s) => {
      const messages = Array.isArray(s.messages) ? s.messages : [];
      const first = messages.find((m) => m && m.role === 'user');
      return {
        id: s.id,
        cwd: (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '~',
        summary: String((first && first.content) || s.title || '').slice(0, 60),
        time: new Date(s.updatedAt || Date.now()).toISOString(),
        own: true,
        origin: s.origin || 'unknown',
        messages: messages.length,
        pending: s.pending === true,
        dir: String(s.cwd || ''),
      };
    });
}

/** Rebuild a transcript (user/assistant pairs) for a session, oldest first. */
function readTranscript(dir, sessionId) {
  const session = getSession(dir, sessionId);
  if (!session) return [];
  return (Array.isArray(session.messages) ? session.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, text: m.content == null ? '' : String(m.content) }));
}

/**
 * Import a legacy store from another directory, ONE way and one time.
 *
 * The desktop wrote `<userData>/sessions.json` before this store existed. On an
 * upgrade that file is the user's entire GUI history, so the shared store
 * adopts it — but only when the shared store has nothing to lose (missing, or
 * empty), and only by copying: the legacy file is left where it is, so a user
 * who downgrades still finds their sessions.
 *
 * @returns {{adopted:boolean, sessions:number, from:string, reason?:string}}
 */
function adopt(dir, fromDir) {
  const from = storeFile(fromDir);
  const exists = (() => {
    try {
      return fs.existsSync(from);
    } catch {
      return false;
    }
  })();
  if (!exists) return { adopted: false, sessions: 0, from, reason: 'no legacy store' };
  const legacy = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(from, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  })();
  const incoming = Object.values(legacy).filter((s) => s && s.id);
  if (!incoming.length) return { adopted: false, sessions: 0, from, reason: 'legacy store empty' };
  if (listSessions(dir).length) {
    return { adopted: false, sessions: 0, from, reason: 'store already has sessions' };
  }
  const next = { ...legacy, __seq: legacy.__seq || 0 };
  for (const s of incoming) {
    // Adopted sessions keep their own history; they are already local content.
    s.seq = nextSeq(next);
    s.adoptedFrom = from;
  }
  next.version = STORE_VERSION;
  save(dir, next);
  return { adopted: true, sessions: incoming.length, from };
}

/**
 * Markdown export (session export, plan: Save as.../Export session). Each
 * message becomes a `## Role` heading followed by its content verbatim —
 * content is never re-escaped or re-wrapped, so any code fences a message
 * already contains (assistant replies routinely have them) survive untouched
 * instead of being nested inside an outer fence.
 */
function toMarkdown(session) {
  const title = (session && (session.title || session.id)) || 'session';
  const messages = (session && Array.isArray(session.messages)) ? session.messages : [];
  const lines = [`# ${title}`, ''];
  for (const message of messages) {
    const role = (message && message.role) || 'unknown';
    const heading = role.charAt(0).toUpperCase() + role.slice(1);
    const content = (message && (message.content || message.text)) || '';
    lines.push(`## ${heading}`, '', content, '');
  }
  return lines.join('\n');
}

/** JSON export: the session record as stored, pretty-printed. */
function toJson(session) {
  return JSON.stringify(session, null, 2);
}

module.exports = {
  STORE_FILE,
  STORE_VERSION,
  MAX_MESSAGES_PER_SESSION,
  storeDir,
  storeFile,
  toEpochMs,
  load,
  save,
  upsertSession,
  appendMessage,
  recordExchange,
  listSessions,
  getSession,
  deleteSession,
  markSynced,
  markPending,
  listPending,
  mergeRemoteSessions,
  listSummaries,
  readTranscript,
  adopt,
  toMarkdown,
  toJson,
};
