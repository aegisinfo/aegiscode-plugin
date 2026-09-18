'use strict';

/**
 * User config + permissions persistence (~/.aegiscode/config.json and
 * permissions.json). Honors AEGISCODE_HOME so tests and side-by-side installs
 * can redirect the data dir. Reads and writes are best-effort: a corrupt
 * config falls back to defaults, and write failures never crash the session.
 *
 * Ported from aegiscodex-dev/src/config.js (ESM → CommonJS). The data dir was
 * renamed ~/.aegiscodex → ~/.aegiscode and the override env var
 * AEGISCODEX_HOME → AEGISCODE_HOME; `aegisDir` is the one shared helper every
 * other module imports rather than recomputing the path.
 */

const fs = require('node:fs');
const path = require('node:path');

// The data dir is defined once, in the shared credential module, because the
// desktop app and the MCP plugin now read and write the same store: a second
// definition here is how the hosts would drift back apart.
const { credentials } = require('./shared.js');

/** Data directory: $AEGISCODE_HOME or ~/.aegiscode (see client/credentials.js). */
function aegisDir(env) {
  return credentials.aegisHome(env);
}

function configPath() {
  return path.join(aegisDir(), 'config.json');
}

/**
 * True once the user has run before — the config file is written during
 * onboarding (and on the first preference change). Used to gate the trust
 * check + theme picker to a genuine first run: re-showing them every launch
 * wiped the screen with the theme picker and discarded the prior session.
 */
function configExists() {
  try { return fs.existsSync(configPath()); } catch { return false; }
}

function permissionsPath() {
  return path.join(aegisDir(), 'permissions.json');
}

const DEFAULT_CONFIG = {
  themeIndex: 1,   // Dark mode
  // Cached `{ checkedAt, latest }` from the once-a-day registry check (see
  // src/update.js). Persisted so a launch reports what the LAST run learned
  // and never waits on the network to draw its own welcome box.
  updateCheck: null,
  // No pinned model. This host runs on AEGIS Cloud, whose pinnable ids are the
  // server's (`/models`) — a client-side default here would have to name one,
  // and the one it named (`sonnet`) is not advertised by the platform at all:
  // the pool accepts an unknown id and answers from its own default with no
  // error, so the pin looked honoured while the reply came from another model.
  // Worse, onboarding persists this object on first run (`updateConfig` merges
  // DEFAULT_CONFIG under the patch), so the phantom pin was written to disk for
  // every user who ever completed the trust check. `null` = no pin; the server
  // chooses, and app.js's validatePinnedModel() clears a stored id the catalog
  // does not advertise.
  model: null,
  // Which class turns run on: 'aegis' (the pool, authenticated and paid for by
  // the account key) or 'byok' (the user's own provider key, relayed and billed
  // a handling fee). Persisted so `/class byok` survives a restart — a class
  // choice that silently reverted would send the next launch's turn somewhere
  // the user did not choose, and on a BYOK setup there is no pooled key to fall
  // back to. Defaulted to the pooled class, which is the only one an account
  // key alone can run.
  modelClass: 'aegis',
  // Phase 6: the full model table (seeded from src/models.js MODELS on first
  // read by pickerModels()). 'currentModelId' mirrors `model` under the
  // aegiscode- name so /model add/remove/switch stay compatible both ways.
  models: null,
  currentModelId: null,
  // The named custom-model catalog behind the `custom` class — the
  // aegiscodex-dev `/model add` concept: each entry names an endpoint the user
  // brings themselves (own base URL + own key), called DIRECTLY through the
  // desktop transport (providers.openaiCompatible / anthropicMessages), tools
  // and all, never through the pooled route or the BYOK relay. Only the
  // non-secret metadata lives here; the key is in the 0600 settings store under
  // `custom:<id>` (engine.js), never in this file (config.json is not 0600 and
  // participates in cloud sync). Shape: [{ id, name, model, baseURL, wire }],
  // wire ∈ {'openai','anthropic'}.
  customModels: [],
  // `null` = no effort pinned, i.e. "auto": each turn is sized by the server
  // from the ask itself (aegis1 services/pool_brain.py estimate_effort). The
  // old 'high' was a *pin* on the top rung of the budget ladder — the most the
  // server can grant — so the CLI's default turn was the most expensive one it
  // could make, and /effort could only ever move it down.
  effort: null,
  vim: false,
  lastCwd: '',
};

