#!/usr/bin/env node
/**
 * AEGIS MCP server — exposes aegiscloud capabilities to any Claude Code user.
 *
 * Zero dependencies: raw JSON-RPC 2.0 over stdio (newline-delimited), Node's
 * global fetch. Runs from a bare `node server.js` — no npm install required.
 *
 * This is a thin HOST: all transport lives in ../client/aegis.js and the tool
 * registry lives in ./tools.js. This file only speaks MCP JSON-RPC.
 */

'use strict';

const { createClient } = require('../client/aegis.js');
const credentials = require('../client/credentials.js');
const { createTools } = require('./tools.js');

// The account credential is resolved the same way in all three hosts: the
// environment first, then the 0600 store the terminal host writes with
// `aegiscode login` (or /key), then a legacy config.json. This host used to
// read `AEGIS_API_KEY` from the environment alone, so a user who signed in from
// the CLI still met "No AEGIS_API_KEY is set" here — the credential existed,
// this process just would not look at it.
//
// `client/` is inside the tree the plugin ships (mcp/ + client/), so this needs
// no dependency on the CLI package to work when installed.
const aegis = createClient(credentials.clientOptions());
// The tool registry lives in ./tools.js, shared with the terminal host
// (cli/) so the two hosts cannot drift apart. This file owns the JSON-RPC
// plumbing and nothing else.
const { TOOLS, toolList } = createTools(aegis);
const API_KEY = aegis.apiKey;
const API_BASE = aegis.apiBase;
const SERVER_NAME = 'aegis';
// Keep in sync with .claude-plugin/plugin.json "version".
const SERVER_VERSION = '0.3.1';

/** The one instruction that actually resolves a missing key. */
function missingKeyText() {
  const { path } = credentials.keyStatus();
  return [
    'No AEGIS API key is configured for this session.',
    '',
    'Set one with any of:',
    '  • `aegiscode login` in a terminal (saves it to ' + path + ', mode 0600)',
    '  • export AEGIS_API_KEY=… in the environment Claude Code was launched from',
    '',
    'Then restart Claude Code. Get a key at https://aegiscloud.org.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP plumbing
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// Track in-flight handlers so we don't exit while a fetch is pending.
let pending = 0;
let stdinClosed = false;
function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // no response for notifications

      case 'ping':
        if (!isNotification) reply(id, {});
        return;

      case 'tools/list':
        reply(id, { tools: toolList() });
        return;

      case 'tools/call': {
        const name = params && params.name;
        const tool = TOOLS[name];
        if (!tool) {
          reply(id, {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          });
          return;
        }
        if (!API_KEY) {
          reply(id, {
            content: [{ type: 'text', text: missingKeyText() }],
            isError: true,
          });
          return;
        }
        try {
          const text = await tool.run((params && params.arguments) || {});
          reply(id, { content: [{ type: 'text', text }], isError: false });
        } catch (err) {
          reply(id, {
            content: [{ type: 'text', text: `AEGIS error: ${err.message}` }],
            isError: true,
          });
        }
        return;
      }

      default:
        if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
        return;
    }
  } catch (err) {
    if (!isNotification) replyError(id, -32603, err.message);
  }
}

// ---------------------------------------------------------------------------
// stdin loop — newline-delimited JSON-RPC
// ---------------------------------------------------------------------------

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    pending++;
    Promise.resolve(handleMessage(msg)).finally(() => {
      pending--;
      maybeExit();
    });
  }
});
process.stdin.on('end', () => {
  stdinClosed = true;
  maybeExit();
});
