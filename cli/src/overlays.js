'use strict';

/**
 * Overlay renderers — the "/" command palette, the alt+p model picker, the
 * /effort picker and the /resume session list. Ported from
 * `aegiscodex-dev/src/commands.js` (which mirrors live captures of Claude Code
 * 2.1.228: a gray `─` rule, a lavender `❯` cursor, a blue selected row, a
 * `⎿  Usage: /x hint` hook under the focused command and a `·`-separated footer).
 *
 * Every renderer here is PURE. It receives the data it draws — a command list, a
 * model list, an item list, a selection index, a width and a height — and
 * returns an array of span lines (`{ t, s, w }`, see screen.js). It imports no
 * registry, no session state and no key handling; the session loop owns those.
 * The palette's command list is the array the concurrent workstream owns:
 * `{ name, aliases?, help|desc, args?, category?, hint?, tool?|local?|unavailable? }`.
 *
 * Filtering reuses `./fuzzy.js` (fuzzyRankWithAliases + fuzzyMatchPositions).
 * The require is guarded: if that module is absent the palette falls back to a
 * substring filter so this file still loads and `node --check` still passes.
 */

const { span, padLine } = require('./screen.js');
const { C, BOLD, BOLD_OFF, GLYPH } = require('./theme.js');

// ── fuzzy.js (guarded require — a concurrent workstream owns it) ─────────────
let fuzzy = null;
try {
  // eslint-disable-next-line global-require
  fuzzy = require('./fuzzy.js');
} catch {
  fuzzy = null;
}

/** Rank palette commands by query (aliases count, like the reference). */
function rankCommands(query, commands) {
  if (fuzzy && typeof fuzzy.fuzzyRankWithAliases === 'function') {
    return fuzzy.fuzzyRankWithAliases(query, commands, (c) => c.name, (c) => c.aliases || []);
  }
  // Fallback: plain case-insensitive substring across name + aliases.
  const q = String(query || '').toLowerCase();
  if (!q) return commands;
  return commands.filter((c) =>
    `${c.name} ${(c.aliases || []).join(' ')}`.toLowerCase().includes(q)
  );
}

/** The short description a registry entry carries (help or desc). */
const descOf = (c) => c.help != null ? c.help : (c.desc != null ? c.desc : '');
/** The usage hint shown on the selected row's `⎿` hook (hint, else args). */
const hintOf = (c) => (c.hint != null ? c.hint : (c.args != null ? c.args : ''));

/** Pad (and, if needed, truncate) every line to `width` cells so an overlay can
 *  never paint wider than the terminal. */
function fit(lines, width) {
  return lines.map((l) => padLine(l, width));
}

/** A full-width blank row. */
const blank = (width) => [span('', ' '.repeat(Math.max(0, width)))];

// Phase 10b (2.1.228 port): split a command name into spans that bold the
// characters which matched the query; the selected row reads blue.
function boldMatched(query, name, colour) {
  const pos = fuzzy && typeof fuzzy.fuzzyMatchPositions === 'function'
    ? fuzzy.fuzzyMatchPositions(query, name)
    : [];
  if (!pos || !pos.length) return [span(colour, name)];
  const segs = [];
  let last = 0;
  for (const p of pos) {
    if (p > last) segs.push(span(colour, name.slice(last, p)));
    segs.push(span(colour + BOLD, name[p]));
    last = p + 1;
  }
  if (last < name.length) segs.push(span(colour, name.slice(last)));
  return segs;
}

// ── Palette overlay (/) ──────────────────────────────────────────────────────

/**
 * @param {Array|{commands:Array, query?:string, sel?:number}} commands
 *        the registry command list (or a state object carrying it as `.commands`)
 * @param {{query?:string, sel?:number}} [state]
 * @param {number} [width]
 * @param {number} [height]
 */
