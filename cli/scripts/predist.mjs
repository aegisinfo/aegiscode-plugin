#!/usr/bin/env node
/**
 * Pre-publish staging for the `aegiscode` package.
 *
 * The CLI is a host, not a fork: it consumes the repo's shared modules
 * (`client/aegis.js` transport, `mcp/tools.js` registry, the desktop's pure
 * `usage.js` mapping) rather than copies of them. npm can only publish a
 * package's own directory, so those files are staged into `cli/vendor/` here,
 * at publish time, keeping the repo's relative shape:
 *
 *   cli/                        repo/
 *     vendor/mcp/tools.js   ≡     mcp/tools.js
 *     vendor/client/*.js    ≡     client/*.js
 *     vendor/desktop/...    ≡     desktop/renderer/usage.js,
 *                                 desktop/lib/local/{engine,tools,shell,agents,prompt}.js
 *
 * The shape matters: `mcp/tools.js` requires `../client/foreign-memory.js`, and
 * because the staged tree mirrors the repo, that path resolves *inside* the
 * vendor tree with no rewrite in either file.
 *
 * `src/deps.js` resolves in-repo paths first and falls back to `vendor/`, so a
 * source checkout and an installed package run identical code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLI_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(CLI_DIR, '..');
const VENDOR = path.join(CLI_DIR, 'vendor');

/** repo-relative -> staged location (same relative shape, under vendor/) */
const FILES = [
  'client/aegis.js',
  'client/update.js',
  'client/foreign-memory.js',
  // The account credential store and the unified session store. Shared with the
  // desktop app and the MCP plugin so all three see one key and one session
  // list; `src/shared.js` resolves them from here in an installed package.
  'client/credentials.js',
  'client/session-store.js',
  'mcp/tools.js',
  'desktop/renderer/usage.js',
  // The agent-loop engine (persistent shell, editFile/grep/exec, Task
  // subagents) the desktop app already ships (desktop/lib/local/). The CLI
  // reuses it as-is, scoped to the 'aegis' class only (see src/engine.js) —
  // one tool loop implementation, not a second one drifting alongside it.
  'desktop/lib/local/engine.js',
  // engine.js requires this at load time to hold a turn cut off at its tool
  // horizon: the interruption is filed against the session and the next turn
  // resumes it instead of starting cold. Staging engine.js without it ships a
  // CLI that throws `Cannot find module './session-rounds.js'` before it can
  // answer anything — the same failure class as the 6.5.6 tarball below.
  'desktop/lib/local/session-rounds.js',
  'desktop/lib/local/tools.js',
  'desktop/lib/local/shell.js',
  'desktop/lib/local/agents.js',
  'desktop/lib/local/prompt.js',
  // The direct-provider transport (openaiCompatible + anthropicMessages) the
  // desktop injects into the engine for its custom-endpoint classes. The CLI's
  // `custom` class (src/engine.js, the /model add catalog) now injects the same
  // real transport instead of the throwing stub it used to, so a user's own
  // base URL + key is called directly with the full tool loop — so this file
  // must ship. Pure node builtins (fetch), stages cleanly.
  'desktop/lib/local/providers.js',
  // The provider-config store: one row per provider (base URL + key), and the
  // row the 'byok' class reads for a per-provider key. The CLI now selects that
  // class (src/engine.js), so it needs the same store the desktop writes —
  // created without a safeStorage argument, which the store already supports
  // (base64 at rest, file mode 0600). Pure node builtins, so it stages cleanly.
  'desktop/lib/settings.js',
  // engine.js requires all three at load time (turn-guard -> git-scope, and
  // worktree-lock), so leaving them out stages a vendor tree whose engine
  // throws MODULE_NOT_FOUND before it can answer anything — which is what
  // test/cli-package.test.mjs caught in the published 6.5.6 tarball.
  'desktop/lib/local/turn-guard.js',
  'desktop/lib/local/worktree-lock.js',
  'desktop/lib/local/git-scope.js',
  // The autonomous work queue (`queue.js`) and its unattended worker
  // (`autonomous.js`), which `src/deps.js` requires at load time along with
  // everything above — a named interface, not a lazy one, so a vendor tree
  // missing either throws MODULE_NOT_FOUND before the CLI can print its usage.
  // `autonomous.js` requires `./queue.js` and `./git-scope.js` at load time and
  // both sit above; `queue.js` requires only node builtins.
  'desktop/lib/local/queue.js',
  'desktop/lib/local/autonomous.js',
];

function main() {
  fs.rmSync(VENDOR, { recursive: true, force: true });
  const staged = [];

  for (const rel of FILES) {
    const from = path.join(REPO_DIR, rel);
    if (!fs.existsSync(from)) {
      console.error(`predist: missing shared module: ${rel} (expected at ${from})`);
      process.exit(1);
    }
    const to = path.join(VENDOR, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const same = fs.readFileSync(from).equals(fs.readFileSync(to));
    if (!same) {
      console.error(`predist: staged copy differs from source: ${rel}`);
      process.exit(1);
    }
    staged.push(`${rel} -> vendor/${rel}`);
  }

  // Prove the staged tree stands on its own: the registry must load and
  // resolve its own dependencies from inside vendor/, not from the repo.
  const toolsPath = path.join(VENDOR, 'mcp', 'tools.js');
  delete require.cache[require.resolve(toolsPath)];
  const { createTools } = require(toolsPath);
  const tools = createTools({
    apiBase: 'http://127.0.0.1',
    apiKey: 'predist-probe',
    randomUUID: () => 'id',
  });
  const count = tools.toolList().length;
  if (count === 0) {
    console.error('predist: staged registry exposes no tools');
    process.exit(1);
  }

  console.log(`predist: staged ${staged.length} shared modules into cli/vendor/`);
  for (const s of staged) console.log(`  ${s}`);
  console.log(`predist: staged registry loads standalone (${count} tools)`);
}

main();
