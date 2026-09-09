# Contributing

Thanks for helping improve AEGIS for Claude Code.

## What this repo is

This is the **thin client wrapper** for AEGIS. It deliberately contains no
engine, orchestration, or server-side logic — only the surface that connects
your Claude Code to the AEGIS service:

- `mcp/server.js` — a zero-dependency MCP server (JSON-RPC over stdio)
- `commands/*` — Claude Code slash commands
- `skills/*` — Claude Code skills
- `install.sh` — the one-line installer

## Ground rules

- **Keep it a thin shell.** Don't move engine/orchestration logic into this
  repo — it belongs server-side.
- **Never commit secrets.** Keys are read from the user's environment only.
- **No new dependencies in `mcp/server.js`.** It must keep running from a bare
  `node server.js` with zero `npm install`.

## Setup

```bash
git clone https://github.com/aegisinfo/aegiscode-plugin.git
cd aegiscode-plugin
# No build step — the server is dependency-free Node.
node --check mcp/server.js   # syntax check
bash -n install.sh           # shell syntax check
```

## Submitting changes

1. Fork the repository and create a feature branch.
2. Make focused, minimal changes.
3. Run `node --check mcp/server.js` and `bash -n install.sh`.
4. Open a pull request describing the change and why it's needed.

## Style

- Shell: POSIX `sh` compatible, `set -eu`.
- JavaScript: CommonJS, `'use strict'`, 2-space indent, no dependencies.
- Keep comments explaining *why*, not *what*.

## Reporting problems

Bug reports and feature requests are welcome via GitHub issues. For security
issues, see [SECURITY.md](SECURITY.md) — do not open a public issue.
