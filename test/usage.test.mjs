#!/usr/bin/env node
/**
 * Unit tests for desktop/renderer/usage.js.
 *
 * This is the display half of the token-accounting contract. The transport half
 * (desktop/lib/local/providers.js normalising Anthropic's split usage into
 * `total_tokens`) is covered in local-providers.test.mjs; what is asserted here
 * is that the renderer can read BOTH wire spellings, so a provider that reports
 * only `input_tokens`/`output_tokens` — which is every Anthropic-compatible
 * endpoint — still shows a token count instead of nothing.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { usageTokens } = require('../desktop/renderer/usage.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ---- OpenAI-compatible shape ----------------------------------------------
assert(usageTokens({ total_tokens: 1550 }) === 1550, 'OpenAI total_tokens read directly');
assert(
  usageTokens({ prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 }) === 1500,
  'a stated total wins over the split'
);
assert(
  usageTokens({ prompt_tokens: 1200, completion_tokens: 300 }) === 1500,
  'OpenAI split without a total is summed'
);

// ---- Anthropic-compatible shape (the regression) ---------------------------
// No `total_tokens` anywhere on an Anthropic stream — this exact object used to
// render as no token count at all, on a call that was still being billed.
assert(
  usageTokens({ input_tokens: 1200, output_tokens: 300 }) === 1500,
  'Anthropic input/output is summed when there is no total_tokens'
);
assert(
  usageTokens({ input_tokens: 0, output_tokens: 42 }) === 42,
  'a zero input half still yields the output count'
);
assert(usageTokens({ input_tokens: 900 }) === 900, 'input only is reported, not dropped');
assert(usageTokens({ output_tokens: 7 }) === 7, 'output only is reported, not dropped');
assert(
  usageTokens({ input_tokens: 100, output_tokens: 50, total_tokens: 150 }) === 150,
  'a total is never double-counted against its own halves'
);

// ---- "unknown" must be null, never 0 --------------------------------------
// A provider that reported nothing has to render as *nothing*: printing
// "tokens: 0" beside a real, billed turn is a worse lie than printing no count.
for (const empty of [null, undefined, {}, 0, 'nope', [], NaN]) {
  assert(usageTokens(empty) === null, `unknown usage ${JSON.stringify(empty)} renders as null`);
}
assert(usageTokens({ total_tokens: 0 }) === 0, 'an explicit zero total is a reported zero');

console.log('usage token-count tests passed');
