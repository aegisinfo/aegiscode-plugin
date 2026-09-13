# Host plan: the terminal CLI (`cli/`)

Companion to `electron-host-plan.md` and `aegis-online-host-plan.md`. The repo
has one transport and one tool registry; this is the third host over them.

## Why a third host

The Claude Code plugin only exists inside an editor's agent loop, and the
desktop app only exists in a window. Neither is usable from a shell script, a
remote box over SSH, or `git commit && aegis-term "review this diff"`. The CLI is
the same account, the same tools and the same billing, reachable from a prompt.

It is also the cheapest host to keep honest: an MCP server answers a model, a
GUI needs a human, but a CLI can be driven end-to-end, non-interactively, by a
test.

## Boundary (unchanged from the other hosts)

Allowed:

- `client/aegis.js` — transport, key handling, SSE reading.
- `mcp/tools.js` — tool names, JSON schemas, result text.
- `desktop/renderer/usage.js` — the pure usage → display-number mapping.
- Terminal presentation: ANSI, layouts, input, live region.

Forbidden, exactly as in `desktop/`:

- Model routing, tier selection, retries against other providers, prompt
  construction, memory extraction, price computation. All of that is the
  server's, and a CLI that reimplements any of it becomes a second brain that
  drifts from the first.

## Structure

```
cli/
  bin/aegis-term.js      arg parsing, process lifecycle, exit codes
  src/theme.js          palette + glyphs (the divergence claim lives here)
  src/art.js            the sigil
  src/screen.js         cell width, wrapping, the live region
  src/render.js         banner, turns, accounting line, status bar
  src/format.js         numbers: tokens, €, elapsed
  src/commands.js       slash commands → registry tools
  src/deps.js           resolves the shared modules (repo or vendor/)
  src/app.js            session state, streaming, dispatch
  scripts/predist.mjs   stages the shared modules for npm
  scripts/demo.mjs      renders a canned session, no network
```

`bin/` holds no logic that a test would want to assert; `src/app.js` holds no
ANSI; `src/render.js` writes nothing. That split is what makes the five test
files possible without a TTY.

## Test contract

| Test | Guarantees |
|---|---|
| `cli-identity.test.mjs` | No Claude Code palette/glyph/art fingerprint; the theme contract is complete and wired up |
| `cli-render.test.mjs` | Width safety, the token-beside-€ accounting line, live-region escape arithmetic |
| `cli-tools.test.mjs` | The CLI's registry is byte-identical to the real MCP server's `tools/list`; commands and tools are mutually reachable |
| `cli-run.test.mjs` | The real binary: one-shot, `--json`, `--no-stream`, stdin, arg errors, exit codes, wire shape |
| `cli-package.test.mjs` | The published layout resolves its own modules and runs, with no repo present |

## Non-goals

- A full-screen alt-buffer TUI. Turns go to scrollback once; only the live line
  is redrawn, so output stays pipeable.
- Local tool execution (shell, file edit). That is the desktop's local-engine
  path and a different threat model; the CLI is a cloud-surface client.
- A second implementation of tool result formatting. If a tool's output needs to
  change, it changes in `mcp/tools.js` and both hosts follow.
