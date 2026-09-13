# AEGIS Desktop

Electron host — see the repo root [README.md](../README.md) for the full
build/architecture reference. This file covers day-to-day usage details that
don't belong in the top-level doc.

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

## Run from source

```bash
cd desktop
npm install
npm start
```

## Checks

```bash
npm run check          # node --check every main-process + renderer file
node ../test/desktop-shell.mjs   # headless IPC smoke test (no Electron binary needed)
```
