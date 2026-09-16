#!/usr/bin/env node
/**
 * One budget rule, two copies — and the ceiling that is only a label.
 *
 * Half of this file is the old max-tokens ceiling test, kept because
 * `maxTokensCeiling()` still exists: it answers "what does this model say its
 * own output limit is?" and is printed in the Model hint. It sizes nothing.
 *
 * The other half is the rule that replaced the Max tokens dropdown, which asked
 * the user to state an answer's length before the answer existed. Output length
 * cannot be predicted from a prompt, and the guess failed in both directions:
 * aegis1 sizes the pooled class from `effort` itself and reads a body
 * max_tokens as a ceiling *over* its ladder, while a DeepSeek reasoning model
 * bills hidden chain-of-thought against the same budget, so the dropdown's 4k
 * default was spent before the first visible token and the turn came back empty
 * with no error.
 *
 * That rule now lives in two places — desktop/renderer/budget.js (what the
 * renderer sends) and desktop/lib/local/engine.js `reasoningBudget()` (what the
 * main process sends, and the last word) — so the two are compared HERE, case
 * by case and literal by literal. A copy that drifts is exactly how aegis1's
 * ladder came to disagree with this side once before (974adc5).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const renderer = require('../desktop/renderer/budget.js');
const engine = require('../desktop/lib/local/engine.js');
const {
  budgetFor,
  effortRung,
  maxTokensCeiling,
  FLAT_CEILING,
  EFFORT_TOKEN_BUDGET,
  DEEPSEEK_REASONING_MODEL_RE,
  REQUIRES_STATED_BUDGET,
} = renderer;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ── 1. The ceiling is display-only ─────────────────────────────────────────
assert(FLAT_CEILING === 300000, `expected flat ceiling 300000, got ${FLAT_CEILING}`);

// No metadata at all -> flat fallback.
assert(maxTokensCeiling(null) === FLAT_CEILING, 'null meta falls back to flat ceiling');
assert(maxTokensCeiling(undefined) === FLAT_CEILING, 'undefined meta falls back to flat ceiling');
assert(maxTokensCeiling({}) === FLAT_CEILING, 'meta without max_output falls back to flat ceiling');

// Model ceiling below the flat cap wins.
assert(maxTokensCeiling({ max_output: 8192 }) === 8192, 'lower per-model ceiling is honored');

// Model ceiling above the flat cap is still clamped to the flat cap.
assert(
  maxTokensCeiling({ max_output: 1000000 }) === FLAT_CEILING,
  'per-model ceiling never exceeds the flat cap'
);

// Non-numeric / non-positive metadata is ignored, not propagated as NaN/0.
assert(maxTokensCeiling({ max_output: 'not-a-number' }) === FLAT_CEILING, 'non-numeric max_output falls back');
assert(maxTokensCeiling({ max_output: 0 }) === FLAT_CEILING, 'zero max_output falls back');
assert(maxTokensCeiling({ max_output: -5 }) === FLAT_CEILING, 'negative max_output falls back');

// ── 2. The rung ────────────────────────────────────────────────────────────
assert(effortRung('low') === 'low' && effortRung('medium') === 'medium', 'a real rung passes through');
assert(effortRung('high') === 'high', "'high' is 'high'");
// "auto" (and anything unrecognised) must not silently mean the SMALLEST
// budget: it falls to the top rung, the same default aegiscodex-dev applies.
for (const v of ['auto', undefined, null, '', 'AUTO', 'turbo']) {
  assert(effortRung(v) === 'high', `unknown effort ${JSON.stringify(v)} falls to high, not low`);
}
assert(
  EFFORT_TOKEN_BUDGET.low < EFFORT_TOKEN_BUDGET.medium &&
    EFFORT_TOKEN_BUDGET.medium < EFFORT_TOKEN_BUDGET.high,
  'the rung ladder is ordered'
);

// ── 3. budgetFor: exactly one authority per call ───────────────────────────
// A number the caller STATED is the budget, verbatim: a deliberate cap is a
// liability ceiling and no rung may raise it.
assert(budgetFor('anthropic', 'claude-sonnet-5', 4096, 'high') === 4096, 'a stated cap is returned verbatim');
assert(budgetFor('aegis', 'pooled-x', 1, 'high') === 1, 'even a tiny stated cap is honoured, never raised');
assert(
  budgetFor('openai-compat', 'deepseek-flash', '2048', 'low') === 2048,
  'a numeric string counts as stated'
);
// Nonsense is "nothing stated", never a 0/NaN-token ceiling.
assert(budgetFor('openai-compat', 'gpt-4o-mini', 0, 'high') === undefined, '0 means unstated');
assert(budgetFor('openai-compat', 'gpt-4o-mini', -1, 'high') === undefined, 'a negative means unstated');
assert(budgetFor('openai-compat', 'gpt-4o-mini', NaN, 'high') === undefined, 'NaN means unstated');

// A model that reasons against its own output budget gets the rung.
for (const id of ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-pro', 'deepseek-reasoner']) {
  assert(
    budgetFor('anthropic', id, undefined, 'low') === EFFORT_TOKEN_BUDGET.low,
    `${id} is sized by the rung, not by the transport's default`
  );
}
// A class whose wire format REQUIRES the field gets the rung too — Anthropic's
// Messages API 400s without max_tokens, so a number must travel.
for (const id of ['claude-sonnet-5', 'claude-haiku-4-5']) {
  assert(
    budgetFor('anthropic', id, undefined, 'medium') === EFFORT_TOKEN_BUDGET.medium,
    `${id} on the anthropic class is sized by the rung`
  );
}
assert(REQUIRES_STATED_BUDGET.has('anthropic'), 'anthropic is the class that requires the field');

// Everything else states NOTHING. This is the fix, not a shortcut: the
// transport used to fill this gap with an invented 4096, which a reasoning
// model spent entirely on hidden chain-of-thought.
assert(budgetFor('openai-compat', 'gpt-4o-mini', undefined, 'high') === undefined, 'a plain OpenAI-compatible id sends no cap');
assert(budgetFor('ollama', 'llama3', undefined, 'high') === undefined, 'a local model sends no cap');
assert(budgetFor('aegis', 'pooled-x', undefined, 'high') === undefined, 'the pooled class sends no cap — aegis1 sizes it');
assert(budgetFor('openai-compat', 'deepseek-chat', undefined, 'high') === undefined, 'a non-reasoning DeepSeek id sends no cap');

// ── 4. The two copies answer identically ───────────────────────────────────
const CASES = [
  ['openai-compat', 'gpt-4o-mini', undefined, undefined],
  ['openai-compat', 'gpt-4o-mini', 4096, 'low'],
  ['openai-compat', 'deepseek-chat', undefined, 'high'],
  ['openai-compat', 'deepseek-flash', undefined, 'low'],
  ['openai-compat', 'deepseek-flash', undefined, 'medium'],
  ['openai-compat', 'deepseek-flash', undefined, 'auto'],
  ['openai-compat', 'deepseek-reasoner', undefined, 'high'],
  ['openai-compat', 'deepseek-v4.1-flash', '8192', 'low'],
  ['anthropic', 'claude-sonnet-5', undefined, 'auto'],
  ['anthropic', 'deepseek-flash', undefined, 'medium'],
  ['anthropic', 'deepseek-v4-pro', 1024, 'high'],
  ['ollama', 'llama3', undefined, 'high'],
  ['aegis', 'pooled-model', undefined, 'high'],
  ['aegis', 'pooled-model', 65536, 'low'],
];
for (const [cls, model, stated, effort] of CASES) {
  const a = budgetFor(cls, model, stated, effort);
  const b = engine.reasoningBudget(cls, model, stated, effort);
  assert(
    a === b,
    `renderer/engine disagree on ${cls}/${model} stated=${stated} effort=${effort}: ${a} vs ${b}`
  );
}

// …and the literals themselves agree, so a one-sided edit is caught even if the
// case table above never happens to cover the changed branch.
const budgetSrc = readFileSync(join(root, 'desktop', 'renderer', 'budget.js'), 'utf8');
const engineSrc = readFileSync(join(root, 'desktop', 'lib', 'local', 'engine.js'), 'utf8');
const regexOf = (src) => (src.match(/\/\^deepseek-[\s\S]*?\$\//) || [null])[0];
assert(regexOf(budgetSrc) && regexOf(budgetSrc) === regexOf(engineSrc), 'DEEPSEEK_REASONING_MODEL_RE is one literal in both files');
assert(
  String(DEEPSEEK_REASONING_MODEL_RE) === regexOf(engineSrc),
  'the exported regex is the literal the tests just compared'
);
const tableOf = (src) => {
  const m = /EFFORT_TOKEN_BUDGET\s*=\s*\{([^}]*)\}/.exec(src);
  return m ? m[1].replace(/\s+/g, '') : null;
};
assert(tableOf(budgetSrc) && tableOf(budgetSrc) === tableOf(engineSrc), 'EFFORT_TOKEN_BUDGET is one table in both files');

// ── 5. No transport invents a cap ──────────────────────────────────────────
const providers = readFileSync(join(root, 'desktop', 'lib', 'local', 'providers.js'), 'utf8');
const ollama = readFileSync(join(root, 'desktop', 'lib', 'local', 'ollama.js'), 'utf8');
assert(
  /if \(Number\(maxTokens\) > 0\) body\.max_tokens = Number\(maxTokens\);/.test(providers),
  'the OpenAI-compatible body states max_tokens only when one was given'
);
assert(
  !/^\s*maxTokens\s*=\s*\d+,/m.test(providers) && !/^\s*maxTokens\s*=\s*\d+,/m.test(ollama),
  'no transport has a defaulted maxTokens parameter'
);
// No floor and no ceiling live on this side. The Messages API does require
// `max_tokens`, but a number this client can only guess at is what truncated
// reasoning turns, and the platform states its own — aegis1 sizes the pooled
// class from `effort` server-side and reads a body max_tokens as a ceiling OVER
// that ladder. So the Anthropic transport follows the same rule as the
// OpenAI-compatible one, and this file asserts the ABSENCE of the invented
// constant it used to require: a reference to one was a throw before the first
// byte, which is what shipped.
assert(
  !/MIN_MAX_TOKENS|MAX_TOKENS\s*=/.test(providers),
  'the Anthropic transport declares no token floor or ceiling of its own'
);
assert(
  (providers.match(/body\.max_tokens = Number\(maxTokens\);/g) || []).length === 2,
  'and states max_tokens only when the caller gave one — on both transports'
);
assert(!/maxTokens\s*=\s*4096/.test(ollama), 'the local transport no longer invents a 4096 budget');

console.log(
  'Budget tests passed: the ceiling is a label, effort sizes the call, and both copies of the rule agree.'
);
