#!/usr/bin/env node
/** Unit tests for desktop/lib/settings.js (plan P1 §5.1). */
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createSettingsStore, maskKey, CONFIRM_MODE_NAMESPACE, isReservedNamespace } =
  require('../desktop/lib/settings.js');

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

// ---- confirm mode: general (non-provider) preference ----------------------
//
// The tool-call approval toggle ("Confirm before running tools"). It must
// default to ON so an install that never flipped it keeps gating every
// exec/writeFile/editFile exactly as before, must persist across store
// instances, and must never leak into the provider CRUD surface.

assert(store.getConfirmMode() === true, 'confirm mode defaults to ON');
assert(CONFIRM_MODE_NAMESPACE.startsWith('__'), 'confirm mode uses a reserved-style namespace');
assert(isReservedNamespace(CONFIRM_MODE_NAMESPACE), 'confirm mode namespace is reserved');
assert(
  !store.list().some((s) => s.provider === CONFIRM_MODE_NAMESPACE),
  'confirm mode is not listed as a provider'
);
let refused = false;
try {
  store.set(CONFIRM_MODE_NAMESPACE, { baseURL: 'https://evil.example' });
} catch {
  refused = true;
}
assert(refused, 'the provider set() surface refuses the confirm-mode namespace');

assert(store.setConfirmMode(false) === false, 'setConfirmMode returns the stored value');
assert(store.getConfirmMode() === false, 'confirm mode persists OFF');
assert(store.setConfirmMode(true) === true && store.getConfirmMode() === true, 'flips back ON');

// A fresh store on the same dir reads what was written (real persistence, and
// the ON default still holds for an install whose settings.json predates it).
store.setConfirmMode(false);
const reopened = createSettingsStore({ dir });
assert(reopened.getConfirmMode() === false, 'confirm mode survives a store restart');
reopened.setConfirmMode(true);
assert(createSettingsStore({ dir }).getConfirmMode() === true, 'and flips back');

// Garbage/treated-as-boolean input never yields a non-boolean.
assert(typeof reopened.setConfirmMode('yes') === 'boolean', 'setConfirmMode coerces to boolean');
assert(reopened.getConfirmMode() === true, 'truthy input reads back as ON');
reopened.setConfirmMode(undefined);
assert(reopened.getConfirmMode() === false, 'undefined input reads back as OFF');

console.log('settings tests passed');
