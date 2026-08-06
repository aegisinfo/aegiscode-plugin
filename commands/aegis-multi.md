---
description: Prepare an ÆGIS /multi command (multi-agent task orchestration) for the user to run in aegis-cli
argument-hint: [the task to split across agents]
allowed-tools: Bash(aegis --print:*), Bash(aegis-cli --print:*), Bash(aegiscode --print:*)
---

`/multi` (and its auto-approve variant `/multiyolo`) are aegis-cli's own
slash commands (Pro tier). aegis-cli does have a headless `--print` mode
that routes `/multi` through the same dispatcher as the interactive
terminal — but its normal "Start multi-agent task?" confirmation prompt has
no UI to render in headless mode, so **`--print` silently skips the
confirmation and runs unattended**, same as `/multiyolo` would. That's a
real difference from how it behaves in the interactive terminal, not a
documentation gap — treat it accordingly.

What to actually do for: $ARGUMENTS

1. **Default to composing, not running.** Give the user the exact command
   to paste into their own `aegis-cli` session, where the confirmation
   prompt works normally:
   ```
   /multi $ARGUMENTS
   ```
   (mention `/multiyolo $ARGUMENTS` as the explicit auto-approved variant if
   they want less friction.)
2. If useful, suggest `--save-as <name>` or `--template <id>` flags per
   aegis-cli's documented usage: `/multi <task> [--save-as <name>] [--template <id>]`.
3. **Only run it yourself via Bash** (`aegis --print --output-format json "/multi $ARGUMENTS"`)
   if the user explicitly asks you to run it now rather than paste it
   themselves — and say plainly first that doing so skips the usual
   confirmation step, so they know what they're opting into.
4. Offer to do the equivalent work yourself in Claude Code instead (single
   agent, sequential) if they'd rather not switch tools or trigger
   multi-agent orchestration at all — being clear that's not the same as
   aegiscode's parallel multi-agent orchestration.
