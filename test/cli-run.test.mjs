#!/usr/bin/env node
/**
 * End-to-end: the real `aegiscode` binary, against a real HTTP backend.
 *
 * The unit tests drive `createApp` with an injected client; this one proves the
 * wiring the user actually touches — argument parsing, the signal handling, the
 * SSE read, the exit codes, and the token line on stdout. No fetch stub: the
 * child process talks to a loopback server over real sockets, and the server
 * asserts what the CLI put on the wire.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = join(__dirname, '..', 'cli', 'bin', 'aegiscode.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** What the CLI sent, so the test can assert the request shape itself. */
const seen = { chat: [], balance: 0 };

const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    if (req.url === '/api/token-bank/balance') {
      seen.balance++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          balance_eur: 3.5,
          ledger: [
            {
              model_key: 'nexus-brain',
              tokens_in: 1200,
              tokens_out: 300,
              kind: 'usage',
              amount_eur: -0.0007,
              created_at: '2026-09-13 10:00:00',
            },
          ],
        })
      );
      return;
    }
    if (req.url === '/api/v1/chat/completions') {
      const payload = JSON.parse(body || '{}');
      seen.chat.push(payload);
      if (!payload.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'nexus-brain',
            choices: [{ message: { content: 'buffered answer' } }],
            usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
          })
        );
        return;
      }
      // The streaming wire format, including the usage-only sentinel frame
      // (`choices: []`) an OpenAI-compatible server sends when asked for usage.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ model: 'nexus-brain', choices: [{ delta: { content: 'Hel' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;

