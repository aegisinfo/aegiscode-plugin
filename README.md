# AEGIS Code

**Pooled multi-provider inference, cross-machine memory, and account tools —
as a Claude Code plugin, a standalone desktop app, and a shared transport
library.** Everything runs off a single AEGIS API key.

This is **not just a Claude Code plugin.** The repo ships three surfaces over
one backend, and you can use any of them without the others.

| I want to… | Use | Install |
|---|---|---|
| Get AEGIS tools inside Claude Code | [Claude Code plugin](#claude-code-plugin) | one-line installer |
| Use a standalone desktop AI app | [AEGIS Desktop](#aegis-desktop-electron) | build from source |
| Embed the transport in my own software | [Shared thin client](#shared-thin-client) | copy `client/aegis.js` |

Get a free key at **https://aegiscloud.org**.

---

## Claude Code plugin

**Requirements:** Node.js 18+ and the `claude` CLI.

```bash
curl -fsSL https://raw.githubusercontent.com/aegisinfo/aegiscode-plugin/main/install.sh | bash
```

The installer prompts for your AEGIS key, saves it to `~/.bashrc` and
`~/.zshrc`, registers the marketplace (`aegisinfo/aegiscode-plugin`), and
installs the plugin (`aegiscode@aegiscode`). Then **restart Claude Code** and
run:

```
/aegis-status
```

### Non-interactive install

Export your real key first, then pipe — the installer will not prompt:

```bash
export AEGIS_API_KEY="aegis_..."
curl -fsSL https://raw.githubusercontent.com/aegisinfo/aegiscode-plugin/main/install.sh | bash
```

### Manual install

```bash
# 1. Save your key
echo 'export AEGIS_API_KEY="aegis_your_key_here"' >> ~/.bashrc   # or ~/.zshrc

# 2. Inside Claude Code
/plugin marketplace add aegisinfo/aegiscode-plugin
/plugin install aegiscode@aegiscode

# 3. Restart Claude Code, then run /aegis-status
```

### Slash commands

These shell out to the installed `aegis` CLI — no server round-trip needed.

| Command | What it does |
|---|---|
| `/aegis-status` | Ecosystem status — memory stats + cloud sync |
| `/aegis-recall <topic>` | Search cross-session AEGIS memory |
| `/aegis-remember <note>` | Save a decision or fact to memory |
| `/aegis-council <question>` | Put a question to the multi-model AEGIS council |
| `/aegis-multi <task>` | Prepare (or run) `/multi` multi-agent orchestration |
| `/aegis-ask` | Pooled inference via the MCP tool below |

### MCP tools

Served by the bundled zero-dependency stdio server (`mcp/server.js`) against
your AEGIS API key.

| Tool | What it does |
|---|---|
| `aegis_ask` | Pooled inference. Pin any `model` id from `aegis_list_models`, or omit `model` to let the server pick its default |
| `aegis_list_models` | List the exact models you can pin with `aegis_ask`'s `model` argument |
| `aegis_balance` | Check your token bank balance and recent spend |
| `aegis_byok_status` | List which providers have a Bring-Your-Own-Key set |
| `aegis_byok_set` | Set (or remove) your own provider API key |
| `aegis_memory_save` | Save a durable note to cloud memory |
| `aegis_memory_search` | Search your cloud memory |
| `aegis_memory_list` | List recent cloud-memory entries |

Cloud memory persists across machines and sessions — anything you save on one
laptop is searchable from another.

### Bring your own key (BYOK)

`aegis_ask` normally spends from your AEGIS token bank. To use your own
Anthropic, Groq, or OpenAI key at your own cost instead, set it once:

```
set my anthropic key to sk-ant-...
```

From then on, `aegis_ask` calls for that provider use your key directly — no
more running out of AEGIS credit. Remove it any time by calling
`aegis_byok_set` again with no key. Keys are encrypted at rest server-side and
never returned in full (only a masked preview).

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AEGIS_API_KEY` | — | Your key (required) |
| `AEGIS_API_BASE` | `https://aegiscloud.org` | Override the backend base URL — useful for self-hosted or staging |

---

## AEGIS Desktop (Electron)

A standalone chat app over the same transport, with an **agentic tool loop**:
the model can read, write, and edit files, list directories, glob, grep, run
shell commands in a persistent session, and delegate whole sub-tasks to
subagents. It does **not** require Claude Code.

| Tool | What it does |
|---|---|
| `readFile` · `writeFile` · `editFile` | File access scoped to the working directory |
| `listDir` · `glob` · `grep` | Navigate and search a tree |
| `exec` | Run commands in a persistent shell session |
| `task` | Delegate a self-contained sub-task to a subagent |

### Model classes

Pick any of four transports from the model-class picker:

| Class | Transport | Key held in |
|---|---|---|
| **Aegis Cloud** | `aegiscloud.org` (pooled or pinned model) | main process |
| **Ollama** | local `ollama` daemon | no key needed |
| **Custom OpenAI-compatible** (LM Studio, OpenRouter, vLLM, …) | direct from the desktop app | main process — never sent to the renderer |
| **Anthropic-compatible** (Claude, or any Messages-format gateway) | direct from the desktop app | main process |

Conversations persist locally (`sessions.json`) and sync to AEGIS cloud memory
via a pending queue that flushes on each "Sync now" or heartbeat retry. The
**remember** button on any assistant reply pins that message to cross-machine
memory — queued locally if you're offline.

### Run from source

```bash
cd desktop
npm install
npm start
```

### Build a distributable

```bash
cd desktop
npm run dist        # packaged app (AppImage / deb / dmg / NSIS .exe)
npm run dist:dir    # unpacked dir, for quick testing
```

> **Note on prebuilt installers:** pushing a `v*` tag runs the release workflow,
> which builds installers for Windows, macOS, and Linux and attaches them to a
> **draft** GitHub Release with `generate_release_notes`. Artifacts are
> currently **unsigned** (Windows Authenticode via SignPath Foundation is
> pending — see `desktop/SIGNING.md`), and a draft release is not public until
> a maintainer publishes it. **Build from source unless a published release
> exists for your platform.**

---

## Shared thin client

`client/aegis.js` is the single public surface that talks to `aegiscloud.org`.
It is zero-dependency and runs unchanged under three hosts:

- `mcp/server.js` — the Claude Code MCP plugin (CommonJS `require`)
- `desktop/` — the Electron shell (CommonJS `require`, via a byte-identical
  vendored copy at `desktop/vendor/aegis.js`)
- `aegis-online` — a browser SPA (`<script>` tag → `window.AegisClient`)

It exposes `verifyApiKey`, `chatCompletion`, `listModels`, `tokenBankBalance`,
`byokStatus` / `byokSet`, `memorySearch` / `memorySave` / `memoryList`, and
`conversationSyncPush` / `conversationSyncPull` — all key-forwarded, with no
local storage of secrets.

```js
const aegis = require('./client/aegis.js');   // Node
// <script src="client/aegis.js"></script>    // Browser → window.AegisClient
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `aegis` tools error with "no API key" | The MCP server reads `AEGIS_API_KEY` from the environment at launch. Export it, then **restart Claude Code** — setting it while Claude Code is running has no effect. |
| `AEGIS_API_KEY` is set but tools still fail | Placeholders are rejected by the installer. Confirm the real key is exported in *this* shell: `echo $AEGIS_API_KEY`. |
| Installer exits with a Node version error | Node 18+ is required (the MCP server uses global `fetch`). Check with `node -v`. |
| Installer exits with "Claude Code CLI not found" | Install Claude Code first: https://claude.com/claude-code. Only the plugin surface needs it — the desktop app does not. |
| `/aegis-status` shows no memory | Cloud memory needs a plan with memory enabled; free accounts are capped at 3 memory sessions. |
| Saved a memory on one machine, can't find it on another | Confirm both machines use the same AEGIS key, then run `/aegis-status` to force a sync. |
| Plugin commands missing after install | Restart Claude Code. If they're still missing, re-run `/plugin install aegiscode@aegiscode`. |
| Desktop app starts but has no models listed | Configure a model class in the picker, or add your Anthropic / OpenAI-compatible key under settings. |

---

## Architecture

This repo ships **transport + UI only**. There is no engine, orchestration, or
routing/tier/brain logic here — that lives server-side on `aegiscloud.org` (and
in the private `ae-guix` product).

| Surface | Where it lives | What it is |
|---|---|---|
| **Shared thin client** | `client/aegis.js` | Zero-dependency transport to `aegiscloud.org`. The only code in this repo that talks to the backend; runs unchanged under Node (MCP + Electron) and in a browser. |
| **Claude Code plugin** | `mcp/`, `commands/`, `skills/`, `install.sh`, `.claude-plugin/` | Slash commands + MCP tools inside Claude Code. **Cloud-only** — Claude Code already runs inside a host with its own models. |
| **AEGIS Desktop** | `desktop/` | Standalone Electron chat app with the four-class model picker, streaming, an agentic tool loop, and cloud sync. Runs without Claude Code. |

### Repository layout

```
client/aegis.js      shared thin transport (MCP + Electron + browser)
mcp/server.js        zero-dependency MCP server (Claude Code tools)
commands/            Claude Code slash commands
skills/              Claude Code skills
install.sh           one-line Claude Code installer
.claude-plugin/      plugin + marketplace metadata
desktop/             AEGIS Desktop (Electron host + lib + renderer)
docs/                product plan and Electron host plan
test/                plain-Node unit + smoke tests (no Electron required)
```

### How it works

The plugin ships a small stdio MCP server (`mcp/server.js`) that calls the
aegiscloud REST API with your key. Inference goes through the OpenAI-compatible
`POST /api/v1/chat/completions`; balance and BYOK tools use the same key
against `/api/token-bank/*` and `/api/user/api-keys`; memory endpoints exchange
your API key for a memory token, then sync via `/api/memory/*`. No key or data
is stored locally by the plugin — it only forwards to `aegiscloud.org` over
HTTPS.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run the tests with plain Node — no
Electron required:

```bash
npm test          # or: node test/local-engine.test.mjs
```

Licensed under MIT — see [LICENSE](LICENSE). Security notes in
[SECURITY.md](SECURITY.md).
