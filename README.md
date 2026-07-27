# AEGIS for Claude Code

Bring AEGIS tooling into your own Claude Code: pooled multi-provider inference,
cross-machine cloud memory, and account tools — all driven by a single AEGIS API
key.

## What you get

| Tool / command | What it does |
|---|---|
| `/aegis-status` · `aegis_status` | Validate your key, show plan + memory status |
| `/aegis-ask` · `aegis_ask` | Pooled inference — one key routes to the cheapest capable provider (DeepSeek/GPT/Claude/Groq) server-side. Modes: `fast`, `smart`, `neo` |
| `aegis_memory_save` | Save a durable note to AEGIS cloud memory |
| `aegis_memory_search` | Search your cloud memory |
| `aegis_memory_list` | List recent cloud-memory entries |

Cloud memory persists across machines and sessions, so anything you save on one
laptop is searchable from another.

## Setup

1. Get an API key at **https://aegiscloud.org** (looks like `aegis_...`).
2. Export it so Claude Code inherits it:

   ```bash
   echo 'export AEGIS_API_KEY="aegis_your_key_here"' >> ~/.bashrc   # or ~/.zshrc
   ```

3. Install the plugin and **restart Claude Code**.
4. Run `/aegis-status` to confirm.

### Optional

- `AEGIS_API_BASE` — override the backend base URL (default
  `https://aegiscloud.org`); handy for self-hosted or staging.

## Requirements

- Node.js 18+ (uses global `fetch`; the MCP server has **zero npm dependencies**).
- An AEGIS account. Cloud memory requires a plan with memory enabled; free
  accounts are capped at 3 memory sessions.

## How it works

The plugin ships a small stdio MCP server (`mcp/server.js`) that calls the
aegiscloud REST API with your key. Inference goes through
`POST /api/v1/complete`; memory endpoints exchange your API key for a
memory token, then sync via `/api/memory/*`. No key or data is stored locally by
the plugin — it only forwards to aegiscloud.org over HTTPS.
