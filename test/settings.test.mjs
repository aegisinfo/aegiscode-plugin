#!/usr/bin/env node
/** Unit tests for desktop/lib/settings.js (plan P1 §5.1). */
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createSettingsStore, maskKey } = require('../desktop/lib/settings.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const dir = mkdtempSync(join(tmpdir(), 'aegis-settings-'));
const store = createSettingsStore({ dir });

// maskKey shape (same as main.js)
assert(maskKey(null) === null, 'maskKey(null)');
assert(maskKey('short') === 'configured', 'short key masked as configured');
const KEY = `sk-${'x'.repeat(24)}`;
const MASK = `sk-${'x'.repeat(6)}\u2026${'x'.repeat(4)}`;
assert(maskKey(KEY) === MASK, 'long key masked');

// set + get: full key never surfaces in get()
store.set('openai', { baseURL: 'https://api.example.com', key: KEY });
const got = store.get('openai');
assert(got.baseURL === 'https://api.example.com', 'baseURL stored');
assert(got.configured === true, 'configured when key present');
assert(got.keyMask === MASK, 'masked preview returned');
assert(got.key === undefined, 'get() must not expose the raw key');
assert(!JSON.stringify(got).includes(KEY), 'raw key never serialised');

// rawKey is the main-process-only accessor
assert(store.rawKey('openai') === KEY, 'rawKey returns the secret (main only)');

// list()
const list = store.list();
assert(list.length === 1 && list[0].provider === 'openai', 'list returns previews');

// remove
store.remove('openai');
assert(store.get('openai').configured === false, 'remove clears the key');

// key removal via set with undefined/null key
store.set('anthropic', { baseURL: 'https://api.example.com', key: 'k2' });
store.set('anthropic', { key: null });
assert(store.get('anthropic').configured === false, 'null key clears config');

console.log('settings tests passed');
