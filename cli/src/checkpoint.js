'use strict';

/**
 * Transcript checkpoints for /rewind. The session loop snapshots the
 * transcript after every exchange into ~/.aegiscode/checkpoints/<session>.jsonl
 * (bounded to the last CHECKPOINT_LIMIT), and /rewind lists or restores them.
 * Checkpoint 0 is the session start (empty transcript).
 *
 * Ported from aegiscodex-dev/src/checkpoint.js (ESM → CommonJS). The data dir
 * now comes from config.js's shared `aegisDir()` helper.
 */

const fs = require('node:fs');
const path = require('node:path');
const { aegisDir } = require('./config.js');

const CHECKPOINT_LIMIT = 8;

function checkpointsPath(sessionId) {
  return path.join(aegisDir(), 'checkpoints', `${sessionId}.jsonl`);
}

/**
 * Snapshot the current transcript. Returns the new checkpoint index.
 * Cheap: transcripts are small arrays of messages.
 */
function snapshotCheckpoint(sessionId, transcript) {
  try {
    fs.mkdirSync(path.dirname(checkpointsPath(sessionId)), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      depth: transcript.length,
      words: transcript.reduce((a, m) => a + (m.text || '').split(/\s+/).length, 0),
      transcript,
    };
    const p = checkpointsPath(sessionId);
    const prev = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
    const lines = [...prev, JSON.stringify(entry)];
    const trimmed = lines.slice(Math.max(0, lines.length - CHECKPOINT_LIMIT));
    fs.writeFileSync(p, trimmed.join('\n') + '\n');
    return lines.length - 1; // index into the trimmed list
  } catch {
    return -1;
  }
}

/** Newest-first checkpoint list: [{ idx, ts, depth, words }]. */
function listCheckpoints(sessionId) {
  try {
    const raw = fs.readFileSync(checkpointsPath(sessionId), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l, idx) => {
        try {
          const e = JSON.parse(l);
          return { idx, ts: e.ts, depth: e.depth || 0, words: e.words || 0 };
        } catch { return null; }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/** Restore a checkpoint by its stored index. Returns the transcript or null. */
function loadCheckpoint(sessionId, idx) {
  try {
    const raw = fs.readFileSync(checkpointsPath(sessionId), 'utf8').split('\n').filter(Boolean);
    const e = JSON.parse(raw[idx]);
    if (!e || !Array.isArray(e.transcript)) return null;
    return e.transcript;
  } catch {
    return null;
  }
}

module.exports = {
  CHECKPOINT_LIMIT,
  checkpointsPath,
  snapshotCheckpoint,
  listCheckpoints,
  loadCheckpoint,
};