// ── persisting memory (the WRITE half of aegis_memory) ──────────────────────

/**
 * Cross-session memory has two halves. The READ half (`aegis_recall`) is sent
 * unconditionally by both hosts — it is cheap, it is what lets an interrupted
 * turn be picked up in a later session, and it is free on every plan. The
 * WRITE half is what actually stored anything, and it used to sit behind
 * `cloudSync`, which is absent (i.e. off) on every fresh install. That is the
 * defect this key replaces: the copy promises "cross-session memory free with
 * any account", the read half shipped to everybody, and the write half — the
 * half that makes the promise true — was opt-in and undiscoverable.
 *
 * So the gate is now `memoryPersist` and it defaults ON. It stays a real gate:
 * `/cloud memory off` (or `/sync off`) writes it false, and this resolver
 * honours it. The write half also has a price, so the ceiling is surfaced
 * rather than guessed at — aegis1 meters WRITES only (FREE_SYNC_TOKENS = 1 MB,
 * PRO_SYNC_TOKENS = 10 MB); reads keep working past it. `/cloud memory` and the
 * first-run notice state that in those words.
 *
 * Migration, not a reset. `loadConfig()` merges DEFAULT_CONFIG under the parsed
 * file, so the *absence* of a key cannot be told from a default once merged —
 * that is why this resolver reads the raw values in the order below instead of
 * checking a merged boolean:
 *
 *   memoryPersist (explicit)  →  cloudSync (an explicit pre-flip choice)
 *   →  MEMORY_PERSIST_DEFAULT (on)
 *
 * An explicit `cloudSync: false` on disk therefore stays off (nobody who turned
 * sync off gets quietly opted back in), an explicit `cloudSync: true` stays on,
 * and a config with neither key becomes on. `setMemoryPersist()` then removes
 * the legacy key, so the choice exists in exactly one place from then on.
 */
const MEMORY_PERSIST_KEY = 'memoryPersist';
const LEGACY_MEMORY_PERSIST_KEY = 'cloudSync';
const MEMORY_PERSIST_DEFAULT = true;

/**
 * Resolve the write half, with where the answer came from.
 *
 * @param {object} [cfg] a loaded config (defaults to `loadConfig()`).
 * @returns {{enabled:boolean, source:'config'|'legacy'|'default'}}
 *          `explicit` is true for the first two — that is the distinction the
 *          status panels need to say "you turned this off" vs "this is the
 *          default", which is the difference between a setting and a rumour.
 */
function memoryPersistState(cfg) {
  let c = cfg;
  if (!c) {
    try {
      c = loadConfig();
    } catch {
      return { enabled: MEMORY_PERSIST_DEFAULT, source: 'default', explicit: false };
    }
  }
  if (c && typeof c[MEMORY_PERSIST_KEY] === 'boolean') {
    return { enabled: c[MEMORY_PERSIST_KEY], source: 'config', explicit: true };
  }
  if (c && typeof c[LEGACY_MEMORY_PERSIST_KEY] === 'boolean') {
    return { enabled: c[LEGACY_MEMORY_PERSIST_KEY], source: 'legacy', explicit: true };
  }
  return { enabled: MEMORY_PERSIST_DEFAULT, source: 'default', explicit: false };
}

/** True when this host should persist memory (default on — see above). */
function memoryPersistEnabled(cfg) {
  return memoryPersistState(cfg).enabled;
}

/**
 * Persist the flip, and retire the legacy key in the same write so the two can
 * never disagree. `undefined` (not `false`) is what removes a key through
 * JSON.stringify — writing `false` would look like an explicit opt-out under
 * the legacy name.
 */