function run(args, { env = {}, input = null } = {}) {
  return new Promise((resolve) => {
    // Every run gets its own empty data dir. Since the CLI persists a key
    // (credentials.json) and can also read the legacy `aegiscloud.api_key` an
    // older AEGIS CLI leaves in config.json, inheriting the developer's
    // ~/.aegiscode would make "no key" cases pass or fail by accident.
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-run-'));
    const child = spawn(process.execPath, [bin, ...args], {
      env: {
        ...process.env,
        AEGISCODE_HOME: homeDir,
        AEGIS_API_KEY: 'aegis_placeholder_for_cli_run',
        AEGIS_API_BASE: base,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('close', (code) => {
      fs.rmSync(homeDir, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
    if (input != null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

try {
  // ── one-shot, streaming (the default path) ───────────────────────────────
  const oneShot = await run(['-p', 'hello there']);
  assert(oneShot.code === 0, `a one-shot prompt exits 0 (got ${oneShot.code}: ${oneShot.stderr})`);
  assert(oneShot.stdout.includes('Hello'), `the streamed answer is printed: ${JSON.stringify(oneShot.stdout)}`);
  assert(!oneShot.stdout.includes('Hel\n'), 'the streamed deltas are joined, not printed per-chunk');
  assert(oneShot.stdout.includes('1,500 tok'), `the token count is printed: ${JSON.stringify(oneShot.stdout)}`);
  assert(oneShot.stdout.includes('nexus-brain'), 'the answering model is printed');
  assert(oneShot.stdout.includes('\x1b[38;2;'), 'output is coloured on a pipe-free run');
  assert(!oneShot.stdout.includes('\x1b[48;2;'), 'no background bar is painted off-TTY');

  const streamed = seen.chat.find((c) => c.stream);
  assert(streamed, 'the default path streams');
  assert(
    streamed.stream_options && streamed.stream_options.include_usage === true,
    'the CLI asks the server for usage on the streaming path'
  );
  // No token ceiling from the client unless the user asked for one: the server
  // sizes a pooled call from `effort`, and a number here is a per-pass ceiling
  // *over* that ladder (aegis1 services/pool_brain.py pass_budgets). The old
  // `max_tokens || 4096` in client/aegis.js invented a cap on every request and
  // took the budget decision away from the effort the caller chose.
  assert(streamed.max_tokens === undefined, `an unpinned run sends no max_tokens: ${streamed.max_tokens}`);
  assert(!streamed.mode, 'an unset mode is never invented');
  assert(!streamed.model, 'an unpinned model is omitted so the server routes');

  // ...and a pinned one still travels, because a ceiling the user typed is the
  // ceiling they asked for.
  const cappedRun = await run(['--max-tokens', '2048', '-p', 'short please']);
  assert(cappedRun.code === 0, 'a --max-tokens run exits 0');
  const cappedReq = seen.chat[seen.chat.length - 1];
  assert(cappedReq.max_tokens === 2048, `--max-tokens is forwarded: ${cappedReq.max_tokens}`);

  // ── --json ───────────────────────────────────────────────────────────────
  const json = await run(['--json', '-p', 'hello again']);
  assert(json.code === 0, 'json run exits 0');
  const parsed = JSON.parse(json.stdout);
  assert(parsed.text === 'Hello', `json carries the text (got ${JSON.stringify(parsed.text)})`);
  assert(parsed.tokens === 1500, 'json carries the token total');
  assert(parsed.model === 'nexus-brain', 'json carries the model');
  assert(parsed.usage.total_tokens === 1500, 'json carries the raw usage object');
  assert(parsed.balance_eur === 3.5, 'json carries the balance it saw');

  // ── --no-stream ──────────────────────────────────────────────────────────
  const buffered = await run(['--no-stream', '-p', 'buffered please']);
  assert(buffered.code === 0, 'buffered run exits 0');
  assert(buffered.stdout.includes('buffered answer'), 'the buffered answer is printed');
  assert(buffered.stdout.includes('1,500 tok'), 'the buffered run still reports tokens');
  const nonStream = seen.chat[seen.chat.length - 1];
  assert(nonStream.stream === false, 'the non-stream path sends stream:false');
  assert(!nonStream.stream_options, 'stream_options is never attached to a non-stream request');

  // ── model pinning reaches the wire ───────────────────────────────────────
  await run(['-m', 'deepseek/deepseek-v4-flash', '-p', 'pinned']);
  const pinned = seen.chat[seen.chat.length - 1];
  assert(pinned.model === 'deepseek/deepseek-v4-flash', '--model pins the id on the request');

  // ── a prompt on stdin ────────────────────────────────────────────────────
  const piped = await run(['-p', '-'], { input: 'from stdin\n' });
  assert(piped.code === 0, `a piped prompt exits 0 (got ${piped.code}: ${piped.stderr})`);
  assert(seen.chat[seen.chat.length - 1].messages.slice(-1)[0].content === 'from stdin', 'stdin becomes the prompt');

  // ── argument handling ────────────────────────────────────────────────────
  const version = await run(['--version']);
  assert(version.code === 0, '--version exits 0');
  assert(/^\d+\.\d+\.\d+$/.test(version.stdout.trim()), `--version prints a version (got ${JSON.stringify(version.stdout)})`);

  const help = await run(['--help']);
  assert(help.code === 0, '--help exits 0');
  assert(help.stdout.includes('aegiscode — AEGIS in your shell'), '--help prints usage');
  assert(help.stdout.includes('--no-stream'), '--help lists the options');

  const badFlag = await run(['--nope']);
  assert(badFlag.code === 2, `an unknown option exits 2 (got ${badFlag.code})`);
  assert(badFlag.stderr.includes('unknown option'), 'and says why');

  const badValue = await run(['--model']);
  assert(badValue.code === 2, 'a flag missing its value exits 2');
  assert(badValue.stderr.includes('needs a value'), 'and says what it needed');

  const noPrompt = await run([]);
  assert(noPrompt.code === 2, `no prompt and no TTY exits 2 (got ${noPrompt.code})`);
  assert(noPrompt.stderr.includes('-p'), 'and points at -p');

  // ── missing key ──────────────────────────────────────────────────────────
  const noKey = await run(['-p', 'hi'], { env: { AEGIS_API_KEY: '' } });
  assert(noKey.code === 2, `a missing key exits 2 (got ${noKey.code})`);
  assert(noKey.stderr.includes('AEGIS_API_KEY'), 'and names the variable');

  // ── a failing backend is reported, not swallowed ─────────────────────────
  const badBase = await run(['-p', 'hi'], { env: { AEGIS_API_BASE: 'http://127.0.0.1:1' } });
  assert(badBase.code === 1, `a dead backend exits non-zero (got ${badBase.code})`);
  assert(badBase.stderr.includes('aegiscode:'), `and reports the failure (${JSON.stringify(badBase.stderr)})`);

  console.log('CLI run test passed');
  console.log(`  one-shot: exit 0, "Hello" + "1,500 tok" on stdout, ${seen.chat.length} backend calls seen`);
  console.log(`  wire: stream_options.include_usage=${streamed.stream_options.include_usage}, model omitted when unpinned`);
  console.log(`  arg handling: --version/--help 0 · bad flag/no prompt/no key 2 · dead backend 1`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  stub.close();
}
