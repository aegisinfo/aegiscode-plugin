'use strict';

/**
 * The AEGIS account credential store for the terminal host.
 *
 * Before this module the CLI had exactly one way to be given a key: an
 * `AEGIS_API_KEY` environment variable, checked as `process.env.AEGIS_API_KEY`
 * at five separate call sites. A shell export does not survive a new terminal,
 * a reboot, an SSH session or a desktop launcher, so every one of those turned
 * the product back into "no key — export one" with no in-band way to fix it:
 * `/byok-set` stores *provider* keys server-side and `/login` is one of the
 * reference commands this host deliberately marks unavailable. The only
 * credential the CLI could not accept was its own.
 *
 * Resolution order, first hit wins:
 *
 *   1. `AEGIS_API_KEY` — the environment, so CI and `--key` keep working and
 *      nothing written here can shadow an explicit export.
 *   2. `credentials.json` in the data dir, mode 0600. The writable store.
 *   3. `config.json`'s `aegiscloud.api_key` / `memory.token` — the shape an
 *      earlier AEGIS CLI left in the same data dir. Read, never written, and
 *      never deleted: it is another product's file and the user's key is in
 *      it. When one is found it is *also* copied into credentials.json so the
 *      next run reads the 0600 copy, and `/cloud status` says the plaintext
 *      copy is still there rather than silently leaving it.
 *
 * The key is never printed in full by anything in this package; callers mask it
 * with format.js's maskKey.
 */

const fs = require('node:fs');
const path = require('node:path');
const { aegisDir, configPath } = require('./config.js');

const KEY_ENV = 'AEGIS_API_KEY';
/** Optional override for the memory token (cloud sync's own credential). */
const MEMORY_ENV = 'AEGIS_MEMORY_TOKEN';
const CREDENTIALS_FILE = 'credentials.json';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function credentialsPath() {
  return path.join(aegisDir(), CREDENTIALS_FILE);
}

/**
 * Accept the key in the shapes a user actually pastes it.
 *
 * Copy-paste from a dashboard, a `.env` line, a shell profile or a chat message
 * are all realistic — and pasting `AEGIS_API_KEY=aegis_…` or `"aegis_…"` into a
 * prompt that stores the literal string produces an auth failure the user
 * cannot see the cause of, because the key *looks* right in the status line.
 */
function normalizeApiKey(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/^export\s+/i, '').trim();
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/s.exec(s);
  if (assignment) s = assignment[1].trim();
  s = s.replace(/^["']|["']$/g, '').trim();
  s = s.replace(/^Bearer\s+/i, '').trim();
  return s;
}

/**
 * Shape check only — no network. Catches the two mistakes that are structural
 * (an empty paste, and a wrapped/truncated multi-line paste) so the caller can
 * refuse before spending a verification round trip.
 */
function validateApiKey(raw) {
  const key = normalizeApiKey(raw);
  if (!key) return { ok: false, key, reason: 'empty', message: 'no key given' };
  if (/\s/.test(key)) {
    return {
      ok: false,
      key,
      reason: 'whitespace',
      message: 'that looks like more than one word — paste just the key',
    };
  }
  if (key.length < 16) {
    return {
      ok: false,
      key,
      reason: 'too short',
      message: `that key is ${key.length} characters — AEGIS keys are longer than that`,
    };
  }
  return { ok: true, key, reason: null, message: null };
}

/** The stored credential object, or {} — never throws on a missing/corrupt file. */
function readCredentials() {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return {};
}

/**
 * Merge a patch into the store, creating it 0600 (and tightening an existing
 * file that is wider — a key file that a previous run left 0644 is exactly the
 * leak this file exists to avoid).
 */
function writeCredentials(patch) {
  const next = { ...readCredentials(), ...patch, version: 1 };
  try {
    fs.mkdirSync(aegisDir(), { recursive: true, mode: DIR_MODE });
    const target = credentialsPath();
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: FILE_MODE });
    fs.renameSync(tmp, target);
    try {
      fs.chmodSync(target, FILE_MODE);
    } catch {}
  } catch (e) {
    if (process.env.AEGIS_HIST_DEBUG) console.error('[credentials] write failed:', e);
    return { ok: false, error: e, credentials: next };
  }
  return { ok: true, credentials: next };
}

/**
 * The key an earlier AEGIS CLI wrote into config.json (the `aegiscloud` /
 * `memory` blocks are not ours — config.js cannot produce them). Read-only.
 */
function readLegacyConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const cloud = parsed.aegiscloud && typeof parsed.aegiscloud === 'object' ? parsed.aegiscloud : {};
    const memory = parsed.memory && typeof parsed.memory === 'object' ? parsed.memory : {};
    return {
      apiKey: normalizeApiKey(cloud.api_key),
      memoryToken: String(memory.token || '').trim(),
      syncConversations: cloud.syncConversations === true ? true : undefined,
      lastVerified: cloud.lastVerified || null,
      memorySubscribed: memory.subscribed === true ? true : undefined,
    };
  } catch {
    return {};
  }
}

/** True when config.json still carries a plaintext copy of the account key. */
function legacyKeyOnDisk() {
  return !!readLegacyConfig().apiKey;
}

/**
 * Copy a legacy key/token into the 0600 store, once, without touching the file
 * it came from. Returns which fields were adopted so the caller can say so.
 */
