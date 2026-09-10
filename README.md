# AEGIS for Claude Code

Bring AEGIS tooling into your own Claude Code: pooled multi-provider inference,
cross-machine cloud memory, and account tools — all driven by a single AEGIS API
key. This repo also ships **AEGIS Desktop**, a standalone Electron chat app —
see [AEGIS Desktop (Electron)](#aegis-desktop-electron) below.

## What you get

| Tool / command | What it does |
|---|---|
| `/aegis-status` | Show ÆGIS ecosystem status — memory stats + cloud sync (via `aegis --memory-stats-json` + `/cloud status`) |
| `/aegis-recall <topic>` | Search cross-session ÆGIS memory (`aegis --memory-search-json`) |
| `/aegis-remember <note>` | Save a decision/fact to ÆGIS memory (`aegis --memory-add-json`) |
| `/aegis-council <question>` | Put a question to the multi-model ÆGIS council (`aegis --print "/council …"`) |
| `/aegis-multi <task>` | Prepare ÆGIS `/multi` multi-agent orchestration (or run it, on request) |
| `/aegis-ask` · `aegis_ask` | Pooled inference. Pin any `model` id from `aegis_list_models`, or omit `model` to let the server pick its default |
| `aegis_list_models` | List the exact models you can pin with `aegis_ask`'s `model` argument |
| `aegis_balance` | Check your AEGIS token bank balance and recent spend |
| `aegis_byok_status` | List which providers have a Bring-Your-Own-Key set |
| `aegis_byok_set` | Set (or remove) your own provider API key |
| `aegis_memory_save` | Save a durable note to AEGIS cloud memory |
| `aegis_memory_search` | Search your cloud memory |
| `aegis_memory_list` | List recent cloud-memory entries |

The `/aegis-status`, `/aegis-recall`, `/aegis-remember`, `/aegis-council`, and
`/aegis-multi` commands shell out to the installed `aegis` CLI (no server, no
key needed beyond `aegis login`). The `aegis_*` MCP tools are served by the
bundled stdio MCP server (`mcp/server.js`) against your AEGIS API key.

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

### Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/aegisinfo/aegiscode-plugin/main/install.sh | bash
```

Prompts for your AEGIS key (get one free at https://aegiscloud.org), writes
it to your shell rc file, adds the marketplace, and installs the plugin —
all via the `claude plugin` CLI. Restart Claude Code afterward and run
`/aegis-status` to confirm. To skip the prompt (e.g. non-interactive shells),
export your **real** key first, then pipe:

```bash
export AEGIS_API_KEY="aegis_..."   # your real key from https://aegiscloud.org
curl -fsSL https://raw.githubusercontent.com/aegisinfo/aegiscode-plugin/main/install.sh | bash
```

### Manual install

1. Get an API key at **https://aegiscloud.org** (looks like `aegis_...`).
2. Export it so Claude Code inherits it:

   ```bash
   echo 'export AEGIS_API_KEY="aegis_your_key_here"' >> ~/.bashrc   # or ~/.zshrc
   ```

3. Inside Claude Code:

   ```
   /plugin marketplace add aegisinfo/aegiscode-plugin
   /plugin install aegiscode@aegiscode
   ```

4. **Restart Claude Code**, then run `/aegis-status` to confirm.

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

## AEGIS Desktop (Electron)

This repo also ships **AEGIS Desktop** (`desktop/`), a thin Electron chat UI
over the same `client/aegis.js` transport, with a model-class picker covering
four sources instead of just the pooled cloud:

| Class | Transport | Key held in |
|---|---|---|
| Aegis Cloud (pooled or pinned model) | `aegiscloud.org` | main process |
| BYOK relay | `aegiscloud.org` relay | main process |
| OpenAI-compatible (Ollama, LM Studio, OpenRouter, vLLM, ...) | direct from desktop | main process — never sent to the renderer |
| Anthropic-compatible (Claude, or any Messages-format gateway) | direct from desktop | main process |

Conversations persist locally (`sessions.json`) and sync to AEGIS cloud memory
via a pending-queue that flushes on each "Sync now" / heartbeat retry; a
"remember" button on any assistant reply — from any of the four classes —
pins that message to cross-machine memory (queued locally if offline).

Run it from source:

```bash
cd desktop
npm install
npm start
```

Build a distributable (AppImage/deb/... via `electron-builder`):

```bash
cd desktop
npm run dist        # packaged app
npm run dist:dir    # unpacked dir, for quick testing
```
