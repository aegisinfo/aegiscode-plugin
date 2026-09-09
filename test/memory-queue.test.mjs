#!/usr/bin/env node
/** Unit tests for desktop/lib/sync/memory-queue.js (plan P3 §7). */
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { queueFile, load, enqueue, listQueued } = require('../desktop/lib/sync/memory-queue.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const dir = mkdtempSync(join(tmpdir(), 'aegis-memory-queue-'));

// missing file -> [] without throwing
assert(Array.isArray(load(dir)) && load(dir).length === 0, 'missing queue file -> []');
assert(!existsSync(queueFile(dir)), 'no file written until the first enqueue');

// enqueue stamps queuedAt and persists
const entry = { text: 'remember this', source: 'aegis-desktop', session: 's1' };
const queued = enqueue(dir, entry);
assert(queued.text === 'remember this', 'enqueue preserves the entry fields');
assert(typeof queued.queuedAt === 'number', 'enqueue stamps queuedAt');
assert(existsSync(queueFile(dir)), 'memory-queue.json written');
assert(listQueued(dir).length === 1, 'listQueued sees the queued entry');

// a second enqueue appends, does not overwrite
enqueue(dir, { text: 'second', source: 'aegis-desktop', session: 's2' });
assert(listQueued(dir).length === 2, 'a second enqueue appends');
assert(listQueued(dir)[1].text === 'second', 'entries queue in order');

console.log('memory-queue tests passed');
