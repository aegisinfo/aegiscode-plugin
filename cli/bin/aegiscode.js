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

Account:
  aegiscode login [<key>]       save your AEGIS API key (prompts, no echo, if omitted)
  aegiscode logout              remove the saved key
  aegiscode key status          show which key is in use and where it came from

Options:
  -m, --model <id>        pin a model id (see /models; default: server choice)
      --base <url>        API base (default $AEGIS_API_BASE or aegiscloud.org)
      --key <key>         API key for THIS RUN only — it is not saved. Use
                           "aegiscode login" to store one for good.
      --json              with -p: emit JSON instead of text
      --no-stream         buffer the answer instead of streaming it
      --max-tokens <n>    output ceiling hint
      --light             light theme
      --width <cols>      force a render width (useful for piping/logs)
      --yolo              skip tool-approval prompts (exec/writeFile/editFile
                           run without asking) — same as the in-session /yolo
  -c, --continue          skip onboarding and resume the most recent session
  -h, --help              this text
  -v, --version           print the version

In-session: type /help for commands, /quit to exit, esc/ctrl+c to interrupt a
running call. Plain text is a prompt (identical to /ask) — a question that
needs a file read, a shell command, or an edit is handled the same turn.
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
    yolo: false,
    continue: false,
    prompt: null,
    help: false,
    version: false,
    command: null,
    commandArg: null,
  };
  const rest = [];

  // An account subcommand is `argv[0]` and nothing else — position 0 only, so
  // `aegiscode -p "key"` (a one-shot prompt whose text happens to be one of
  // these words) is never hijacked into an account operation.
  const head = argv[0];
  if (head && !head.startsWith('-') && ACCOUNT_COMMANDS.has(head)) {
    const arg = argv[1];
    opts.command = head;
    opts.commandArg = arg && !arg.startsWith('-') ? arg : null;
    argv = argv.slice(opts.commandArg ? 2 : 1);
  } else if (head === 'autonomous') {
    // Same position-0 rule, one difference: a queue subcommand owns the REST of
    // the line (including flags, which are the subcommand's, not the session
    // parser's), so the tail is handed over verbatim instead of parsed here.
    // `aegiscode autonomous "write a file"` is not a thing — `add` is — so a
    // bare `autonomous` is help, not a prompt.
    const sub = argv[1] && !argv[1].startsWith('-') ? argv[1] : 'help';
    opts.command = 'autonomous';
    opts.commandArg = sub;
    opts.commandArgv = argv.slice(argv[1] && !argv[1].startsWith('-') ? 2 : 1);
    argv = [];
  }

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
      case '--yolo':
        opts.yolo = true;
        break;
      case '-c':
      case '--continue':
        opts.continue = true;
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

/**
 * Account subcommands: the in-band way to give this host a key.
 *
 * They exist because an `AEGIS_API_KEY` export was previously the *only* way
 * in, and an export does not survive a new terminal. `--key` remains purely
 * per-run (CI, a rotation test) so there is exactly one thing a user has to
 * remember: `aegiscode login` saves it, `aegiscode logout` removes it.
 */
const ACCOUNT_COMMANDS = new Set(['login', 'logout', 'key']);

/**
 * Run `login` / `logout` / `key` and return a process exit code.
 *
 * Exit codes are meaningful because these are the commands a script calls:
 * 0 = done, 1 = the server refused the credential, 2 = no credential and no
 * way to ask for one (no TTY).
 */