function renderPalette(commands, state = {}, width = 80, height = 24) {
  // Accept either `renderPalette(list, {query, sel}, w, h)` or the reference's
  // `renderPalette({commands, query, sel}, w, h)`.
  if (!Array.isArray(commands) && commands && typeof commands === 'object') {
    state = commands;
    commands = Array.isArray(commands.commands) ? commands.commands : [];
  }
  const list = rankCommands(state.query || '', commands || []);
  const sel = Number.isInteger(state.sel) ? state.sel : 0;
  const total = list.length;
  const per = Math.max(1, Math.min(12, height - 8));
  const start = Math.max(0, Math.min(sel - Math.floor(per / 2), Math.max(0, total - per)));
  const visible = list.slice(start, start + per);

  const lines = [];
  lines.push(blank(width));
  lines.push([span(C.gray, '  ' + '─'.repeat(Math.max(10, width - 4)))]);
  for (let i = 0; i < visible.length; i++) {
    const c = visible[i];
    const idx = start + i;
    const active = idx === sel;
    const left = active ? span(C.lavender, GLYPH.cursor) : span('', ' ');
    const row = active ? C.blue : C.white;
    const name = [span(row, '/'), ...boldMatched(state.query || '', c.name, row)];
    const pad = ' '.repeat(Math.max(1, 22 - [...c.name].length));
    lines.push([
      span('', ' '),
      left,
      span('', ' '),
      ...name,
      span(c.unavailable ? C.dim : C.gray, pad + descOf(c)),
    ]);
    if (active && hintOf(c)) {
      lines.push([span('', ' '), span(C.gray, `${GLYPH.hook}  Usage: /${c.name} ${hintOf(c)}`)]);
    }
  }
  while (lines.length < 4 + per * 2) lines.push(blank(width));
  lines.push([span(C.gray, '  ' + '─'.repeat(Math.max(10, width - 4)))]);
  lines.push([
    span(
      C.gray,
      `  type to filter ${GLYPH.bullet} enter to run ${GLYPH.bullet} esc to close`
    ),
  ]);
  return fit(lines, width);
}

// ── Model picker overlay (alt+p) ─────────────────────────────────────────────

/**
 * @param {Array} models entries ({id, label?, name?, note?, model?})
 * @param {number} sel selected index
 * @param {number} width
 * @param {number} height
 * @param {string|null} current the currently-pinned model id
 */
function renderModelPicker(models, sel = 0, width = 80, height = 24, current = null) {
  const lines = [];
  lines.push(blank(width));
  lines.push([span('', ' '), span(C.white + BOLD, 'Select model'), span(BOLD_OFF, '')]);
  lines.push([span('', ' '), span(C.gray, 'Switch between models. Your pick becomes the default for new sessions.')]);
  lines.push([span('', ' '), span(C.gray, 'Manage the list with /model add|remove — /model <id> switches directly.')]);
  lines.push(blank(width));
  for (let i = 0; i < models.length; i++) {
    const m = models[i] || {};
    const label = m.label || m.name || m.id || '';
    const active = i === sel;
    const cur = current != null && m.id === current;
    const left = active ? span(C.lavender, GLYPH.cursor) : span('', ' ');
    const num = span(C.gray, `${i + 1}.`);
    const nameSpan = active ? span(C.lavender, label) : span(C.white, label);
    const mark = cur ? span(C.green, ' ' + GLYPH.check) : span('', '');
    const pad = ' '.repeat(Math.max(1, 22 - [...label].length));
    lines.push([
      span('', ' '),
      left,
      span('', ' '),
      num,
      span('', ' '),
      nameSpan,
      mark,
      span(C.gray, pad + (m.note || m.model || '')),
    ]);
  }
  lines.push(blank(width));
  lines.push([span('', ' '), span(C.gray, `arrow keys to navigate ${GLYPH.bullet} enter to select ${GLYPH.bullet} esc to cancel`)]);
  return fit(lines, width);
}

// ── Effort picker overlay (/effort) ──────────────────────────────────────────

const EFFORT_LEVELS = [
  { label: 'Auto', value: null, note: 'Sized per turn from the ask (default)' },
  { label: 'Low', note: 'Fastest, cheapest budget' },
  { label: 'Medium', note: 'Balanced' },
  { label: 'High', note: 'Highest budget, slowest' },
];

// The picker's order reduced to the values a selection means, so the row a user
// picks and the value the session stores can never come from two different
// lists (commands.js validates against this, chatflow.js resolves the overlay
// through it). `null` is "auto" — no rung pinned.
const EFFORT_VALUES = EFFORT_LEVELS.map((lv) => (lv.value === undefined ? lv.label.toLowerCase() : lv.value));

/**
 * @param {number} sel selected index
 * @param {number} width
 * @param {string|null} current the currently-selected effort level (null = auto)
 * @param {Array} [levels] override the level table
 */
