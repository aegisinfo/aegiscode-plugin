# aegiscode — the terminal host

`aegiscode` in your shell — the command-line version of AEGIS Desktop. The same
tool surface the Claude Code plugin exposes over MCP, plus a terminal instead of
an editor — built on the same two shared pieces and no others:

| Shared piece | What it is |
|---|---|
| `client/aegis.js` | The thin transport. Holds the API key, speaks HTTP/SSE. No brain logic. |
| `mcp/tools.js` | The tool registry — names, JSON schemas, result formatting. |
| `desktop/renderer/usage.js` | The token-usage → number mapping, shared with the GUI so the two can never disagree. |

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

In a session, plain text is a prompt. `/help` lists commands:

| Command | What it does |
|---|---|
| `/ask <prompt>` | Pooled inference (identical to typing the prompt) |
| `/status` | Key, plan, account, memory state |
| `/models` | The model ids you can pin |
| `/balance` | Token-bank balance and recent spend — tokens beside € |
| `/recall <query>` | Search cloud memory |
| `/remember <text>` | Save a durable note |
| `/memory` `/import` | Review or import memory from other tools |
| `/byok` `/byok-set` `/byok-rm` | Bring-your-own-key status and management (the key is prompted, never echoed) |
| `/model` `/stream` `/theme` `/cost` `/clear` `/help` `/quit` | Session controls |
| `/tool <name> [json]` | Call any registry tool directly |

Every command above that talks to AEGIS names a tool from `mcp/tools.js`, and
the test suite asserts both directions: no command points at a tool that does
not exist, and no tool is unreachable from the prompt.

Command names, aliases and categories follow `aegiscodex-dev`'s registry, so the
vocabulary matches the other terminal host: the AEGIS family is spelled
`/aegis-ask`, `/aegis-status`, `/aegis-recall`, `/aegis-remember`, `/aegis-import`
(with `/ask`, `/status`, `/recall`, `/remember` kept as aliases), and the session
and model controls are its `help`/`?`/`h`, `exit`/`quit`, `clear`/`cls`,
`theme`/`t`, `version`/`v` and `model`/`m`. Commands that need a local agent loop
this client deliberately does not have — `/login`, `/doctor`, `/permissions`,
`/mcp`, `/skills`, `/hooks`, `/agents`, `/resume` and a few more — are listed but
answer honestly with the reason and the nearest working alternative rather than
pretending to work.

## What it looks like

```
━────────────────────────────────────────────────────────────────────────────━

            ✦               █████▓▓░      ▓▓▓▓▓▓▓▓▓ ✦       ▒▒▒▒▒▒▒▒▒▒▒▒ 
                 ✦        ███▓░     ░░    ▓▓▓▓▓▓▓░░░       ▒▒▒▒▒▒▒▒▒▒▒▒▒ 
             ░░░░         ███▓░           ▓▓▓▓░░░░░░     ██▒▒▒▒▒▒▒▒▒▒▒▒▓▓
           ░░░░░░░░       ███▓░             ░░░░░░       ██▒▒▒▒▒▒▒▒▒▒▒▒▓ 
         ░░░░░░░░░░░░     ███▓░           ✦   ·   ·       ▒▒▒▒▒▒▒▒▒▒▒▒▒▒ 
                  ██▓░░      ▓                             ░░░░░░░░░░░░  
                  ░▓▓███▓▓░                                              
     ▐▛███▜▌                                                             
    ▝▜█████▛▘                                                            
      ▘▘ ▝▝                                                              

                            Welcome to AEGIS Code
                     v6.1.0 · Cloud brain in your shell.

───────────────────────────────── aegiscode ──────────────────────────────────
  version v6.1.0
  model   nexus-brain
  base    https://aegiscloud.org
  key     aegis_••••4f2a
  render  streaming

 type /help for commands · /quit to exit

❯ summarise what changed in the token accounting
● Three things changed, and one of them was costing you money:

  - the pool merges worker usage instead of overwriting it
  - cache reads and writes are billed, not ignored
  - a zero-token call no longer refunds its reservation

  merge_usage({input_tokens: 1250}, {output_tokens: 312})
  => 1562 total

Use /balance to see tokens beside € on every row.
⎿  nexus-brain · 1,562 tok · 1,250/312 · €0.0007 · 4.2s · 4 calls

* Consulting… (2.1s)  esc to interrupt
 aegis · nexus-brain · 1,562 tok · €0.0007 · stream               ctrl+c quit 
```

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

**A linear transcript, not a full-screen TUI.** Finished turns are written once
to the scrollback; only the one live line (spinner, elapsed time) is redrawn.
Output stays selectable, searchable and pipeable, which matters for a tool you
script.

**Tokens beside money, always.** A turn prints what it consumed and what it
settled at, in the same line: `1,562 tok ∙ 1,250/312 ∙ €0.0007`. Sub-cent
amounts keep four decimals, because a €0.0007 call rendered at 2dp reads as
free usage next to a token count.

## Tests

```bash
node ../../test/cli-conformance.test.mjs # the design guard: palette, glyphs, art, verbs
node ../../test/cli-render.test.mjs      # width safety, accounting, live region
node ../../test/cli-overlays.test.mjs    # the / palette, model + effort pickers, resume list
node ../../test/cli-fuzzy.test.mjs       # palette ranking and match positions
node ../../test/cli-markdown.test.mjs    # span-line markdown, cell widths
node ../../test/cli-tools.test.mjs       # registry parity with the MCP host + dispatch
node ../../test/cli-run.test.mjs         # the real binary against a real backend
node ../../test/cli-package.test.mjs     # the published layout, isolated from the repo
npm test                                 # all of the above
```

`npm run predist` stages `client/`, `mcp/tools.js` and the desktop's `usage.js`
into `cli/vendor/` (gitignored) so the published package resolves its own
modules. `test/cli-package.test.mjs` copies that tree somewhere with no repo
around it and runs the binary there.
