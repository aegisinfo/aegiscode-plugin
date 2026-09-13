'use strict';

/**
 * deep-link.js — aegis:// URL parsing (native desktop plumbing).
 * Pure functions, no Electron import, so this unit-tests without the
 * Electron binary. main.js wires the result into IPC; this module only
 * turns a raw URL/argv list into `{ action, ... }` or null.
 *
 * Supported shapes:
 *   aegis://open?session=<id>   -> { action: 'open', sessionId }
 *   aegis://new?prompt=<text>   -> { action: 'new', prompt }
 */

const PROTOCOL = 'aegis';
const SCHEME_PREFIX = `${PROTOCOL}://`;

/** True for any string that looks like our protocol, cheap enough to filter
 *  argv with before the full URL parse (which throws on most argv entries —
 *  flags, file paths — so callers should not run it against every arg). */
function isDeepLinkUrl(value) {
  return typeof value === 'string' && value.toLowerCase().startsWith(SCHEME_PREFIX);
}

/**
 * Parse a raw `aegis://...` URL into a routable action, or null for anything
 * unparseable or from a scheme/action this app doesn't recognise. Never
 * throws — a malformed or malicious URL (e.g. handed to the OS by another
 * app) just yields null.
 */
function parseDeepLinkUrl(url) {
  if (!isDeepLinkUrl(url)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PROTOCOL}:`) return null;

  // For a non-special scheme like "aegis:", "//host" still parses into
  // `.hostname` — aegis://open?session=x -> hostname "open".
  const action = (parsed.hostname || '').toLowerCase();

  if (action === 'open') {
    const sessionId = parsed.searchParams.get('session');
    if (!sessionId) return null;
    return { action: 'open', sessionId };
  }

  if (action === 'new') {
    return { action: 'new', prompt: parsed.searchParams.get('prompt') || '' };
  }

  return null;
}

/**
 * Find the deep-link URL among a process's argv, handling the Linux quirk
 * where the OS hands the URL to the app as a bare positional argument (no
 * `--url=` flag, no special marker) — it can land anywhere after the
 * executable/script path, so every entry is checked rather than assuming a
 * fixed index.
 */
function extractDeepLinkUrl(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    if (isDeepLinkUrl(arg)) return arg;
  }
  return null;
}

/** Convenience: argv -> parsed action in one call, or null at either step. */
function parseDeepLinkArgv(argv) {
  return parseDeepLinkUrl(extractDeepLinkUrl(argv));
}

module.exports = {
  PROTOCOL,
  isDeepLinkUrl,
  parseDeepLinkUrl,
  extractDeepLinkUrl,
  parseDeepLinkArgv,
};
