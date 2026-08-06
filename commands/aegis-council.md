---
description: Put a question to the ÆGIS council (multi-model consensus vote) via aegis-cli
argument-hint: [the question or decision to put to the council]
allowed-tools: Bash(aegis --print:*), Bash(aegis-cli --print:*), Bash(aegiscode --print:*)
---

`/council` is one of aegis-cli's own slash commands (Pro tier), but aegis-cli
also has a headless `--print` mode that routes slash commands through the
same dispatcher as the interactive terminal — so this can be run directly
over Bash, not just composed for the user to paste in:

```
aegis --print --output-format json "/council $ARGUMENTS"
```

Steps:
1. Run that command via Bash. `/council`'s handler runs synchronously and
   returns its result with no interactive confirmation step, so this is
   safe to run unattended.
2. Parse the JSON output (`{"result": "...", "success": true|false}`) and
   present the council's answer — consensus, any dissents, your own take if
   useful.
3. If it fails because the account isn't Pro tier, tell the user council
   voting needs the aegis-cli Pro subscription ($2/mo at aegiscloud.org) and
   offer to just answer the question yourself as a single model instead —
   being explicit that's not the same as a multi-model vote.
4. If `aegis`/`aegis-cli`/`aegiscode` isn't found, tell the user to
   `npm install -g aegiscode` first.
