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
  ['client', 'foreign-memory.js'],
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
