'use strict';

/**
 * Cross-platform clipboard write. Tries the platform's native tool first
 * (pbcopy / wl-copy / xclip / xsel / clip.exe), then falls back to writing a
 * file in the data dir and reporting its path — the CLI never errors out over
 * clipboard availability. Set AEGISCODE_NO_CLIPBOARD=1 to force the file
 * fallback (used by tests and headless setups).
 *
 * Ported from aegiscodex-dev/src/clipboard.js (ESM → CommonJS). The data dir
 * comes from the shared `aegisDir()` helper and the force-fallback env var was
 * renamed AEGISCODEX_NO_CLIPBOARD → AEGISCODE_NO_CLIPBOARD.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { aegisDir } = require('./config.js');

const TOOLS = [
  { name: 'pbcopy', cmd: 'pbcopy', args: [], test: () => process.platform === 'darwin' },
  { name: 'wl-copy', cmd: 'wl-copy', args: [], test: () => process.platform === 'linux' },
  { name: 'xclip', cmd: 'xclip', args: ['-selection', 'clipboard'], test: () => process.platform === 'linux' },
  { name: 'xsel', cmd: 'xsel', args: ['--clipboard', '--input'], test: () => process.platform === 'linux' },
  { name: 'clip', cmd: 'clip', args: [], test: () => process.platform === 'win32' },
];

function toolAvailable(cmd) {
  // `sh` doesn't exist on Windows — use `where` there, `command -v` on POSIX.
  const isWin = process.platform === 'win32';
  const r = isWin
    ? spawnSync('where', [cmd], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8', timeout: 3000 });
  return !r.error && r.status === 0;
}

/**
 * Copy text to the system clipboard.
 * Returns { ok, via, path? } — via is 'tool:<name>' or 'file'.
 */
function copyToClipboard(text) {
  const forced = process.env.AEGISCODE_NO_CLIPBOARD === '1';
  if (!forced) {
    for (const t of TOOLS) {
      if (!t.test()) continue;
      if (!toolAvailable(t.cmd)) continue;
      const r = spawnSync(t.cmd, t.args, { input: String(text), encoding: 'utf8', timeout: 4000 });
      if (!r.error && r.status === 0) return { ok: true, via: `tool:${t.name}` };
    }
  }
  // Fallback: write to the data dir and report the path.
  try {
    fs.mkdirSync(aegisDir(), { recursive: true });
    const p = path.join(aegisDir(), 'clipboard.txt');
    fs.writeFileSync(p, String(text), 'utf8');
    return { ok: true, via: 'file', path: p };
  } catch {
    return { ok: false, via: 'none' };
  }
}

module.exports = { copyToClipboard };
