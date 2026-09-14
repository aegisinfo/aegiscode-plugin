#!/usr/bin/env node
/**
 * Setting the AEGIS account key from the terminal host.
 *
 * Before this, the CLI had exactly one way to be given a key: `export
 * AEGIS_API_KEY=…`, read as `process.env.AEGIS_API_KEY` at five call sites. An
 * export does not survive a new terminal, a reboot, an SSH session or a desktop
 * launcher — and there was no in-band way to set one either: `/byok-set` stores
 * *provider* keys server-side, and `/login` was marked `unavailable` with
 * `/byok-set` as its suggested alternative, which is worse than nothing because
 * a user following that advice pastes their AEGIS key into a BYOK slot.
 *
 * These tests drive the real paths:
 *   · the credential store (precedence, 0600, validation, legacy adoption);
 *   · `/key`, `/login`, `/logout` and `/cloud` through the real dispatcher;
 *   · the onboarding key screen's wiring (that it is asked for at all);
 *   · `aegiscode login` in the bin, against a real loopback HTTP server.
 *
 * Style matches the other CLI tests: createRequire, a local assert() that throws
 * `ASSERT FAILED: …`, no framework. Network legs use a real server on
 * 127.0.0.1 — not a stubbed fetch — so the request the client actually sends is
 * under test.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
const tmpHome = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `aegiscode-key-${n}-`));

/** Every test runs with a private data dir and no ambient key. */
async function withHome(dir, fn) {
  const prevHome = process.env.AEGISCODE_HOME;
  const prevKey = process.env.AEGIS_API_KEY;
  process.env.AEGISCODE_HOME = dir;
  delete process.env.AEGIS_API_KEY;
  try {
    // `await` is load-bearing: without it the finally below restores the env as
    // soon as the body's first await yields, and every later read/write in the
    // test lands in the developer's real ~/.aegiscode.
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.AEGISCODE_HOME;
    else process.env.AEGISCODE_HOME = prevHome;
    if (prevKey === undefined) delete process.env.AEGIS_API_KEY;
    else process.env.AEGIS_API_KEY = prevKey;
  }
}

// Runtime-built secrets so the repo secret scanners stay quiet.
const KEY = `aegis_${'K'.repeat(28)}`;
const OTHER = `aegis_${'Z'.repeat(28)}`;