function setMemoryPersist(on) {
  return updateConfig({
    [MEMORY_PERSIST_KEY]: on === true,
    [LEGACY_MEMORY_PERSIST_KEY]: undefined,
  });
}

/** Read the config, falling back to defaults (never throws). */
function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { ...DEFAULT_CONFIG, ...parsed };
  } catch {}
  return { ...DEFAULT_CONFIG };
}

/**
 * Merge a patch into the config on disk and return the merged config.
 * A no-op that still returns the merged view when the data dir is unwritable.
 */
function updateConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  try {
    fs.mkdirSync(aegisDir(), { recursive: true });
    // Write atomically-ish: tmp file + rename so a crash can't corrupt it.
    const tmp = configPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, configPath());
  } catch (e) {
    if (process.env.AEGIS_HIST_DEBUG) console.error('[config] write failed:', e);
  }
  return next;
}

// ── Permissions (~/.aegiscode/permissions.json) ─────────────────────────────

const DEFAULT_PERMISSIONS = {
  defaultMode: 'ask', // 'ask' | 'allow' | 'deny'
  allow: [],          // ["Bash(npm run *)", "Edit(src/**)"]
  deny: [],
  ask: [],
};

/**
 * Read permission rules, falling back to the empty default (never throws).
 * `explicitAsk` is true only when the permissions file *explicitly* writes
 * `"defaultMode": "ask"`. The file-free default is also 'ask', but it must
 * not trigger a prompt on every call out of the box — evalPermission only
 * consults explicitAsk, so the distinction matters.
 */
function loadPermissions() {
  try {
    const raw = fs.readFileSync(permissionsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        ...DEFAULT_PERMISSIONS,
        allow: Array.isArray(parsed.allow) ? parsed.allow : [],
        deny: Array.isArray(parsed.deny) ? parsed.deny : [],
        ask: Array.isArray(parsed.ask) ? parsed.ask : [],
        defaultMode: parsed.defaultMode || DEFAULT_PERMISSIONS.defaultMode,
        explicitAsk: parsed.defaultMode === 'ask',
      };
    }
  } catch {}
  return { ...DEFAULT_PERMISSIONS, allow: [], deny: [], ask: [], explicitAsk: false };
}

/** Persist permission rules. Returns the saved rules (or the input on failure). */
function savePermissions(rules) {
  try {
    fs.mkdirSync(aegisDir(), { recursive: true });
    const tmp = permissionsPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rules, null, 2) + '\n');
    fs.renameSync(tmp, permissionsPath());
  } catch (e) {
    if (process.env.AEGIS_HIST_DEBUG) console.error('[permissions] write failed:', e);
  }
  return rules;
}

/**
 * Add a rule to a permission list if not already present.
 * Returns { added, rules } — added is false when the rule already exists.
 */
function addPermissionRule(list, pattern, rules) {
  const key = list === 'allow' || list === 'deny' || list === 'ask' ? list : 'allow';
  const patterns = rules[key];
  if (patterns.includes(pattern)) return { added: false, rules };
  return { added: true, rules: { ...rules, [key]: [...patterns, pattern] } };
}

/** Remove a rule from a permission list. Returns { removed, rules }. */
function removePermissionRule(list, pattern, rules) {
  const key = list === 'allow' || list === 'deny' || list === 'ask' ? list : 'allow';
  const patterns = rules[key].filter((p) => p !== pattern);
  return { removed: patterns.length !== rules[key].length, rules: { ...rules, [key]: patterns } };
}

module.exports = {
  aegisDir,
  configPath,
  configExists,
  permissionsPath,
  DEFAULT_CONFIG,
  loadConfig,
  updateConfig,
  MEMORY_PERSIST_KEY,
  LEGACY_MEMORY_PERSIST_KEY,
  MEMORY_PERSIST_DEFAULT,
  memoryPersistState,
  memoryPersistEnabled,
  setMemoryPersist,
  DEFAULT_PERMISSIONS,
  loadPermissions,
  savePermissions,
  addPermissionRule,
  removePermissionRule,
};
