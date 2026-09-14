'use strict';

/**
 * Session persistence — one JSON line per exchange in ~/.aegiscode/history.jsonl
 * (or $AEGISCODE_HOME). Keeps the file bounded (oldest entries dropped past
 * HISTORY_LIMIT lines).
 *
 * Ported from aegiscodex-dev/src/history.js (ESM → CommonJS). The data dir now
 * comes from config.js's shared `aegisDir()` helper.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { aegisDir } = require('./config.js');
const { estimateTokens } = require('./tokens.js');

const HISTORY_LIMIT = 500;

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
    return list.length;
  } catch (e) {
    // Persistence is best-effort; never crash the session over it.
    if (process.env.AEGIS_HIST_DEBUG) console.error('[history] write failed:', e);
    return 0;
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

/** Rebuild the transcript (user/assistant pairs) of a session, oldest first. */
function readSessionTranscript(sessionId) {
  return readEntries()
    .filter((e) => e.sessionId === sessionId)
    .flatMap((e) => [
      { role: 'user', text: e.prompt },
      { role: 'assistant', text: e.reply || '(no response)' },
    ]);
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
 * Sessions for the /resume overlay: own Aegiscode sessions merged with real
 * Claude Code sessions from ~/.claude/history.jsonl, newest first.
 */
function readResumeList(limit = 8, ownLimit = 5, claudeLimit = 8) {
  const items = readOwnSessions(ownLimit);
  const claudeItems = [];
  const histPath = `${os.homedir()}/.claude/history.jsonl`;
  try {
    const raw = fs.readFileSync(histPath, 'utf8');
    const lines = raw.trim().split('\n').reverse().slice(0, claudeLimit);
    for (const l of lines) {
      try {
        const j = JSON.parse(l);
        const meta = j.extra && JSON.parse(j.extra);
        if (meta && meta.sessionId) {
          const c = (j.cwd || '').split('/').filter(Boolean).pop() || '~';
          const t = (j.summary || '').slice(0, 60);
          claudeItems.push({ id: meta.sessionId, cwd: c, summary: t, time: j.timestamp, own: false });
        }
      } catch {}
    }
  } catch {}
  return [...items, ...claudeItems]
    .sort((a, b) => (String(a.time || '') < String(b.time || '') ? 1 : -1))
    .slice(0, limit);
}

module.exports = {
  HISTORY_LIMIT,
  historyPath,
  ensureHistoryDir,
  appendHistory,
  appendHistoryEntries,
  readHistoryEntries,
  readOwnSessions,
  readSessionTranscript,
  sessionHistoryEntries,
  pruneSessionHistory,
  aggregateSessionUsage,
  readResumeList,
};
