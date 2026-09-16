#!/usr/bin/env node
/**
 * Packaging-boundary test — the staged `vendor/` set vs what the asar ships.
 *
 * The bug this locks down: `desktop/scripts/predist.mjs` stages five shared
 * files into `desktop/vendor/` (aegis, credentials, foreign-memory,
 * session-store, update), but `desktop/electron-builder.yml` `files:` listed
 * only two of them. electron-builder cannot reach outside the app dir, so the
 * app resolves shared code through `vendor/` when packaged — and an unlisted
 * file is simply not in the asar.
 *
 * That failure is silent in the exact place it matters:
 *
 *   - `vendor/credentials.js` is required by main.js with NO inner fallback
 *     (the outer `catch` re-throws), so the packaged app died at module load
 *     with MODULE_NOT_FOUND before it ever drew a window;
 *   - `vendor/update.js` is required lazily inside a function, where the
 *     nested try/catch swallows it, so the update checker just sat at
 *     `disabled` on every packaged build — the visible symptom that started
 *     this.
 *
 * `github-release.yml`-built installers are the only place this shows up, so
 * nothing in the local dev loop catches it. Hence this test derives everything
 * from the real sources instead of restating the lists:
 *
 *   1. every file predist stages must be matched by an electron-builder glob;
 *   2. every `require('…/vendor/x.js')` in main.js + lib/ must be a staged
 *      file — this is what catches the *lazy* require, which a load-only
 *      check would never see;
 *   3. an actual load of the packaged file set, in a throwaway dir, must
 *      succeed;
 *   4. that load must FAIL when a required vendor file is removed — so a
 *      vacuous pass can't masquerade as coverage.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(__dirname, '..', 'desktop');

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error(`ASSERT FAILED: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 1. The staged set, read from predist.mjs itself (never restated here).
// ---------------------------------------------------------------------------
const PREDIST_SRC = readFileSync(join(DESKTOP, 'scripts', 'predist.mjs'), 'utf8');

/** Pull `['client', 'update.js'],`-style entries out of the `staged` array. */
function parseStaged(src) {
  const block = src.match(/const\s+staged\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error('could not find the `staged` array in scripts/predist.mjs');
  const entries = [];
  for (const m of block[1].matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)) {
    entries.push({ from: m[1], file: m[2], dest: `vendor/${m[2]}` });
  }
  return entries;
}

const staged = parseStaged(PREDIST_SRC);
assert(staged.length >= 5, `expected predist to stage at least 5 files, parsed ${staged.length}`);

// ---------------------------------------------------------------------------
// 2. The electron-builder `files:` globs, read from the real config.
// ---------------------------------------------------------------------------
const EBB_SRC = readFileSync(join(DESKTOP, 'electron-builder.yml'), 'utf8');

/**
 * Parse the top-level `files:` block. js-yaml (electron-builder's own parser)
 * is preferred; the line scanner is a dependency-free fallback for the narrow
 * shape this file uses — plain `- glob` scalars under one key.
 */
function parseFilesList(src) {
  try {
    const requireFromDesktop = createRequire(join(DESKTOP, 'package.json'));
    const yaml = requireFromDesktop('js-yaml');
    const doc = yaml.load(src);
    if (doc && Array.isArray(doc.files)) return doc.files.map(String);
  } catch {
    /* fall through to the line scanner */
  }
  const globs = [];
  let inFiles = false;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (!/^\s/.test(line)) {
      inFiles = false; // a new top-level key ends the block
      continue;
    }
    if (!inFiles) continue;
    const m = line.trim().match(/^-\s*(\S+)\s*$/);
    if (m) globs.push(m[1]);
  }
  return globs;
}

const filesGlobs = parseFilesList(EBB_SRC);
assert(filesGlobs.length >= 5, `expected several electron-builder files globs, parsed ${filesGlobs.length}`);
assert(
  filesGlobs.some((g) => g.startsWith('vendor/')),
  'electron-builder `files:` no longer ships anything from vendor/ — the packaged app cannot resolve shared code',
);

