#!/usr/bin/env node
/**
 * Smoke test: boots the real MCP server as a subprocess and validates the
 * JSON-RPC handshake + tools/list response over stdio. No network access is
 * required — `tools/list` is served entirely from in-memory tool definitions.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'mcp', 'server.js');

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AEGIS_API_KEY: 'aegis_placeholder_for_smoke_test' },
});

let out = '';
let errOut = '';
let nextId = 1;
const pending = new Map();

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
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => (errOut += c));

function rpc(method, params) {
  return new Promise((resolve, reject) => {
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
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

try {
  // 1. initialize handshake
  const init = await rpc('initialize', { protocolVersion: '2024-11-05' });
  assert(init.result && init.result.serverInfo, 'initialize should return serverInfo');
  assert(init.result.serverInfo.name === 'aegis', 'server name should be "aegis"');
  assert(
    init.result.serverInfo.version === '0.2.0',
    `server version should be 0.2.0, got ${init.result.serverInfo.version}`
  );

  // 2. tools/list must expose the public tool surface
  const list = await rpc('tools/list', {});
  assert(Array.isArray(list.result && list.result.tools), 'tools/list should return an array');
  const names = list.result.tools.map((t) => t.name);
  const expected = [
    'aegis_status',
    'aegis_ask',
    'aegis_list_models',
    'aegis_balance',
    'aegis_byok_status',
    'aegis_byok_set',
    'aegis_memory_search',
    'aegis_memory_save',
    'aegis_memory_list',
  ];
  for (const n of expected) {
    assert(names.includes(n), `expected tool ${n}, got: ${names.join(', ')}`);
  }

  // 3. every tool must declare a valid JSON inputSchema
  for (const t of list.result.tools) {
    assert(
      t.inputSchema && t.inputSchema.type === 'object',
      `tool ${t.name} should have an object inputSchema`
    );
  }

  console.log(`Smoke test passed: ${names.length} tools, version ${init.result.serverInfo.version}`);
  console.log(`Tools: ${names.join(', ')}`);
} catch (err) {
  console.error(err.message);
  console.error('--- stderr ---');
  console.error(errOut);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}