function adoptLegacy() {
  const legacy = readLegacyConfig();
  const creds = readCredentials();
  const patch = {};
  if (legacy.apiKey && !creds.aegisApiKey) patch.aegisApiKey = legacy.apiKey;
  if (legacy.memoryToken && !creds.memoryToken) patch.memoryToken = legacy.memoryToken;
  if (!Object.keys(patch).length) return { adopted: [] };
  const written = writeCredentials({ ...patch, adoptedFrom: configPath() });
  if (!written.ok) return { adopted: [] };
  return { adopted: Object.keys(patch) };
}

/**
 * The key to use, and where it came from.
 *
 * @returns {{key:string, source:'env'|'credentials'|'config'|'none', from:string}}
 */
function resolveApiKey(o = {}) {
  const env = o.env || process.env;
  const fromEnv = normalizeApiKey(env && env[KEY_ENV]);
  if (fromEnv) return { key: fromEnv, source: 'env', from: KEY_ENV };

  const creds = readCredentials();
  const stored = normalizeApiKey(creds.aegisApiKey);
  if (stored) return { key: stored, source: 'credentials', from: credentialsPath() };

  const legacy = readLegacyConfig().apiKey;
  if (legacy) return { key: legacy, source: 'config', from: configPath() };

  return { key: '', source: 'none', from: '' };
}

/** Whether any credential is available (env, store or legacy config). */
function hasApiKey(o = {}) {
  return !!resolveApiKey(o).key;
}

/**
 * Persist a key.
 *
 * @returns {{ok:boolean, key:string, path:string, error?:Error, message?:string}}
 */
function saveApiKey(raw) {
  const v = validateApiKey(raw);
  if (!v.ok) return { ok: false, key: v.key, path: credentialsPath(), message: v.message };
  const written = writeCredentials({ aegisApiKey: v.key, savedAt: new Date().toISOString() });
  if (!written.ok) {
    return {
      ok: false,
      key: v.key,
      path: credentialsPath(),
      error: written.error,
      message: `could not write ${credentialsPath()}`,
    };
  }
  return { ok: true, key: v.key, path: credentialsPath() };
}

/**
 * Remove the stored key (and nothing else — the memory token stays, since a
 * key rotation should not silently unsubscribe cloud memory). config.json is
 * never touched: another product writes it.
 */
function clearApiKey() {
  const had = !!normalizeApiKey(readCredentials().aegisApiKey);
  const written = writeCredentials({ aegisApiKey: '', adoptedFrom: '' });
  return { cleared: had, ok: written.ok, path: credentialsPath() };
}

/** The memory token cloud sync authenticates with, from store or legacy. */
function resolveMemoryToken(o = {}) {
  const env = o.env || process.env;
  const fromEnv = String((env && env[MEMORY_ENV]) || '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  const creds = readCredentials();
  const stored = String(creds.memoryToken || '').trim();
  if (stored) return { token: stored, source: 'credentials' };
  const legacy = readLegacyConfig().memoryToken;
  if (legacy) return { token: legacy, source: 'config' };
  return { token: '', source: 'none' };
}

function saveMemoryToken(token, extra = {}) {
  return writeCredentials({ memoryToken: String(token || '').trim(), ...extra });
}

function clearMemoryToken() {
  return writeCredentials({ memoryToken: '', memorySubscribed: false });
}

/**
 * Everything a status screen or a `doctor` line needs about the credential,
 * without ever exposing the key itself.
 */
function keyStatus(o = {}) {
  const { key, source, from } = resolveApiKey(o);
  const creds = readCredentials();
  let mode = null;
  try {
    mode = fs.statSync(credentialsPath()).mode & 0o777;
  } catch {}
  return {
    configured: !!key,
    key,
    source,
    from,
    path: credentialsPath(),
    fileMode: mode == null ? null : '0' + mode.toString(8),
    stored: !!normalizeApiKey(creds.aegisApiKey),
    legacyPlaintext: legacyKeyOnDisk(),
    verifiedAt: creds.verifiedAt || null,
    account: creds.account || null,
    memoryToken: !!resolveMemoryToken(o).token,
    memorySource: resolveMemoryToken(o).source,
  };
}

/**
 * Client options for `createClient`: the resolved key plus the stored memory
 * token, so a restart does not re-exchange for a token it already has.
 */
function clientOptions(o = {}) {
  const { key } = resolveApiKey(o);
  const { token } = resolveMemoryToken(o);
  const opts = {};
  if (key) opts.apiKey = key;
  if (token) opts.memoryToken = token;
  return opts;
}

/** Human label for a resolution source, for status lines. */
const SOURCE_LABEL = {
  env: `$${KEY_ENV}`,
  credentials: 'saved key file',
  config: 'config.json (aegis CLI)',
  none: 'not set',
};

function sourceLabel(source) {
  return SOURCE_LABEL[source] || SOURCE_LABEL.none;
}

/** One line telling the user how to supply a key, used by every error path. */
const HOW_TO_SET = 'run `aegiscode login` (or /key inside a session) to save one';

module.exports = {
  KEY_ENV,
  MEMORY_ENV,
  CREDENTIALS_FILE,
  credentialsPath,
  normalizeApiKey,
  validateApiKey,
  readCredentials,
  writeCredentials,
  readLegacyConfig,
  legacyKeyOnDisk,
  adoptLegacy,
  resolveApiKey,
  hasApiKey,
  saveApiKey,
  clearApiKey,
  resolveMemoryToken,
  saveMemoryToken,
  clearMemoryToken,
  keyStatus,
  clientOptions,
  sourceLabel,
  HOW_TO_SET,
};
