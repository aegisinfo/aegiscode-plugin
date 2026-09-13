# aegiscode — the terminal host

`aegiscode` in your shell — the command-line version of AEGIS Desktop. The same
tool surface the Claude Code plugin exposes over MCP, plus a terminal instead of
an editor — built on the same two shared pieces and no others:

| Shared piece | What it is |
|---|---|
| `client/aegis.js` | The thin transport. Holds the API key, speaks HTTP/SSE. No brain logic. |
| `mcp/tools.js` | The tool registry — names, JSON schemas, result formatting. |
| `desktop/renderer/usage.js` | The token-usage → number mapping, shared with the GUI so the two can never disagree. |
| `desktop/lib/local/` | The agent-loop engine — persistent-shell exec, read/write/edit/glob/grep, Task subagents. The CLI runs the same loop the GUI does, scoped to the AEGIS class. |

Routing, model tiers, memory and billing all stay behind aegiscloud.org.

## Names: one name, `aegiscode`

This host and the CLI used to be two names for two packages. They are one
product, so they are one name now:

| Name | Status |
|---|---|
| `aegiscode` | **this host**, v6.0.0. Installs a single binary, `aegiscode`. |
| `aegis-terminal` | deprecated — the 0.1.x spelling of this package, folded into `aegiscode`. |
| `aegiscode-cli` | 4.0.3, an earlier name of the full `aegisinfo/aegiscode` coding-assistant CLI. Untouched. |
| `aegis-cli` | 0.4.8 (unrelated). |
| `aegis` (bin) | claimed **twice already** — by `aegiscode-cli` (→ `bin/cli.js`) and by `aegis-desktop` (→ `bin/aegis.js`). Pre-existing; whichever installs last wins. |

Publishing this host as `aegiscode` moves the `latest` dist-tag for that name
onto it. The previous line (`aegiscode@5.x`, the `aegisinfo/aegiscode` agent) is
still installable and immutable on the registry — pin `aegiscode@5` for it.

## Install

```bash
npm install -g aegiscode
# or, from a source checkout — no install needed:
node cli/bin/aegiscode.js
```

Requires Node 18+. Set your key once:

```bash
export AEGIS_API_KEY="aegis_..."
```

## Use

```bash
aegiscode                        # interactive session
aegiscode "why is the sky blue"  # one-shot, prints the answer and the tokens
aegiscode -p "..." --json        # machine-readable
echo "q" | aegiscode -p -        # prompt on stdin
aegiscode -m deepseek/deepseek-v4-flash -p "..."   # pin a model
```

In a session, plain text is a prompt. `/help` lists commands, grouped by
category, the way `aegiscodex-dev` does. The registry is that client's, ported
command for command — 75 entries across nine categories:

| Category | Commands |
|---|---|
| Session & context | `/clear` `/compact` `/cost` `/exit` `/new` `/recap` `/resume` `/rewind` `/agents` `/status` `/teleport` `/version` `/clone` `/schedule` |
| Workspace | `/run` `/build` `/cd` `/copy` `/init` `/review` `/prs` |
| Model & behavior | `/model` `/effort` `/thinking` `/theme` `/vim` `/router` `/confirm` `/yolo` `/permissions` `/hooks` `/skills` `/mcp` |
| Data | `/context` `/export` `/tokens` |
| Auth | `/credentials` `/byok` `/byok-set` `/byok-rm` |
| Support | `/help` `/doctor` `/troubleshooting` `/feedback` `/bug` `/issue` `/onboarding` `/benchmark` `/release-notes` `/billing` `/cloud` |
| Aegis plugin | `/aegis-ask` `/aegis-status` `/aegis-recall` `/aegis-remember` `/memory` `/aegis-council` `/aegis-multi` `/aegis-print` `/aegis-import` `/tool` |
| Fun | `/radio` `/waifu` |

`/help` shows the live list with hints; aliases are searchable in the `/`
palette exactly as they are there (`/ask` → `/aegis-ask`, `?` → `/help`,
`quit` → `/exit`, `tok` → `/tokens`, …).

Every command that talks to AEGIS names a tool from `mcp/tools.js`, and the test
suite asserts both directions: no command points at a tool that does not exist,
and no tool is unreachable from the prompt. Everything else is a real local
handler — `/run` detects and drives this project's dev command, `/init` sniffs
the project and writes `AEGIS.md`, `/export` writes the transcript out,
`/resume` and `/rewind` read the session store, `/cd` moves the working
directory, `/doctor` runs diagnostics.

The only two commands that answer "not available" are `/login` and `/logout`:
their whole premise is Claude Code's own auth loop, which this client does not
participate in — it authenticates with an AEGIS key (or your own provider key
via `/byok-set`). They say so, and point at the working alternative.

## The chatflow

The session is `aegiscodex-dev`'s loop, ported rather than approximated: an
alternate-screen frame of header rule, transcript viewport, spinner/effort line,
input line and status line, driven by a raw key stream.

```
╭───────────────────────────── AEGIS Code v6.2.0 ─────────────────────────────╮
❯ summarise what changed in the token accounting
● Three things changed, and one of them was costing you money:

  - the pool merges worker usage instead of overwriting it
  - cache reads and writes are billed, not ignored
  - a zero-token call no longer refunds its reservation

● Running 1 shell command…
  ⎿  $ git log --oneline -3
Ran 1 shell command
✻ Worked for 6s
⎿  nexus-brain · 1,562 tok · 1,250/312 · €0.0007 · 4.2s
                                                            ● high · /effort
────────────────────────────────────────────────────────────────────────────────
❯  Try "edit <filepath> to..."
────────────────────────────────────────────────────────────────────────────────
⏸ manual mode on · ? for shortcuts · ← for agents
```

What the loop does, in the order a turn happens:

