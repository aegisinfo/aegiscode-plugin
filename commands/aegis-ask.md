---
description: Ask AEGIS pooled inference a question (pick a model, or let it route server-side).
argument-hint: [question]
---

Use the `aegis_ask` MCP tool to answer the user's question: $ARGUMENTS

Model-first: the server's model list is the truth.
- If the user named a specific model (or you're unsure what's available), call
  `aegis_list_models` first and pass their exact choice as `model` — this pins
  that provider.
- Otherwise omit `model` entirely — the server picks its default.

`mode` is a legacy server-side shorthand; never set it and never invent a model
id. Pass the user's text as `prompt`. Relay the model's answer, and note which
provider/model served it (shown in the tool output) so the user sees the routing.
