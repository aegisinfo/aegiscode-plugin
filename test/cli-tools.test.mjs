#!/usr/bin/env node
/**
 * The CLI talks to the SAME registry the MCP host does — proven against the
 * real MCP server, not a copy of its list.
 *
 * The failure this prevents is the one that made the two hosts diverge in the
 * first place: a capability exists in the MCP tool list and has no way to be
 * reached from the terminal (or a command names a tool that was since renamed).
 * It also drives real turns and real command dispatch through `createApp` with
 * an injected client, so nothing here needs a TTY or a live key.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const deps = require(join(root, 'cli', 'src', 'deps.js'));
const { COMMANDS, parseLine } = require(join(root, 'cli', 'src', 'commands.js'));
const { createApp } = require(join(root, 'cli', 'src', 'app.js'));
const { stripAnsi } = require(join(root, 'cli', 'src', 'screen.js'));

// ── 1. One registry, both hosts ────────────────────────────────────────────
// tools/list comes from the actual MCP server process; the CLI is built from
// the same module, so any divergence is a real drift, not a fixture mismatch.
const serverPath = join(root, 'mcp', 'server.js');
const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AEGIS_API_KEY: 'aegis_placeholder_for_cli_test' },
});
let buf = '';
const pending = new Map();
let nextId = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
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
function rpc(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// ── 2. An injected client: no network, records what was asked of it ────────
function stubClient(overrides = {}) {
  const calls = [];
  const record = (name) => (args) => {
    calls.push({ name, args });
    return Promise.resolve({});
  };
  const client = {
    apiBase: 'https://aegiscloud.org',
    apiKey: 'aegis_placeholder_for_cli_test',
    calls,
    verifyApiKey: async () => {
      calls.push({ name: 'verifyApiKey' });
      return { valid: true, plan: 'pro', email: 'user@example.com', memory_token: 'tok' };
    },
    tokenBankBalance: async () => {
      calls.push({ name: 'tokenBankBalance' });
      return {
        balance_eur: 3.5,
        ledger: [
          {
            model_key: 'deepseek/deepseek-v4-flash',
            tokens_in: 1200,
            tokens_out: 300,
            kind: 'usage',
            amount_eur: -0.0007,
            created_at: '2026-09-13 10:00:00',
          },
        ],
      };
    },
    listModels: async () => {
      calls.push({ name: 'listModels' });
      return { models: [{ id: 'nexus-brain', capabilities: ['brain'] }, { id: 'deepseek/deepseek-v4-flash', capabilities: [] }] };
    },
    chatCompletion: async (opts) => {
      calls.push({ name: 'chatCompletion', opts });
      if (typeof opts.onStream === 'function') {
        opts.onStream({ delta: 'streamed ' });
        opts.onStream({ delta: 'answer' });
      }
      return {
        model: opts.model || 'nexus-brain',
        choices: [{ message: { content: 'streamed answer' } }],
        usage: { total_tokens: 1500, prompt_tokens: 1200, completion_tokens: 300 },
      };
    },
    memorySearch: async (q) => {
      calls.push({ name: 'memorySearch', args: q });
      return { entries: [{ content: `hit for ${q}`, timestamp: '2026-09-13' }] };
    },
    memorySave: async (e) => {
      calls.push({ name: 'memorySave', args: e });
      return { saved: 1 };
    },
    memoryList: async () => {
      calls.push({ name: 'memoryList' });
      return { entries: [{ content: 'remembered thing' }] };
    },
    byokStatus: async () => {
      calls.push({ name: 'byokStatus' });
      return { openai: { set: true, masked: 'sk-••••1234' }, anthropic: { set: false } };
    },
    byokSet: async () => {
      calls.push({ name: 'byokSet' });
      return { message: 'openai key saved.' };
    },
    randomUUID: () => 'uuid-1',
    ...overrides,
  };
  for (const name of ['memoryPull', 'memoryActivate', 'memorySaveBatch']) {
    if (!client[name]) client[name] = record(name);
  }
  return client;
}

function captureApp(client) {
  const written = [];
  const out = {
    isTTY: false,
    write: (s) => {
      written.push(s);
      return true;
    },
  };
  const err = { write: () => true };
  const app = createApp({
    client,
    tools: deps.createTools(client),
    out,
    err,
    stream: true,
    width: () => 80,
  });
  return { app, text: () => stripAnsi(written.join('')) };
}

try {
  await rpc('initialize', { protocolVersion: '2024-11-05' });
  const listed = await rpc('tools/list', {});
  const mcpTools = listed.result.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const cliTools = deps.createTools(stubClient()).toolList();
  assert(mcpTools.length > 0, 'the MCP host must expose tools');

  const mcpJson = JSON.stringify(mcpTools);
  const cliJson = JSON.stringify(cliTools);
  assert(cliJson === mcpJson, 'the CLI and MCP hosts must expose identical tool names and schemas');
  assert(
    JSON.stringify(mcpTools.map((t) => t.name).sort()) ===
      JSON.stringify(cliTools.map((t) => t.name).sort()),
    'tool name sets must match exactly'
  );

  // ── 3. Every registry tool is reachable from the prompt ─────────────────
  const names = new Set(cliTools.map((t) => t.name));
  const reachable = new Set(COMMANDS.filter((c) => c.tool).map((c) => c.tool));
  const generic = COMMANDS.some((c) => c.generic);
  for (const name of names) {
    assert(
      reachable.has(name) || generic,
      `registry tool ${name} has no command — add one (or keep /tool as the escape hatch)`
    );
  }
  for (const cmd of COMMANDS) {
    if (!cmd.tool) continue;
    assert(names.has(cmd.tool), `/${cmd.name} points at unknown tool ${cmd.tool}`);
  }
  // Duplicate command names would silently shadow each other in the index.
  const seen = new Set();
  for (const c of COMMANDS) {
    for (const n of [c.name, ...(c.aliases || [])]) {
      assert(!seen.has(n), `command name/alias /${n} is defined twice`);
      seen.add(n);
    }
  }

  // ── 4. One usage mapping for terminal and GUI ──────────────────────────
  assert(
    deps.usageTokens === require(join(root, 'desktop', 'renderer', 'usage.js')).usageTokens,
    'the CLI must reuse the desktop usage mapping, not a second copy'
  );

  // ── 5. Real dispatch through the app ───────────────────────────────────
  const client = stubClient();
  const { app, text } = captureApp(client);

  await app.handleLine('/status');
  assert(text().includes('Key valid: yes'), `aegis_status result rendered: ${text()}`);
  assert(text().includes('aegis_status'), 'tool output is headed by the tool it came from');

  await app.handleLine('/balance');
  assert(text().includes('€3.50'), 'balance rendered');
  assert(text().includes('-€0.0007'), 'signed sub-cent spend rendered');
  assert(text().includes('1200/300 tok'), 'tokens beside the charge rendered');

  await app.handleLine('/spend'); // alias
  assert(client.calls.filter((c) => c.name === 'tokenBankBalance').length >= 2, '/spend is an alias of /balance');

  await app.handleLine('/models');
  assert(text().includes('nexus-brain'), 'models rendered');

  await app.handleLine('/recall anything');
  assert(text().includes('hit for anything'), 'recall passes its query through');
  assert(
    client.calls.some((c) => c.name === 'memorySearch' && c.args === 'anything'),
    'recall reaches memorySearch with the query'
  );

  // A plain prompt and /ask must take the same path.
  const before = client.calls.filter((c) => c.name === 'chatCompletion').length;
  await app.handleLine('why is the sky blue');
  assert(
    client.calls.filter((c) => c.name === 'chatCompletion').length === before + 1,
    'a plain prompt is a question to the pool'
  );
  await app.handleLine('/ask and again');
  assert(
    client.calls.filter((c) => c.name === 'chatCompletion').length === before + 2,
    '/ask dispatches the same call'
  );

  // The turn must show its text, once, plus the token count and the € it cost.
  const turnText = text();
  assert(turnText.includes('streamed answer'), 'the answer is rendered');
  assert(
    turnText.split('streamed answer').length - 1 === 2,
    'each of the two turns is printed exactly once (no duplicated streamed body)'
  );
  assert(turnText.includes('1,500 tok'), 'the turn reports tokens consumed');
  assert(turnText.includes('1,200/300'), 'and the in/out split');
  assert(turnText.includes('€0.0007'), 'and what the call settled at');
  assert(turnText.includes('nexus-brain'), 'and which model answered');
  assert(app.session.tokens === 3000, `session tokens accumulate (got ${app.session.tokens})`);
  assert(app.session.calls === 2, 'session counts the calls');

  // Streaming was actually requested, and usage asked for on the wire.
  const streamCall = client.calls.find((c) => c.name === 'chatCompletion' && c.opts.stream);
  assert(streamCall, 'the CLI streams by default');
  assert(streamCall.opts.includeUsage === true, 'and asks the server for the token count');

  // Model pinning flows into the request.
  await app.handleLine('/model deepseek/deepseek-v4-flash');
  await app.handleLine('pinned?');
  const pinned = client.calls.filter((c) => c.name === 'chatCompletion').pop();
  assert(pinned.opts.model === 'deepseek/deepseek-v4-flash', '/model pins the id on the next call');

  // /tool reaches anything the registry has, including new tools.
  await app.handleLine('/tool aegis_balance {}');
  assert(text().includes('Recent activity'), '/tool dispatches by name');
  await app.handleLine('/tool nope_not_a_tool {}');
  assert(text().includes('unknown tool'), 'an unknown tool is reported, not thrown');

  // Local commands and error paths.
  await app.handleLine('/cost');
  assert(text().includes('session'), '/cost reports the session');
  await app.handleLine('/nonsense');
  assert(text().includes('unknown command'), 'an unknown command is reported, not thrown');
  const keep = await app.handleLine('/quit');
  assert(keep === false, '/quit ends the session loop');
  await app.handleLine('');
  assert(parseLine('').kind === 'empty', 'blank input is not a prompt');
  assert(parseLine('  hello  ').kind === 'prompt', 'plain text is a prompt');
  assert(parseLine('/ask hi').kind === 'command', 'slash input is a command');
  assert(parseLine('/ask hi').arg === 'hi', 'the argument is split off');

  // A missing key must be a clear message, not a crash or a silent no-op.
  const noKey = stubClient({ apiKey: '' });
  const nk = captureApp(noKey);
  await nk.app.handleLine('hello');
  assert(nk.text().includes('no AEGIS_API_KEY'), 'a missing key is reported in-session');
  await nk.app.handleLine('/balance');
  assert(nk.text().includes('no AEGIS_API_KEY'), 'and on a tool command');

  console.log('CLI tools test passed');
  console.log(`  registry: ${cliTools.length} tools, identical to the MCP host's tools/list`);
  console.log(`  commands: ${COMMANDS.length} (${reachable.size} tool-backed) — none orphaned either way`);
  console.log(`  dispatch: 2 turns, ${app.session.tokens} tok, ${client.calls.length} client calls recorded`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}
