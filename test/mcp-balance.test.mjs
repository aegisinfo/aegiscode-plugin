#!/usr/bin/env node
/**
 * Boots the real MCP server against a stub AEGIS backend and calls
 * `aegis_balance`, proving the ledger renderer reads the fields the balance
 * endpoint actually returns.
 *
 * Regression guard: the tool used to read `ledger[].charged_micros`, which
 * /api/token-bank/balance has never returned (it returns `amount_eur` and the
 * per-row `tokens_in`/`tokens_out`). Every usage row therefore rendered as
 * "-€0.0000" while the tokens consumed sat invisible — the reported spend could
 * not match the call's token count.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'mcp', 'server.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ── Stub backend: the exact shape /api/token-bank/balance returns ──────────
const stub = createServer((req, res) => {
  if (req.url === '/api/token-bank/balance') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      balance_eur: 3.5,
      currency: 'EUR',
      ledger: [
        { model_key: 'deepseek/deepseek-v4-flash', tokens_in: 1200, tokens_out: 300,
          kind: 'usage', amount_eur: -0.0007, note: null, created_at: '2026-09-13 10:00:00' },
        { model_key: null, tokens_in: 0, tokens_out: 0,
          kind: 'topup', amount_eur: 5, note: 'stripe topup', created_at: '2026-09-12 09:00:00' },
      ],
    }));
    return;
  }
  res.writeHead(404).end('{}');
});

await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const port = stub.address().port;

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    AEGIS_API_KEY: 'aegis_placeholder_for_balance_test',
    AEGIS_API_BASE: `http://127.0.0.1:${port}`,
  },
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

try {
  await rpc('initialize', { protocolVersion: '2024-11-05' });
  const res = await rpc('tools/call', { name: 'aegis_balance', arguments: {} });
  assert(res.result && !res.result.isError, 'aegis_balance should succeed');
  const text = res.result.content[0].text;

  assert(text.includes('Balance: €3.50'), `balance rendered: ${text}`);
  // Usage row: spend is signed negative and carries the token count.
  assert(text.includes('-€0.0007'), `sub-cent spend shown, not €0.0000: ${text}`);
  assert(text.includes('1200/300 tok'), `tokens consumed shown: ${text}`);
  // Top-up row: funds added are signed positive.
  assert(text.includes('+€5.00'), `top-up signed positive: ${text}`);
  assert(!text.includes('-€0.0000'), `no zeroed spend rows: ${text}`);

  console.log('MCP balance test passed');
  console.log(text);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
  stub.close();
}
