#!/usr/bin/env node
/**
 * Smoke test for the aegis-online browser host (Phase O3,
 * docs/aegis-online-host-plan.md).
 *
 * No browser is booted here (that's covered manually / by a future headless
 * run) — this asserts the static shape a browser would load: the vendored
 * transport stays byte-identical to the tracked source, the page actually
 * wires up window.AegisClient, and the CSP meta tag is present so the host
 * never silently ships without it.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readFileSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { fileURLToPath } = require('node:url');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// online/vendor/ is gitignored (predist.mjs regenerates it from
// client/aegis.js on every build) — same convention as desktop/vendor/, see
// aegis-reasoning.test.mjs. Skipped when absent; that is not a failure, it
// just means predist hasn't run on this checkout yet.
const vendorPath = join(repoRoot, 'online', 'vendor', 'aegis.js');
if (existsSync(vendorPath)) {
  const src = readFileSync(join(repoRoot, 'client', 'aegis.js'), 'utf8');
  const vendor = readFileSync(vendorPath, 'utf8');
  assert(
    src === vendor,
    'online/vendor/aegis.js has drifted from client/aegis.js — re-run online/scripts/predist.mjs',
  );
  console.log('  vendor: byte-identical to client/aegis.js');
} else {
  console.log('  vendor: skipped (online/vendor/aegis.js not staged on this checkout)');
}

const html = readFileSync(join(repoRoot, 'online', 'index.html'), 'utf8');
const appJs = readFileSync(join(repoRoot, 'online', 'app.js'), 'utf8');

assert(html.includes('vendor/aegis.js'), 'index.html must load the vendored transport script');
assert(html.includes('app.js'), 'index.html must load app.js');
assert(
  /Content-Security-Policy/.test(html) && /script-src[^;"]*'self'/.test(html),
  'index.html must ship a CSP meta tag restricting script-src to \'self\'',
);
assert(
  appJs.includes('window.AegisClient'),
  'app.js must reference window.AegisClient (the shared transport, not a re-implementation)',
);

// The hard boundary (plan §"Hard boundary"): no brain/orchestration logic may
// ever enter online/, same rule the thin-shell guard enforces for desktop/.
const banned = ['SaaS.js', 'chat-engine', 'chat-service.js', 'lib/memory'];
for (const name of banned) {
  assert(!appJs.includes(name), `app.js references a banned brain artifact: ${name}`);
}

console.log('  index.html: loads vendor + app.js, CSP present');
console.log('  app.js: uses window.AegisClient, no brain-artifact references');
console.log('aegis-online smoke test: OK');
