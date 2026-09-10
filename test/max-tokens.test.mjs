#!/usr/bin/env node
/** Unit tests for desktop/renderer/max-tokens.js (plan P2 §6.3 output ceiling). */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { maxTokensCeiling, FLAT_CEILING } = require('../desktop/renderer/max-tokens.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

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

console.log('max-tokens ceiling tests passed');