// ---------------------------------------------------------------------------
// 3. Glob matching, supporting the `**`, `*` and `?` forms the config uses.
// ---------------------------------------------------------------------------
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` spans zero or more whole segments; a bare `**` spans anything.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

const matchers = filesGlobs.map((g) => ({ glob: g, re: globToRegExp(g) }));
const matchingGlobs = (relPath) => matchers.filter((m) => m.re.test(relPath)).map((m) => m.glob);

// ---------------------------------------------------------------------------
// 4. Every staged file must survive into the asar.
// ---------------------------------------------------------------------------
for (const entry of staged) {
  const hits = matchingGlobs(entry.dest);
  assert(
    hits.length > 0,
    `predist stages ${entry.dest} but no electron-builder \`files:\` glob matches it — ` +
      'the file is missing from the packaged app (add it, or widen the vendor glob)',
  );
  // predist resolves its sources from the repo root, one level above desktop/.
  const source = join(DESKTOP, '..', entry.from, entry.file);
  let exists = false;
  try {
    exists = statSync(source).isFile();
  } catch {
    exists = false;
  }
  assert(exists, `predist stages ${entry.from}/${entry.file}, which does not exist`);
}

// ---------------------------------------------------------------------------
// 5. Every vendor require must be backed by a staged file. This is the check
//    that catches a lazily-required module the app loads fine without, right
//    up until the feature is used (`vendor/update.js`).
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const RUNTIME_SOURCES = [
  join(DESKTOP, 'main.js'),
  join(DESKTOP, 'preload.js'),
  ...walk(join(DESKTOP, 'lib')).filter((f) => f.endsWith('.js')),
];

const stagedNames = new Set(staged.map((e) => e.file));
const requiredVendor = new Map(); // dest -> [source files]
for (const file of RUNTIME_SOURCES) {
  const src = readFileSync(file, 'utf8');
  // Only real require() calls: these files' comments discuss `vendor/aegis.js`
  // in prose constantly, and prose is not a dependency.
  for (const m of src.matchAll(/require\(\s*['"][^'"]*vendor\/([\w.-]+\.js)['"]\s*\)/g)) {
    const dest = `vendor/${m[1]}`;
    if (!requiredVendor.has(dest)) requiredVendor.set(dest, []);
    requiredVendor.get(dest).push(relative(DESKTOP, file));
  }
}

assert(requiredVendor.size >= 4, `expected to find several vendor requires, found ${requiredVendor.size}`);
for (const [dest, sources] of requiredVendor) {
  assert(
    stagedNames.has(dest.replace(/^vendor\//, '')),
    `${sources.join(', ')} requires '${dest}' but predist never stages that file`,
  );
}

// ---------------------------------------------------------------------------
// 6. Load the packaged file set for real. Build a dir from exactly the files
//    the globs select, then require main.js the way the asar would.
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', 'release', 'test', 'build', 'scripts', '.git']);

/** Files under desktop/ that the `files:` globs actually ship. */
function selectPackagedFiles() {
  const selected = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const rel = relative(DESKTOP, full);
      if (statSync(full).isDirectory()) visit(full);
      else if (matchingGlobs(rel).length > 0) selected.push(rel);
    }
  };
  visit(DESKTOP);
  return selected;
}

const packaged = selectPackagedFiles();
for (const entry of staged) {
  assert(packaged.includes(entry.dest), `the packaged file set is missing ${entry.dest}`);
}

