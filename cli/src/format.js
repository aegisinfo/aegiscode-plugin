'use strict';

/**
 * Number/text formatting for the CLI — one place, so the transcript, the status
 * bar and the headless `--print` output always agree.
 *
 * The sub-cent rule mirrors the server-side ledger: AEGIS pooled calls settle
 * around €0.0007, so a 2dp rendering shows a real charge as "€0.00" next to its
 * token count and reads as free usage.
 */

/** Group digits: 1562 -> "1,562". */
function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  return Math.round(v)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** € amount, 4dp below a cent (per-call spend) and 2dp above it (top-ups). */
function fmtEur(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '€?';
  const abs = Math.abs(v);
  return `€${abs < 0.01 ? abs.toFixed(4) : abs.toFixed(2)}`;
}

/** Signed € amount, from the user's side: -€0.0007 spent, +€5.00 added. */
function fmtEurSigned(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '€?';
  return `${v < 0 ? '-' : '+'}${fmtEur(Math.abs(v))}`;
}

/** Compact duration: 850 -> "0.9s", 65000 -> "1m05s". */
function fmtElapsed(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m${String(rest).padStart(2, '0')}s`;
}

/** Mask an API key for display: never echo enough to be useful if leaked. */
function maskKey(key) {
  const s = String(key || '');
  if (!s) return 'not set';
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 6)}${'•'.repeat(4)}${s.slice(-4)}`;
}

module.exports = { fmtTokens, fmtEur, fmtEurSigned, fmtElapsed, maskKey };