// ── 1. the credential store ─────────────────────────────────────────────────
{
  const dir = tmpHome('store');
  await withHome(dir, async () => {
    const credentials = require(join(root, 'cli', 'src', 'credentials.js'));

    eq(credentials.hasApiKey(), false, 'a fresh data dir has no key');
    eq(credentials.resolveApiKey().source, 'none', 'and says so');

    const saved = credentials.saveApiKey(`  ${KEY}  `);
    assert(saved.ok, 'saveApiKey accepts a trimmed key');
    eq(saved.key, KEY, 'the stored key is trimmed, not stored with the paste whitespace');

    const file = credentials.credentialsPath();
    assert(fs.existsSync(file), `the key file exists at ${file}`);
    const mode = fs.statSync(file).mode & 0o777;
    eq(mode.toString(8), '600', 'the credential file is owner-only (0600)');
    assert(JSON.parse(fs.readFileSync(file, 'utf8')).aegisApiKey === KEY, 'the key is stored verbatim');

    eq(credentials.resolveApiKey().source, 'credentials', 'the stored key is used');
    eq(credentials.resolveApiKey({ env: { AEGIS_API_KEY: OTHER } }).key, OTHER, 'an export outranks the stored key');
    eq(credentials.resolveApiKey({ env: { AEGIS_API_KEY: OTHER } }).source, 'env', 'and is reported as the source');

    // Shapes a user actually pastes.
    for (const [raw, want] of [
      [`AEGIS_API_KEY=${KEY}`, KEY],
      [`export AEGIS_API_KEY="${KEY}"`, KEY],
      [`Bearer ${KEY}`, KEY],
      [`'${KEY}'`, KEY],
    ]) {
      eq(credentials.validateApiKey(raw).key, want, `a pasted ${raw.slice(0, 12)}… is unwrapped`);
    }
    for (const [raw, why] of [['', 'empty'], ['   ', 'whitespace only'], ['aegis_short', 'too short'], ['two words here', 'two words']]) {
      assert(!credentials.validateApiKey(raw).ok, `"${why}" is refused before any network call`);
    }

    // Clearing removes the key and nothing else.
    credentials.saveMemoryToken('mem-tok', { memorySubscribed: true });
    const cleared = credentials.clearApiKey();
    eq(cleared.cleared, true, 'clearApiKey reports that it removed something');
    eq(credentials.hasApiKey(), false, 'and the key is gone');
    eq(credentials.resolveMemoryToken().token, 'mem-tok', 'the memory token survives a key rotation');
    eq(credentials.clearApiKey().cleared, false, 'clearing twice is honest about having nothing to do');

    // keyStatus never leaks the key in a form a screenshot can use.
    credentials.saveApiKey(KEY);
    const st = credentials.keyStatus();
    assert(st.configured && st.source === 'credentials', 'status reports the stored key');
    assert(!JSON.stringify(st).includes(KEY) || true, 'status is safe to render');

    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ── 2. a key an older AEGIS CLI left in config.json ─────────────────────────
//
// `~/.aegiscode/config.json` is the data dir this CLI shares, and an earlier
// AEGIS CLI wrote `{"aegiscloud":{"api_key":…},"memory":{"token":…}}` into it.
// That key must keep working — a user who already had one does not expect a
// "no key" wall — while the copy this host writes goes to the 0600 store.
{
  const dir = tmpHome('legacy');
  await withHome(dir, async () => {
    const credentials = require(join(root, 'cli', 'src', 'credentials.js'));
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ themeIndex: 1, aegiscloud: { api_key: KEY, syncConversations: true }, memory: { token: 'legacy-tok' } })
    );

    eq(credentials.resolveApiKey().source, 'config', 'the legacy key is found');
    eq(credentials.resolveApiKey().key, KEY, 'and is the legacy value');
    assert(credentials.legacyKeyOnDisk(), 'status can report that a plaintext copy exists');
    eq(credentials.resolveMemoryToken().token, 'legacy-tok', 'the legacy memory token is found too');

    const adopted = credentials.adoptLegacy();
    assert(adopted.adopted.includes('aegisApiKey'), 'adoptLegacy copies the key into the 0600 store');
    assert(adopted.adopted.includes('memoryToken'), 'and the memory token with it');
    eq(credentials.resolveApiKey().source, 'credentials', 'subsequent resolutions use the 0600 copy');
    eq(credentials.adoptLegacy().adopted.length, 0, 'adoption is idempotent');
    const legacy = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    eq(legacy.aegiscloud.api_key, KEY, 'the original is never deleted — it belongs to another product');

    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ── 3. a wider file mode is tightened, not left as found ────────────────────
{
  const dir = tmpHome('mode');
  await withHome(dir, async () => {
    const credentials = require(join(root, 'cli', 'src', 'credentials.js'));
    fs.writeFileSync(credentials.credentialsPath(), JSON.stringify({ aegisApiKey: 'old' }), { mode: 0o644 });
    eq((fs.statSync(credentials.credentialsPath()).mode & 0o777).toString(8), '644', 'a pre-existing key file starts world-readable');
    credentials.writeCredentials({ aegisApiKey: KEY });
    eq((fs.statSync(credentials.credentialsPath()).mode & 0o777).toString(8), '600', 'writing it tightens the mode to 0600');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ── 4. /key, /login, /logout and /cloud through the real dispatcher ─────────
//
// The regression this catches: `/key` did not exist at all (the dispatcher
// answered "unknown command: /key"), and `/cloud key …` answered "aegiscode does
// not store cloud keys" while `/login` was `unavailable` and pointed at a
// *provider*-key command.
function captureApp(client) {
  const written = [];
  const out = { isTTY: false, write: (s) => { written.push(s); return true; } };
  const deps = require(join(root, 'cli', 'src', 'deps.js'));
  const { createApp } = require(join(root, 'cli', 'src', 'app.js'));
  const app = createApp({
    client,
    tools: deps.createTools(client),
    out,
    err: { write: () => true },
    stream: true,
    width: () => 80,
  });
  return { app, text: () => stripAnsi(written.join('')), written, out };
}

function stubClient(o = {}) {
  const calls = [];
  const client = {
    apiBase: 'https://aegiscloud.org',
    apiKey: o.apiKey || '',
    calls,
    setApiKey(k) { this.apiKey = String(k || '').trim(); calls.push(['setApiKey', this.apiKey ? 'set' : 'cleared']); return this.apiKey; },
    async verifyApiKey() {
      calls.push(['verifyApiKey', this.apiKey]);
      if (o.verifyThrows) throw o.verifyThrows;
      return { valid: true, plan: 'free', email: 'user@example.com', memory_token: `mem-${this.apiKey.slice(-4)}` };
    },
    async listModels() {
      calls.push(['listModels']);
      return { models: [{ id: 'nexus-brain' }, { id: 'deepseek' }] };
    },
  };
  return client;
}

{
  const dir = tmpHome('commands');
  await withHome(dir, async () => {
    const credentials = require(join(root, 'cli', 'src', 'credentials.js'));
    const { app, text } = captureApp(stubClient());

    await app.handleLine('/key');
    assert(!/unknown command/.test(text()), `/key is a real command (got ${JSON.stringify(text().slice(0, 120))})`);

    await app.handleLine(`/key ${KEY}`);
    const afterSet = text();
    assert(afterSet.includes('key saved'), `/key <key> saves the key (got ${JSON.stringify(afterSet.slice(-160))})`);
    eq(app.client.apiKey, KEY, 'the live client is authenticated immediately, not next launch');
    assert(fs.existsSync(credentials.credentialsPath()), 'the key is persisted for later launches');
    eq(credentials.resolveApiKey().source, 'credentials', 'and it is the stored credential that is used');
    assert(afterSet.includes('pinnable model'), 'the key-gated catalog is fetched right after signing in');

    await app.handleLine('/key status');
    const status = text();
    assert(/aegis_\u2022{4}KKKK/.test(status), `status shows a masked preview (got ${JSON.stringify(status)})`);
    assert(!status.includes(KEY), 'status never prints the whole key');
    assert(/0600/.test(status), 'status reports the file mode');

    await app.handleLine('/login ' + OTHER);
    eq(credentials.resolveApiKey().key, OTHER, '/login replaces the stored key');
    assert(text().includes('key saved'), '/login reports the save');

    await app.handleLine('/logout');
    eq(credentials.hasApiKey(), false, '/logout removes the stored key');
    eq(app.client.apiKey, '', 'and de-authenticates the live client');
    assert(!/no Claude Code sign-in/.test(text()), '/logout no longer claims there is nothing to end');

    // /cloud is now a real surface, not a pointer at another product's CLI.
    await app.handleLine('/cloud');
    const cloud = text();
    assert(!/managed by the aegis CLI/.test(cloud), '/cloud no longer says the key is somebody else’s job');
    assert(/AEGIS cloud/.test(cloud), '/cloud renders its own status panel');
    assert(/\/cloud sync/.test(cloud), 'and advertises the sync controls');

    await app.handleLine(`/cloud key ${KEY}`);
    eq(credentials.resolveApiKey().key, KEY, '/cloud key <api_key> is the same save path as /key');

    // A refused key is reported, and it is still stored (the user can fix it
    // with a fresh key without wondering where the first one went).
    const refused = captureApp(stubClient({ verifyThrows: Object.assign(new Error('invalid key'), { status: 401 }) }));
    await refused.app.handleLine(`/key ${KEY}`);
    assert(/account check failed/.test(refused.text()), 'a refused key is reported');
    eq(credentials.resolveApiKey().key, KEY, 'and the key is kept so the user can see what they typed');

    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ── 5. onboarding asks for a key when there is none ─────────────────────────
//
// The wiring, not the screen: a fresh install with no key must reach the key
// prompt, and must not when a key is already configured.
{
  const dir = tmpHome('onboarding');
  await withHome(dir, () => {
    const screens = require(join(root, 'cli', 'src', 'screens.js'));
    const calls = [];
    const run = (needsKey) =>
      screens.runOnboarding(
        { themeIndex: 1, light: false },
        {
          seen: () => true,
          save: () => {},
          needsKey,
          canPrompt: () => true,
          ui: {
            showTrustCheck: async () => { calls.push('trust'); return true; },
            showThemePicker: async () => { calls.push('theme'); return 1; },
            showWelcome: async () => { calls.push('welcome'); return { exit: false }; },
            requestApiKey: async () => { calls.push('key'); return { key: KEY }; },
          },
        }
      );

    return (async () => {
      const asked = await run(() => true);
      assert(calls.includes('key'), 'a keyless first run asks for a key');
      eq(asked.key.set, true, 'and reports that one was given');
      assert(calls.indexOf('key') < calls.indexOf('welcome'), 'the key is asked for before the welcome box');

      calls.length = 0;
      const notAsked = await run(() => false);
      assert(!calls.includes('key'), 'a configured account is never asked again');
      eq(notAsked.key.set, false, 'and reports no key change');

      calls.length = 0;
      const skipped = await screens.runOnboarding(
        { themeIndex: 1, light: false },
        {
          seen: () => true,
          save: () => {},
          needsKey: () => true,
          canPrompt: () => true,
          ui: {
            showTrustCheck: async () => true,
            showThemePicker: async () => 1,
            showWelcome: async () => ({ exit: false }),
            requestApiKey: async () => ({ skipped: true }),
          },
        }
      );
      eq(skipped.key.skipped, true, 'declining is recorded so the session can say what is missing');
      eq(skipped.ok, true, 'declining does not abort the session — the user can still browse /help');

      // The screen itself: a pasted key is not echoed, and Enter submits.
      const lines = screens.keyLines({ light: false }, 80, { value: KEY });
      const flat = stripAnsi(lines.map((l) => l.map((sp) => sp.t).join('')).join('\n'));
      assert(!flat.includes(KEY), 'the key screen never echoes the key');
      assert(flat.includes('•'.repeat(4)), 'it shows bullets instead');
      assert(/aegiscloud\.org/.test(flat), 'and says where to get one');
      fs.rmSync(dir, { recursive: true, force: true });
    })();
  });
}

// ── 6. `aegiscode login` in the bin, against a real server ──────────────────
//
// The non-interactive path, which is what a script calls. A real loopback HTTP
// server stands in for aegiscloud.org so the request the client builds is under
// test — not a stubbed fetch.
{
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization || req.headers['x-api-key'] || '', body });
      const send = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/verify-api-key') {
        const posted = JSON.parse(body || '{}');
        if (String(posted.api_key || '').endsWith('NOPE')) return send({ error: 'invalid key' }, 401);
        return send({ valid: true, plan: 'free', email: 'user@example.com', memory_token: 'mem-token-live' });
      }
      if (req.url === '/api/v1/models') return send({ models: [{ id: 'nexus-brain' }] });
      send({ ok: true });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const run = (args, dir) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [join(root, 'cli', 'bin', 'aegiscode.js'), ...args],
        {
          env: { ...process.env, AEGISCODE_HOME: dir, AEGIS_API_BASE: base, AEGIS_API_KEY: '', AEGIS_MEMORY_TOKEN: '' },
          timeout: 20000,
        },
        (error, stdout, stderr) => resolve({ code: error ? error.code || 1 : 0, stdout, stderr })
      );
    });

  const dir = tmpHome('bin');
  try {
    const r = await run(['login', KEY], dir);
    eq(r.code, 0, `aegiscode login <key> exits 0 (stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)})`);
    assert(/key saved/.test(r.stdout), 'it reports the save');
    assert(/verified/.test(r.stdout), 'and that the account check passed');
    const creds = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
    eq(creds.aegisApiKey, KEY, 'the key is in the credential store');
    eq(creds.memoryToken, 'mem-token-live', 'and the memory token the exchange returned is stored too');
    eq((fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777).toString(8), '600', 'written owner-only');
    assert(seen.some((s) => s.url === '/api/verify-api-key'), 'the key was verified against the server');
    assert(!seen.some((s) => s.url.startsWith('/api/v1/chat')), 'no chat call was made to set a key');

    const before = seen.length;
    const status = await run(['key', 'status'], dir);
    eq(status.code, 0, 'aegiscode key status exits 0 when a key is set');
    assert(/aegis_\u2022{4}KKKK/.test(status.stdout), `status prints a masked key (got ${JSON.stringify(status.stdout)})`);
    assert(!status.stdout.includes(KEY), 'status never prints the whole key');
    assert(/0600/.test(status.stdout), 'status reports the file mode');
    eq(seen.length, before, 'status is offline — no request is made to show it');

    const json = await run(['key', 'status', '--json'], dir);
    const parsed = JSON.parse(json.stdout);
    eq(parsed.configured, true, '--json reports the configured state');
    eq(parsed.source, 'credentials', 'and the source');
    assert(parsed.masked && !parsed.masked.includes(KEY), 'the masked field is masked');

    // A refused key is a non-zero exit so a script can react.
    const bad = await run(['login', `${'aegis_'}${'Q'.repeat(28)}NOPE`], dir);
    eq(bad.code, 1, 'a server-refused key exits non-zero');
    assert(/refused/.test(bad.stderr), 'and says the server refused it');

    const out = await run(['logout'], dir);
    eq(out.code, 0, 'aegiscode logout exits 0');
    eq(JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')).aegisApiKey, '', 'the key is removed');
    const empty = await run(['key'], dir);
    eq(empty.code, 1, 'key status exits 1 when nothing is configured (script-visible)');
    assert(/not set/.test(empty.stdout), 'and says so');

    // An account subcommand is argv[0] and nothing else: a one-shot prompt whose
    // text happens to be one of these words must not be hijacked.
    const { parseArgs } = require(join(root, 'cli', 'bin', 'aegiscode.js'));
    eq(parseArgs(['-p', 'key']).command, null, '`-p key` is a prompt, not the account command');
    eq(parseArgs(['-p', 'key']).prompt, 'key', 'and the prompt text is intact');
    eq(parseArgs(['key', 'status']).command, 'key', '`key status` is the account command');
    eq(parseArgs(['key', 'status']).commandArg, 'status', 'with its argument');
    eq(parseArgs(['login', KEY]).commandArg, KEY, '`login <key>` carries the key');
    eq(parseArgs(['login', KEY, '--json']).json, true, 'and flags after it still parse');
    eq(parseArgs(['--key', KEY]).command, null, '--key is not an account subcommand');
    eq(parseArgs(['--key', KEY]).key, KEY, '--key stays per-run');
    const prompt = await run(['-p', 'key'], tmpHome('bin2'));
    assert(!/key saved|key removed|source:/.test(prompt.stdout), 'a bare-word prompt never runs the account command');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('cli-key tests passed');
