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
  // Phase 6: the full model table (seeded from src/models.js MODELS on first
  // read by pickerModels()). 'currentModelId' mirrors `model` under the
  // aegiscode- name so /model add/remove/switch stay compatible both ways.
  models: null,
  currentModelId: null,
  // `null` = no effort pinned, i.e. "auto": each turn is sized by the server
  // from the ask itself (aegis1 services/pool_brain.py estimate_effort). The
  // old 'high' was a *pin* on the top rung of the budget ladder — the most the
  // server can grant — so the CLI's default turn was the most expensive one it
  // could make, and /effort could only ever move it down.
  effort: null,
  vim: false,
  lastCwd: '',
};

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
  DEFAULT_PERMISSIONS,
  loadPermissions,
  savePermissions,
  addPermissionRule,
  removePermissionRule,
};
