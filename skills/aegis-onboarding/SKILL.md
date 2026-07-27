---
name: aegis-onboarding
description: Use when an AEGIS MCP tool (aegis_status, aegis_ask, aegis_memory_*) fails because no API key is configured, or when the user asks how to set up / connect / authenticate the AEGIS (aegiscloud) plugin. Walks the user through getting and setting their AEGIS API key.
---

# AEGIS setup

The AEGIS plugin gives Claude Code pooled multi-provider inference and
cross-machine cloud memory through a single AEGIS API key.

## Getting a key

1. Sign in at **https://aegiscloud.org**.
2. Copy the API key — it looks like `aegis_...` (paid plans also unlock cloud memory).

## Setting the key

The MCP server reads `AEGIS_API_KEY` from the environment. Have the user add it
to their shell profile so Claude Code inherits it:

```bash
echo 'export AEGIS_API_KEY="aegis_your_key_here"' >> ~/.bashrc   # or ~/.zshrc
```

Then **fully restart Claude Code** (the MCP server picks up env at launch).

Optional: set `AEGIS_API_BASE` to override the default `https://aegiscloud.org`
(useful for self-hosted / staging backends).

## Verifying

Run `/aegis-status` (or call the `aegis_status` tool). A valid key reports the
plan and whether memory is enabled.

## What the tools do

- `aegis_status` — validate key, show plan + memory status.
- `aegis_ask` — send a prompt to AEGIS pooled inference (`fast`/`smart`/`neo`).
- `aegis_memory_save` / `aegis_memory_search` / `aegis_memory_list` — durable
  cloud memory that persists across machines and sessions (requires a plan with
  memory enabled; free accounts are capped at 3 memory sessions).

## Common issues

- **"No AEGIS_API_KEY is set"** — the env var isn't visible to Claude Code.
  Confirm with `echo $AEGIS_API_KEY` in the same shell that launches Claude Code,
  then restart it.
- **Memory tool says memory isn't enabled** — the account's plan doesn't include
  cloud memory. Upgrade at https://aegiscloud.org/subscribe.
- **402 insufficient_quota on `aegis_ask`** — the account's token bank is empty;
  top up or upgrade.
