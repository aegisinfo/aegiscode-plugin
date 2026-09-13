'use strict';

/**
 * Wires the CLI into the same agent-loop engine the desktop app already
 * ships (desktop/lib/local/engine.js, commit e4b0a9a): persistent-shell exec,
 * readFile/writeFile/editFile/listDir/glob/grep, and Task subagents. This
 * host only ever selects the 'aegis' class (it authenticates with an AEGIS
 * key, not a local Ollama/BYOK endpoint), so the other three classes'
 * dependencies (settings store, Ollama probe, custom-endpoint providers) are
 * unreachable and stay stubs that throw if the engine ever calls them —
 * proof that a code path meant only for those classes never silently runs
 * here instead.
 */

const os = require('node:os');
const { createLocalEngine } = require('./deps.js');
const VERSION = require('../package.json').version;

function unsupported(label) {
  return async () => {
    throw new Error(`aegiscode: ${label} is not available — this client only runs the aegis class`);
  };
}

/**
 * @param {object} client A client from client/aegis.js (createClient()).
 * @param {() => boolean} getConfirmMode Whether mutating tools (exec,
 *   writeFile, editFile) require approval before running. Read per call, so
 *   toggling it (/permissions, /yolo) takes effect on the next tool round.
 */
function createEngine({ client, getConfirmMode }) {
  const local = createLocalEngine({
    aegis: client,
    settings: { get: () => ({}), rawKey: unsupported('BYOK/custom endpoints') },
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

  return {
    chat: (payload, onDelta) => local.chat({ ...payload, class: 'aegis' }, onDelta),
    cancel: local.cancel,
    respondApproval: local.respondApproval,
    clearSessionApprovals: local.clearSessionApprovals,
  };
}

module.exports = { createEngine };
