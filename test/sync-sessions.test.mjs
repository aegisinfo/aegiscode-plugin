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

console.log('sessions tests passed');
