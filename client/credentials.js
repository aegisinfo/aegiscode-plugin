'use strict';

/**
 * credentials.js — the ONE AEGIS account credential store, shared by every
 * host in this repo (terminal `aegiscode`, the MCP plugin, the desktop app).
 *
 * Why it lives in `client/`: this directory is the only tree every host
 * already bundles. The MCP plugin ships `mcp/` + `client/` and nothing else, so
 * a reader placed here needs no cross-package dependency — which is what the
 * alternative (the MCP host requiring `cli/src/credentials.js`) would have
 * forced, and why that host used to read `AEGIS_API_KEY` from the environment
 * alone while the CLI could save a key to disk. One login, one file, all
 * four hosts: that is the point of this module.
 *
 * Zero dependencies, no host imports. The data dir is resolved here
 * (`aegisHome()`) rather than imported from the CLI's config.js, so this file
 * runs from a bare `node client/credentials.js` inside the plugin tree.
 *
 * Resolution order, first hit wins:
 *
 *   1. `AEGIS_API_KEY` — the environment, so CI and an explicit export keep
 *      working and nothing written here can shadow them.
 *   2. `credentials.json` in the data dir, mode 0600. The writable store.
 *   3. `config.json`'s `aegiscloud.api_key` / `memory.token` — the shape an
 *      earlier AEGIS CLI left in the same data dir. Read, never written, and
 *      never deleted: it is another product's file and the user's key is in
 *      it. When one is found it is *also* copied into credentials.json so the
 *      next run reads the 0600 copy, and the status line says the plaintext
 *      copy is still there rather than silently leaving it.
 *
 * The key is never printed in full by anything in this repo; callers mask it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY_ENV = 'AEGIS_API_KEY';
/** Optional override for the memory token (cloud sync's own credential). */
const MEMORY_ENV = 'AEGIS_MEMORY_TOKEN';
const HOME_ENV = 'AEGISCODE_HOME';
const CREDENTIALS_FILE = 'credentials.json';
const CONFIG_FILE = 'config.json';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * The per-user AEGIS data directory: `$AEGISCODE_HOME` or `~/.aegiscode`.
 *
 * Every host resolves its data dir through this one function, so the CLI, the
 * MCP plugin and the desktop app agree on where memory and credentials live
 * instead of each keeping a private store the others cannot see. (The desktop
 * still keeps its *settings* — the safeStorage-encrypted key, window state —
 * in Electron's userData; only the shared memory + credential files live here.)
 */
function aegisHome(env) {
  const e = env || process.env;
  const override = e && e[HOME_ENV];
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(os.homedir(), '.aegiscode');
}

function credentialsPath(dir) {
  return path.join(dir || aegisHome(), CREDENTIALS_FILE);
}

function configPath(dir) {
  return path.join(dir || aegisHome(), CONFIG_FILE);
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
function readCredentials(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(dir), 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return {};
}

/**
 * Merge a patch into the store, creating it 0600 (and tightening an existing
 * file that is wider — a key file that a previous run left 0644 is exactly the
 * leak this file exists to avoid).
 */
function writeCredentials(patch, dir) {
  const target = credentialsPath(dir);
  const next = { ...readCredentials(dir), ...patch, version: 1 };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
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
 * `memory` blocks are not ours). Read-only.
 */
function readLegacyConfig(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
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
function legacyKeyOnDisk(dir) {
  return !!readLegacyConfig(dir).apiKey;
}

/**
 * Copy a legacy key/token into the 0600 store, once, without touching the file
 * it came from. Returns which fields were adopted so the caller can say so.
 */
function adoptLegacy(dir) {
  const legacy = readLegacyConfig(dir);
  const creds = readCredentials(dir);
  const patch = {};
  if (legacy.apiKey && !creds.aegisApiKey) patch.aegisApiKey = legacy.apiKey;
  if (legacy.memoryToken && !creds.memoryToken) patch.memoryToken = legacy.memoryToken;
  if (!Object.keys(patch).length) return { adopted: [] };
  const written = writeCredentials({ ...patch, adoptedFrom: configPath(dir) }, dir);
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
  const dir = o.dir;
  const fromEnv = normalizeApiKey(env && env[KEY_ENV]);
  if (fromEnv) return { key: fromEnv, source: 'env', from: KEY_ENV };

  const creds = readCredentials(dir);
  const stored = normalizeApiKey(creds.aegisApiKey);
  if (stored) return { key: stored, source: 'credentials', from: credentialsPath(dir) };

  const legacy = readLegacyConfig(dir).apiKey;
  if (legacy) return { key: legacy, source: 'config', from: configPath(dir) };

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
function saveApiKey(raw, dir) {
  const v = validateApiKey(raw);
  if (!v.ok) return { ok: false, key: v.key, path: credentialsPath(dir), message: v.message };
  const written = writeCredentials({ aegisApiKey: v.key, savedAt: new Date().toISOString() }, dir);
  if (!written.ok) {
    return {
      ok: false,
      key: v.key,
      path: credentialsPath(dir),
      error: written.error,
      message: `could not write ${credentialsPath(dir)}`,
    };
  }
  return { ok: true, key: v.key, path: credentialsPath(dir) };
}

/**
 * Remove the stored key (and nothing else — the memory token stays, since a
 * key rotation should not silently unsubscribe cloud memory). config.json is
 * never touched: another product writes it.
 */
function clearApiKey(dir) {
  const had = !!normalizeApiKey(readCredentials(dir).aegisApiKey);
  const written = writeCredentials({ aegisApiKey: '', adoptedFrom: '' }, dir);
  return { cleared: had, ok: written.ok, path: credentialsPath(dir) };
}

/** The memory token cloud sync authenticates with, from store or legacy. */
function resolveMemoryToken(o = {}) {
  const env = o.env || process.env;
  const dir = o.dir;
  const fromEnv = String((env && env[MEMORY_ENV]) || '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  const creds = readCredentials(dir);
  const stored = String(creds.memoryToken || '').trim();
  if (stored) return { token: stored, source: 'credentials' };
  const legacy = readLegacyConfig(dir).memoryToken;
  if (legacy) return { token: legacy, source: 'config' };
  return { token: '', source: 'none' };
}

function saveMemoryToken(token, extra = {}, dir) {
  return writeCredentials({ memoryToken: String(token || '').trim(), ...extra }, dir);
}

function clearMemoryToken(dir) {
  return writeCredentials({ memoryToken: '', memorySubscribed: false }, dir);
}

/**
 * Everything a status screen or a `doctor` line needs about the credential,
 * without ever exposing the key itself.
 */
function keyStatus(o = {}) {
  const dir = o.dir;
  const { key, source, from } = resolveApiKey(o);
  const creds = readCredentials(dir);
  let mode = null;
  try {
    mode = fs.statSync(credentialsPath(dir)).mode & 0o777;
  } catch {}
  return {
    configured: !!key,
    key,
    source,
    from,
    path: credentialsPath(dir),
    fileMode: mode == null ? null : '0' + mode.toString(8),
    stored: !!normalizeApiKey(creds.aegisApiKey),
    legacyPlaintext: legacyKeyOnDisk(dir),
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
  env: `${KEY_ENV}`,
  credentials: 'saved key file',
  config: 'config.json (aegis CLI)',
  none: 'not set',
};

function sourceLabel(source) {
  return SOURCE_LABEL[source] || SOURCE_LABEL.none;
}

/**
 * Prefer the most recently saved key between a host's own copy and this file.
 *
 * The desktop keeps its key encrypted via Electron safeStorage, which is a
 * better place for it than a 0600 file — but only one of the two can be in
 * force, and picking wrong is silent: the user rotates their key with
 * `aegiscode login`, the app keeps presenting an old string it saved last week,
 * and every call 401s with a key that looks right in Settings.
 *
 * Both sides stamp `savedAt`, so the rule is simply "the newest write wins",
 * with the host's own copy breaking a tie (it is encrypted). A missing stamp on
 * either side loses to a present one; equal keys always resolve to the host's.
 *
 * @returns {{key:string, source:'host'|'shared'|'none', sharedAt:number, hostAt:number}}
 */
function preferNewest(storedKey, storedAt, o = {}) {
  const ownKey = normalizeApiKey(storedKey);
  const ownAt = Date.parse(storedAt || '') || 0;
  const shared = readCredentials(o.dir);
  const sharedKey = normalizeApiKey(shared.aegisApiKey);
  const sharedAt = Date.parse(shared.savedAt || '') || 0;

  if (!sharedKey) return { key: ownKey, source: ownKey ? 'host' : 'none', sharedAt, hostAt: ownAt };
  if (!ownKey) return { key: sharedKey, source: 'shared', sharedAt, hostAt: ownAt };
  if (ownKey === sharedKey) return { key: ownKey, source: 'host', sharedAt, hostAt: ownAt };
  return sharedAt > ownAt
    ? { key: sharedKey, source: 'shared', sharedAt, hostAt: ownAt }
    : { key: ownKey, source: 'host', sharedAt, hostAt: ownAt };
}

/** One line telling the user how to supply a key, used by every error path. */
const HOW_TO_SET = 'run `aegiscode login` (or /key inside a session) to save one';

module.exports = {
  KEY_ENV,
  MEMORY_ENV,
  HOME_ENV,
  CREDENTIALS_FILE,
  CONFIG_FILE,
  aegisHome,
  credentialsPath,
  configPath,
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
  preferNewest,
  sourceLabel,
  HOW_TO_SET,
};
