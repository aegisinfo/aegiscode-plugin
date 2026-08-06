---
description: Show ÆGIS ecosystem status — login, memory, and cloud sync state
argument-hint: (no arguments)
allowed-tools: Bash(aegis --memory-stats-json:*), Bash(aegis --print:*), Bash(aegis-cli --memory-stats-json:*), Bash(aegiscode --memory-stats-json:*)
---

Report the current ÆGIS ecosystem status. Run both of these via Bash:

```
aegis --memory-stats-json
aegis --print --output-format json "/cloud status"
```

Both are one-shot, non-interactive, and exit immediately — no server, no
handshake.

Steps:
1. Run both commands.
2. From `--memory-stats-json`, report entry count, session count, and the
   role breakdown (user/assistant/other).
3. From `/cloud status`, report whether an aegiscloud.org API key is
   configured and whether conversation sync is on.
4. Summarize in a short status block, e.g.:
   ```
   ÆGIS Status
   ─────────────────────────
   Memory:  1,514 entries across 96 sessions
   Cloud:   ✓ connected, sync on
   ```
5. If either command fails or `aegis`/`aegis-cli`/`aegiscode` isn't found,
   say so plainly and suggest `npm install -g aegiscode` or `aegis login`
   as appropriate — don't fabricate status you couldn't actually check.
