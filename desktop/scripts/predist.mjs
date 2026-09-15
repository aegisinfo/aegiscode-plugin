#!/usr/bin/env node
/**
 * Pre-distribution step (Phase D3): stage the shared thin transport into the
 * app dir so the packaged app is self-contained.
 *
 * main.js resolves ../client/aegis.js in the repo (dev / CI / smoke tests) and
 * falls back to ./vendor/aegis.js when packaged — electron-builder cannot
 * reach files outside the app directory, so before every build we copy the
 * same thin client here. It is the same transport file, never brain logic.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const repo = join(desktop, '..');
const destDir = join(desktop, 'vendor');

// Files that live at the repo root (shared with the CLI/MCP host) but must be
// present inside the app dir, because electron-builder cannot reach outside it.
const staged = [
  ['client', 'aegis.js'],
  // The npm update checker — the desktop's own update path (see main.js).
  ['client', 'update.js'],
  ['client', 'foreign-memory.js'],
  // The shared account-credential store and the unified session store. Both are
  // pure Node, and both are read by the terminal host and the MCP plugin too —
  // they are staged here for the same reason the client is: the packaged app
  // cannot reach outside its own directory.
  ['client', 'credentials.js'],
  ['client', 'session-store.js'],
];

mkdirSync(destDir, { recursive: true });

for (const segments of staged) {
  const src = join(repo, ...segments);
  const dest = join(destDir, segments[segments.length - 1]);
  if (!existsSync(src)) {
    throw new Error(`shared file not found at ${src} — run from the repo root`);
  }
  copyFileSync(src, dest);
  console.log(`staged ${dest}`);
}
