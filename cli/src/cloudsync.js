'use strict';

/**
 * Cloud conversation sync for the terminal host.
 *
 * The desktop has had this since P4.5 (`desktop/lib/sync/sessions.js` +
 * `desktop/main.js`'s sync handlers, behind the "Sync now" button). The CLI had
 * the transport for it — `client.conversationSyncPush/Pull` are the same two
 * shared-client methods the desktop calls — and no code that used them, plus a
 * `/cloud` command whose reply was "managed by the aegis CLI: run `aegis login`
 * — aegiscode does not store cloud keys." That was a dead end twice over: the
 * key *is* storable now (credentials.js), and nothing else was going to push
 * this host's sessions anywhere.
 *
 * Shape of the local store: the sessions that sync are the ones the CLI
 * already persists in `history.jsonl` (one record per exchange, keyed by
 * sessionId). Building a second session store for sync would mean `/resume`
 * and cloud sync disagreed about which sessions exist, so there is exactly one
 * and this module reads it, then writes imported remote sessions back into it —
 * which is what makes a pulled session show up in `/resume` like any other.
 *
 * What is tracked locally, in `sync-state.json`:
 *
 *   sessions[id] = { syncedAt, localUpdatedAt, remoteUpdatedAt, importedRemoteAt, lastError }
 *
 * "Pending" is derived, never stored as a flag that can go stale: a session is
 * pending when its newest local record is newer than the last successful push.
 *
 * Quota note, because it is the difference between a working sync and a
 * surprise: the server charges a push for the *growth* of a session
 * (`_session_token_delta` in aegis1's conversation_sync), refuses with 402 once
 * the plan's synced-token ceiling would be exceeded, and always serves pulls.
 * So sync is opt-in (config `cloudSync`, default off) rather than automatic on
 * every turn, and a 402 is reported as the quota error it is instead of being
 * swallowed into "sync failed".
 */

const fs = require('node:fs');
const path = require('node:path');
const { aegisDir } = require('./config.js');
const {
  historyPath,
  appendHistoryEntries,
  readHistoryEntries,
  readSessionTranscript,
} = require('./history.js');
const { estimateTokens } = require('./tokens.js');

/** Recorded on every session this host pushes, so the server can tell hosts apart. */
const SOURCE = 'aegiscode-cli';
const SYNC_FILE = 'sync-state.json';
const DEFAULT_LIMIT = 50;

function syncStatePath() {
  return path.join(aegisDir(), SYNC_FILE);
}

/** The sync ledger, or an empty one. Never throws on a missing/corrupt file. */
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncStatePath(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        lastPushAt: parsed.lastPushAt || null,
        lastPullAt: parsed.lastPullAt || null,
        importedRemoteAt: parsed.importedRemoteAt || {},
        // How many messages of each remote session are already in the local
        // store. Without this a session that grew by one turn re-imported its
        // whole transcript, so every pull duplicated every earlier exchange and
        // /cost doubled with each sync.
        importedRemoteCount: parsed.importedRemoteCount || {},
      };
    }
  } catch {}
  return { sessions: {}, lastPushAt: null, lastPullAt: null, importedRemoteAt: {}, importedRemoteCount: {} };
}

function saveState(state) {
  try {
    fs.mkdirSync(aegisDir(), { recursive: true });
    const tmp = syncStatePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, syncStatePath());
    return true;
  } catch (e) {
    if (process.env.AEGIS_HIST_DEBUG) console.error('[cloudsync] write failed:', e);
    return false;
  }
}

/** Local sessions from history.jsonl, newest activity first. One pass. */
function localSessions({ limit = DEFAULT_LIMIT } = {}) {
  const byId = new Map();
  for (const e of readHistoryEntries()) {
    if (!e || !e.sessionId) continue;
    const cur = byId.get(e.sessionId) || {
      id: e.sessionId,
      cwd: e.cwd || '',
      firstPrompt: '',
      updatedAt: '',
      exchanges: 0,
    };
    cur.exchanges += 1;
    if (!cur.firstPrompt && e.prompt) cur.firstPrompt = String(e.prompt);
    if (String(e.ts || '') > String(cur.updatedAt || '')) cur.updatedAt = e.ts || '';
    byId.set(e.sessionId, cur);
  }
  return [...byId.values()]
    .sort((a, b) => (String(a.updatedAt) < String(b.updatedAt) ? 1 : -1))
    .slice(0, Math.max(1, limit));
}

/** Title for a session: its first prompt, collapsed to one line. */
function titleFor(session) {
  const raw = String((session && session.firstPrompt) || '').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 80);
}

/**
 * A pulled/pushed transcript in the wire shape.
 *
 * `messages` is `{role, content}` — the same keys the desktop pushes, because
 * the server stores this array verbatim and a different spelling here would
 * make one host's sessions unreadable to the other.
 */