- **You type.** The input line has history (`↑`/`↓`), tab completion for `/…`,
  word motions, a rotating suggestion when empty, horizontal scrolling for a
  long line, and a collapsed one-line preview for a multi-line paste (the full
  text is still what gets submitted).
- **The turn starts.** A random verb from the reference set shimmers in coral
  beside the spinner, with elapsed time and a live token estimate.
- **The answer streams into a row**, markdown-rendered, opening with `●` and
  trailing a live cursor while it grows.
- **Tool calls become rows.** `● Running 1 shell command… · 3s` resolves to
  `Ran 1 shell command` when the call returns — paired by tool-call id, so
  parallel same-name calls and nested subagent rows stay separate, and the
  plural is right.
- **The turn ends** with `✻ Churned for Ns` (no tools) or `✻ Worked for Ns`
  (tools), then an accounting row: `⎿ nexus-brain · 1,562 tok · 1,250/312 ·
  €0.0007 · 4.2s`.
- **Esc interrupts.** The abort reaches the transport through an
  `AbortSignal`, so the in-flight provider call is genuinely cancelled — it
  does not keep running and billing behind a "stopped" label — and whatever had
  already streamed is kept, marked `(stopped)`.
- **Keys work mid-turn.** Esc/Ctrl-C abort; PgUp/PgDn and the wheel scroll the
  transcript live (and scrolling up is anchored to an absolute line index, so an
  arriving delta does not drag the reader back to the bottom); everything else
  you type is replayed into the input line afterwards.
- **Overlays**: `/` the palette, `alt+p` the model picker, `/effort` the effort
  picker, `/resume` the session list, `?` the shortcut grid, and a centred
  Yes/No dialog when a mutating tool needs approval.

Anything that is not a real terminal — a pipe, `-p`, a CI run — stays a linear
transcript written once to scrollback, so output remains pipeable and
scriptable.

Render it yourself, with no key and no network:

```bash
node cli/scripts/demo.mjs            # from a source checkout
                                     # --light, --width 100, --plain also work
```

## Design notes

**It looks like `aegiscodex-dev` on purpose.** The gold/coral/lavender palette,
the `✦`-studded welcome mark (mascot, crescent moon and diving whale), the `❯`
prompt, the `⎿` hook rows and the `✻` spinner line are the `aegiscodex-dev`
design system, adopted wholesale rather than approximated: the palette, glyphs,
welcome art, working verbs and command vocabulary all come from it, and
`test/cli-conformance.test.mjs` pins every RGB triple, glyph, spinner frame, verb
and art row to that source so the two hosts cannot drift apart. (An earlier
revision of this CLI was a deliberate divergence — a violet/cyan "Signal" theme
with a test asserting it. That direction is gone.)

**A full-screen chatflow on a terminal, a linear transcript everywhere else.**
On a TTY the session is the reference's loop: alternate screen, header rule,
transcript viewport, spinner, effort line, input line, status line, overlays.
Anywhere else — a pipe, `-p`, CI — turns are written once to the scrollback
instead, so output stays selectable, searchable and pipeable. A tool you script
should not become un-scriptable because the interactive mode got nicer.

**The command registry is `aegiscodex-dev`'s, ported.** Names, aliases,
categories, the palette grouping and the handlers themselves come from it, with
`test/cli-commands.test.mjs` asserting the full name list so a silent drop
fails the build. Local capability that the reference has — a dev-server runner,
project sniffing, an export path, a session store, checkpoints, permission
rules, subagent presets — was ported with it rather than stubbed.

**Tokens beside money, always.** A turn prints what it consumed and what it
settled at, in the same line: `1,562 tok ∙ 1,250/312 ∙ €0.0007`. Sub-cent
amounts keep four decimals, because a €0.0007 call rendered at 2dp reads as
free usage next to a token count.

**Esc really stops the call.** The interrupt travels as an `AbortSignal` into
the transport, and the engine does not re-dispatch after an abort — a cancelled
turn used to fire a second billed provider request ("the model said nothing"
recovery, triggered by the empty result an abort produces) and stream the
partial answer twice. `test/local-engine.test.mjs` pins the dispatch count.

## Tests

```bash
node ../test/cli-chatflow.test.mjs    # the session loop, driven with a synthetic key stream
node ../test/cli-commands.test.mjs    # the full command table, aliases, dispatch contract
node ../test/cli-panels.test.mjs      # every panel builder, defensive against missing data
node ../test/cli-support.test.mjs     # config/history/tokens/agents/export/checkpoints
node ../test/cli-conformance.test.mjs # the design guard: palette, glyphs, art, verbs
node ../test/cli-render.test.mjs      # width safety, accounting, live region
node ../test/cli-overlays.test.mjs    # the / palette, model + effort pickers, resume list
node ../test/cli-fuzzy.test.mjs       # palette ranking and match positions
node ../test/cli-markdown.test.mjs    # span-line markdown, cell widths
node ../test/cli-tools.test.mjs       # registry parity with the MCP host + dispatch
node ../test/cli-run.test.mjs         # the real binary against a real backend
node ../test/cli-package.test.mjs     # the published layout, isolated from the repo
npm test                                 # all of the above
```

The chatflow test drives `runSession` for real: a synthetic key stream, stdout
captured, and the app entered exactly as `bin/aegiscode.js` enters it. It covers
the turn lifecycle, tool-row pairing, the interrupt reaching the transport, the
viewport anchor, the input line's cell maths and an abort that must not
re-dispatch.

`npm run predist` stages `client/`, `mcp/tools.js` and the desktop's `usage.js`,
`local/engine.js` and `local/agents.js` into `cli/vendor/` (gitignored) so the
published package resolves its own modules. `test/cli-package.test.mjs` copies
that tree somewhere with no repo around it and runs the binary there.