const appDir = mkdtempSync(join(tmpdir(), 'aegis-packaged-'));
try {
  for (const rel of packaged) {
    const dest = join(appDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(DESKTOP, rel), dest);
  }

  // Load in a child process so the module cache can't mask a missing file.
  const loader = join(appDir, '__load.cjs');
  writeFileSync(loader, "require('./main.js');\nconsole.log('PACKAGED LOAD OK');\n");
  const run = (script = loader) => spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: appDir });

  const loaded = run();
  assert(
    loaded.status === 0 && /PACKAGED LOAD OK/.test(loaded.stdout || ''),
    `main.js does not load from the packaged file set:\n${(loaded.stderr || '').trim().split('\n').slice(0, 3).join('\n')}`,
  );

  // Prove the check above can fail: drop a required vendor file and the load
  // must break. Without this, a future refactor could make it vacuous.
  // Skipped when the file is already absent — then the load above has already
  // reported the real defect, and crashing here would bury it.
  const victim = join(appDir, 'vendor', 'credentials.js');
  if (existsSync(victim)) {
    const saved = readFileSync(victim);
    rmSync(victim);
    const broken = run();
    assert(
      broken.status !== 0,
      'removing vendor/credentials.js did NOT break the packaged load — this test is vacuous',
    );
    writeFileSync(victim, saved);

    const restored = run();
    assert(restored.status === 0, 'restoring vendor/credentials.js did not restore the packaged load');
  }

} finally {
  rmSync(appDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 6. The CLI's own vendor boundary — the same defect class, a second host.
//
// `cli/scripts/predist.mjs` stages the shared modules into `cli/vendor/`, and
// `cli/src/deps.js` resolves each one through `resolveShared()`. Stage nothing
// and an installed `aegiscode` throws MODULE_NOT_FOUND before it can print a
// version — which is exactly what commit 96fb64f shipped when it pointed
// deps.js at the new `queue.js` / `autonomous.js` without staging them.
// ---------------------------------------------------------------------------
const CLI = join(__dirname, '..', 'cli');
const CLI_PREDIST = readFileSync(join(CLI, 'scripts', 'predist.mjs'), 'utf8');
const CLI_DEPS = readFileSync(join(CLI, 'src', 'deps.js'), 'utf8');

/** Flat `const FILES = ['client/aegis.js', …]` list from cli/scripts/predist.mjs. */
function parseCliFiles(src) {
  const block = src.match(/const\s+FILES\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error('could not find the `FILES` array in cli/scripts/predist.mjs');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const cliFiles = new Set(parseCliFiles(CLI_PREDIST));
assert(cliFiles.size >= 5, `expected cli predist to stage at least 5 files, parsed ${cliFiles.size}`);

/** Every repo-relative path `cli/src/deps.js` pulls in via resolveShared(). */
const cliResolved = [...CLI_DEPS.matchAll(/resolveShared\(\s*path\.join\(([^)]*)\)\s*\)/g)].map((m) =>
  [...m[1].matchAll(/'([^']+)'/g)].map((s) => s[1]).join('/'),
);
assert(
  cliResolved.length >= 5,
  `expected several resolveShared() calls in cli/src/deps.js, found ${cliResolved.length}`,
);

for (const rel of cliResolved) {
  assert(
    cliFiles.has(rel),
    `cli/src/deps.js resolves ${rel} but cli/scripts/predist.mjs does not stage it — ` +
      'an installed CLI dies at load with MODULE_NOT_FOUND',
  );
  assert(existsSync(join(__dirname, '..', rel)), `cli/src/deps.js resolves ${rel}, which does not exist`);
}

/**
 * Drop comments before scanning for requires. `client/aegis.js` documents its
 * own usage as `require('./client/aegis.js')` inside a JSDoc block, which a raw
 * scan reads as a self-referential dependency.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Transitive relative requires among the staged set (engine.js -> turn-guard ->
// git-scope, queue.js -> worktree-lock). A missing transitive dep breaks the
// CLI exactly as hard as a missing direct one, and is easier to overlook.
for (const rel of cliFiles) {
  const abs = join(__dirname, '..', rel);
  if (!existsSync(abs)) continue; // already reported above when it is a direct dep
  const src = stripComments(readFileSync(abs, 'utf8'));
  for (const m of src.matchAll(/require\(\s*'\.\/([^']+)'\s*\)/g)) {
    const target = join(dirname(rel), m[1]).replace(/\\/g, '/');
    assert(
      cliFiles.has(target),
      `${rel} requires ./${m[1]} (staged as ${target}) but cli/scripts/predist.mjs does not stage it`,
    );
  }
}

if (failures === 0) {
  console.log(
    `Packaging test passed: ${staged.length} staged files all ship (${packaged.length} files total), ` +
      `${requiredVendor.size} vendor requires backed, packaged load verified and fault-injected; ` +
      `cli vendor boundary intact (${cliFiles.size} staged, ${cliResolved.length} resolved).`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} packaging assertion(s) failed.`);
  process.exit(1);
}