function buildTranscript(session, o = {}) {
  const rows = o.transcript || readSessionTranscript(session.id);
  const messages = rows
    .filter((r) => r && (r.role === 'user' || r.role === 'assistant'))
    .map((r) => ({ role: r.role, content: String(r.text == null ? '' : r.text) }));
  return {
    session_id: session.id,
    title: o.title != null ? o.title : titleFor(session),
    messages,
    source: o.source || SOURCE,
  };
}

function isPending(session, state) {
  const rec = state.sessions[session.id];
  if (!rec || !rec.syncedAt) return true;
  return String(session.updatedAt || '') > String(rec.localUpdatedAt || '');
}

/** Sessions with local changes the cloud has not seen, oldest first. */
function listPending(o = {}) {
  const state = o.state || loadState();
  return localSessions(o)
    .filter((s) => isPending(s, state))
    .reverse();
}

function markSynced(state, id, o = {}) {
  const prev = state.sessions[id] || {};
  state.sessions[id] = {
    ...prev,
    syncedAt: Date.now(),
    localUpdatedAt: o.localUpdatedAt || prev.localUpdatedAt || '',
    remoteUpdatedAt: o.remoteUpdatedAt || prev.remoteUpdatedAt || null,
    lastError: null,
  };
  return state.sessions[id];
}

function markFailed(state, id, err) {
  const prev = state.sessions[id] || {};
  state.sessions[id] = { ...prev, lastError: err, failedAt: Date.now() };
  return state.sessions[id];
}

/** Flatten a remote messages array into history records for the local store. */
function entriesFromRemote(session, now, skip = 0) {
  const out = [];
  const all = Array.isArray(session.messages) ? session.messages : [];
  // Only the messages this host has not already written: a resync after a new
  // turn must add that turn, not the whole thread again.
  const messages = skip > 0 && skip <= all.length ? all.slice(skip) : all;
  let pendingPrompt = null;
  const flush = (prompt, reply) => {
    if (prompt == null && reply == null) return;
    out.push({
      ts: session.updated_at || now,
      sessionId: session.session_id,
      cwd: '',
      prompt: prompt == null ? '' : String(prompt),
      reply: reply == null ? '' : String(reply),
      status: 'done',
      imported: true,
      importedFrom: String(session.source || 'cloud'),
      tokens: {
        input: estimateTokens(String(prompt || '')),
        output: estimateTokens(String(reply || '')),
        cacheRead: 0,
        cacheWrite: 0,
        real: false,
      },
    });
  };
  for (const m of messages) {
    const role = m && m.role;
    const text = m && (m.content != null ? m.content : m.text);
    if (role === 'user') {
      if (pendingPrompt != null) flush(pendingPrompt, null);
      pendingPrompt = text == null ? '' : text;
    } else if (role === 'assistant' || role === 'system') {
      flush(pendingPrompt, text);
      pendingPrompt = null;
    }
  }
  if (pendingPrompt != null) flush(pendingPrompt, null);
  return out;
}

/** A quota refusal is not a transport failure — say which one it is. */
function describeError(err) {
  const status = err && (err.status || (err.response && err.response.status));
  const message = (err && err.message) || String(err);
  if (status === 402) {
    return { kind: 'quota', status, message, hint: 'the plan’s synced-token ceiling is reached — /cloud sync off, or free space in the account dashboard' };
  }
  if (status === 401) {
    return { kind: 'auth', status, message, hint: 'the memory token was refused — run /key <api_key> to re-exchange it' };
  }
  return { kind: 'error', status: status || null, message, hint: null };
}

/**
 * Push every pending session, one request each.
 *
 * A single failure does not abort the run: the sessions that did go out are
 * recorded as synced, and the ones that did not keep their `lastError` so the
 * next attempt (or `/cloud status`) reports the real reason rather than a
 * session that silently looks in sync.
 */
