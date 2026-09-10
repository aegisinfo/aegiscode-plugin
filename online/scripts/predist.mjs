#!/usr/bin/env node
/**
 * Pre-distribution step (aegis-online): stage the shared thin transport into
 * the online/ dir so the browser SPA can load it with a single <script> tag.
 *
 * index.html loads ./vendor/aegis.js (which exposes window.AegisClient). The
 * file is the SAME transport as client/aegis.js — never brain logic. Keeping
 * it as a byte-identical vendor copy lets CI `cmp` the two so drift fails the
 * build (mirrors desktop/scripts/predist.mjs).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const online = join(here, '..');
const repo = join(online, '..');
const destDir = join(online, 'vendor');

const staged = [['client', 'aegis.js']];

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
