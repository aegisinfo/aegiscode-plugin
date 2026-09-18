'use strict';

/**
 * Where the CLI finds the modules it shares with the rest of the repo.
 *
 * Two layouts must work:
 *
 *   in-repo   <repo>/cli/src/deps.js   -> <repo>/client/aegis.js, <repo>/mcp/tools.js
 *   npm       <pkg>/src/deps.js        -> <pkg>/vendor/{client,mcp,desktop}/...
 *
 * The published package is staged by `scripts/predist.mjs` into `cli/vendor/`
 * keeping the repo's own relative shape, so nothing here (or in the copied
 * files) needs a path rewrite — `vendor/mcp/tools.js` requiring
 * `../client/foreign-memory.js` resolves inside the vendor tree by construction.
 *
 * Resolution is by existence, and a missing module is a loud error rather than
 * a silent fallback to a second copy: duplicate transports are how the two
 * hosts would drift.
 */

const fs = require('node:fs');
const path = require('node:path');

function roots() {
  const srcDir = __dirname; // <root>/cli/src
  const cliDir = path.join(srcDir, '..');
  return [
    path.join(srcDir, '..', '..'), // repo root (in-repo layout)
    path.join(cliDir, 'vendor'), // staged tree (published layout)
  ];
}

/** Resolve a repo-relative module path against whichever root has it. */
function resolveShared(relPath) {
  for (const root of roots()) {
    const candidate = path.join(root, relPath);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `aegiscode: cannot find ${relPath}. Expected it beside cli/ (in the repo) or ` +
      'under cli/vendor/ (installed package). Reinstall the package, or run ' +
      '`node scripts/predist.mjs` from cli/ if this is a source checkout.'
  );
}

const clientPath = resolveShared(path.join('client', 'aegis.js'));
const toolsPath = resolveShared(path.join('mcp', 'tools.js'));
// The desktop's pure usage module is the single source of truth for turning a
// provider's usage object into a display number. The CLI reuses the same file
// instead of re-implementing the mapping, so the terminal and the GUI can never
// disagree about what a call consumed (test/cli-tools.test.mjs asserts the
// function identity).
const usagePath = resolveShared(path.join('desktop', 'renderer', 'usage.js'));
// The desktop's agent-loop engine — persistent-shell exec, editFile/grep,
// Task subagents — reused verbatim (src/engine.js scopes it to the 'aegis'
// class) so the CLI's chat loop is the same tool loop as the GUI's, not a
// second implementation that can drift out of step with it.
const enginePath = resolveShared(path.join('desktop', 'lib', 'local', 'engine.js'));
// The provider-config store the desktop's settings pane writes (one row per
// provider: base URL + key, 0600 on disk). The CLI reads the same file for the
// 'byok' class' per-provider keys, so a key saved in either host is the same
// key — and so there is one implementation of "where a provider key lives"
// rather than a second one that drifts.
const settingsPath = resolveShared(path.join('desktop', 'lib', 'settings.js'));
// Subagent role presets (/agents lists these; the model's task tool delegates
// to them by name) — lives beside engine.js, staged into the same vendor dir.
const agentsPath = resolveShared(path.join('desktop', 'lib', 'local', 'agents.js'));
// The persona the tool loop runs under. The CLI sent NO system prompt at all,
// so a pooled turn reached the model as a bare user message plus tool schemas
// with nothing saying when a tool is appropriate — which is how "hey" started
// running shell commands. Same file as the GUI, for the same reason engine.js
// is: two personas would drift, and only one of them would get fixed.
const promptPath = resolveShared(path.join('desktop', 'lib', 'local', 'prompt.js'));
// The npm update checker, shared with the desktop host: two package names, one
// implementation, so a fix to the check reaches both.
const updatePath = resolveShared(path.join('client', 'update.js'));
// The autonomous work queue: the durable task list (`queue.js`) and the
// unattended worker that drives the same engine (`autonomous.js`). Shared with
// the desktop host rather than reimplemented, for the reason engine.js is —
// `aegiscode autonomous proceed` on a systemd timer and the GUI's Drain button
// must work the SAME queue with the SAME rules (scoped commits included).
const queuePath = resolveShared(path.join('desktop', 'lib', 'local', 'queue.js'));
const autonomousPath = resolveShared(path.join('desktop', 'lib', 'local', 'autonomous.js'));
// The direct-provider transport (openaiCompatible + anthropicMessages). The
// desktop injects it into createLocalEngine for its custom-endpoint classes;
// the CLI injects the same real module for its `custom` class (the /model add
// catalog) rather than the throwing stub it shipped before.
const providersPath = resolveShared(path.join('desktop', 'lib', 'local', 'providers.js'));

const { createClient } = require(clientPath);
const { createTools } = require(toolsPath);
const { usageTokens } = require(usagePath);
const { createLocalEngine } = require(enginePath);
const providers = require(providersPath);
const { createSettingsStore, isReservedNamespace } = require(settingsPath);
const { agentRoles, agentRoleLabel } = require(agentsPath);
const { buildSystemPrompt } = require(promptPath);
const updater = require(updatePath);
const queue = require(queuePath);
const autonomous = require(autonomousPath);

module.exports = {
  resolveShared,
  createClient,
  createTools,
  usageTokens,
  createLocalEngine,
  providers,
  createSettingsStore,
  isReservedNamespace,
  agentRoles,
  agentRoleLabel,
  buildSystemPrompt,
  updater,
  queue,
  autonomous,
  paths: { client: clientPath, tools: toolsPath, usage: usagePath, engine: enginePath, providers: providersPath, settings: settingsPath, agents: agentsPath, prompt: promptPath, update: updatePath, queue: queuePath, autonomous: autonomousPath },
  roots,
};
