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

## Quick start

Four steps, in order. Everything past this section is the fuller reference for
each one.

**1. Install** — requires Node 18+.

```bash
npm install -g aegiscode
```

**2. Log in** — get a key at <https://aegiscloud.org> if you don't have one.

```bash
aegiscode login                    # prompts, no echo
aegiscode key status               # verify: masked key + which source is in use
```

**3. (Optional) Bring your own key** — skip this if you're happy on the
pooled AEGIS Cloud route (the default). Use your own OpenAI/Anthropic/etc. key
instead, at a flat handling fee instead of the pooled margin — see [Bring your
own key](#bring-your-own-key).

```bash
/byok                              # list providers and which are already set
/byok-key openai                   # save a key on this machine, prompts, no echo
/class byok                        # switch the session to run on it
```

**4. Use it.**

```bash
aegiscode                          # interactive session
aegiscode "why is the sky blue"    # one-shot, prints the answer and the tokens
```

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

## Installation

```bash
npm install -g aegiscode
# or, from a source checkout — no install needed:
node cli/bin/aegiscode.js
```

Requires Node 18+. Save your key once — it goes to `~/.aegiscode/credentials.json`
(mode `0600`) and is then picked up by every later launch, script and shell:

```bash
aegiscode login                    # prompts, no echo
aegiscode login "aegis_..."        # or inline
aegiscode key status               # masked key + which source is in use
aegiscode logout                   # remove it
```

`AEGIS_API_KEY` still works and still wins (useful in CI, or for a one-off);
`aegiscode --key <key>` applies to a single run and is never saved. A key an
older AEGIS CLI left in `~/.aegiscode/config.json` is picked up and copied into
the 0600 store automatically — `/cloud status` says so if the plaintext copy is
still there.

That one file is shared: the MCP plugin and AEGIS Desktop read the same store, so
signing in here signs you in everywhere (see [One memory, shared with AEGIS
Desktop](#one-memory-shared-with-aegis-desktop)).

## Launch options

```bash
aegiscode                        # interactive session
aegiscode --continue             # skip onboarding, resume the last session
aegiscode "why is the sky blue"  # one-shot, prints the answer and the tokens
aegiscode -p "..." --json        # machine-readable
echo "q" | aegiscode -p -        # prompt on stdin
aegiscode -m deepseek/deepseek-v4-flash -p "..."   # pin a model
aegiscode --terminal              # print the resolved terminal capabilities
aegiscode --ascii                 # force the ASCII mark (legacy consoles)
aegiscode --width 100             # pin the frame width
```

## One look on every terminal

The welcome screen, the palette and the glyph set are resolved from what the
terminal *can actually draw*, not from `process.platform`. PowerShell inside
Windows Terminal sets `WT_SESSION`/`TERM_PROGRAM`, so it renders the **same
byte-identical frame** as zsh: `unicode` mark, `native` star, 24-bit colour. The
host OS is only a fallback hint; the environment wins.

`cli/src/caps.js` resolves one capability object — mark (`unicode`/`ascii`), face
(`native`/`edges`), star (`native`/`narrow`), colour depth (24/8/4/0), control
(`ansi`/`plain`), size and EOL — and everything that draws goes through it.
`theme.js` builds its palettes and glyph table via `caps.rgb()`/`caps.bg()`, so a
16-colour console is painted in colours it has instead of literal escape text,
and `art.js` applies composable stencils (`ascii`, `edges`, `star`) rather than a
per-platform art table.

Only a **legacy** Windows console degrades — and it says why:

| host | mark | star | colour | reason |
| --- | --- | --- | --- | --- |
| win32 legacy conhost | `ascii` | `narrow` | 16 | Consolas has no block glyphs |
| win32 Windows Terminal | `unicode` | `native` | truecolor | Windows VT host (`WT_SESSION`) |
| Linux/macOS, zsh | `unicode` | `native` | truecolor | — |
| `TERM=dumb` | `ascii` | `narrow` | none | no control sequences |

The **star defaults to native on Windows VT.** `✦` appears eleven times in the
welcome art, so forcing it narrow there would *create* the divergence this is
meant to remove; ConPTY does font fallback single-width. `AEGIS_STAR=narrow`
is the escape hatch if a host proves otherwise.

Overrides, at launch — `--ascii`, `--unicode`, `--no-color`, `--color`,
`--width <cols>`, `--terminal` (print the report) — and in-session via
`/terminal ascii|unicode|color|no-color|star <native|narrow>|width <cols>|auto|status`.
`/terminal auto` re-probes rather than restoring launch flags. `/terminal width`
pins the frame, so resizes are ignored until `/terminal auto`; every other
`/terminal` switch leaves resize handling intact.

The same axes are settable by environment for scripts and CI: `AEGIS_ART`,
`AEGIS_ASCII`, `AEGIS_UNICODE`, `AEGIS_STAR`, `AEGIS_COLOR`, `AEGIS_VT`,
`AEGIS_WIDTH`, `AEGIS_WIDE_RUNES`. `NO_COLOR` is honoured to the letter —
"present and not an empty string, regardless of its value".

## First run

A genuine first run walks the reference's onboarding before the session starts —
the order is `aegiscodex-dev`'s:

```
────────────────────────────────────────────────────────────────────────────────
Accessing workspace:
/home/you/project

Quick safety check: Is this a project you created or one you trust? …
AEGIS Code will be able to read, edit, and execute files here.

Security guide

❯ 1.Yes, I trust this folder
  2.No, exit

Enter to confirm · Esc to cancel
```

then the theme picker (the reference's 7 rows — Auto, Dark/Light, plus
colourblind-friendly and ANSI-only variants, each previewed as a real diff in
that palette), then the welcome screen with the mark, a **Tips for getting
started** box and a **What's new** box. The chosen row is written to
`~/.aegiscode/config.json`, so `Welcome back!` is what you get next time and the
picker never reappears.

Declining the trust check **ends the process** rather than continuing — the
folder you just refused to vouch for is not read, edited or executed in.
`--continue` skips onboarding entirely.

Preferences survive a restart: model, effort, theme and vim mode are restored on
launch, and an explicit flag (`-m`, `--light`) always outranks the stored value.

## Commands

In a session, plain text is a prompt. `/help` lists commands, grouped by
category, the way `aegiscodex-dev` does. The registry is that client's, ported
command for command — 75 entries across nine categories:

| Category | Commands |
|---|---|
| Session & context | `/clear` `/compact` `/cost` `/exit` `/new` `/recap` `/resume` `/rewind` `/agents` `/status` `/teleport` `/version` `/clone` `/schedule` |
| Workspace | `/run` `/build` `/cd` `/copy` `/init` `/review` `/prs` |
| Model & behavior | `/model` `/models` `/class` `/effort` `/thinking` `/theme` `/vim` `/router` `/confirm` `/yolo` `/permissions` `/hooks` `/skills` `/mcp` |
| Data | `/context` `/export` `/tokens` `/sync` |
| Auth | `/key` `/login` `/logout` `/credentials` `/byok` `/byok-set` `/byok-rm` `/byok-key` `/byok-rm-key` |
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

## Model selection

Three layers, from broadest to narrowest. You only need the first one.

**1. The class — which route the turn takes.**

```bash
/class            # show the picker
/class aegis      # pooled AEGIS Cloud (the default)
/class byok       # your own provider key, relayed by AEGIS
/class custom     # your own endpoint, called by aegiscode directly
```

A class is *whose credential pays and who talks to the vendor*, not a model.
Switching applies to your **next** turn and leaves the conversation intact. The
choice is written to `~/.aegiscode/config.json` (`modelClass`), so it survives a
restart.

| Class | Route | Who pays |
|---|---|---|
| `aegis` *(default)* | the AEGIS pool — one id, `nexus-brain` (alias `aegis-brain`), auto-routed server-side across whichever providers are live | your AEGIS account balance |
| `byok` | your provider key, relayed via `POST /api/v1/byok/chat/completions` | your provider direct, **plus** a small AEGIS handling fee on your account |
| `custom` | your own base URL, called **directly** by aegiscode — nothing is relayed | your provider direct. No AEGIS fee, no margin, no account balance |

**2. The model id — what to pin.**

```bash
/models                 # what you can pin, for the class you are on
/model                  # open the picker
/model nexus-brain      # pin it
/model -                # clear the pin, back to the class default
```

`/models` is class-aware: it answers from the pool catalogue under `aegis`, from
the models your saved keys actually unlock under `byok`, and from the entries you
added with `/model add` under `custom`. A pin is **cleared with a reason** if you
switch to a class it does not belong to, instead of failing later at the route.

Under `byok` every id is compound — `provider:model`:

```bash
/models                       # e.g.  anthropic:claude-sonnet-4-5
/model anthropic:claude-sonnet-4-5
```

Under `custom` the id is whatever you named the entry:

```bash
/models                       # e.g.  local-llama, work-gateway
/model local-llama
```

```bash
aegiscode -m nexus-brain -p "…"                      # pin at launch
aegiscode -m anthropic:claude-sonnet-4-5 -p "…"      # a BYOK id at launch
aegiscode -m local-llama -p "…"                      # a custom id at launch
```

**3. Effort — how hard it reasons.**

```bash
/effort                # show
/effort low|medium|high
```

Effort scales the token budget the provider is given, so it is the dial that
actually changes reasoning depth on a reasoning model (see the root README for
the per-provider mechanics).

> **A `byok` turn is single-shot.** The relay takes no `tools` parameter, so the
> agentic tool loop is off by construction — no file edits, no shell, no
> subagents, no approval cards. `/class` says so rather than letting you discover
> it mid-task. **`custom` does not have this limit** — aegiscode calls your
> endpoint itself, so the full tool loop works normally.

## Custom models — your endpoint, called directly

`/model add` teaches aegiscode about an endpoint AEGIS never sees. There is no
relay, no handling fee and no margin: the request goes straight from your machine
to the base URL you gave, with the key you gave.

```bash
/model add local-llama  "Local Llama"  llama-3.3-70b  http://localhost:11434/v1
/model add work-gw      "Work gateway" gpt-4o        https://gw.corp/v1  openai
/model key local-llama                  # set or replace the key later (prompted, masked)
/class custom                           # route turns through these
/model local-llama                      # pin one
/model remove local-llama               # drop the entry and its key
```

The wire protocol is detected from the base URL — `anthropic.com` gets the
Messages API, everything else the OpenAI-compatible one — or you can pass
`openai` / `anthropic` explicitly to override it.

Where things are stored, and why it is split:

| What | Where | Why |
|---|---|---|
| name, model, base URL, wire | `~/.aegiscode/config.json` | it is configuration, and it is not secret |
| the API key | `~/.aegiscode/settings.json` (mode `0600`) | secrets belong in the file we chmod, keyed `custom:<id>` |

The key is never written into `config.json`. A local endpoint that needs no key
is fine — omit it and no `Authorization` header is sent.

## Bring your own key

Two lanes. The one people mix up is which key goes where, so state it plainly:
**`/byok-set` stores on your AEGIS account; `/byok-key` stores on this machine.**

| | `/byok-set <provider>` | `/byok-key <provider>` |
|---|---|---|
| Key lives | on your AEGIS account, encrypted server-side | in `~/.aegiscode/settings.json` (mode `0600`) |
| Follows you to other machines | yes | no |
| Reaches the vendor via | AEGIS, server-side | AEGIS's BYOK relay |
| Needed for `/class byok`? | no | **yes** — this is the one the relay reads |

### Save a key on this machine

```bash
/byok                        # list every provider, and which are already set
/byok-key openai             # prompts, no echo, never enters history
/byok-key openai sk-…        # scriptable form
/byok-rm-key openai          # forget it
```

The first command is the one to run when you don't know a provider id. The
catalogue is server-side and grows, so `/byok` is the authority — each row names
the provider, the models its key unlocks, where the vendor issues it, and the
prefix a valid key starts with. A typo'd or wrong-vendor key is caught before it
is stored.

### Save a key on your account

```bash
/byok-set anthropic          # prompts, no echo
/byok-rm anthropic           # remove it
```

### What a BYOK turn costs

Bringing your own key does not make the turn free, and it is not meant to. AEGIS
pays the vendor nothing on this lane, so there is no provider cost to take a
margin on — the account is charged a flat **handling fee** per 1k tokens
instead, for the routing, prompt assembly, caching, tool bridging and uptime
that still happen server-side. It is deliberately well under the pooled price
for the same traffic, so BYOK stays the cheaper lane; it just is not the free
one.

The figure is published by the server (`GET /api/v1/byok/providers` returns
`fee`) and never hardcoded in this client, so what you see is what is charged.
Two consequences worth knowing:

- A BYOK turn needs an **AEGIS account key** as well as your provider key — that
  is where the fee is billed. Without one the relay refuses up front and says so,
  rather than running the turn and dropping the charge.
- If a fee is ever configured to zero the lane is genuinely free, and nothing in
  this client needs to change to reflect that.

Removing a key is the only thing that stops the key being sent; unsetting
`/class byok` switches the route but leaves the key on disk.

## Command manual

Copy-paste, in the order you actually need them.

### Install and sign in

```bash
npm install -g aegiscode           # requires Node 18+
aegiscode login                    # prompts for your AEGIS key, no echo
aegiscode key status               # verify: masked key + which source is in use
aegiscode                          # start a session
```

No AEGIS key yet? Get one at <https://aegiscloud.org>. To run entirely on your
own provider key instead, skip `login` and see
[Bring your own key](#bring-your-own-key) — note that lane still bills its fee to
an AEGIS account.

### Day one in a repo

```bash
cd ~/my-project
aegiscode                          # first run asks you to trust the folder
/init                              # sniff the project, write AEGIS.md
/status                            # key, class, model, effort, cwd — one panel
```

Then just type. Plain text is a prompt.

### Ask one question and leave

```bash
aegiscode "explain this stack trace"
aegiscode -p "summarise docs/design.md" --json
echo "why is the sky blue" | aegiscode -p -
```

`--json` emits the answer plus the usage object, token total and balance.

### Switch how you're paying

```bash
/class                             # see every route and who pays
/class byok                        # use your own key
/byok-key openai                   # …save one first if it says you have none
/models                            # what that key unlocks
/model openai:gpt-4o               # pin one
/class aegis                       # back to the pool

/model add local-llama "Local Llama" llama-3.3-70b http://localhost:11434/v1
/class custom                      # or call your own endpoint directly
```

### Control the budget

```bash
/effort low                        # cheaper, shallower
/effort high                       # deeper reasoning
/cost                              # this session
/balance                           # tokens beside € on every ledger row
/billing                           # spend and plan
```

### Keep the work

```bash
/compact                           # shrink the context, keep the thread
/export markdown ~/notes/session.md
/resume                            # pick up a saved session
/rewind 3                          # back up three turns
/sync                              # push pending, then pull
```

### When something is wrong

```bash
/doctor                            # diagnostics, in one panel
/status                            # key + class + model actually in effect
/byok                              # which provider keys are set
/troubleshooting
```

### Unattended work

```bash
aegiscode autonomous add "fix the flaky retry test" --cwd ~/repo
aegiscode autonomous list
aegiscode autonomous proceed --commit
```

Queued tasks always run on the pooled brain (`nexus-brain`); a task naming
another model is refused where you can still see it. `--commit` commits only the
paths that task's own tool layer wrote.

## Account key and cloud sync

Three ways in, one store: `aegiscode login <key>`, `/key <api_key>` (or a bare
`/key` to paste it echo-off), and `$AEGIS_API_KEY`. The first two persist;
the env var outranks the store and needs no persistence. `/login` used to be an
unavailable Claude Code auth-loop command pointing at `/byok-set` — which stores
a *provider* key, so that advice sent the AEGIS key into the wrong slot. It is
now the in-band way to set the account key, and `/logout` removes it.

Conversation sync is the same `conversationSyncPush/Pull` surface the desktop
uses, over the sessions this host keeps in `~/.aegiscode/history.jsonl`:

```bash
/sync                 # push what is pending, then pull — the one you want
/sync status          # local / pending / in-sync counts, last push and pull
/sync on | off         # auto-push after each turn (off by default)
/cloud                 # key + sync state in one panel
/cloud activate        # turn on cloud memory for the account
```

Sync is **off by default** on purpose: the server charges a push for the growth
of a session against the plan's synced-token ceiling, so nothing is uploaded
until you ask. A refusal (HTTP 402) is reported as a quota refusal with the way
out, not as "sync failed". Imported remote sessions land in the same store
`/resume` reads, and are marked `imported` with estimated token counts — never
passed off as measured here.

## One memory, shared with AEGIS Desktop

`~/.aegiscode/` is the data dir for **every** AEGIS host — this CLI, AEGIS
Desktop and the MCP plugin built on the same account:

| File | What it holds | Written by |
|---|---|---|
| `credentials.json` | the account key, mode 0600 | `aegiscode login`, `/key`, the desktop's Settings pane |
| `sessions.json` | every conversation, one record per session | both hosts, live |
| `history.jsonl` | this host's per-exchange ledger (feeds `/cost`) | the CLI |
| `config.json` | preferences, permissions | the CLI |

Sign in once and all three hosts are signed in: they resolve the key with the
same precedence (`$AEGIS_API_KEY` → `credentials.json` → an older `config.json`),
and when two hosts hold a key the **most recently saved one wins** — so rotating
it from the terminal does not leave the app 401-ing on a stale string.

Sessions are shared too, and not only through the cloud. `/resume` lists a
thread typed in the desktop, and the desktop's session list shows a thread typed
here — same file, no sync and no network. An upgrade adopts a desktop install's
private `sessions.json` into the shared store once, so no existing conversation
is lost. Records carry `origin`, and terminal sessions are **not** enrolled in
the desktop's push queue (that would spend the account's synced-token quota as a
side effect of typing in a shell); this host's own `/sync` covers them.

There are currently **no** `unavailable` commands: every entry in the registry
either runs or is a real handler that says honestly what it cannot do.

## The chatflow

The session is `aegiscodex-dev`'s loop, ported rather than approximated: an
alternate-screen frame of header rule, transcript viewport, spinner/effort line,
input line and status line, driven by a raw key stream.

```
╭───────────────────────────── AEGIS Code v6.3.0 ─────────────────────────────╮
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
- **Overlays**: `/` the palette (fuzzy-ranked, with `Tab` to complete to the
  highlighted command), `alt+p` the model picker, `/effort` the effort picker,
  `/resume` the session list, `?` the shortcut grid, `ctrl+o` permissions, and a
  centred Yes/No dialog when a mutating tool needs approval. `Esc` closes an
  overlay, and clears the input line when nothing is open.
- **Every turn is persisted** to `~/.aegiscode/history.jsonl` and mirrored into
  the shared `~/.aegiscode/sessions.json`, with a transcript checkpoint alongside
  them, so `/resume`, `/cost`, `/clear` and `/rewind` all have something real to
  read — and the desktop app sees the same conversations. On exit the session
  prints how to come back to it.

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
node ../test/cli-terminal-caps.test.mjs # capability resolution: PowerShell and zsh agree
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
