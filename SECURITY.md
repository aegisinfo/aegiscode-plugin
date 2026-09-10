# Security Policy

## Reporting a vulnerability

If you discover a security issue in this repository, please **do not** open a
public issue. Report it privately so it can be addressed before disclosure:

- GitHub: **Security → Report a vulnerability** (private security advisory) on
  [aegisinfo/aegiscode-plugin](https://github.com/aegisinfo/aegiscode-plugin/security/advisories/new)
- Email: security@aegiscloud.org

Please include:

1. A description of the issue and its impact.
2. Steps to reproduce (or a proof of concept).
3. The affected component and version.

You should receive an initial response within **72 hours**. We will keep you
informed of progress and credit you in the fix unless you ask to remain
anonymous.

## Scope

This repository is a **thin client wrapper** only. In scope:

- `install.sh` — the one-line installer
- `mcp/server.js` — the zero-dependency stdio MCP server
- `commands/*` and `skills/*` — Claude Code slash commands and skills

Out of scope (handled by separate private/service teams):

- `aegiscloud.org` and its server-side services
- The private AEGIS engine and orchestration ("the brain")

## What this repository does **not** contain

- **No secrets, keys, or credentials** are stored in this repository.
- Your `AEGIS_API_KEY` (`aegis_...`) lives only in your own shell environment,
  written by `install.sh` to your shell rc file. It is never committed and
  never shipped in the plugin.
- The memory token is **derived from your `AEGIS_API_KEY`** at runtime
  (`client/aegis.js` exchanges the key via `POST /api/verify-api-key`) and is
  cached in memory only. It is never a credential you hold, supply, or store.
- No model weights, no orchestration logic, no server-side code.

If you believe a secret has been committed, report it via the private channel
above immediately.