async function push(client, o = {}) {
  const state = o.state || loadState();
  const limit = o.limit || DEFAULT_LIMIT;
  const pending = o.sessionIds
    ? o.sessionIds.map((id) => localSessions({ limit: Number.MAX_SAFE_INTEGER, state }).find((s) => s.id === id)).filter(Boolean)
    : listPending({ ...o, limit, state });

  const pushed = [];
  const failed = [];
  const skipped = [];
  for (const session of pending) {
    const transcript = buildTranscript(session, {});
    if (!transcript.messages.length) {
      skipped.push({ id: session.id, reason: 'no messages' });
      continue;
    }
    try {
      const res = await client.conversationSyncPush(transcript);
      const remoteId = (res && (res.session_id || res.id)) || session.id;
      markSynced(state, session.id, {
        localUpdatedAt: session.updatedAt,
        remoteUpdatedAt: (res && res.updated_at) || new Date().toISOString(),
      });
      pushed.push({
        id: session.id,
        remoteId,
        messages: transcript.messages.length,
        title: transcript.title,
        quota: res && res.token_limit ? { used: res.tokens_used, limit: res.token_limit } : null,
      });
      if (typeof o.onProgress === 'function') o.onProgress({ phase: 'push', id: session.id });
    } catch (err) {
      const info = describeError(err);
      markFailed(state, session.id, info.message);
      failed.push({ id: session.id, ...info });
      if (info.kind === 'quota' || info.kind === 'auth') break; // every later one fails the same way
    }
  }
  if (pushed.length) state.lastPushAt = Date.now();
  saveState(state);
  return { pushed, failed, skipped, pending: listPending({ state, limit }).length };
}

/**
 * Pull the account's remote sessions.
 *
 * `import` writes remote transcripts into history.jsonl so `/resume` sees them.
 * Re-pulling an unchanged session imports nothing — otherwise every pull would
 * duplicate the whole account into the local store, and `/cost` would double
 * with each sync.
 */
async function pull(client, o = {}) {
  const state = o.state || loadState();
  const importRemote = o.import !== false;
  let data;
  try {
    data = await client.conversationSyncPull();
  } catch (err) {
    return { ok: false, sessions: [], imported: 0, failed: [describeError(err)] };
  }
  const sessions = (data && data.sessions) || [];
  const imported = [];
  const now = new Date().toISOString();
  const batch = [];

  for (const remote of sessions) {
    const id = remote && remote.session_id;
    if (!id) continue;
    const seenAt = state.importedRemoteAt[id];
    const total = Array.isArray(remote.messages) ? remote.messages.length : 0;
    const seenCount = Number((state.importedRemoteCount || {})[id] || 0);
    const changed = !seenAt || seenAt !== remote.updated_at || total !== seenCount;
    if (importRemote && changed) {
      const entries = entriesFromRemote(remote, now, total >= seenCount ? seenCount : 0);
      if (entries.length) batch.push(...entries);
      state.importedRemoteAt[id] = remote.updated_at || now;
      state.importedRemoteCount = { ...(state.importedRemoteCount || {}), [id]: total };
    }
    // A session that came back from the cloud is in sync by definition; without
    // this the very next `push` would send it straight back up.
    markSynced(state, id, {
      localUpdatedAt: remote.updated_at || now,
      remoteUpdatedAt: remote.updated_at || now,
    });
    imported.push({
      id,
      title: remote.title || '',
      messages: (remote.messages || []).length,
      source: remote.source || '',
      updatedAt: remote.updated_at || null,
      imported: importRemote && changed,
    });
  }

  const written = batch.length ? appendHistoryEntries(batch) : 0;
  state.lastPullAt = Date.now();
  saveState(state);
  return {
    ok: true,
    sessions: imported,
    remote: sessions.length,
    imported: written,
    failed: [],
  };
}

/** Push then pull. Either half can fail without hiding the other's result. */
async function syncNow(client, o = {}) {
  const state = o.state || loadState();
  const out = { ok: true, push: null, pull: null };
  try {
    out.push = await push(client, { ...o, state });
  } catch (err) {
    out.ok = false;
    out.push = { pushed: [], failed: [describeError(err)], skipped: [] };
  }
  try {
    out.pull = await pull(client, { ...o, state });
    if (out.pull && out.pull.ok === false) out.ok = false;
  } catch (err) {
    out.ok = false;
    out.pull = { ok: false, sessions: [], imported: 0, failed: [describeError(err)] };
  }
  return out;
}

/** Counts for a status panel, with no network access. */
function status() {
  const state = loadState();
  const sessions = localSessions({ limit: Number.MAX_SAFE_INTEGER });
  const pending = sessions.filter((s) => isPending(s, state));
  const errors = sessions
    .filter((s) => state.sessions[s.id] && state.sessions[s.id].lastError)
    .map((s) => ({ id: s.id, error: state.sessions[s.id].lastError }));
  return {
    local: sessions.length,
    pending: pending.length,
    synced: sessions.length - pending.length,
    lastPushAt: state.lastPushAt,
    lastPullAt: state.lastPullAt,
    importedRemote: Object.keys(state.importedRemoteAt || {}).length,
    errors,
    path: syncStatePath(),
    historyPath: historyPath(),
  };
}

module.exports = {
  SOURCE,
  syncStatePath,
  loadState,
  saveState,
  localSessions,
  titleFor,
  buildTranscript,
  isPending,
  listPending,
  markSynced,
  markFailed,
  entriesFromRemote,
  describeError,
  push,
  pull,
  syncNow,
  status,
};
