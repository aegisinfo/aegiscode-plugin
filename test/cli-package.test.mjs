#!/usr/bin/env node
/**
 * The PACKAGED layout, not the repo layout.
 *
 * `cli/src/deps.js` resolves the shared modules two ways: beside the repo
 * (client/, mcp/, desktop/) or under `cli/vendor/`, staged at publish time. The
 * repo layout is what every other test exercises; this one copies the staged
 * tree somewhere with no repo around it and runs the real binary there, so the
 * path an `npm install -g aegis-terminal` user gets is proven before publishing —
 * not after.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cliDir = join(root, 'cli');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const STAGED = [
  'client/aegis.js',
  'client/foreign-memory.js',
  'mcp/tools.js',
  'desktop/renderer/usage.js',
];

const tmp = fs.mkdtempSync(join(os.tmpdir(), 'aegiscode-pkg-'));

const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    if (req.url === '/api/token-bank/balance') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ balance_eur: 1.25, ledger: [] }));
      return;
    }
    if (req.url === '/api/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ model: 'nexus-brain', choices: [{ delta: { content: 'packaged ok' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404).end('{}');
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;

try {
  // 1. Stage exactly what `prepublishOnly` would.
  const staged = await sh(process.execPath, [join(cliDir, 'scripts', 'predist.mjs')], { cwd: cliDir });
  assert(staged.code === 0, `predist must succeed: ${staged.err}`);
  assert(staged.out.includes('staged registry loads standalone'), `predist self-check ran: ${staged.out}`);

  // 2. The staged tree must match its sources byte for byte — a stale vendor
  //    directory is how an installed CLI would ship old behaviour.
  for (const rel of STAGED) {
    const from = join(root, rel);
    const to = join(cliDir, 'vendor', rel);
    assert(fs.existsSync(to), `predist must stage ${rel}`);
    assert(fs.readFileSync(from).equals(fs.readFileSync(to)), `staged ${rel} differs from its source`);
  }

  // 3. `cli/vendor/` must never be committed: it is generated at publish time.
  const ignored = await sh('git', ['check-ignore', 'cli/vendor/mcp/tools.js'], { cwd: root });
  assert(ignored.code === 0, 'cli/vendor/ must be gitignored (it is staged at publish time)');

  // 4. Rebuild the published shape somewhere with no repo in sight.
  const pkgDir = join(tmp, 'pkg');
  for (const part of ['bin', 'src', 'vendor']) {
    fs.cpSync(join(cliDir, part), join(pkgDir, part), { recursive: true });
  }
  fs.copyFileSync(join(cliDir, 'package.json'), join(pkgDir, 'package.json'));
  assert(!fs.existsSync(join(pkgDir, '..', 'client')), 'the copied package must not have a sibling client/ dir');

  // 5. It must resolve its shared modules from its own vendor tree.
  const resolved = await sh(
    process.execPath,
    ['-e', 'const d=require("./src/deps.js");console.log(JSON.stringify(d.paths))'],
    { cwd: pkgDir }
  );
  assert(resolved.code === 0, `the packaged CLI must load: ${resolved.err}`);
  const paths = JSON.parse(resolved.out);
  for (const [name, p] of Object.entries(paths)) {
    assert(
      !relative(pkgDir, p).startsWith('..'),
      `${name} resolved outside the installed package (${p}) — the vendor tree is not self-contained`
    );
    assert(p.includes('vendor'), `${name} should resolve from vendor/ when installed (got ${p})`);
  }

  // 6. …and it must run a real turn from there.
  const version = await sh(process.execPath, [join(pkgDir, 'bin', 'aegis-term.js'), '--version'], { cwd: tmp });
  assert(version.code === 0, `packaged --version exits 0 (${version.err})`);
  const pkgVersion = JSON.parse(fs.readFileSync(join(cliDir, 'package.json'), 'utf8')).version;
  assert(version.out.trim() === pkgVersion, `packaged --version prints ${pkgVersion} (got ${version.out.trim()})`);

  const run = await sh(process.execPath, [join(pkgDir, 'bin', 'aegis-term.js'), '-p', 'hi'], {
    cwd: tmp,
    env: { ...process.env, AEGIS_API_KEY: 'aegis_placeholder_for_pkg_test', AEGIS_API_BASE: base },
  });
  assert(run.code === 0, `the packaged CLI must run a prompt (exit ${run.code}: ${run.err})`);
  assert(run.out.includes('packaged ok'), `the packaged CLI prints the answer: ${JSON.stringify(run.out)}`);
  assert(run.out.includes('25 tok'), `the packaged CLI reports tokens: ${JSON.stringify(run.out)}`);

  // 7. The published file list must include everything the binary loads.
  const manifest = JSON.parse(fs.readFileSync(join(cliDir, 'package.json'), 'utf8'));
  for (const need of ['bin', 'src', 'vendor']) {
    assert(manifest.files.includes(need), `package.json "files" must ship ${need}/`);
  }
  assert(manifest.bin && manifest.bin['aegis-term'] === 'bin/aegis-term.js', 'the bin entry must point at the CLI');
  assert(manifest.scripts && manifest.scripts.prepublishOnly, 'publishing must run predist (prepublishOnly)');

  console.log('CLI package test passed');
  console.log(`  staged: ${STAGED.length} modules, byte-identical, gitignored, registry loads standalone`);
  console.log(`  isolated: resolves from vendor/ · --version ${pkgVersion} · one-shot turn with tokens`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  stub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