async function runAccountCommand(command, arg, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const stdin = io.stdin || process.stdin;
  const { credentials, readSecret, maskKey } = loadAccountDeps();

  const where = () => credentials.credentialsPath();

  if (command === 'logout' || (command === 'key' && ['clear', 'remove', 'rm'].includes(String(arg || '').toLowerCase()))) {
    const res = credentials.clearApiKey();
    stdout.write(
      res.cleared
        ? `aegiscode: key removed from ${res.path}\n`
        : 'aegiscode: no saved key to remove\n'
    );
    if (credentials.legacyKeyOnDisk()) {
      stdout.write(
        'aegiscode: note — a plaintext copy is also in config.json, written by an older ' +
          'AEGIS CLI; delete its "aegiscloud" block as well to finish removing it\n'
      );
    }
    return 0;
  }

  if (command === 'key' && ['status', 'show', ''].includes(String(arg || '').toLowerCase())) {
    const st = credentials.keyStatus();
    if (io.json) {
      stdout.write(
        JSON.stringify(
          {
            configured: st.configured,
            source: st.source,
            source_label: credentials.sourceLabel(st.source),
            path: st.path,
            file_mode: st.fileMode,
            masked: st.configured ? maskKey(st.key) : null,
            memory_token: st.memoryToken,
            verified_at: st.verifiedAt,
            plaintext_copy_in_config: st.legacyPlaintext,
          },
          null,
          2
        ) + '\n'
      );
      return st.configured ? 0 : 1;
    }
    stdout.write(
      [
        `key:      ${st.configured ? maskKey(st.key) : 'not set'}`,
        `source:   ${credentials.sourceLabel(st.source)}`,
        `file:     ${st.path}${st.fileMode ? ` (${st.fileMode})` : ''}`,
        `memory:   ${st.memoryToken ? 'token held (cloud sync ready)' : 'no token'}`,
        st.verifiedAt ? `verified: ${st.verifiedAt}` : null,
        st.legacyPlaintext
          ? `note:     a plaintext copy also sits in config.json — re-save with \`aegiscode login\` to move it`
          : null,
      ]
        .filter(Boolean)
        .join('\n') + '\n'
    );
    return st.configured ? 0 : 1;
  }

  // `login [<key>]` and `key <api_key>`: take the key inline or ask for it.
  let key = arg && arg !== 'status' ? String(arg).trim() : '';
  if (!key) {
    if (!stdin.isTTY) {
      stderr.write(
        'aegiscode: no terminal to prompt on — pass the key: `aegiscode login <api_key>`\n' +
          '           (or set AEGIS_API_KEY for a single run)\n'
      );
      return 2;
    }
    key = await readSecret('AEGIS API key (kept off screen, Enter to cancel): ', { stdin, stdout });
  }
  if (!key) {
    stderr.write('aegiscode: no key given — nothing saved\n');
    return 2;
  }

  const { createApp } = require('../src/app.js');
  const app = createApp({ interactive: false });
  const res = await app.setApiKey(key);
  if (!res.ok) {
    stderr.write(`aegiscode: ${res.message || 'that key could not be saved'}\n`);
    return 2;
  }
  const who = res.account && (res.account.email || res.account.plan);
  stdout.write(`aegiscode: key saved to ${res.path}${who ? ` — ${who}` : ''}\n`);
  if (res.error) {
    const status = res.error.status;
    stderr.write(`aegiscode: the account check failed: ${res.error.message}\n`);
    if (status === 401 || status === 403) {
      stderr.write('aegiscode: the key is stored but the server refused it — re-run with a fresh key\n');
      return 1;
    }
    stderr.write('aegiscode: (stored anyway — the server could not be reached to confirm it)\n');
    return 0;
  }
  stdout.write('aegiscode: verified — run `aegiscode` to start a session\n');
  return 0;
}

/** Lazily required so `--version`/`--help` stay dependency-free and instant. */
function loadAccountDeps() {
  const credentials = require('../src/credentials.js');
  const { readSecret } = require('../src/secret.js');
  const { maskKey } = require('../src/format.js');
  return { credentials, readSecret, maskKey };
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

  // Account subcommands run before a session is built: they are one-shot,
  // non-interactive, and must work in a script (`aegiscode login "$KEY"`) as
  // well as at a prompt.
  if (ACCOUNT_COMMANDS.has(opts.command)) {
    return runAccountCommand(opts.command, opts.commandArg, {
      json: opts.json,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
  }

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
    confirmMode: !opts.yolo,
    continue: opts.continue,
  });

  if (prompt) return app.runOnce(prompt, { json: opts.json });

  if (!process.stdin.isTTY) {
    process.stderr.write(
      'aegiscode: no terminal and no prompt. Use `aegiscode -p "question"` or pipe a prompt in.\n'
    );
    return 2;
  }
  const code = await app.runInteractive();
  // The reference leaves a resume hint on exit; without one there is no way to
  // discover that a session was persisted at all (`/resume` lists them, but a
  // user who just quit is not looking at a command list).
  process.stdout.write(`\nResume this session with:\n  aegiscode --continue   (or /resume for the list)\n`);
  return code;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((e) => {
      process.stderr.write(`aegiscode: ${e && e.message ? e.message : e}\n`);
      process.exit(1);
    });
}

module.exports = { main, parseArgs, HELP, ACCOUNT_COMMANDS, runAccountCommand };
