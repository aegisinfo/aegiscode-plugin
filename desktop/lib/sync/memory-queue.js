'use strict';

/**
 * memory-queue.js — local retry queue for cloud memory saves (plan P3 §7).
 * When `aegis.memorySave()` fails (no key configured, offline), the entry is
 * appended to <dir>/memory-queue.json instead of being dropped, so a later
 * "Sync now" or heartbeat retry can flush it once the cloud is reachable.
 * Pure Node + injectable dir, mirrors desktop/lib/sync/sessions.js.
 */

const fs = require('node:fs');
const path = require('node:path');

function queueFile(dir) {
  return path.join(dir, 'memory-queue.json');
}

function load(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(queueFile(dir), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function save(dir, entries) {
  atomicWrite(queueFile(dir), entries);
}

/** Queue a memory entry that a cloud save couldn't reach right now. */
function enqueue(dir, entry) {
  const entries = load(dir);
  const queued = { ...entry, queuedAt: Date.now() };
  entries.push(queued);
  save(dir, entries);
  return queued;
}

function listQueued(dir) {
  return load(dir);
}

module.exports = {
  queueFile,
  load,
  save,
  enqueue,
  listQueued,
};
