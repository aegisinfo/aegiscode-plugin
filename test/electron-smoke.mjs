#!/usr/bin/env node
/**
 * Headless Electron smoke test — PLAN Phase 9 (P3.6).
 *
 *   node test/electron-smoke.mjs
 *
 * The gate this repo has been missing: it boots the REAL desktop host
 * (`desktop/main.js` + preload + renderer/app.js) under Electron and drives a
 * streamed turn through it, then asserts the three behaviours the scroll/
 * interrupt fix exists for — and the DOM behaviour is asserted in the actual
 * DOM, not against a fake one:
 *
 *   1. scrolling up mid-stream does not lose the reader's position;
 *   2. Escape stops the running turn (all the way down to the in-flight fetch);
 *   3. the partial answer is salvaged and labelled `stopped by you`.
 *
 * Hermetic by construction. This file owns a loopback HTTP server that speaks
 * the real SSE wire format and points the app at it with AEGIS_API_BASE, so the
 * run needs no API key, no provider and no outbound network — while the
 * transport *stack* under test (client/aegis.js SSE parsing, AbortController,
 * engine, IPC, preload, renderer) is the genuine one, unstubbed.
 *
 * Exit code 0 only when every check passes, in both processes: the driver's DOM
 * assertions AND this file's server-side ones (the stream was genuinely cut
 * short mid-flight, and the salvaged text is a real prefix of what was sent).
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..', 'desktop');
const DRIVER = path.join(DESKTOP, 'test', 'electron-smoke-main.js');

// A key shaped nothing like a real one — it only has to be truthy so the
// renderer's Aegis Cloud class is "configured"; the stub server ignores it.
const FAKE_KEY = 'aegis-smoke-test-only';
const CHUNK_COUNT = 400;
const CHUNK_INTERVAL_MS = 25;

const failures = [];
const passes = [];

function check(name, ok, detail) {
  if (ok) {
    passes.push(`${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
  return Boolean(ok);
}

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// The stubbed streaming transport: an SSE endpoint speaking the same wire
// format the cloud pool does. It records what it sent and whether the client
// hung up mid-stream (that hang-up is the proof Escape reached the socket).
// ---------------------------------------------------------------------------
function chunkText(i) {
  return `SMOKE ${String(i).padStart(4, '0')} ${'stream filler '.repeat(4)}\n`;
}

function startStubServer() {
  const state = {
    requests: {},
    chatStreams: 0,
    chunksSent: 0,
    fullText: '',
    aborted: false,
    completed: false,
    abortedAtChunk: -1,
  };

  function json(res, body, status = 200) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function streamChat(req, res) {
    state.chatStreams += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let i = 0;
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      // A close before the last chunk is the client aborting the fetch —
      // exactly what Escape must cause.
      if (i < CHUNK_COUNT) {
        state.aborted = true;
        state.abortedAtChunk = i;
      }
    };

    const timer = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) {
        stop();
        return;
      }
      const text = chunkText(i);
      const frame = `data: ${JSON.stringify({
        id: 'chatcmpl-smoke',
        model: 'nexus-brain',
        choices: [{ index: 0, delta: { content: text } }],
      })}\n\n`;
      try {
        res.write(frame);
      } catch {
        stop();
        return;
      }
      state.fullText += text;
      state.chunksSent += 1;
      i += 1;
      if (i >= CHUNK_COUNT) {
        try {
          res.write('data: [DONE]\n\n');
          res.end();
        } catch {
          /* client left first */
        }
        clearInterval(timer);
        closed = true;
        state.completed = true;
      }
    }, CHUNK_INTERVAL_MS);

    req.on('error', stop);
    res.on('error', stop);
    res.on('close', stop);
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      state.requests[url.pathname] = (state.requests[url.pathname] || 0) + 1;

      if (url.pathname === '/api/v1/models') {
        // The cloud class collapses its catalog to the one "Nexus" entry the
        // pool advertises, so the picker has something real to select.
        json(res, {
          models: [
            { id: 'nexus-brain', label: 'Nexus' },
            { id: 'aegis-brain', label: 'Nexus', hidden: true, alias_of: 'nexus-brain' },
          ],
        });
        return;
      }
      if (url.pathname === '/api/v1/chat/completions' && req.method === 'POST') {
        streamChat(req, res);
        return;
      }
      // Everything else the renderer asks for at boot (status, token bank,
      // memory search, sync) gets a benign answer: this test is not about them
      // and none of them may error the boot.
      json(res, { ok: true, models: [], results: [], sessions: [] });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ---------------------------------------------------------------------------
// Launching the real host.
// ---------------------------------------------------------------------------
function resolveElectronBin() {
  const direct = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron');
  if (fs.existsSync(direct)) return direct;
  try {
    const viaModule = require(path.join(DESKTOP, 'node_modules', 'electron'));
    if (typeof viaModule === 'string' && fs.existsSync(viaModule)) return viaModule;
  } catch {
    /* fall through to the error below */
  }
  return null;
}

