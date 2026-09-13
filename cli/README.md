# aegis-terminal — the AEGIS terminal host

AEGIS in your shell. The same tool surface the Claude Code plugin exposes over
MCP, plus a terminal instead of an editor — built on the same two shared pieces
and no others:

| Shared piece | What it is |
|---|---|
| `client/aegis.js` | The thin transport. Holds the API key, speaks HTTP/SSE. No brain logic. |
| `mcp/tools.js` | The tool registry — names, JSON schemas, result formatting. |
| `desktop/renderer/usage.js` | The token-usage → number mapping, shared with the GUI so the two can never disagree. |

Routing, model tiers, memory and billing all stay behind aegiscloud.org.

## Names: why `aegis-terminal` / `aegis-term`

Two names were checked against the registry rather than assumed, and both were
already taken — by this project's own packages:

| Name | Status |
|---|---|
| `aegiscode-cli` | taken: 4.0.3, the full coding-assistant CLI (`aegisinfo/aegiscode`) |
| `aegis-cli` | taken: 0.4.8 (unrelated) |
| `aegis` (bin) | claimed **twice already** — by `aegiscode-cli` (→ `bin/cli.js`) and by `aegis-desktop` (→ `bin/aegis.js`) |

So this host publishes as **`aegis-terminal`** and installs a single binary,
**`aegis-term`**, which collides with neither. (The double claim on `aegis` is
pre-existing and worth resolving separately — whichever package installs last
wins.)

## Install

```bash
npm install -g aegis-terminal        # after publish
# or, from a source checkout — no install needed:
node cli/bin/aegis-term.js
```

Requires Node 18+. Set your key once:

```bash
export AEGIS_API_KEY="aegis_..."
```

## Use

```bash
aegis-term                        # interactive session
aegis-term "why is the sky blue"  # one-shot, prints the answer and the tokens
aegis-term -p "..." --json        # machine-readable
echo "q" | aegis-term -p -        # prompt on stdin
aegis-term -m deepseek/deepseek-v4-flash -p "..."   # pin a model
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

## What it looks like

```
                                     ▄▄▄▄▄▄▄
                                     ▟███████▙
                                     ▜███▀███▛
                                      ▜█████▛
                                       ▜███▛
                                        ▜▛

                                     A E G I S
                             Cloud brain in your shell.

┏━ AEGIS terminal ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ version  v0.1.0                                              ┃
┃ model    nexus-brain                                         ┃
┃ base     https://aegiscloud.org                              ┃
┃ key      aegis_••••4f2a                                      ┃
┃ render   streaming                                           ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 type /help for commands ∙ /quit to exit

┃» you
┃ summarise what changed in the token accounting
┃⬢ aegis
┃ Three things changed, and one of them was costing you money:
┃
┃ ∙ the pool merges worker usage instead of overwriting it
┃ ∙ cache reads and writes are billed, not ignored
┃ ∙ a zero-token call no longer refunds its reservation
┃
┃   merge_usage({input_tokens: 1250}, {output_tokens: 312})
┃   => 1562 total
┣─ ∅ nexus-brain ∙ 1,562 tok ∙ 1,250/312 ∙ €0.0007 ∙ 4.2s ∙ 4 calls

 ⬢ aegis ∙ nexus-brain ∙ 1,562 tok ∙ €0.0007 ∙ stream          ctrl+c quit
```

Render it yourself, with no key and no network:

```bash
node cli/scripts/demo.mjs            # from a source checkout
                                     # --light, --width 100, --plain also work
```

## Design notes

**It is not a Claude Code look-alike.** Violet-and-cyan on ink; a hexagonal
shield sigil rather than a mascot; a `»` prompt and a `┃` transcript rail rather
than `❯` and `✻`; heavy box corners rather than rounded ones. This is a
deliberate divergence, not an accident of taste: `test/cli-identity.test.mjs`
fails if any of Claude Code's exact RGB triples, glyphs, spinner frames or art
rows appear in this host.

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
node ../../test/cli-identity.test.mjs   # the divergence guard
node ../../test/cli-render.test.mjs     # width safety, accounting, live region
node ../../test/cli-tools.test.mjs      # registry parity with the MCP host + dispatch
node ../../test/cli-run.test.mjs        # the real binary against a real backend
node ../../test/cli-package.test.mjs    # the published layout, isolated from the repo
npm test                                # all of the above
```

`npm run predist` stages `client/`, `mcp/tools.js` and the desktop's `usage.js`
into `cli/vendor/` (gitignored) so the published package resolves its own
modules. `test/cli-package.test.mjs` copies that tree somewhere with no repo
around it and runs the binary there.
