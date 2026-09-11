'use strict';

/**
 * prompt.js — the desktop client's system prompt (client half of
 * aegiscodex-dev's tool calling).
 *
 * aegiscodex-dev sends a real persona on every provider turn
 * (src/backend.js MAIN_CHAT_PROMPT plus a docs/operating-context.md block).
 * The desktop renderer used to send nothing at all, so every model answered a
 * bare user string with no identity, no work rules and no idea which machine
 * it was on — hence the "which OS are you using?" round trips.
 *
 * MAIN_CHAT_PROMPT below is the same identity + truthfulness rule set, ported
 * verbatim where it still applies, including the CLI's "delegate with the
 * task tool" rule now that the desktop has a subagent runner (engine.js
 * runSubagent). One naming deviation from the CLI text: the tool names are
 * readFile/writeFile/editFile/listDir/glob/grep/exec/task (lowerCamelCase,
 * matching this repo's existing tool vocabulary — see
 * desktop/lib/local/tools.js) rather than the CLI's Read/Write/Edit/Grep/
 * Bash/Task.
 *
 * The environment preamble names the platform, the home directory and the
 * repo roots the host already knows (main.js), so the model stops asking.
 */

/** Identity + work rules. Ported from aegiscodex-dev src/backend.js. */
const MAIN_CHAT_PROMPT =
  `You are Aegiscodex, a terminal coding assistant that works in the user's repository. ` +
  `Help with software engineering tasks: read and reason about code, write and edit files, ` +
  `run shell commands, and investigate bugs. Work rules:\n` +
  `- Use tools silently. A one-line reason is enough; do not narrate your plan as a story. ` +
  `- Never claim what a tool found or what a command returned before the tool actually runs. ` +
  `  Report only the results you really received. ` +
  `- Act, don't just inspect. After at most 2 rounds of reading or exploration, start making ` +
  `  changes with writeFile or editFile. Reconnaissance is not progress — implement, then verify.\n` +
  `- When you have what you need, stop using tools and give a concise, direct answer to the ` +
  `  user's question. Never end your turn with an intention like "Let me check…" or "I'll now…" ` +
  `  — that is not an answer. ` +
  `- When a focused multi-step sub-task can be delegated, use the task tool to spawn a ` +
  `  specialist subagent rather than doing everything inline. ` +
  `- If the user references a workflow you don't recognize, inspect the repo/scripts for that ` +
  `  mechanism before acting — don't assume it means inline work.`;

/** The tools the desktop actually advertises (kept in step with tools.js). */
const TOOL_LINE =
  'Tools: readFile, writeFile, editFile, listDir, glob, grep, exec, task. Paths are absolute; ' +
  'exec runs in a persistent shell session on this machine — cd and exported env vars carry ' +
  'across calls within the turn, like a real terminal. task spawns a specialist subagent ' +
  '(its own tool loop, same model) for a focused, self-contained piece of work.';

/**
 * Render the environment preamble. Everything is optional: a missing field is
 * simply omitted, so a headless caller can build a persona with nothing but
 * the identity block.
 */
function environmentPreamble(env = {}) {
  const { platform, arch, homedir, cwd, roots, appVersion, model } = env || {};
  const bits = [];
  if (platform) bits.push(`platform: ${platform}${arch ? ` (${arch})` : ''}`);
  if (homedir) bits.push(`home directory: ${homedir}`);
  if (cwd) bits.push(`working directory: ${cwd}`);
  if (model) bits.push(`model: ${model}`);
  if (appVersion) bits.push(`AEGIS Desktop ${appVersion}`);

  const rootList = Array.isArray(roots) ? roots.filter(Boolean) : [];
  const lines = [];
  if (bits.length) lines.push(bits.join('\n'));
  if (rootList.length) {
    lines.push(`repo roots:\n${rootList.map((r) => `  - ${r}`).join('\n')}`);
  }
  if (!lines.length) return '';
  return `# Environment\n${lines.join('\n')}`;
}

/**
 * The full system prompt for a desktop chat turn: identity + work rules +
 * the tool line + the environment block. Never empty.
 */
function buildSystemPrompt(env = {}) {
  const parts = [MAIN_CHAT_PROMPT, TOOL_LINE];
  const preamble = environmentPreamble(env);
  if (preamble) parts.push(preamble);
  return parts.join('\n\n');
}

module.exports = {
  MAIN_CHAT_PROMPT,
  TOOL_LINE,
  environmentPreamble,
  buildSystemPrompt,
};