function hasXvfb() {
  return spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).status === 0;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function main() {
  const electronBin = resolveElectronBin();
  check(
    'electron-present',
    Boolean(electronBin),
    electronBin || 'no Electron binary — run `npm ci` in desktop/ first'
  );
  if (!electronBin) return;

  const stub = await startStubServer();
  const apiBase = `http://127.0.0.1:${stub.port}`;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-smoke-'));

  const switches = ['--no-sandbox', '--disable-gpu', '--in-process-gpu', DRIVER];
  let command = electronBin;
  let args = switches;
  if (hasXvfb()) {
    // CI path: a throwaway X server, nothing else on the machine involved.
    command = 'xvfb-run';
    args = ['-a', '--server-args=-screen 0 1280x800x24', electronBin, ...switches];
    check('headless-display', true, 'xvfb-run');
  } else if (process.env.DISPLAY) {
    check('headless-display', true, `existing DISPLAY=${process.env.DISPLAY} (xvfb-run not installed)`);
  } else {
    check(
      'headless-display',
      false,
      'no xvfb-run and no DISPLAY — install xvfb (apt-get install -y xvfb) or run with a display'
    );
  }
  if (failures.length) {
    await stub.close();
    return;
  }

  const env = {
    ...process.env,
    AEGIS_SMOKE: '1',
    AEGIS_API_BASE: apiBase,
    AEGIS_API_KEY: FAKE_KEY,
    // The app must never touch the developer's real settings/sessions store.
    XDG_CONFIG_HOME: userData,
    HOME: process.env.HOME || userData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  delete env.AEGIS_MEMORY_TOKEN;
  delete env.AEGIS_TOKEN;

  const child = spawn(command, args, {
    cwd: DESKTOP,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  const timeoutMs = Number(process.env.AEGIS_SMOKE_TIMEOUT_MS || 120000);
  const exitCode = await new Promise((resolve) => {
    const killer = setTimeout(() => {
      failures.push(`electron run timed out after ${timeoutMs}ms`);
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve(signal ? `signal:${signal}` : code);
    });
  });

  await stub.close();
  const state = stub.state;
  const evidenceLine = stdout.split('\n').find((l) => l.startsWith('SMOKE_EVIDENCE '));
  let payload = null;
  if (evidenceLine) {
    try {
      payload = JSON.parse(evidenceLine.slice('SMOKE_EVIDENCE '.length));
    } catch (err) {
      failures.push(`could not parse SMOKE_EVIDENCE: ${err.message}`);
    }
  }

  if (process.env.AEGIS_SMOKE_DEBUG === '1' || !payload) {
    if (stderr.trim()) console.error(stderr.trim().split('\n').slice(-40).join('\n'));
  }

  // ── process-level ────────────────────────────────────────────────────────
  check('electron-exit-0', exitCode === 0, `exit=${exitCode}`);
  check('driver-evidence', Boolean(payload), evidenceLine ? '' : 'no SMOKE_EVIDENCE line on stdout');
  if (!payload) {
    report({ state, payload });
    return;
  }

  const ev = payload.evidence || {};
  const byName = new Map((payload.checks || []).map((c) => [c.name, c]));
  const driverCheck = (name) => {
    const c = byName.get(name);
    return check(`driver:${name}`, Boolean(c && c.ok), c && !c.ok ? String(c.detail) : '');
  };

  check('driver-ok', payload.ok === true, payload.fatal ? `fatal: ${payload.fatal}` : '');
  check(
    'driver-ran-enough-checks',
    (payload.checks || []).length >= 10,
    `${(payload.checks || []).length} checks recorded`
  );

  // ── 1. scroll-hold (the regression this phase exists to catch) ──────────
  driverCheck('transcript-overflows');
  driverCheck('scrolled-up-moved');
  driverCheck('stream-live-during-hold');
  driverCheck('position-held-while-streaming');
  driverCheck('veto-engaged');
  driverCheck('scrolled-up-flag-set');

  // ── 2. Escape stops the stream ───────────────────────────────────────────
  driverCheck('escape-consumed');
  check(
    'transport-saw-abort',
    state.aborted === true,
    state.aborted
      ? `client hung up at chunk ${state.abortedAtChunk}/${CHUNK_COUNT}`
      : 'the stubbed transport was never aborted — Escape did not reach the fetch'
  );
  check(
    'stream-cut-short',
    state.completed === false,
    state.completed ? 'the stub stream finished on its own; nothing was interrupted' : ''
  );
  check(
    'stub-was-used',
    state.chatStreams === 1,
    `chat streams through the stub: ${state.chatStreams}, paths: ${JSON.stringify(state.requests)}`
  );

  // ── 3. partial answer salvaged, honestly labelled ───────────────────────
  driverCheck('salvage-bubble-present');
  driverCheck('partial-text-salvaged');
  driverCheck('no-error-bubble');
  driverCheck('pending-bubble-cleared');
  driverCheck('stream-really-stopped');

  const salvaged = norm(ev.settled && ev.settled.stoppedText);
  const sent = norm(state.fullText);
  check(
    'salvaged-is-real-prefix',
    salvaged.length > 200 && sent.startsWith(salvaged),
    `salvaged ${salvaged.length} chars of ${sent.length} streamed — ${
      sent.startsWith(salvaged) ? 'exact prefix' : 'NOT a prefix of what the transport sent'
    }`
  );
  check(
    'salvaged-is-partial',
    salvaged.length < sent.length,
    'the salvaged text equals the whole stream — nothing was actually interrupted'
  );

  report({ state, payload });
}

function report({ state, payload }) {
  console.log('\n── headless Electron smoke (P3.6) ─────────────────────────────');
  for (const p of passes) console.log(`  PASS  ${p}`);
  for (const f of failures) console.log(`  FAIL  ${f}`);
  if (payload && payload.evidence) {
    const e = payload.evidence;
    console.log(
      `\n  transcript: scrollTop ${e.before.scrollTop} -> ${e.held.scrollTop} while ` +
        `${e.before.textLen} -> ${e.held.textLen} chars streamed ` +
        `(scrollHeight ${e.held.scrollHeight}, clientHeight ${e.held.clientHeight})`
    );
    console.log(
      `  interrupt:  Escape at ${e.escaped.textAtEscape} chars -> salvaged ` +
        `${e.settled.stoppedLength} chars labelled "stopped by you"; transport aborted=${state.aborted}`
    );
  }
  console.log(
    `\n  ${failures.length === 0 ? 'OK' : 'FAILED'} — ${passes.length} passed, ${failures.length} failed\n`
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
