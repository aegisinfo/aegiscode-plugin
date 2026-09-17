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

/** Reserved namespace for the global quick-launcher shortcut config
 *  ({ enabled, shortcut }) — app-level settings, not a provider, so it must
 *  stay out of the provider CRUD surface for the same reason the AEGIS key
 *  does (see AEGIS_KEY_NAMESPACE above). */
const QUICK_LAUNCHER_NAMESPACE = '__quickLauncher';

/** Default global shortcut: rare enough on both major platforms to avoid
 *  fighting existing app/OS bindings, memorable enough to type once. */
const DEFAULT_QUICK_LAUNCHER_SHORTCUT = 'CmdOrCtrl+Shift+Space';

/** Reserved namespace for the tool-call approval ("confirm mode") preference:
 *  `{ enabled }` — app-level, not a provider, so it stays out of the provider
 *  CRUD surface for the same reason the AEGIS key does. Default is ON
 *  (settings.getConfirmMode() === true when unset), which is the historical
 *  behaviour: exec/writeFile/editFile always asked for approval.
 *  NOTE: like the AEGIS key and the quick launcher, this lives in its own
 *  top-level namespace — never inside a provider's `cfg[provider]` object. */
const CONFIRM_MODE_NAMESPACE = '__confirmMode';

/** Reserved namespace for the persisting-memory preference: `{ enabled }` —
 *  app-level, not a provider. This is the desktop's counterpart to the CLI's
 *  `memoryPersist` config key, and the gate `lib/sync/persist-gate.js` reads
 *  before any automatic cloud push. Default is ON (an absent namespace means
 *  persistence is on, which is the shipped decision); an explicit `false` is
 *  what turns it off. Nothing secret lives here, so no encryption. */
const MEMORY_PERSIST_NAMESPACE = '__memoryPersist';

/** Namespaces the provider-config surface must never see or mutate. */
const RESERVED_NAMESPACES = Object.freeze([
  AEGIS_KEY_NAMESPACE,
  LEGACY_AEGIS_NAMESPACE,
  QUICK_LAUNCHER_NAMESPACE,
  CONFIRM_MODE_NAMESPACE,
  MEMORY_PERSIST_NAMESPACE,
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

  /**
   * When this host last wrote its own AEGIS key (ISO string, or null).
   *
   * The shared credential file records the same thing, and startup compares the
   * two so the most recently saved key wins. Without a stamp the app cannot tell
   * "I saved this last week" from "the user ran `aegiscode login` a minute ago
   * with a rotated key", and would silently keep presenting the stale one.
   */
  function aegisKeySavedAt() {
    const cfg = load()[AEGIS_KEY_NAMESPACE] || {};
    return cfg.savedAt || null;
  }

  function setAegisKey(key) {
    const data = load();
    data[AEGIS_KEY_NAMESPACE] = {
      ...(data[AEGIS_KEY_NAMESPACE] || {}),
      key: key ? encrypt(key) : null,
      savedAt: key ? new Date().toISOString() : null,
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

  // --- Quick launcher: reserved namespace, plain (unencrypted) config ------
  // No secret lives here — just a bool and a shortcut string — so unlike the
  // AEGIS key above there is nothing to encrypt/decrypt.

  function quickLauncherConfig() {
    const cfg = load()[QUICK_LAUNCHER_NAMESPACE] || {};
    const shortcut =
      typeof cfg.shortcut === 'string' && cfg.shortcut.trim()
        ? cfg.shortcut.trim()
        : DEFAULT_QUICK_LAUNCHER_SHORTCUT;
    return { enabled: Boolean(cfg.enabled), shortcut };
  }

  function setQuickLauncherConfig({ enabled, shortcut } = {}) {
    const data = load();
    data[QUICK_LAUNCHER_NAMESPACE] = {
      enabled: Boolean(enabled),
      shortcut:
        typeof shortcut === 'string' && shortcut.trim()
          ? shortcut.trim()
          : DEFAULT_QUICK_LAUNCHER_SHORTCUT,
    };
    save(data);
    return quickLauncherConfig();
  }

  // --- Confirm mode: reserved namespace, plain (unencrypted) preference ----
  // "Confirm before running tools" — the ON/OFF switch for the renderer's
  // tool-call approval gate (desktop/lib/local/engine.js gatedExecuteTool).
  // ON (default, and the behaviour shipped so far) means every mutating tool
  // call — exec / writeFile / editFile — is previewed and approved by the user
  // first. OFF means the engine runs them straight through, like a tool the
  // session already allowed. Nothing secret is stored here, so no encryption.

  function getConfirmMode() {
    const cfg = load()[CONFIRM_MODE_NAMESPACE] || {};
    // Unset === true: an existing install that never touched the toggle keeps
    // the gate exactly as it was.
    return cfg.enabled === undefined ? true : Boolean(cfg.enabled);
  }

  function setConfirmMode(enabled) {
    const data = load();
    data[CONFIRM_MODE_NAMESPACE] = { enabled: Boolean(enabled) };
    save(data);
    return getConfirmMode();
  }

  // --- Persisting memory: reserved namespace, plain preference -------------
  // The desktop's half of "persisting memory for every account": whether a
  // finished turn is pushed to cloud memory automatically. ON when unset —
  // an install that never touched the toggle behaves like cli/, whose
  // `memoryPersist` also defaults to on. `memoryPersistState()` reports the
  // SOURCE as well as the value so "off" and "never set" stay distinguishable;
  // lib/sync/persist-gate.js reads the same namespace straight off disk, and
  // the two must agree on the default.

  function getMemoryPersist() {
    const cfg = load()[MEMORY_PERSIST_NAMESPACE] || {};
    return cfg.enabled === undefined ? true : Boolean(cfg.enabled);
  }

  /** `{ enabled, source }` — mirrors cli/src/cloudsync.js memoryPersistState(). */
  function memoryPersistState() {
    const cfg = load()[MEMORY_PERSIST_NAMESPACE] || {};
    return {
      enabled: getMemoryPersist(),
      source: cfg.enabled === undefined ? 'default' : 'config',
    };
  }

  function setMemoryPersist(enabled) {
    const data = load();
    data[MEMORY_PERSIST_NAMESPACE] = { enabled: Boolean(enabled) };
    save(data);
    return memoryPersistState();
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
    aegisKeySavedAt,
    setAegisKey,
    migrateLegacyAegisKey,
    quickLauncherConfig,
    setQuickLauncherConfig,
    getConfirmMode,
    setConfirmMode,
    getMemoryPersist,
    memoryPersistState,
    setMemoryPersist,
  };
}

module.exports = {
  SETTINGS_FILE,
  AEGIS_KEY_NAMESPACE,
  LEGACY_AEGIS_NAMESPACE,
  QUICK_LAUNCHER_NAMESPACE,
  CONFIRM_MODE_NAMESPACE,
  MEMORY_PERSIST_NAMESPACE,
  DEFAULT_QUICK_LAUNCHER_SHORTCUT,
  RESERVED_NAMESPACES,
  isReservedNamespace,
  maskKey,
  createSettingsStore,
};
