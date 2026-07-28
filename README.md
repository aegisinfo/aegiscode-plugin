# AEGIS for Claude Code

Bring AEGIS tooling into your own Claude Code: pooled multi-provider inference,
cross-machine cloud memory, and account tools — all driven by a single AEGIS API
key.

## What you get

| Tool / command | What it does |
|---|---|
| `/aegis-status` · `aegis_status` | Validate your key, show plan + memory status |
| `/aegis-ask` · `aegis_ask` | Pooled inference — one key routes to the cheapest capable provider (DeepSeek/GPT/Claude/Groq) server-side. Modes: `fast`, `smart`, `neo` |
| `aegis_balance` | Check your AEGIS token bank balance and recent spend |
| `aegis_byok_status` | List which providers have a Bring-Your-Own-Key set |
| `aegis_byok_set` | Set (or remove) your own provider API key |
| `aegis_memory_save` | Save a durable note to AEGIS cloud memory |
| `aegis_memory_search` | Search your cloud memory |
| `aegis_memory_list` | List recent cloud-memory entries |

Cloud memory persists across machines and sessions, so anything you save on one
laptop is searchable from another.

### Bring your own key (BYOK)

`aegis_ask` normally spends from your AEGIS token bank. If you'd rather use
your own Anthropic, Groq, or OpenAI key at your own cost, set it once with
`aegis_byok_set` (e.g. "set my anthropic key to sk-ant-..."). From then on,
`aegis_ask` calls for that provider use your key directly instead of the
pooled balance — no more running out of AEGIS credit. Remove it any time by
calling `aegis_byok_set` again with no key.

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
aegiscloud REST API with your key. Inference goes through the
OpenAI-compatible `POST /api/v1/chat/completions`; balance and BYOK tools use
the same key against `/api/token-bank/*` and `/api/user/api-keys`; memory
endpoints exchange your API key for a memory token, then sync via
`/api/memory/*`. No key or data is stored locally by the plugin — it only
forwards to aegiscloud.org over HTTPS. BYOK keys you set are encrypted at
rest server-side and never returned in full (only a masked preview).
