'use strict';

/**
 * Wires the CLI into the same agent-loop engine the desktop app already ships
 * (desktop/lib/local/engine.js): persistent-shell exec, readFile/writeFile/
 * editFile/listDir/glob/grep, and Task subagents.
 *
 * ── the two classes this host runs ──────────────────────────────────────────
 *
 *   aegis  the pooled route. The account's AEGIS key authenticates the call and
 *          pays for it; the pool picks the provider.
 *   byok   "bring your own key". The user's *provider* key authenticates the
 *          upstream call, the account's AEGIS key rides along as X-AEGIS-Key,
 *          and the request goes through the stateless relay
 *          (POST /api/v1/byok/chat/completions, client/aegis.js
 *          byokChatCompletion). The relay charges AEGIS's handling fee on the
 *          turn, which is exactly what makes BYOK billable traffic instead of a
 *          free ride — and why the key must never be handed to a direct provider
 *          call from here.
 *
 * Only those two: `cls` is the engine's own class selector, and the two local
 * classes (ollama, custom endpoints) stay stubs that throw if the engine ever
 * calls them. They need a settings/endpoint surface this host does not offer,
 * and a stub is proof that a code path meant for another host never silently
 * runs here.
 *
 * ── the key store ───────────────────────────────────────────────────────────
 *
 * The 'byok' class reads one row per provider (`byok:<provider>` —
 * desktop/lib/settings.js, the same rows the desktop's Provider settings write)
 * for the provider key. The CLI creates that store itself, without Electron's
 * safeStorage: base64 at rest, file mode 0600, in the CLI's data dir
 * ($AEGISCODE_HOME or ~/.aegiscode). No server-side BYOK mechanism is involved
 * here — that one (/byok-set, services/byok_service.py) stores the key on the
 * AEGIS account and is folded into the pooled route, an unbilled path by
 * design; the two must not be confused.
 */

const os = require('node:os');
const { createLocalEngine, createSettingsStore } = require('./deps.js');
const { credentials } = require('./shared.js');
const VERSION = require('../package.json').version;

/** The classes this host can actually run (see the docstring above). */
const HOST_CLASSES = Object.freeze(['aegis', 'byok']);

/** The class a turn runs on when nothing else is said. */
const DEFAULT_CLASS = 'aegis';

/** One-line labels for /class, the status line and the model picker. */
const CLASS_LABELS = Object.freeze({
  aegis: 'AEGIS Cloud (pooled)',
  byok: 'Bring your own key (relayed, billed)',
});

function unsupported(label) {
  return async () => {
    throw new Error(`aegiscode: ${label} is not available — this client only runs the aegis and byok classes`);
  };
}

/**
 * @param {object} client A client from client/aegis.js (createClient()).
 * @param {() => boolean} getConfirmMode Whether mutating tools (exec,
 *   writeFile, editFile) require approval before running. Read per call, so
 *   toggling it (/permissions, /yolo) takes effect on the next tool round.
 * @param {() => string} getClass Which class the next turn runs on — read per
 *   call for the same reason getConfirmMode is: /class must take effect on the
 *   very next turn, not on the next launch.
 * @param {object} [settings] The provider-config store. Injected by tests
 *   (and by app.js, so one store serves both the engine and the commands);
 *   otherwise created against the CLI's data dir.
 * @returns {{chat: Function, cancel: Function, respondApproval: Function,
 *   clearSessionApprovals: Function, listClasses: Function, listModels: Function,
 *   classLabel: Function, getClass: Function, setClass: Function, settings: object}}
 */
function createEngine({ client, getConfirmMode, getClass, settings: injectedSettings } = {}) {
  const settings = injectedSettings || createSettingsStore({ dir: credentials.aegisHome() });

  const local = createLocalEngine({
    aegis: client,
    settings,
    ollama: {
      probe: async () => ({ running: false }),
      listTags: async () => [],
      chat: unsupported('Ollama'),
    },
    providers: {
      anthropicMessages: unsupported('a custom Anthropic-compatible endpoint'),
      openaiCompatible: unsupported('a custom OpenAI-compatible endpoint'),
    },
    env: {
      platform: process.platform,
      arch: process.arch,
      homedir: os.homedir(),
      cwd: process.cwd(),
      appVersion: `aegiscode v${VERSION}`,
    },
    getConfirmMode,
  });

  /** The live class, clamped to what this host can run. */
  function currentClass() {
    const asked = typeof getClass === 'function' ? getClass() : null;
    return HOST_CLASSES.includes(asked) ? asked : DEFAULT_CLASS;
  }

  return {
    // `class` is stamped here rather than sent by every caller, so the class a
    // turn runs on has exactly one source of truth (the live session state) and
    // a caller cannot accidentally pin a stale one.
    chat: (payload, onDelta) => local.chat({ ...payload, class: currentClass() }, onDelta),
    cancel: local.cancel,
    respondApproval: local.respondApproval,
    clearSessionApprovals: local.clearSessionApprovals,
    // The engine's own class table, narrowed to the two this host runs — so a
    // UI built from listClasses() can never offer a class that would throw.
    // Async, like the local engine's: listClasses() probes Ollama (a live
    // HTTP round-trip) before it can answer, so returning the raw promise made
    // `/class` throw "filter is not a function". The caller awaits it.
    listClasses: async () => (await local.listClasses()).filter((c) => HOST_CLASSES.includes(c.class)),
    listModels: (cls) => local.listModels(cls || currentClass()),
    classLabel: (cls) => CLASS_LABELS[cls] || CLASS_LABELS[DEFAULT_CLASS],
    getClass: currentClass,
    settings,
  };
}

/**
 * The settings row one BYOK provider's key lives in. Exported (rather than
 * spelled out again in commands.js) because it is the SAME key the shared
 * engine reads when it resolves the relay's provider credential — and the same
 * row the desktop's Provider settings write. Two spellings would mean a key
 * saved by `/byok-key openai` never reaching the call that needs it.
 */
function byokNamespace(provider) {
  return `byok:${provider}`;
}

module.exports = { createEngine, HOST_CLASSES, DEFAULT_CLASS, CLASS_LABELS, byokNamespace };
