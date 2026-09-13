'use strict';

/**
 * Pure token-usage → display-number mapping.
 *
 * Standalone from app.js (same reason as max-tokens.js/stream-policy.js): it is
 * requireable from a plain Node test without window.aegis. app.js only calls
 * into it.
 *
 * Why this exists at all: the two wire formats spell the same quantity
 * differently, and the renderer used to read exactly one of the spellings.
 *
 *   OpenAI-compatible       { prompt_tokens, completion_tokens, total_tokens }
 *   Anthropic-compatible    { input_tokens,  output_tokens }        ← no total
 *
 * Reading only `total_tokens` — the field OpenAI happens to provide — meant
 * every Anthropic-compatible model rendered with no token count at all, while
 * the call was silently being billed. Accepting both spellings, and deriving
 * the total when the provider doesn't state one, is what makes the spend
 * visible regardless of which endpoint answered.
 */

/**
 * Number of tokens to show for a completed turn, or `null` when the provider
 * reported none (an unknown count must render as nothing, never as `0`).
 *
 * @param {{total_tokens?: number, prompt_tokens?: number, completion_tokens?: number,
 *          input_tokens?: number, output_tokens?: number}|null|undefined} usage
 * @returns {number|null}
 */
function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return null;
  return (input || 0) + (output || 0);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { usageTokens };
}
