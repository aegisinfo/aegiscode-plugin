'use strict';

/**
 * Session persistence — one JSON line per exchange in ~/.aegiscode/history.jsonl
 * (or $AEGISCODE_HOME). Keeps the file bounded (oldest entries dropped past
 * HISTORY_LIMIT lines).
 *
 * history.jsonl is this host's *ledger*: one record per exchange, carrying the
 * token/cost numbers `/cost` aggregates. It stays the CLI's own format.
 *
 * What changed with the shared store (`client/session-store.js`) is that every
 * recorded exchange is ALSO mirrored into `<dir>/sessions.json`, the store the
 * desktop app and the MCP plugin read. That file is what makes a terminal turn
 * show up in the GUI's session list — and, in the other direction, what lets
 * `/resume` open a session that was typed in the desktop, without cloud sync
 * and without a key. `readResumeList` merges both sources by id, so no session
 * is listed twice.
 *
 * Ported from aegiscodex-dev/src/history.js (ESM → CommonJS). The data dir now
 * comes from config.js's shared `aegisDir()` helper.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { aegisDir } = require('./config.js');
const { sessionStore } = require('./shared.js');
const { estimateTokens } = require('./tokens.js');

const HISTORY_LIMIT = 500;
/** Which host wrote a mirrored record, so either side can tell them apart. */
const SOURCE = 'aegiscode-cli';

function historyPath() {
  return path.join(aegisDir(), 'history.jsonl');
}

function ensureHistoryDir() {
  fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
}

/**
 * Record one exchange. `reply` is stored in full so /resume can restore the
 * transcript exactly. Token accounting (Phase 4):
 *   live — `usage` carries the real numbers from the provider stream-json
 *          (input/output/cacheRead/cacheWrite + costUsd), stored verbatim;
 *   demo — estimated from text length (~4 chars/token), labeled real:false.
 * /cost aggregates these records, so compacted-away exchanges still count.
 */
function appendHistory({ sessionId, prompt, reply, status, usage }) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      sessionId,
      cwd: process.cwd(),
      prompt,
      reply,
      status, // 'done' | 'stopped' | 'error'
      tokens: usage
        ? {
            input: usage.input || 0,
            output: usage.output || 0,
            cacheRead: usage.cacheRead || 0,
            cacheWrite: usage.cacheWrite || 0,
            real: true,
          }
        : { input: estimateTokens(prompt), output: estimateTokens(reply || ''), real: false },
    };
    if (usage && typeof usage.costUsd === 'number') entry.costUsd = usage.costUsd;
    return appendHistoryEntries([entry]);
  } catch (e) {
    // Persistence is best-effort; never crash the session over it.
    if (process.env.AEGIS_HIST_DEBUG) console.error('[history] write failed:', e);
    return 0;
  }
}

/**
 * Append a batch of already-shaped entries in ONE read/trim/write pass.
 *
 * `appendHistory` re-reads and rewrites the whole file per exchange, which is
 * fine for one turn at a time but quadratic for a caller with a list of them —
 * importing 50 pulled sessions would rewrite the file 50 times, each pass
 * re-parsing everything the previous pass just wrote. The single writer (and
 * therefore the single place the file format is defined) stays here.
 *
 * @returns {number} entries written
 */
function appendHistoryEntries(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  if (!list.length) return 0;
  try {
    ensureHistoryDir();
    const p = historyPath();
    const prev = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
    const lines = [...prev, ...list.map((e) => JSON.stringify(e))];
    const trimmed = lines.slice(Math.max(0, lines.length - HISTORY_LIMIT));
    fs.writeFileSync(p, trimmed.join('\n') + '\n');
    mirrorToSharedStore(list);
    return list.length;
  } catch (e) {
    // Persistence is best-effort; never crash the session over it.
    if (process.env.AEGIS_HIST_DEBUG) console.error('[history] write failed:', e);
    return 0;
  }
}

/**
 * Mirror freshly-recorded exchanges into the shared session store, so the
 * desktop and the MCP plugin can see this host's sessions.
 *
 * Only *writes* mirror — a read of history.jsonl never re-imports itself, which
 * is what would otherwise duplicate every exchange on every launch. A mirror
 * failure must never cost the user the history line it accompanies, so this is
 * called after the ledger write and swallows its own errors.
 */
function mirrorToSharedStore(entries) {
  for (const e of entries) {
    try {
      sessionStore.recordExchange(aegisDir(), {
        sessionId: e.sessionId,
        prompt: e.prompt,
        reply: e.reply,
        status: e.status,
        cwd: e.cwd,
        ts: e.ts,
        tokens: e.tokens,
        costUsd: e.costUsd,
        origin: SOURCE,
      });
    } catch (err) {
      if (process.env.AEGIS_HIST_DEBUG) console.error('[history] mirror failed:', err);
    }
  }
}

