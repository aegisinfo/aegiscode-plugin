'use strict';

/**
 * settings.js — provider-config store for the desktop host (plan P1 §5.1).
 * Holds base URLs and provider keys in the main process only. Keys are
 * encrypted at rest via Electron safeStorage when available, otherwise stored
 * base64 (best-effort; never real security) — and only masked previews ever
 * cross the IPC bridge.
 *
 * The in-app AEGIS key lives in its own reserved namespace (AEGIS_KEY_NAMESPACE)
 * with dedicated accessors, so the provider CRUD surface — and the Settings
 * pane built on it — can never list it as a provider or remove it.
 *
 * Pure Node + injectable storage dir / safeStorage so it unit-tests without
 * an Electron binary.
 */

const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_FILE = 'settings.json';

/**
 * Reserved namespace for the in-app AEGIS API key. It deliberately does NOT
 * look like a provider id: the provider-config surface (get/set/remove/list,
 * and therefore the Settings pane and the model: IPC) must never be able to
 * list it as a provider or delete it via "Remove" — that coupling is defect
 * #1 of the AEGIS-key wiring review (settings.set('aegis', …) used the same
 * namespace as user provider configs). Use the dedicated AEGIS accessors on
 * the store (setAegisKey / aegisRawKey / aegisKey) to touch it.
 */
const AEGIS_KEY_NAMESPACE = '__aegis';

/** Pre-fix builds persisted the AEGIS key as a plain provider named 'aegis';
 *  migrateLegacyAegisKey() relocates it (and list() hides it meanwhile). */
const LEGACY_AEGIS_NAMESPACE = 'aegis';

/** Namespaces the provider-config surface must never see or mutate. */
const RESERVED_NAMESPACES = Object.freeze([
  AEGIS_KEY_NAMESPACE,
  LEGACY_AEGIS_NAMESPACE,
]);

/** True for the AEGIS-key namespace(s) — provider CRUD must refuse these. */
function isReservedNamespace(provider) {
  return RESERVED_NAMESPACES.includes(provider);
}

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

  /** Provider CRUD must never touch a reserved (AEGIS-key) namespace. */
  function assertNotReserved(provider) {
    if (isReservedNamespace(provider)) {
      throw new Error(
        `reserved namespace "${provider}" is not a provider config — ` +
          'use setAegisKey()/aegisRawKey() for the AEGIS key'
      );
    }
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
    assertNotReserved(provider);
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
    assertNotReserved(provider);
    const data = load();
    delete data[provider];
    save(data);
    return { ok: true };
  }

  /** Every provider config, never the AEGIS key (defect #1). */
  function list() {
    const data = load();
    return Object.keys(data)
      .filter((p) => !isReservedNamespace(p))
      .map((p) => get(p));
  }

  // --- AEGIS key: separate namespace, separate accessors -------------------

  function aegisKey() {
    const cfg = load()[AEGIS_KEY_NAMESPACE] || {};
    const key = decrypt(cfg.key);
    return { configured: Boolean(key), keyMask: maskKey(key) };
  }

  /** Main-process-only: the decrypted AEGIS key. Never crosses IPC. */
  function aegisRawKey() {
    const cfg = load()[AEGIS_KEY_NAMESPACE] || {};
    return decrypt(cfg.key);
  }

  function setAegisKey(key) {
    const data = load();
    data[AEGIS_KEY_NAMESPACE] = {
      ...(data[AEGIS_KEY_NAMESPACE] || {}),
      key: key ? encrypt(key) : null,
    };
    save(data);
    return aegisKey();
  }

  /**
   * Relocate a pre-fix `settings['aegis'].key` into the reserved namespace and
   * drop the pseudo-provider entry. Moved at ciphertext level (no decrypt /
   * re-encrypt), so it is safe to run before Electron's app 'ready' — when
   * safeStorage is not usable yet. Idempotent; never throws.
   */
  function migrateLegacyAegisKey() {
    try {
      const data = load();
      if (!data[LEGACY_AEGIS_NAMESPACE]) return { migrated: false };
      const legacy = data[LEGACY_AEGIS_NAMESPACE] || {};
      const current = data[AEGIS_KEY_NAMESPACE] || {};
      const next = { ...data };
      if (legacy.key && !current.key) {
        next[AEGIS_KEY_NAMESPACE] = { ...current, key: legacy.key };
      }
      delete next[LEGACY_AEGIS_NAMESPACE];
      save(next);
      return { migrated: true };
    } catch {
      return { migrated: false };
    }
  }

  return {
    file,
    get,
    set,
    rawKey,
    remove,
    list,
    maskKey,
    aegisKey,
    aegisRawKey,
    setAegisKey,
    migrateLegacyAegisKey,
  };
}

module.exports = {
  SETTINGS_FILE,
  AEGIS_KEY_NAMESPACE,
  LEGACY_AEGIS_NAMESPACE,
  RESERVED_NAMESPACES,
  isReservedNamespace,
  maskKey,
  createSettingsStore,
};
