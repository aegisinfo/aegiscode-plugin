'use strict';

/**
 * Transcript summarization for /compact and /recap.
 *
 * Dependency-free port of aegiscodex-dev/src/summarize.js. The reference
 * spawns `claude -p "Summarize…"` (via platform.resolveExecutable); here the
 * backend is *injected* instead, so this module pulls in nothing but tokens.js:
 *
 *   async summarizeTranscript(transcript, { callModel, model, signal } = {})
 *   async recapLine(transcript, { callModel, model, signal } = {})
 *
 * `callModel(prompt) -> string` (async) is the caller's own model seam. When
 * `callModel` is not a function the module falls back to a purely local
 * extraction — the first user text, the last assistant text and the turn count
 * — and never throws. On abort (signal.aborted) it resolves null so handlers
 * can report "cancelled"; on any other backend failure it resolves the local
 * extraction.
 */

const { estimateTokens } = require('./tokens.js');

// Guard: don't push more than this many chars into a prompt.
const MAX_INPUT_CHARS = 120_000;
const MAX_REPLY_CHARS = 2_000;

function extractiveSummary(transcript) {
  const users = transcript.filter((m) => m.role === 'user').map((m) => m.text || '');
  const lastAsst = [...transcript].reverse().find((m) => m.role === 'assistant');
  const topics = users.slice(0, 3).map((t) => `“${t.length > 48 ? t.slice(0, 45) + '…' : t}”`);
  const parts = [];
  if (users.length) parts.push(`Covered ${users.length} prompt${users.length > 1 ? 's' : ''}: ${topics.join('; ')}.`);
  if (lastAsst) {
    const tail = (lastAsst.text || '').split(/\s+/).slice(0, 30).join(' ');
    parts.push(`Last reply began: ${tail.length > 100 ? tail.slice(0, 97) + '…' : tail}`);
  }
  if (!parts.length) return 'Session with no exchanges yet.';
  return parts.join(' ');
}

function demoSummary(transcript) {
  return `[demo summary] ${extractiveSummary(transcript)}`;
}

/** Summarize the whole transcript in a few sentences. Resolves null on abort. */
async function summarizeTranscript(transcript, { callModel, model, signal } = {}) {
  if (!transcript || !transcript.length) return 'Session with no exchanges yet.';
  if (typeof callModel !== 'function') return demoSummary(transcript);
  return callBackend('summarize', transcript, model, signal, callModel, () => demoSummary(transcript));
}

/** A single-line recap. Resolves null on abort. */
async function recapLine(transcript, { callModel, model, signal } = {}) {
  if (!transcript || !transcript.length) return 'No exchanges yet.';
  if (typeof callModel !== 'function') return `[demo recap] ${extractiveSummary(transcript)}`;
  return callBackend('recap', transcript, model, signal, callModel, () => `[demo recap] ${extractiveSummary(transcript)}`);
}

async function callBackend(kind, transcript, model, signal, callModel, fallback) {
  const text = transcriptToText(transcript).slice(0, MAX_INPUT_CHARS);
  // NB: the ternary binds exactly as in the reference — the recap branch does
  // not append the transcript text. Ported verbatim.
  const prompt = kind === 'recap'
    ? 'Recap the following conversation in one sentence. Be factual and specific.'
    : 'Summarize the following conversation. Preserve every requirement, decision, and open question, in 2-4 sentences.'
    + '\n\n' + text;

  try {
    if (signal && signal.aborted) return null;
    const out = await callModel(prompt, { model, signal });
    if (signal && signal.aborted) return null;
    if (typeof out === 'string' && out.trim()) return out.trim().slice(0, MAX_REPLY_CHARS);
    return fallback();
  } catch {
    return fallback();
  }
}

function transcriptToText(transcript) {
  return transcript
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'note')
    .map((m) => `${m.role}: ${m.text || ''}`)
    .join('\n\n');
}

module.exports = {
  summarizeTranscript,
  recapLine,
  estimateTokens,
};