function readEntries() {
  try {
    const raw = fs.readFileSync(historyPath(), 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Every history record, oldest first. Public name for other modules. */
function readHistoryEntries() {
  return readEntries();
}

/** Newest-first list of own sessions, one per distinct sessionId. */
function readOwnSessions(limit = 8) {
  const entries = readEntries();
  const byId = new Map();
  for (const e of entries) {
    if (!byId.has(e.sessionId)) byId.set(e.sessionId, e);
  }
  const items = [...byId.values()]
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, limit)
    .map((e) => ({
      id: e.sessionId,
      cwd: (e.cwd || '').split('/').filter(Boolean).pop() || '~',
      summary: (e.prompt || '').slice(0, 60),
      time: e.ts,
      own: true,
    }));
  return items;
}

/**
 * Rebuild the transcript (user/assistant pairs) of a session, oldest first.
 *
 * history.jsonl wins when it has records for the id (this host's own ledger,
 * complete with the exchanges the shared store may have trimmed). Otherwise the
 * session came from another host — a desktop thread — and the shared store is
 * the only place its messages exist, so /resume can open it too.
 */
function readSessionTranscript(sessionId) {
  const own = readEntries()
    .filter((e) => e.sessionId === sessionId)
    .flatMap((e) => [
      { role: 'user', text: e.prompt },
      { role: 'assistant', text: e.reply || '(no response)' },
    ]);
  if (own.length) return own;
  try {
    return sessionStore.readTranscript(aegisDir(), sessionId);
  } catch {
    return [];
  }
}

/** Sessions in the shared store written by another host (the desktop app). */
function readSharedStoreSessions(limit = 8) {
  try {
    return sessionStore.listSummaries(aegisDir(), limit);
  } catch {
    return [];
  }
}

/** All history records for one session, oldest first (power /cost). */
function sessionHistoryEntries(sessionId) {
  return readEntries().filter((e) => e.sessionId === sessionId);
}

/**
 * Drop every history record for a session (Phase 10b, 2.1.228 port). /clear
 * calls this so /cost stops summing old rows — the sessionId stays stable, so
 * rewind checkpoints and the transcript lineage are unaffected.
 */
function pruneSessionHistory(sessionId) {
  try {
    const p = historyPath();
    if (!fs.existsSync(p)) return;
    const kept = fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => {
        try { return JSON.parse(l).sessionId !== sessionId; } catch { return true; }
      });
    fs.writeFileSync(p, kept.length ? kept.join('\n') + '\n' : '');
  } catch (e) {
    if (process.env.AEGIS_HIST_DEBUG) console.error('[history] prune failed:', e);
  }
}

/**
 * Sum a session's token records across history.jsonl. Compacted-away exchanges
 * still count because /compact writes a summary exchange, it never deletes the
 * file. `real` is true only when every record carries live CLI usage numbers.
 */
function aggregateSessionUsage(sessionId) {
  const entries = sessionHistoryEntries(sessionId);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let real = entries.length > 0;
  let costUsd = 0;
  for (const e of entries) {
    const t = e.tokens || {};
    if (!t.real) real = false;
    usage.input += t.input || 0;
    usage.output += t.output || 0;
    usage.cacheRead += t.cacheRead || 0;
    usage.cacheWrite += t.cacheWrite || 0;
    if (typeof e.costUsd === 'number') costUsd += e.costUsd;
  }
  return { entries: entries.length, usage, real, costUsd };
}

/**
 * Sessions for the /resume overlay: own Aegiscode sessions, sessions written
 * into the shared store by another host (the desktop app), and real Claude Code
 * sessions from ~/.claude/history.jsonl — newest first, deduplicated by id.
 *
 * The dedup matters: an own session is mirrored into the shared store, so
 * without it every terminal session would be listed twice, once from each
 * source.
 */
function readResumeList(limit = 8, ownLimit = 5, claudeLimit = 8) {
  const items = readOwnSessions(ownLimit);
  const seen = new Set(items.map((i) => i.id));
  const sharedItems = readSharedStoreSessions(ownLimit).filter((i) => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
  const claudeItems = [];
  const histPath = `${os.homedir()}/.claude/history.jsonl`;
  try {
    const raw = fs.readFileSync(histPath, 'utf8');
    const lines = raw.trim().split('\n').reverse().slice(0, claudeLimit);
    for (const l of lines) {
      try {
        const j = JSON.parse(l);
        const meta = j.extra && JSON.parse(j.extra);
        if (meta && meta.sessionId && !seen.has(meta.sessionId)) {
          seen.add(meta.sessionId);
          const c = (j.cwd || '').split('/').filter(Boolean).pop() || '~';
          const t = (j.summary || '').slice(0, 60);
          claudeItems.push({ id: meta.sessionId, cwd: c, summary: t, time: j.timestamp, own: false });
        }
      } catch {}
    }
  } catch {}
  return [...items, ...sharedItems, ...claudeItems]
    .sort((a, b) => (String(a.time || '') < String(b.time || '') ? 1 : -1))
    .slice(0, limit);
}

module.exports = {
  HISTORY_LIMIT,
  SOURCE,
  historyPath,
  ensureHistoryDir,
  appendHistory,
  appendHistoryEntries,
  readHistoryEntries,
  readOwnSessions,
  readSessionTranscript,
  readSharedStoreSessions,
  sessionHistoryEntries,
  pruneSessionHistory,
  aggregateSessionUsage,
  readResumeList,
};
