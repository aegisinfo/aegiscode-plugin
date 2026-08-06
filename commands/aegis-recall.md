---
description: Recall relevant ÆGIS cross-session memory before starting work on this topic
argument-hint: [topic or free text query]
allowed-tools: Bash(aegis --memory-search-json:*), Bash(aegis-cli --memory-search-json:*), Bash(aegiscode --memory-search-json:*)
---

Recall context from the user's ÆGIS semantic memory about: $ARGUMENTS

There is no MCP server for this — aegiscode exposes memory as a one-shot CLI
flag specifically so external tools like Claude Code can call it directly:

```
aegis --memory-search-json "$ARGUMENTS" 20
```

(If `aegis` isn't on PATH, try `aegis-cli` or `aegiscode` — all three names
point at the same binary.)

Steps:
1. Run that command via Bash. It prints a JSON array of memory entries
   (`{id, timestamp, source, role, content, session, importance, tags, ...}`)
   — no server, no handshake, exits immediately.
2. If the command fails with something like "command not found," tell the
   user `aegiscode` isn't installed and to run `npm install -g aegiscode`.
3. If it prints `[]`, cross-session memory may not be active yet — tell the
   user to run `aegis login` once (memory is free with any login, no
   subscription needed) — or there's just nothing relevant stored yet.
4. Otherwise, summarize what came back in 3-6 bullet points: prior
   decisions, open threads, and anything directly relevant to the current
   task. Note the `source` field — entries may come from `aegis-cli` itself
   or from imported Claude Code history (`source: "claude-code"`).
5. Do not fabricate memory content — only report what the command actually
   printed. If nothing relevant comes back, say so plainly instead of
   guessing.
