/**
 * The system prompt must not turn a greeting into a work order.
 *
 * `MAIN_CHAT_PROMPT` carried "Act, don't just inspect. After at most 2 rounds
 * of reading or exploration, start making changes with writeFile or editFile"
 * with no condition attached. It is written for a coding task and was applied
 * to EVERY turn, so on 2026-09-15 "hey" started running shell commands, and
 * "can you check the plan" spent ~70 rounds writing ~400 lines of unrequested
 * code into the repo.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { MAIN_CHAT_PROMPT, buildSystemPrompt } = require(join(root, 'desktop', 'lib', 'local', 'prompt.js'));

function assert(c, m) { if (!c) throw new Error(`ASSERT FAILED: ${m}`); }

// ── conversation is answered, not investigated ─────────────────────────────
assert(/no tools/i.test(MAIN_CHAT_PROMPT),
  'the prompt must say plainly that some turns take no tools at all');
assert(/greeting/i.test(MAIN_CHAT_PROMPT),
  'and name the case that actually broke: a greeting');

// ── the action bias is conditional, not standing ───────────────────────────
{
  const i = MAIN_CHAT_PROMPT.indexOf("act, don't just inspect");
  assert(i > -1, 'the action rule still exists — it is right, for real tasks');
  // It must be preceded by its condition in the same rule, not left standing.
  const before = MAIN_CHAT_PROMPT.slice(Math.max(0, i - 120), i);
  assert(/WHEN THE USER HAS ASKED FOR WORK/i.test(before),
    'the action rule must be gated on a task existing');
}

// ── it may never be read as a licence to invent work ───────────────────────
assert(/never a reason to invent one/i.test(MAIN_CHAT_PROMPT),
  'the prompt must forbid inventing a task from the action rule');
assert(/did not ask you to touch/i.test(MAIN_CHAT_PROMPT),
  'and forbid writing files the user never asked about — the EUR 2 failure');

// ── the rest of the contract survives ──────────────────────────────────────
for (const [re, why] of [
  [/Use tools silently/i, 'silent tool use'],
  [/Never claim what a tool found/i, 'no fabricated tool results'],
  [/stop using tools and give a concise, direct answer/i, 'answer-first ending'],
  [/task tool/i, 'subagent delegation'],
]) assert(re.test(MAIN_CHAT_PROMPT), `${why} must be preserved`);

// ── it still composes ──────────────────────────────────────────────────────
{
  const full = buildSystemPrompt({ platform: 'linux', homedir: '/home/neo' });
  assert(typeof full === 'string' && full.includes('Aegiscodex'), 'prompt builds');
  assert(full.length > MAIN_CHAT_PROMPT.length, 'environment preamble is appended');
}

console.log('prompt-discipline tests passed');
