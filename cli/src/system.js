'use strict';

/**
 * Small system helpers: best-effort URL opening (never blocks or errors) and
 * a few constants shared by the support/easter-egg commands.
 *
 * Ported from aegiscodex-dev/src/system.js (ESM → CommonJS). The URLS table
 * pointed at Anthropic/Claude support endpoints; those are re-homed to the
 * AEGIS base (https://aegiscloud.org) and the project repo. Deep paths that
 * had no AEGIS equivalent collapse to the base rather than inventing a route.
 */

const { spawn } = require('node:child_process');

/** Best-effort open of a URL in the system browser. Returns true if launched. */
function openUrl(url) {
  try {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? ['open'] : platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open'];
    const child = spawn(cmd[0], [...cmd.slice(1), url], { stdio: 'ignore', detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// AEGIS support URLs (used by /troubleshooting, /feedback…).
const URLS = {
  troubleshooting: 'https://aegiscloud.org',
  feedback: 'https://aegiscloud.org',
  issues: 'https://github.com/aegisinfo/aegiscode-plugin/issues/new',
  docs: 'https://aegiscloud.org',
  radio: 'https://www.youtube.com/watch?v=cP8jB6YQWbQ',
};

module.exports = { openUrl, URLS };
