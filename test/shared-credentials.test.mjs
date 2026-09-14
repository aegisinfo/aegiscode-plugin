#!/usr/bin/env node
/**
 * One credential store for every host.
 *
 * The MCP plugin used to read `AEGIS_API_KEY` from the environment alone — it
 * ships as `mcp/` + `client/` and so could not reach `cli/src/credentials.js` —
 * which meant a user who signed in with `aegiscode login` still met "No
 * AEGIS_API_KEY is set" in Claude Code. The store moved to `client/`, the tree
 * all three hosts bundle, and every host now resolves the same file.
 *
 *   A  one implementation: the CLI's module IS the shared one
 *   B  resolution order: env > credentials.json > legacy config.json
 *   C  writes are 0600, and a legacy plaintext key is adopted once
 *   D  preferNewest: the most recently saved key wins, whichever host saved it
 *   E  the real MCP server boots with a key from the file and authenticates
 *      with it (no AEGIS_API_KEY anywhere)
 *   F  with no key anywhere it says how to set one instead of only "no env var"
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, statSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const home = mkdtempSync(join(tmpdir(), 'aegis-cred-home-'));
process.env.AEGISCODE_HOME = home;

const shared = require('../client/credentials.js');

// ── A. one implementation ──────────────────────────────────────────────────
const cliCredentials = require('../cli/src/credentials.js');
assert(cliCredentials === shared, 'the CLI re-exports the shared store, not a second copy');
const cliConfig = require('../cli/src/config.js');
assert(
  cliConfig.aegisDir() === shared.aegisHome(),
  'the CLI data dir and the credential dir are one definition'
);

// ── B. resolution order ────────────────────────────────────────────────────
const KEY = 'aegis_key_from_the_store_0001';
const ENV_KEY = 'aegis_key_from_the_environment_0002';

assert(shared.resolveApiKey({ env: {} }).source === 'none', 'nothing configured -> none');

writeFileSync(join(home, 'credentials.json'), JSON.stringify({ aegisApiKey: KEY, savedAt: '2026-01-01T00:00:00.000Z' }));
assert(shared.resolveApiKey({ env: {} }).key === KEY, 'reads the 0600 store');
assert(shared.resolveApiKey({ env: {} }).source === 'credentials', 'reports the store as the source');

writeFileSync(
  join(home, 'config.json'),
  JSON.stringify({ aegiscloud: { api_key: 'aegis_legacy_from_config_00003' } })
);
assert(
  shared.resolveApiKey({ env: {} }).key === KEY,
  'the store outranks the legacy config.json copy'
);

rmSync(join(home, 'credentials.json'));
assert(
  shared.resolveApiKey({ env: {} }).key === 'aegis_legacy_from_config_00003',
  'with no store, the legacy config.json key is used'
);

assert(
  shared.resolveApiKey({ env: { AEGIS_API_KEY: ENV_KEY } }).source === 'env',
  'the environment outranks both files'
);
assert(
  shared.normalizeApiKey(`export AEGIS_API_KEY="${ENV_KEY}"`) === ENV_KEY,
  'a pasted `export …` line is unwrapped'
);
assert(shared.normalizeApiKey(`Bearer ${ENV_KEY}`) === ENV_KEY, 'a pasted Bearer header is unwrapped');
assert(shared.validateApiKey('short').ok === false, 'a truncated paste is refused before any request');
assert(shared.validateApiKey('two words here now').reason === 'whitespace', 'a wrapped paste is refused');

// ── C. 0600 writes + legacy adoption ───────────────────────────────────────
const legacyDir = mkdtempSync(join(tmpdir(), 'aegis-cred-legacy-'));
writeFileSync(
  join(legacyDir, 'config.json'),
  JSON.stringify({ aegiscloud: { api_key: 'aegis_legacy_key_in_config_0004' }, memory: { token: 'mem-legacy' } })
);
assert(shared.legacyKeyOnDisk(legacyDir) === true, 'a plaintext key in config.json is detected');
const adopted = shared.adoptLegacy(legacyDir);
assert(adopted.adopted.includes('aegisApiKey'), `key adopted into the 0600 store: ${JSON.stringify(adopted)}`);
assert(adopted.adopted.includes('memoryToken'), 'memory token adopted too');
assert(
  JSON.parse(readFileSync(join(legacyDir, 'config.json'), 'utf8')).aegiscloud.api_key === 'aegis_legacy_key_in_config_0004',
  'the legacy file is read, never rewritten or deleted'
);

const saved = shared.saveApiKey(KEY, home);
assert(saved.ok === true, `save succeeds: ${JSON.stringify(saved)}`);
assert(saved.path === join(home, 'credentials.json'), 'saves into the shared data dir');
assert(
  (statSync(saved.path).mode & 0o777) === 0o600,
  `key file is 0600, got 0${(statSync(saved.path).mode & 0o777).toString(8)}`
);

// A wider mode left by an earlier run is tightened on the next write.
const { chmodSync } = require('node:fs');
chmodSync(saved.path, 0o644);
shared.saveApiKey(KEY, home);
assert((statSync(saved.path).mode & 0o777) === 0o600, 'a 0644 key file is tightened to 0600 on rewrite');

const status = shared.keyStatus({ env: {}, dir: home });
assert(status.configured === true && status.fileMode === '0600', `status reports the file: ${JSON.stringify(status)}`);
assert(status.key === KEY, 'status carries the key for the main process to use');
assert(status.source === 'credentials', `and says where it came from: ${status.source}`);

// ── D. preferNewest ────────────────────────────────────────────────────────
const older = shared.preferNewest('aegis_host_copy_0000000005', '2026-01-01T00:00:00.000Z', { dir: home });
assert(older.source === 'shared', `the store is newer than the host copy -> store wins: ${JSON.stringify(older)}`);
const newer = shared.preferNewest(KEY, '2027-01-01T00:00:00.000Z', { dir: home });
assert(newer.source === 'host', `the host copy is newer -> host wins (it is the encrypted one)`);
const tie = shared.preferNewest(KEY, '1999-01-01T00:00:00.000Z', { dir: home });
assert(tie.key === KEY, 'equal keys always resolve to the host copy');
assert(
  shared.preferNewest('', null, { dir: home }).source === 'shared',
  'no host copy -> the shared store is adopted'
);
const bareDir = mkdtempSync(join(tmpdir(), 'aegis-cred-bare-'));
assert(
  shared.preferNewest('aegis_only_host_000000000006', null, { dir: bareDir }).source === 'host',
  'no shared key -> the host copy stands'
);

// ── E./F. the real MCP server ──────────────────────────────────────────────
const seenHeaders = [];
const stub = createServer((req, res) => {
  seenHeaders.push({ url: req.url, key: req.headers['x-api-key'] || null });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ valid: true, plan: 'pro', email: 'a@b.c', memory_token: '' }));
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const port = stub.address().port;
const serverPath = join(__dirname, '..', 'mcp', 'server.js');

function bootServer(env) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AEGISCODE_HOME: home, AEGIS_API_BASE: `http://127.0.0.1:${port}`, ...env },
  });
  let out = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
    let nl;
    while ((nl = out.indexOf('\n')) !== -1) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }
      }, 5000);
    });
  return { child, rpc };
}

// E. The key comes from the file, with no AEGIS_API_KEY in the child's env.
// (The developer's own environment may well hold one — that is the point: the
// child below is launched with `AEGIS_API_KEY` explicitly empty, so anything it
// authenticates with can only have come from credentials.json.)
const withFile = bootServer({ AEGIS_API_KEY: '' });
try {
  await withFile.rpc('initialize', { protocolVersion: '2024-11-05' });
  const res = await withFile.rpc('tools/call', { name: 'aegis_status', arguments: {} });
  const text = res.result.content[0].text;
  assert(res.result.isError === false, `aegis_status succeeds with a saved key: ${text}`);
  assert(text.includes('Key valid: yes'), `the account was reached: ${text}`);
  assert(
    seenHeaders.some((h) => h.key === KEY),
    `the server authenticated with the key from credentials.json, saw ${JSON.stringify(seenHeaders.map((h) => h.key))}`
  );
} finally {
  withFile.child.stdin.end();
  withFile.child.kill();
}

// F. With no key anywhere the error names the way out — and nothing is sent.
const requestsBefore = seenHeaders.length;
const emptyHome = mkdtempSync(join(tmpdir(), 'aegis-cred-empty-'));
const noKey = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AEGISCODE_HOME: emptyHome, AEGIS_API_KEY: '', AEGIS_API_BASE: `http://127.0.0.1:${port}` },
});
let noKeyOut = '';
const noKeyPending = new Map();
let nid = 1;
noKey.stdout.setEncoding('utf8');
noKey.stdout.on('data', (chunk) => {
  noKeyOut += chunk;
  let nl;
  while ((nl = noKeyOut.indexOf('\n')) !== -1) {
    const line = noKeyOut.slice(0, nl).trim();
    noKeyOut = noKeyOut.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && noKeyPending.has(msg.id)) {
      noKeyPending.get(msg.id)(msg);
      noKeyPending.delete(msg.id);
    }
  }
});
const noKeyRpc = (method, params) =>
  new Promise((resolve) => {
    const id = nid++;
    noKeyPending.set(id, resolve);
    noKey.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
try {
  await noKeyRpc('initialize', {});
  const res = await noKeyRpc('tools/call', { name: 'aegis_status', arguments: {} });
  const text = res.result.content[0].text;
  assert(res.result.isError === true, 'no key -> the call fails');
  assert(text.includes('aegiscode login'), `the fix is named, not just the env var: ${text}`);
  assert(text.includes('credentials.json'), `the file it writes is named: ${text}`);
  assert(text.includes('AEGIS_API_KEY'), 'the env route is still offered');
  assert(
    seenHeaders.length === requestsBefore,
    'no request left the process without a key'
  );
} finally {
  noKey.stdin.end();
  noKey.kill();
  stub.close();
}

rmSync(home, { recursive: true, force: true });
rmSync(legacyDir, { recursive: true, force: true });
rmSync(bareDir, { recursive: true, force: true });
rmSync(emptyHome, { recursive: true, force: true });

console.log('shared credential tests passed');
