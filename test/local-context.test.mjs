#!/usr/bin/env node
/** Unit tests for desktop/lib/local/context.js (plan P1 §5.1). */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { estimateTokens, trimContext } = require('../desktop/lib/local/context.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// Token estimation: ~4 chars/token.
assert(estimateTokens('') === 0, 'empty string -> 0 tokens');
assert(estimateTokens(null) === 0, 'null -> 0 tokens');
assert(estimateTokens('abcd') === 1, '4 chars -> 1 token');
assert(estimateTokens('abcdefgh') === 2, '8 chars -> 2 tokens');
assert(estimateTokens('abcde') === 2, '5 chars rounds up to 2 tokens');

// Budget math + oldest-drop ordering.
const msgs = [
  { role: 'user', content: 'a'.repeat(4000) }, // 4 + 1000 = 1004
  { role: 'assistant', content: 'b'.repeat(4000) },
  { role: 'user', content: 'c'.repeat(4000) },
];

const trimmed = trimContext({ messages: msgs, budgetTokens: 2000 });
assert(trimmed.dropped === 2, `expected 2 dropped, got ${trimmed.dropped}`);
assert(trimmed.messages.length === 1, 'only newest turn kept');
assert(trimmed.messages[0].content === 'c'.repeat(4000), 'newest turn survives');
assert(trimmed.estimatedTokens === 1004, `expected 1004, got ${trimmed.estimatedTokens}`);

// Reserve tokens for the reply shrink the available budget.
const reserved = trimContext({ messages: msgs, budgetTokens: 3000, reserveTokens: 1000 });
assert(reserved.messages.length === 1, 'reserve lowers the effective limit');

// System message counts toward the budget.
const withSystem = trimContext({
  system: 's'.repeat(4000), // 4 + 1000 = 1004
  messages: msgs,
  budgetTokens: 1500,
});
assert(withSystem.dropped === 2, 'system budget consumes room for older turns');
assert(withSystem.system === 's'.repeat(4000), 'system message preserved');

// A single oversized newest message is still kept (never silently emptied).
const huge = trimContext({ messages: [{ role: 'user', content: 'x'.repeat(40000) }], budgetTokens: 100 });
assert(huge.messages.length === 1, 'newest oversized message kept');
assert(huge.dropped === 0, 'nothing else to drop');

console.log('context tests passed');
