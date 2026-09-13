'use strict';

/**
 * window-state.js — persisted BrowserWindow bounds (native desktop plumbing).
 * Pure Node + injectable dir, mirrors desktop/lib/sync/memory-queue.js: reads
 * and writes <dir>/window-state.json, no Electron import, so it unit-tests
 * without the Electron binary.
 */

const fs = require('node:fs');
const path = require('node:path');

function stateFile(dir) {
  return path.join(dir, 'window-state.json');
}

function load(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function save(dir, state) {
  const file = stateFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Clamp a saved rectangle so it always intersects at least one connected
 * display's work area. A saved position from a monitor that has since been
 * unplugged, or from a resolution that shrank, would otherwise place the
 * window off every visible screen — it "opens" but is unreachable. `displays`
 * takes plain `{ workArea: {x,y,width,height} }` objects (electron.screen's
 * shape) so this stays pure and Electron-free for testing.
 */
function clampToDisplay(bounds, displays, fallback) {
  if (!bounds || typeof bounds !== 'object') return { ...fallback };
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return { ...fallback };

  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const list = Array.isArray(displays) ? displays : [];

  const visible = list.some((d) => {
    const wa = d && d.workArea;
    if (!wa) return false;
    return x < wa.x + wa.width && x + w > wa.x && y < wa.y + wa.height && y + h > wa.y;
  });

  if (visible) return { x, y, width: w, height: h };
  // Position is off every screen: keep the saved size but drop x/y so the
  // caller's default centering (no x/y passed to BrowserWindow) takes over.
  return { ...fallback, width: w, height: h };
}

module.exports = { stateFile, load, save, clampToDisplay };