function renderEffortPicker(sel = 0, width = 80, current = null, levels = EFFORT_LEVELS) {
  const lines = [];
  lines.push(blank(width));
  lines.push([span('', ' '), span(C.white + BOLD, 'Select effort'), span(BOLD_OFF, '')]);
  lines.push([span('', ' '), span(C.gray, 'Sets the token budget the pool sizes each turn from.')]);
  lines.push(blank(width));
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    const active = i === sel;
    // `current == null` is auto, which is the first row's own value — matching
    // on the label alone would never mark the default as the current choice.
    const cur = current == null
      ? lv.value === null
      : String(current).toLowerCase() === String(lv.label).toLowerCase();
    const left = active ? span(C.lavender, GLYPH.cursor) : span('', ' ');
    const nameSpan = active ? span(C.lavender, lv.label) : span(C.white, lv.label);
    const mark = cur ? span(C.green, ' ' + GLYPH.check) : span('', '');
    const pad = ' '.repeat(Math.max(1, 12 - [...lv.label].length));
    lines.push([span('', ' '), left, span('', ' '), nameSpan, mark, span(C.gray, pad + lv.note)]);
  }
  lines.push(blank(width));
  lines.push([span('', ' '), span(C.gray, `arrow keys to navigate ${GLYPH.bullet} enter to select ${GLYPH.bullet} esc to cancel`)]);
  return fit(lines, width);
}

// ── Resume-list overlay (/resume) ────────────────────────────────────────────

/**
 * @param {Array} items entries ({own?, summary?, cwd?, time?})
 * @param {number} sel selected index
 * @param {number} width
 * @param {number} height
 */
function renderResumeList(items, sel = 0, width = 80, height = 24) {
  const list = Array.isArray(items) ? items : [];
  const lines = [];
  lines.push(blank(width));
  lines.push([span('', ' '), span(C.gray, '─'.repeat(Math.max(10, width - 4)))]);
  lines.push([
    span('', ' '),
    span(C.white + BOLD, 'Resume session'),
    span(C.gray, ` (${sel + 1} of ${Math.max(1, list.length)})`),
    span(BOLD_OFF, ''),
  ]);
  // search box
  const boxW = Math.max(10, width - 4);
  lines.push([span('', ' '), span(C.gray, '╭' + '─'.repeat(Math.max(0, boxW - 2)) + '╮')]);
  lines.push([
    span('', ' '),
    span(C.gray, '│'),
    span(C.white, '⌕ Search…'),
    span('', ' '.repeat(Math.max(0, boxW - 9))),
    span(C.gray, '│'),
  ]);
  lines.push([span('', ' '), span(C.gray, '╰' + '─'.repeat(Math.max(0, boxW - 2)) + '╯')]);
  lines.push(blank(width));
  const per = Math.max(2, Math.min(6, height - 16));
  const start = Math.max(0, Math.min(sel - Math.floor(per / 2), Math.max(0, list.length - per)));
  const visible = list.slice(start, start + per);
  for (let i = 0; i < visible.length; i++) {
    const it = visible[i] || {};
    const idx = start + i;
    const active = idx === sel;
    const left = active ? span(C.lavender, GLYPH.cursor) : span('', ' ');
    const tag = it.own ? span(C.green, GLYPH.star + ' ') : span(C.gray, GLYPH.bullet + ' ');
    const title = active
      ? span(C.white + BOLD, it.summary || '(untitled)')
      : span(C.white, it.summary || '(untitled)');
    lines.push([span('', ' '), left, span('', ' '), tag, title]);
    lines.push([span('', '     '), span(C.gray, `${it.cwd || '~'} ${GLYPH.bullet} ${ago(it.time)}`)]);
  }
  while (lines.length < 6 + per * 2) lines.push(blank(width));
  lines.push([span('', ' '), span(C.gray, '─'.repeat(Math.max(10, width - 4)))]);
  lines.push([
    span('', ' '),
    span(
      C.gray,
      `Ctrl+A all projects ${GLYPH.bullet} Space to preview ${GLYPH.bullet} Type to search ${GLYPH.bullet} Esc to cancel`
    ),
  ]);
  return fit(lines, width);
}

function ago(ts) {
  if (!ts) return '';
  const ms = Date.now() - new Date(String(ts)).getTime();
  if (!(ms >= 0) || Number.isNaN(ms)) return '';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

module.exports = {
  boldMatched,
  renderPalette,
  renderModelPicker,
  renderEffortPicker,
  renderResumeList,
  EFFORT_LEVELS,
  EFFORT_VALUES,
};
