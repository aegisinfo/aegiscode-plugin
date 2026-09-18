# AEGIS Code

**Pooled multi-provider inference, cross-machine memory, and account tools —
as a Claude Code plugin, a standalone desktop app, and a shared transport
library.** Everything runs off a single AEGIS API key.

This is **not just a Claude Code plugin.** The repo ships three surfaces over
one backend, and you can use any of them without the others.

| I want to… | Use | Install |
|---|---|---|
| Get AEGIS tools inside Claude Code | [Claude Code plugin](#claude-code-plugin) | one-line installer |
| Use a standalone desktop AI app | [AEGIS Desktop](#aegis-desktop-electron) | `npm i -g aegis-desktop` |
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
# 1. Save your key — one file, shared with the desktop app and the CLI
aegiscode login                       # prompts, no echo, saves to ~/.aegiscode/credentials.json
# …or, if you don't have the CLI installed:
echo 'export AEGIS_API_KEY="aegis_your_key_here"' >> ~/.bashrc   # or ~/.zshrc

# 2. Inside Claude Code
/plugin marketplace add aegisinfo/aegiscode-plugin
/plugin install aegiscode@aegiscode

# 3. Restart Claude Code, then run /aegis-status
```

The plugin resolves the credential the same way the other AEGIS hosts do —
`$AEGIS_API_KEY` first, then `~/.aegiscode/credentials.json` — so a key saved by
`aegiscode login` or in the desktop's Settings works here with no environment
variable to keep in sync.

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

Two lanes, and they are genuinely different. Pick by **where you want the key to
live**, not by which is cheaper.

| | Lane A — account key | Lane B — machine key |
|---|---|---|
| What it stores | your provider key on your **AEGIS account** | your provider key on **this machine** |
| Who talks to the vendor | AEGIS, server-side | AEGIS, server-side (relay) |
| Best for | Claude Code on any machine you sign in to | one terminal, no key ever on the account |
| Plugin | `set my anthropic key to sk-ant-…` (`aegis_byok_set`) | — |
| CLI | `/byok-set anthropic` | `/byok-key anthropic` |
| Desktop | Settings → provider row | Settings → provider row |

`aegis_ask` normally spends from your AEGIS token bank. Lane A replaces the
*provider credential* with yours; the request still runs through AEGIS, so your
account is charged a small **BYOK handling fee** — a flat rate, not a margin on
the vendor's price, because AEGIS pays that vendor nothing on this lane. It is
published by the server and always below the pooled price for the same traffic,
so bringing your own key stays the cheaper lane — it is just no longer the free
one. Run `/byok` in the CLI (or check Settings in the desktop) to see the live
figure; it is never hardcoded in a client.

Keys are encrypted at rest server-side and never returned in full (only a masked
preview). Remove one any time by calling `aegis_byok_set` again with no key.

**Which providers?** The catalogue grows server-side, so ask rather than
remember: `/byok` in the CLI, or `GET /api/v1/byok/providers`. Each entry names
the provider, the models that key unlocks, and where the vendor issues it.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AEGIS_API_KEY` | — | Your key (required) |
| `AEGIS_API_BASE` | `https://aegiscloud.org` | Override the backend base URL — useful for self-hosted or staging |

---

## aegiscode (CLI)

The same tools in a shell — third host over the shared transport and tool
registry, no editor and no Electron required. Published to npm as
[`aegiscode`](https://www.npmjs.com/package/aegiscode) (`npm i -g aegiscode`),
which is also the command-line version of AEGIS Desktop:

```bash
npm i -g aegiscode
export AEGIS_API_KEY="aegis_your_key_here"
aegiscode                 # interactive session
aegiscode "explain this stack trace"   # one-shot
echo "q" | aegiscode -p - # prompt on stdin
```

From a source checkout, `node cli/bin/aegiscode.js` runs the same code with no
install. The older `aegis-terminal` / `aegis-term` spelling is deprecated: it was
the 0.1.x name of this same package, now folded into `aegiscode`.

Plain text is a prompt; `/help` lists every command. Type it and go — the four
you need first are `/class` (which route your turns take), `/models` (what you
can pin), `/model` (pin one), and `/byok-key` (save your own provider key on
this machine, without echoing it). `--json` gives machine-readable output with
the usage object, the token total and the balance. See
[cli/README.md](cli/README.md) for the full command manual.

### Model classes

A **class** is the route a turn takes — who talks to the vendor, and whose
credential pays. `/class` with no argument shows the picker; switching takes
effect on your next turn, with the conversation intact.

| Class | Route | Who pays |
|---|---|---|
| `aegis` *(default)* | the AEGIS pool — one id, `nexus-brain`, auto-routed across whichever providers are live | your AEGIS account balance |
| `byok` | your provider key, relayed by AEGIS (`/api/v1/byok/chat/completions`) | your provider, **plus** the AEGIS handling fee on your account |

Under `byok` every model id is compound — `provider:model`, e.g.
`anthropic:claude-sonnet-4-5`. `/models` lists exactly what your saved keys
unlock, and `/class` refuses to leave you on a class with no key rather than
failing later at the relay. A BYOK turn is **single-shot**: the relay takes no
`tools` parameter, so the agentic tool loop is off by construction, not by
preference. Ollama, LM Studio and any custom endpoint are desktop-only classes —
the CLI deliberately exposes two.

It carries the `aegiscodex-dev` design — palette, welcome art, prompt glyphs and
command vocabulary — pinned by `test/cli-conformance.test.mjs`; `test/cli-render.test.mjs`,
`test/cli-overlays.test.mjs`, `test/cli-fuzzy.test.mjs` and `test/cli-markdown.test.mjs`
cover the rest of the surface. Its turns are written once to the scrollback rather
than into a full-screen TUI, so its output stays pipeable.

---

## AEGIS Desktop (Electron)

A standalone chat app over the same transport, with an **agentic tool loop**:
the model can read, write, and edit files, list directories, glob, grep, run
shell commands in a persistent session, and delegate whole sub-tasks to
subagents. It does **not** require Claude Code.

Published to npm as [`aegis-desktop`](https://www.npmjs.com/package/aegis-desktop)
(`npm i -g aegis-desktop && aegis`), with its own dedicated source repo at
[aegiscloud/aegiscode-desktop](https://github.com/aegiscloud/aegiscode-desktop)
(a `git subtree split` of this `desktop/` directory) — this section stays the
canonical build/architecture reference; the other repo carries the install
guide and screenshot.

| Tool | What it does |
|---|---|
| `readFile` · `writeFile` · `editFile` | File access scoped to the working directory |
| `listDir` · `glob` · `grep` | Navigate and search a tree |
| `exec` | Run commands in a persistent shell session |
| `task` | Delegate a self-contained sub-task to a subagent |

`exec`/`writeFile`/`editFile` are gated behind a diff/approval card by
default — approve once, approve for the rest of the conversation, or deny.
Toggle it off in **Settings → "Confirm before running tools"** if you'd
rather the agent run mutating calls without asking.

A global quick launcher (`Cmd/Ctrl+Shift+Space`, configurable) opens a small
always-on-top prompt window for a fast one-shot answer from anywhere on the
desktop, and an `aegis://` protocol handler supports deep links
(`aegis://open?session=<id>`, `aegis://new?prompt=<text>`). Full keyboard
shortcuts and deep-link reference: [`desktop/README.md`](desktop/README.md).

### Model classes

Pick any of four transports from the model-class picker:

| Class | Transport | Key held in |
|---|---|---|
| **Aegis Cloud** | `aegiscloud.org` (pooled or pinned model) | main process |
| **Ollama** | local `ollama` daemon | no key needed |
| **Custom OpenAI-compatible** (LM Studio, OpenRouter, vLLM, …) | direct from the desktop app | main process — never sent to the renderer |
| **Anthropic-compatible** (Claude, or any Messages-format gateway) | direct from the desktop app | main process |

Conversations persist locally to `~/.aegiscode/sessions.json` — the same file
the CLI and the MCP plugin read, so a thread typed in the terminal shows up in
the app's session list with no sync and no key — and sync to AEGIS cloud memory
via a pending queue that flushes on each "Sync now" or heartbeat retry. (A
pre-upgrade install's private `sessions.json` in Electron's userData is adopted
into the shared store once, so nothing is lost.) The **remember** button on any
assistant reply pins that message to cross-machine memory — queued locally if
you're offline.

### Autonomous queue

The desktop app and the CLI share one unattended work queue
(`~/.aegiscode/queue.jsonl`): append tasks, drain them later, one at a time,
with tool approval disabled and commits scoped to the files that task itself
wrote.

```bash
aegiscode autonomous add "fix the flaky retry test" --cwd ~/repo --commit
aegiscode autonomous list
aegiscode autonomous proceed --max 3      # drain up to three
aegiscode autonomous reconcile --auto     # queue the next unfinished PLAN.md phase, then drain
```

It runs **Aegis Cloud only** — `nexus-brain`, the pooled class — and a task that
names any other model is refused where you can still see it: at `add` time, or
pre-flight in the worker, rather than as an opaque error minutes into a drain. A
single pass at `medium` effort is the default; the pooled fan-out (`workers` + 1
provider calls at `high`) is opt-in via `AEGIS_AUTONOMOUS_FANOUT=1`. And a turn
that reaches the tool-round cap no longer loses its work — the interruption is
filed against the session and your next message resumes it under a continuation
preamble with a padded horizon (in memory only, claimed once). Full detail:
[`desktop/README.md`](desktop/README.md#autonomous-queue).

### Install

```bash
npm install -g aegis-desktop
aegis
```

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
| `aegis` tools error with "no API key" | The MCP server resolves the key from `$AEGIS_API_KEY` and then `~/.aegiscode/credentials.json`. Set one (`aegiscode login`, or an export) and **restart Claude Code** — setting it while Claude Code is running has no effect. |
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
client/aegis.js      shared thin transport (MCP + Electron + browser + CLI)
mcp/server.js        zero-dependency MCP server (Claude Code tools)
mcp/tools.js         the shared tool registry (MCP host + CLI host)
commands/            Claude Code slash commands
skills/              Claude Code skills
install.sh           one-line Claude Code installer
.claude-plugin/      plugin + marketplace metadata
desktop/             AEGIS Desktop (Electron host + lib + renderer)
cli/                 AEGIS Terminal (third host: same transport + registry)
docs/                product plan and host plans (Electron, online, CLI)
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
Electron required, and no dependencies to install at the repo root (there is no
root `package.json`):

```bash
node --test test/*.test.mjs     # the whole suite
node --test test/local-engine.test.mjs   # one file
```

Licensed under MIT — see [LICENSE](LICENSE). Security notes in
[SECURITY.md](SECURITY.md).
