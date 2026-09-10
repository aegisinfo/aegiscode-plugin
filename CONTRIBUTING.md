# Contributing

Thanks for helping improve AEGIS Code.

## What this repo is

This is the **thin client wrapper** for AEGIS: one repo, three surfaces — the
shared thin client, the Claude Code plugin, and the AEGIS Desktop app. It
deliberately contains no engine, orchestration, routing, or server-side logic —
only the surface that connects your tools to the AEGIS service:

- `client/aegis.js` — shared zero-dependency transport to `aegiscloud.org`
  (used by the MCP server, the Electron app, and the `aegis-online` browser SPA)
- `mcp/server.js` — a zero-dependency MCP server (JSON-RPC over stdio)
- `commands/*` — Claude Code slash commands
- `skills/*` — Claude Code skills
- `desktop/` — AEGIS Desktop, a thin Electron host with direct local /
  OpenAI-compatible / Anthropic-compatible transport
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
