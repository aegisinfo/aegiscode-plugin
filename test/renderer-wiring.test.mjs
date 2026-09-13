#!/usr/bin/env node
/**
 * Wiring guard for desktop/renderer/*.
 *
 * `node --check` proves a file parses; it cannot see an undefined global. That
 * is exactly how stream-policy.js shipped unwired: app.js called shouldFollow()
 * while index.html never loaded the file, so the renderer threw a
 * ReferenceError on the first message paint and the syntax check stayed green.
 *
 * This asserts:
 *   1. every renderer/*.js is loaded by some *.html entry point (no orphan);
 *   2. each entry point loads only its own scripts (index.html vs quick.html);
 *   3. a script is always loaded before the scripts that consume its globals —
 *      including a renderer script consuming another renderer script, which is
 *      how transcript-view.js depends on stream-policy.js;
 *   4. the specific wiring the transcript policy depends on, so an
 *      "Escape is unbound" or "the veto moved back into app.js" edit fails here
 *      as well as behaviourally in renderer-dom.test.mjs.
 *
 * The behavioural half lives in test/renderer-dom.test.mjs (rafPainter
 * coalescing, follow-only-at-tail, Escape → stopPendingTurn). This file is the
 * static half: it is what fails when a script tag goes missing.
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
const quickHtml = readFileSync(join(rendererDir, 'quick.html'), 'utf8');

// Script tags in document order — classic scripts execute in this order, so
// order is what decides whether a global exists at call time.
const scriptSrcs = (src) => [...src.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
const loaded = scriptSrcs(html);
assert(loaded.length > 0, 'index.html loads at least one script');

// Local (non-vendor) scripts, in load order.
const localLoaded = loaded.filter((s) => !s.startsWith('vendor/'));

// ---------------------------------------------------------- 1. no orphan files
// A renderer/*.js that no entry point loads is dead code at best, and an
// unwired dependency at worst. There are two windows — index.html (main) and
// quick.html (the launcher) — each with its own script list, so the orphan
// check spans every *.html in the directory while the order rules below apply
// to index.html specifically.
const htmlFiles = readdirSync(rendererDir).filter((f) => f.endsWith('.html'));
assert(htmlFiles.includes('index.html'), 'index.html is present');
assert(htmlFiles.includes('quick.html'), 'quick.html is present');

const loadedAnywhere = new Set();
for (const f of htmlFiles) {
  for (const src of scriptSrcs(readFileSync(join(rendererDir, f), 'utf8'))) loadedAnywhere.add(src);
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

// --------------------------------------------------- 2. one script, one window
// quick.js belongs to quick.html, the second window entry point. Loading it in
// the main window (or leaving it out of the quick window) has already shipped
// once as a launch-crashing regression, so the ownership is explicit.
assert(
  loadedAnywhere.has('quick.js'),
  'quick.js must be loaded by an entry point (quick.html)'
);
assert(
  !loaded.includes('quick.js'),
  'index.html must not load quick.js — it belongs to quick.html, the launcher window'
);
assert(
  scriptSrcs(quickHtml).includes('quick.js'),
  'quick.html loads quick.js'
);

// ------------------------------------------------- 3. load order before app.js
const appIdx = loaded.indexOf('app.js');
assert(appIdx !== -1, 'index.html loads app.js');
assert(
  appIdx === loaded.length - 1,
  `app.js must be the last script, found ${loaded.slice(appIdx + 1).join(', ')} after it`
);

// ------------------------------------------------- 4. globals resolve at call time
// Top-level declarations of a classic script become globals (and share one
// global lexical environment with every other script on the page). Collect them
// per file so we can tell which script must be loaded first.
//
// Two things this has to get right, or the check cries wolf:
//   - a file whose whole body is an IIFE (app.js) declares *no* globals — its
//     `const aegis`/`let transcript` live in a function scope;
//   - comments name these symbols all the time ("the rule itself is
//     `shouldFollow`…"), so both declaration scanning and reference scanning run
//     on comment-stripped source.
const DECL = /^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const IIFE = /^\s*(?:\(\s*function|!\s*function|\(\s*\(\s*\)\s*=>)/;

/** Strip // and /* *\/ comments, leaving string/regex literals intact. */
function stripComments(code) {
  let out = '';
  let i = 0;
  let prev = ''; // last significant character, to tell a regex from division
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i += 1;
      while (i < code.length) {
        if (code[i] === '\\') {
          out += code[i] + (code[i + 1] || '');
          i += 2;
          continue;
        }
        out += code[i];
        if (code[i] === c) {
          i += 1;
          break;
        }
        i += 1;
      }
      prev = c;
      continue;
    }
    if (c === '/' && /[=(,:;[!&|?{}]/.test(prev || '')) {
      // Regex literal: skip to the unescaped closing slash.
      out += c;
      i += 1;
      while (i < code.length && code[i] !== '/') {
        if (code[i] === '\\') i += 1;
        i += 1;
      }
      out += code[i] || '';
      i += 1;
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

const code = new Map(); // file -> comment-stripped source
for (const src of localLoaded) code.set(src, stripComments(readFileSync(join(rendererDir, src), 'utf8')));

const declaredBy = new Map(); // name -> first file that declares it globally
for (const src of localLoaded) {
  const body = code.get(src);
  // A leading 'use strict'; prologue (app.js) precedes the wrapper.
  const head = body.replace(/^\s*['"]use strict['"]\s*;?/, '');
  if (IIFE.test(head)) continue; // scoped wrapper: nothing reaches the global env
  for (const m of body.matchAll(DECL)) {
    if (!declaredBy.has(m[1])) declaredBy.set(m[1], src);
  }
}

/** Reference to `name` in `body`, bounded so `nearBottomX`/`a.nearBottom` don't count. */
const references = (body, name) => new RegExp(`(^|[^\\w$.])${name}\\b`).test(body);

// Every consumer of a cross-file global must be loaded after its declaration.
// This generalises the original app.js-only rule: renderer scripts consume each
// other too (transcript-view.js calls stream-policy.js's shouldFollow).
const missing = [];
for (const src of localLoaded) {
  const body = code.get(src);
  for (const [name, file] of declaredBy) {
    if (file === src) continue;
    if (!references(body, name)) continue;
    if (loaded.indexOf(file) > loaded.indexOf(src)) {
      missing.push(`${name} (declared in ${file}) used by ${src}`);
    }
  }
}
assert(
  missing.length === 0,
  `renderer scripts use globals from a script loaded after them: ${missing.join(', ')}`
);

const appCode = code.get('app.js');

// The specific dependency that shipped broken: the streaming decisions must be
// declared by stream-policy.js, loaded before the scripts that call them.
for (const name of ['nearBottom', 'shouldFollow', 'isCancellation']) {
  assert(declaredBy.get(name) === 'stream-policy.js', `${name} is declared by stream-policy.js`);
  assert(
    loaded.indexOf('stream-policy.js') < appIdx,
    `stream-policy.js must load before app.js (${name})`
  );
}
assert(
  references(code.get('transcript-view.js'), 'shouldFollow') &&
    references(code.get('transcript-view.js'), 'nearBottom'),
  'transcript-view.js must call stream-policy.js decisions (shouldFollow/nearBottom), not reimplement them'
);

// Phase 8 extraction: the DOM half of the streaming policy. It must be loaded
// by index.html, ahead of app.js, and app.js must actually call into it —
// otherwise the behavioural tests in renderer-dom.test.mjs prove nothing about
// the shipped renderer.
assert(declaredBy.get('createTranscriptView') === 'transcript-view.js', 'createTranscriptView is declared by transcript-view.js');
assert(declaredBy.get('bindEscapeInterrupt') === 'transcript-view.js', 'bindEscapeInterrupt is declared by transcript-view.js');
assert(onDisk.includes('transcript-view.js'), 'transcript-view.js is on disk');
for (const name of ['createTranscriptView', 'bindEscapeInterrupt']) {
  assert(
    loaded.indexOf('transcript-view.js') < appIdx,
    `transcript-view.js must load before app.js (${name})`
  );
  assert(references(appCode, name), `app.js actually calls ${name}`);
}

// ------------------------------------------------- 5. the two symptom guards
// 5a. Escape → stopPendingTurn. The listener itself lives in transcript-view.js
//     and is asserted behaviourally; here we pin the wiring app.js hands it, so
//     pointing Escape at something else (or at nothing) cannot pass silently.
assert(
  /bindEscapeInterrupt\(\{/.test(appCode),
  'app.js binds the Escape interrupt'
);
assert(
  /stopTurn:\s*stopPendingTurn\b/.test(appCode),
  'Escape must reach stopPendingTurn — the same call the cancel button makes'
);
assert(
  /hasPendingTurn:\s*\(\)\s*=>\s*!!pendingSessionId/.test(appCode),
  'Escape only interrupts a turn that is actually pending'
);
assert(
  /isOverlayOpen:\s*overlayOpen\b/.test(appCode),
  'the memory overlay keeps precedence over Escape-as-interrupt'
);
// A deliberate stop must stay distinguishable from a failure, or the abort the
// user asked for is reported as an error and the partial answer is discarded.
assert(
  /function stopPendingTurn\(\)[\s\S]*?userStopped\s*=\s*true[\s\S]*?models\.cancel\(/.test(appCode),
  'stopPendingTurn records userStopped before aborting the transport'
);
assert(
  /isCancellation\(err,\s*\{\s*userStopped\s*\}\)/.test(appCode),
  "send()'s catch classifies the abort with isCancellation(err, { userStopped })"
);

// 5b. The reader's veto. It must be registered by transcript-view.js
//     (attachScrollVeto → a passive scroll listener) and not re-implemented or
//     bypassed in app.js: a second scroll listener with its own copy of the
//     flag is how the veto silently stops applying.
assert(
  /\btranscript\.attachScrollVeto\(/.test(appCode),
  'app.js installs the scroll veto via transcript.attachScrollVeto()'
);
assert(
  !/addEventListener\(\s*'scroll'/.test(appCode),
  "app.js must not register its own 'scroll' listener — the veto lives in transcript-view.js"
);
assert(
  !/\buserScrolledUp\b/.test(appCode),
  'app.js must not carry its own userScrolledUp flag — it lives in transcript-view.js'
);
assert(
  /createTranscriptView\(\{[\s\S]*?messages:\s*els\.messages[\s\S]*?requestFrame:/.test(appCode),
  'the transcript view is built with the real transcript element and the window frame clock'
);

console.log(
  `renderer wiring tests passed (${localLoaded.length} local scripts, ` +
    `${declaredBy.size} globals, no orphans, transcript policy wired)`
);
