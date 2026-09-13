#!/usr/bin/env node
'use strict';

/**
 * `aegiscode` — the AEGIS terminal host.
 *
 * Third host over the same two shared pieces the other two use: the thin
 * transport (client/aegis.js) and the tool registry (mcp/tools.js). The MCP
 * host answers a coding agent's tool calls; the desktop is a window; this is
 * the shell. None of them owns a brain — routing, tiers, memory and billing all
 * stay behind aegiscloud.org.
 *
 * This file is argument parsing and process lifecycle only. Everything
 * testable lives in ../src/app.js.
 */

const path = require('node:path');

const HELP = `aegiscode — AEGIS in your shell.

Usage:
  aegiscode                     interactive session
  aegiscode "question"          one-shot, then exit
  aegiscode -p "question"       same, explicit
  echo "q" | aegiscode -p -     read the prompt from stdin

Options:
  -m, --model <id>        pin a model id (see /models; default: server choice)
      --base <url>        API base (default $AEGIS_API_BASE or aegiscloud.org)
      --key <key>         API key for this run (prefer $AEGIS_API_KEY)
      --json              with -p: emit JSON instead of text
      --no-stream         buffer the answer instead of streaming it
      --max-tokens <n>    output ceiling hint
      --light             light theme
      --width <cols>      force a render width (useful for piping/logs)
  -h, --help              this text
  -v, --version           print the version

In-session: type /help for commands, /quit to exit, esc/ctrl+c to interrupt a
running call. Plain text is a prompt (identical to /ask).
`;

function parseArgs(argv) {
  const opts = {
    model: null,
    base: null,
    key: null,
    json: false,
    stream: true,
    maxTokens: undefined,
    light: false,
    width: null,
    prompt: null,
    help: false,
    version: false,
  };
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      case '-p':
      case '--print':
        // `-p` takes an optional prompt; a bare `-p` means "read stdin".
        opts.prompt = argv[i + 1] && !argv[i + 1].startsWith('-') ? next() : '-';
        break;
      case '-m':
      case '--model':
        opts.model = next();
        break;
      case '--base':
        opts.base = next();
        break;
      case '--key':
        opts.key = next();
        break;
      case '--json':
        opts.json = true;
        break;
      case '--no-stream':
        opts.stream = false;
        break;
      case '--stream':
        opts.stream = true;
        break;
      case '--max-tokens':
        opts.maxTokens = Number(next());
        break;
      case '--light':
        opts.light = true;
        break;
      case '--width':
        opts.width = Number(next());
        break;
      default:
        if (a.startsWith('-') && a !== '-') throw new Error(`unknown option: ${a}`);
        rest.push(a);
    }
  }
  if (!opts.prompt && rest.length) opts.prompt = rest.join(' ');
  return opts;
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
    });
    process.stdin.on('end', () => resolve(buf.trim()));
  });
}

async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`aegiscode: ${e.message}\n\n${HELP}`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const pkg = require(path.join(__dirname, '..', 'package.json'));
  if (opts.version) {
    process.stdout.write(pkg.version + '\n');
    return 0;
  }

  // Apply the flags that the shared client reads from the environment, before
  // anything constructs it.
  if (opts.base) process.env.AEGIS_API_BASE = opts.base;
  if (opts.key) process.env.AEGIS_API_KEY = opts.key;

  const { createApp } = require('../src/app.js');

  let prompt = opts.prompt;
  if (prompt === '-') {
    if (process.stdin.isTTY) {
      process.stderr.write('aegiscode: -p - expects a prompt on stdin\n');
      return 2;
    }
    prompt = await readStdin();
    if (!prompt) {
      process.stderr.write('aegiscode: empty stdin\n');
      return 2;
    }
  }

  const app = createApp({
    model: opts.model,
    stream: opts.stream,
    light: opts.light,
    maxTokens: opts.maxTokens,
    width: opts.width ? () => opts.width : undefined,
    interactive: !prompt && Boolean(process.stdin.isTTY),
  });

  if (prompt) return app.runOnce(prompt, { json: opts.json });

  if (!process.stdin.isTTY) {
    process.stderr.write(
      'aegiscode: no terminal and no prompt. Use `aegiscode -p "question"` or pipe a prompt in.\n'
    );
    return 2;
  }
  return app.runInteractive();
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((e) => {
      process.stderr.write(`aegiscode: ${e && e.message ? e.message : e}\n`);
      process.exit(1);
    });
}

module.exports = { main, parseArgs, HELP };
