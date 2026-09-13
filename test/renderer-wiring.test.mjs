#!/usr/bin/env node
/**
 * Wiring guard for desktop/renderer/*.
 *
 * `node --check` proves a file parses; it cannot see an undefined global. That
 * is exactly how stream-policy.js shipped unwired: app.js called shouldFollow()
 * while index.html never loaded the file, so the renderer threw a
 * ReferenceError on the first message paint and the syntax check stayed green.
 *
 * This asserts the two things that catch that class of bug:
 *   1. every renderer/*.js is actually loaded by index.html (no orphan module);
 *   2. the files that declare globals app.js consumes are loaded BEFORE app.js.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..', 'desktop', 'renderer');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const html = readFileSync(join(rendererDir, 'index.html'), 'utf8');

// Script tags in document order — classic scripts execute in this order, so
// order is what decides whether a global exists at call time.
const loaded = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
assert(loaded.length > 0, 'index.html loads at least one script');

// Local (non-vendor) scripts, in load order.
const localLoaded = loaded.filter((s) => !s.startsWith('vendor/'));

// ---------------------------------------------------------- 1. no orphan files
// A renderer/*.js that no entry point loads is dead code at best, and an
// unwired dependency at worst. There are two windows: index.html (main) and
// quick.html (the launcher), each with its own script list — so the orphan
// check spans every *.html in the directory while the order rules below apply
// to index.html specifically.
const htmlFiles = readdirSync(rendererDir).filter((f) => f.endsWith('.html'));
assert(htmlFiles.includes('index.html'), 'index.html is present');

const loadedAnywhere = new Set();
for (const f of htmlFiles) {
  const src = readFileSync(join(rendererDir, f), 'utf8');
  for (const m of src.matchAll(/<script\s+src="([^"]+)"/g)) loadedAnywhere.add(m[1]);
}

const onDisk = readdirSync(rendererDir).filter((f) => f.endsWith('.js'));
const orphans = onDisk.filter((f) => !loadedAnywhere.has(f));
assert(
  orphans.length === 0,
  `renderer/*.js loaded by no *.html entry point (unwired module): ${orphans.join(', ')}`
);

// Every loaded local script must exist.
for (const src of localLoaded) {
  assert(onDisk.includes(src), `index.html loads renderer/${src}, which does not exist`);
}

// ------------------------------------------------- 2. load order before app.js
const appIdx = loaded.indexOf('app.js');
assert(appIdx !== -1, 'index.html loads app.js');
assert(
  appIdx === loaded.length - 1,
  `app.js must be the last script, found ${loaded.slice(appIdx + 1).join(', ')} after it`
);

// ------------------------------------------------- 3. globals resolve at call time
// Top-level declarations of a classic script become globals. Collect them per
// file so we can tell which script must be loaded first.
const DECL = /^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

const declaredBy = new Map(); // name -> file
for (const src of localLoaded) {
  const code = readFileSync(join(rendererDir, src), 'utf8');
  for (const m of code.matchAll(DECL)) {
    if (!declaredBy.has(m[1])) declaredBy.set(m[1], src);
  }
}

const appCode = readFileSync(join(rendererDir, 'app.js'), 'utf8');

// Names app.js references that are declared in a *different* renderer file.
const missing = [];
for (const [name, file] of declaredBy) {
  if (file === 'app.js') continue;
  // Call or read of the name, bounded by a non-identifier char.
  const used = new RegExp(`(^|[^\\w$.])${name}\\b`).test(appCode);
  if (!used) continue;
  if (loaded.indexOf(file) > appIdx) {
    missing.push(`${name} (declared in ${file})`);
  }
}
assert(
  missing.length === 0,
  `app.js uses globals from a script loaded after it: ${missing.join(', ')}`
);

// The specific dependency that shipped broken: app.js must consume the
// stream-policy helpers, and that file must precede it.
for (const name of ['nearBottom', 'shouldFollow', 'isCancellation']) {
  assert(declaredBy.get(name) === 'stream-policy.js', `${name} is declared by stream-policy.js`);
  assert(
    loaded.indexOf('stream-policy.js') < appIdx,
    `stream-policy.js must load before app.js (${name})`
  );
  assert(
    new RegExp(`(^|[^\\w$.])${name}\\b`).test(appCode),
    `app.js actually calls ${name}`
  );
}

console.log(
  `renderer wiring tests passed (${localLoaded.length} local scripts, ` +
    `${declaredBy.size} globals, no orphans)`
);
