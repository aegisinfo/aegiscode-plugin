'use strict';

/**
 * settings.js — provider-config store for the desktop host (plan P1 §5.1).
 * Holds base URLs and provider keys in the main process only. Keys are
 * encrypted at rest via Electron safeStorage when available, otherwise stored
 * base64 (best-effort; never real security) — and only masked previews ever
 * cross the IPC bridge.
 *
 * Pure Node + injectable storage dir / safeStorage so it unit-tests without
 * an Electron binary.
 */

const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_FILE = 'settings.json';

/** Same masking shape as desktop/main.js so previews are consistent. */
function maskKey(key) {
  if (!key) return null;
  if (key.length <= 10) return 'configured';
  return `${key.slice(0, 9)}\u2026${key.slice(-4)}`;
}

function createSettingsStore({ dir, safeStorage } = {}) {
  if (!dir) throw new Error('createSettingsStore requires a storage dir');
  const file = path.join(dir, SETTINGS_FILE);

  const safeAvailable = () =>
    Boolean(
      safeStorage &&
        typeof safeStorage.isEncryptionAvailable === 'function' &&
        safeStorage.isEncryptionAvailable()
    );

  function encrypt(value) {
    if (value == null) return null;
    if (safeAvailable()) {
      return safeStorage.encryptString(String(value)).toString('base64');
    }
    return Buffer.from(String(value), 'utf8').toString('base64');
  }

  function decrypt(value) {
    if (!value) return null;
    try {
      const buf = Buffer.from(String(value), 'base64');
      if (safeAvailable()) return safeStorage.decryptString(buf);
      return buf.toString('utf8');
    } catch {
      return null;
    }
  }

  function load() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  function save(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  function get(provider) {
    const cfg = (load()[provider]) || {};
    const key = decrypt(cfg.key);
    return {
      provider,
      baseURL: cfg.baseURL || '',
      configured: Boolean(key),
      keyMask: maskKey(key),
    };
  }

  function set(provider, { baseURL, key } = {}) {
    const data = load();
    const cfg = data[provider] || {};
    if (baseURL !== undefined) cfg.baseURL = baseURL;
    if (key !== undefined) cfg.key = key ? encrypt(key) : null;
    data[provider] = cfg;
    save(data);
    return get(provider);
  }

  function rawKey(provider) {
    const cfg = load()[provider] || {};
    return decrypt(cfg.key);
  }

  function remove(provider) {
    const data = load();
    delete data[provider];
    save(data);
    return { ok: true };
  }

  function list() {
    const data = load();
    return Object.keys(data).map((p) => get(p));
  }

  return { file, get, set, rawKey, remove, list, maskKey };
}

module.exports = { SETTINGS_FILE, maskKey, createSettingsStore };
