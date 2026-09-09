'use strict';

/**
 * Pure per-model max-tokens ceiling math (plan Phase 5, product-plan §6.3).
 * Standalone from app.js so it's requireable from a plain Node test without
 * pulling in DOM/window.aegis — app.js only calls into it.
 */

const FLAT_CEILING = 64000;

function maxTokensCeiling(meta) {
  const raw = meta && Number(meta.max_output);
  return Number.isFinite(raw) && raw > 0 ? Math.min(FLAT_CEILING, raw) : FLAT_CEILING;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { maxTokensCeiling, FLAT_CEILING };
}
