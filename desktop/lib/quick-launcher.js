'use strict';

/**
 * quick-launcher.js — pure geometry + gating logic for the global quick-
 * launcher popup (native desktop plumbing). Mirrors desktop/lib/window-state.js:
 * no Electron import, so both functions unit-test without the Electron binary.
 * main.js wires the result into a BrowserWindow + globalShortcut; this module
 * only decides where the window should sit and whether the shortcut should be
 * registered at all.
 */

/**
 * A global shortcut is a machine-wide hook — every packaged build ships it,
 * but a `npm start` dev run must NOT silently start grabbing a hotkey that
 * might collide with whatever else the developer has running, unless they've
 * explicitly opted in via the settings flag.
 */
function shouldEnableGlobalShortcut({ isPackaged, enabled } = {}) {
  return Boolean(isPackaged) || Boolean(enabled);
}

/**
 * Where the launcher window should land: centred on the cursor's current
 * position, clamped so the whole window stays within that cursor's display
 * work area (never straddling into an unplugged second monitor, never
 * hanging off a screen edge). Falls back to centring on the first available
 * display — or the given fallback rectangle — when there is no usable cursor
 * point or display list (e.g. a headless test).
 *
 * `cursor` / `displays` take the plain shapes electron.screen already
 * returns (`{x,y}` / `{workArea:{x,y,width,height}}`), so this stays pure and
 * Electron-free for testing, exactly like window-state.js's clampToDisplay.
 */
function computeQuickLauncherBounds({ cursor, displays, size, fallback } = {}) {
  const width = Math.max(1, (size && size.width) || 560);
  const height = Math.max(1, (size && size.height) || 320);
  const list = Array.isArray(displays) ? displays : [];
  const point =
    cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y) ? cursor : null;

  const containing = point
    ? list.find((d) => {
        const wa = d && d.workArea;
        return (
          wa &&
          point.x >= wa.x &&
          point.x < wa.x + wa.width &&
          point.y >= wa.y &&
          point.y < wa.y + wa.height
        );
      })
    : null;

  const target = containing || list[0] || null;
  if (!target || !target.workArea) {
    return {
      x: (fallback && fallback.x) || 0,
      y: (fallback && fallback.y) || 0,
      width,
      height,
    };
  }

  const wa = target.workArea;
  let x;
  let y;
  if (point) {
    x = Math.round(point.x - width / 2);
    y = Math.round(point.y - height / 2);
  } else {
    x = Math.round(wa.x + (wa.width - width) / 2);
    y = Math.round(wa.y + (wa.height - height) / 2);
  }

  x = Math.min(Math.max(x, wa.x), Math.max(wa.x, wa.x + wa.width - width));
  y = Math.min(Math.max(y, wa.y), Math.max(wa.y, wa.y + wa.height - height));

  return { x, y, width, height };
}

module.exports = { shouldEnableGlobalShortcut, computeQuickLauncherBounds };
