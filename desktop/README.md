# AEGIS Desktop

A standalone Electron chat app over the [AEGIS](https://aegiscloud.org) API,
with an **agentic tool loop**: the model can read, write, and edit files,
list directories, glob, grep, run shell commands in a persistent session, and
delegate whole sub-tasks to subagents. It does **not** require Claude Code.

```bash
npm install -g aegis-desktop
aegis
```

## Model classes

Pick any of four transports from the model-class picker, switchable
mid-conversation with context intact:

| Class | Transport | Key held in |
|---|---|---|
| **Aegis Cloud** | `aegiscloud.org` — one entry, **Nexus**; the pool auto-routes across whichever providers are live | main process |
| **Ollama** | local `ollama` daemon | no key needed |
| **Custom OpenAI-compatible** (LM Studio, OpenRouter, vLLM, …) | direct from the desktop app | main process — never sent to the renderer |
| **Anthropic-compatible** (Claude, or any Messages-format gateway) | direct from the desktop app | main process |

Get a free AEGIS key at **https://aegiscloud.org**, or use your own
Ollama/OpenAI-compatible/Anthropic-compatible endpoint — no AEGIS account
needed for those.

## Tools available to the model

| Tool | What it does |
|---|---|
| `readFile` · `writeFile` · `editFile` | File access scoped to the working directory |
| `listDir` · `glob` · `grep` | Navigate and search a tree |
| `exec` | Run commands in a persistent shell session |
| `task` | Delegate a self-contained sub-task to a subagent |

Before `exec`, `writeFile`, or `editFile` runs, a diff/approval card asks you
to confirm — approve once, approve for the rest of the conversation, or deny.
Flip **Settings → "Confirm before running tools"** off if you'd rather the
agent run mutating tool calls without asking; it's on by default.

Conversations persist locally and sync to AEGIS cloud memory via a pending
queue that flushes on each "Sync now" or heartbeat retry. The **remember**
button on any assistant reply pins that message to cross-machine memory —
queued locally if you're offline.

## Autonomous queue

The unattended work queue, shared with the CLI: tasks are appended to
`~/.aegiscode/queue.jsonl` and drained later, one at a time, with tool approval
**disabled** — there is nobody there to click an approval card. The desktop
sidebar's queue card and `aegiscode autonomous` are two views of the same file.

```bash
aegiscode autonomous add "fix the flaky retry test" --cwd ~/repo --commit
aegiscode autonomous list
aegiscode autonomous run                 # drain one task, then stop
aegiscode autonomous proceed --max 3     # drain up to three
aegiscode autonomous reconcile --auto    # queue the next unfinished PLAN.md phase, then drain it
aegiscode autonomous retry <id>          # put a finished task back
aegiscode autonomous clear --all         # empty the queue
```

A task's text is stored verbatim — `add "fix --json in the parser"` is a task,
not a flag. Drains commit only the paths that task's own tool layer wrote, so a
drain never sweeps a peer's in-flight edits into your commit.

### Aegis Cloud only

A queued task runs on the pooled brain — **`nexus-brain`** (alias
`aegis-brain`) — for the same reason the Claude Code plugin is cloud-only: the
queue hands work to a loop with no human in it, and the pooled class is the one
the server can route, budget, and bill on its own. A task that *states* another
model id is refused where you can still see it, instead of failing minutes into
a drain as an opaque server error:

| Where the model was stated | What happens |
|---|---|
| `autonomous add --model <id>` | refused, with the reason, at add time — nothing is queued |
| A hand-edited `queue.jsonl` | refused pre-flight by the worker (`ms: 0`), before any turn is billed |
| `AEGIS_MODEL=<id>` in the environment | **ignored for queue runs**, and reported as a note — that variable is shared with the interactive surfaces, which *do* run direct providers |
| nothing stated | `nexus-brain` |

### What a queued task costs

The queue has two shapes, and the cheap one is the default:

| | Single pass (default) | Fan-out (opt in) |
|---|---|---|
| Provider calls | 1 | `workers` + 1 (investigation passes, then synthesis) |
| Effort rung | `medium` | `high` |
| How to ask for it | nothing — it is the default | `AEGIS_AUTONOMOUS_FANOUT=1` |

An earlier version sent **every** queued task as a fan-out at the priciest rung:
one queued line could become several reasoning calls plus a synthesis, all at
`high`. Making the fan-out opt-in, and letting effort follow the shape of the
task rather than always topping out, removes the worker multiplication and
roughly halves the budget on a one-line task. `--effort` (or
`AEGIS_AUTONOMOUS_EFFORT`) still wins outright, and `--workers N` is only sent
when you are actually fanning out.

> **Known gap:** there is no `--fanout` flag yet — the opt-in is the environment
> variable or `singlePass: false` in the task record. `--single-pass` still
> parses, but it now agrees with the default instead of overriding it.

### A turn that runs out of rounds keeps its work

The tool loop runs against a round horizon: 24 rounds for an interactive turn
(`AEGIS_CHAT_MAX_ROUNDS`), 40 for a queued one
(`AEGIS_AUTONOMOUS_MAX_ROUNDS`). A model that reached it mid-turn used to lose
everything it had assembled, because the cap was *turn* state.

The horizon is now **session state**, held in `lib/local/session-rounds.js`. When
a turn stops at the cap the interruption is filed against the session, and the
next message in that conversation is prefixed with a continuation preamble —
*cut off after N tool rounds; continue, do not restart* — along with
`max(4, ⌈horizon/4⌉)` extra rounds so re-orientation does not eat the new
horizon. The resume is announced in the transcript, so it is visible rather
than silent.

- In-memory and **process-local** (30-minute TTL, 64 entries) — it never leaves
  the process and never touches disk.
- Claiming an entry **consumes** it: one resume per interruption, so a chain of
  interruptions is a chain of deliberate asks, never an automatic loop.
- A **stated** horizon always wins; the ledger only pads its own default.
- A caller that mints a fresh session key every turn adopts the most recent held
  entry (bounded to 10 minutes) instead of losing the work.

## Keyboard shortcuts

### In the main window

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+N` | New chat |
| `Cmd/Ctrl+K` | Open search (memory inspector) |
| `Cmd/Ctrl+S` | Save as… (export the open session as Markdown) |
| `Cmd/Ctrl+R` | Reload |
| `Cmd/Ctrl+Shift+I` | Toggle DevTools |
| `Enter` | Send the composer prompt |
| `Shift+Enter` | Newline in the composer |
| `Esc` | Close the memory inspector overlay |

### Global quick launcher

`Cmd/Ctrl+Shift+Space` (default, configurable in the sidebar's **Quick
Launcher** card) toggles a small, frameless, always-on-top prompt window near
your cursor — from anywhere on the desktop, even when AEGIS Desktop isn't the
focused app. It streams a one-shot answer over the same transport the main
window uses, with the agent's tool-calling loop turned off (no file/shell
access, no approval prompts) — just a fast question and an answer.

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+Shift+Space` (default, configurable) | Toggle the quick launcher |
| `Enter` | Ask the typed prompt |
| `Shift+Enter` | Newline in the prompt |
| `Cmd/Ctrl+Enter` | Add the current answer to the main window as a new chat turn |
| `Esc` | Close the quick launcher |
| *(click away)* | Also closes it — closing never steals focus from whatever window had it before |

**Packaged builds** (the installed app) always register the global shortcut.
**Dev runs** (`npm start` / `electron .`) do not, unless you turn on "enable
global shortcut" in the sidebar's Quick Launcher card — this keeps a local
dev session from silently grabbing a systemwide hotkey. If the configured
accelerator is already claimed by another application, registration fails
gracefully: a warning is logged to the main process console and the
Quick Launcher card shows the reason instead of the app crashing or hanging.

## Deep links

The app registers an `aegis://` protocol handler:

| Link | What it does |
|---|---|
| `aegis://open?session=<id>` | Resumes a saved session |
| `aegis://new?prompt=<text>` | Starts a fresh chat with that prompt pre-filled |

## Run from source

```bash
cd desktop
npm install
npm start
```

## Build a distributable

```bash
npm run dist        # packaged app (AppImage / MSI+NSIS / dmg)
npm run dist:dir    # unpacked dir, for quick testing
```

## Checks

```bash
npm run check                    # node --check every main-process + renderer file
node ../test/desktop-shell.mjs   # headless IPC smoke test (no Electron binary needed)
```

## Structure

```
main.js              Electron main process — window + IPC shell only
preload.js           Context-isolated IPC bridge exposed to the renderer
renderer/            UI (vanilla JS, no framework)
lib/local/           Model classes, providers, agentic tool loop, prompt
lib/local/queue.js   The shared work queue (~/.aegiscode/queue.jsonl)
lib/local/autonomous.js  The unattended worker — directive, digest, commits
lib/local/session-rounds.js  Session-scoped tool-round ledger (in-memory)
lib/sync/            Local session/memory persistence + sync queue
vendor/aegis.js      The AEGIS transport client (thin — no engine logic)
bin/aegis.js         `aegis` CLI entry point for the global npm install
```

This directory is part of the [aegiscode-plugin](../README.md) monorepo,
which also ships a Claude Code plugin and the shared `client/aegis.js`
transport over the same AEGIS backend — see the repo root for that fuller
architecture picture. A read-only mirror of just this directory (for
browsing or `git clone`) lives at
[aegiscloud/aegiscode-desktop](https://github.com/aegiscloud/aegiscode-desktop).
