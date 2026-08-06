---
description: Save a note, decision, or fact to ÆGIS cross-session semantic memory
argument-hint: [what to remember]
allowed-tools: Bash(aegis --memory-add-json:*), Bash(aegis-cli --memory-add-json:*), Bash(aegiscode --memory-add-json:*)
---

Save the following to the user's ÆGIS memory so future sessions (in aegis-cli,
Claude Code, or the extension) can recall it: $ARGUMENTS

There is no MCP server for this — use the one-shot CLI flag directly:

```
aegis --memory-add-json "$ARGUMENTS" user
```

Steps:
1. Run that command via Bash (quote `$ARGUMENTS` so it's passed as a single
   argument). It prints `{"ok":true,"id":"..."}` on success or
   `{"ok":false,"error":"..."}` on failure — no server, no handshake.
2. If `ok` is true, confirm back to the user in one line what was stored,
   quoting it exactly as saved.
3. If `ok` is false, report the exact error — don't claim it saved if it
   didn't. A common cause is very short/low-signal content being filtered
   out by aegiscode's own noise filter; that's expected behavior, not a bug.
4. If the command isn't found, tell the user `aegiscode` isn't installed
   and to run `npm install -g aegiscode`.
