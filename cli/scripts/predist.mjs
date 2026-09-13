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
 *     vendor/desktop/...    ≡     desktop/renderer/usage.js
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
  'client/foreign-memory.js',
  'mcp/tools.js',
  'desktop/renderer/usage.js',
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
