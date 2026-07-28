---
description: Ask AEGIS pooled inference a question (pick a model, or let it route server-side).
argument-hint: [question]
---

Use the `aegis_ask` MCP tool to answer the user's question: $ARGUMENTS

If the user named a specific model (or you're unsure what's available), call
`aegis_list_models` first and pass their choice as `model` — this pins that
exact provider instead of auto-routing.

Otherwise, pick `mode` based on the task (only used when `model` is unset):
- `fast` — quick lookups, short answers, low cost
- `smart` — default; balanced quality
- `neo` — hard reasoning, multi-step problems

Pass the user's text as `prompt`. Relay the model's answer, and note which
provider/model served it (shown in the tool output) so the user sees the routing.
