---
description: Ask AEGIS pooled inference a question (routes to the best provider server-side).
argument-hint: [question]
---

Use the `aegis_ask` MCP tool to answer the user's question: $ARGUMENTS

Pick the `mode` based on the task:
- `fast` — quick lookups, short answers, low cost
- `smart` — default; balanced quality
- `neo` — hard reasoning, multi-step problems

Pass the user's text as `prompt`. Relay the model's answer, and note which
provider/model served it (shown in the tool output) so the user sees the routing.
