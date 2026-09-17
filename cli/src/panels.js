'use strict';

/**
 * Panel builders — the bodies that slash-commands print.
 *
 * Ported from `aegiscodex-dev/src/panels.js` (868 lines), keeping its layouts
 * and copy wherever the capability exists in this client. Everything here is
 * PURE: a builder receives all of its data as arguments and returns an array of
 * span lines (each line an array of `{ t, s, w }`, see `screen.js`). No stdout
 * writes, no `process.exit`, no network, no filesystem reads — which is exactly
 * what makes them assertable from a plain Node test with no TTY.
 *
 * Style objects come from `themeOf(ctx)` (`ctx = { light }`), never a
 * module-scoped palette. Money is euro: `fmtEur` renders 4dp below a cent (a
 * pooled call settles near €0.0007) and 2dp at or above it, so a real charge
 * never reads as "€0.00". The reference printed USD; every `$` became `€`.
 * Claude/Anthropic names became AEGIS (`aegiscode`, `aegiscloud.org`,
 * `github.com/aegisinfo/aegiscode-plugin`) and `~/.aegiscodex` became
 * `~/.aegiscode`.
 *
 * Every builder is defensive: a missing field is omitted, never rendered as
 * `undefined`, `NaN` or `[object Object]`.
 *
 * ── Ported for real ──────────────────────────────────────────────────────────
 *   buildHelp buildStatus buildCost buildContext buildTokens buildAgents
 *   renderSessionsOverlay buildPermissions buildModelList buildRewindList
 *   buildOnboarding buildShellCompletion buildTerminalSetup buildPRs
 *   buildBenchmark buildWaifu buildAegisStatus buildAegisRecall buildAegisMulti
 *   buildBilling buildMemory buildMemoryTiers buildRouter buildYolo buildSkills
 *   buildMcp buildHooksStatus buildHooksList buildTroubleshooting
 *   buildReleaseNotes
 *   (plus the pure reference helpers with no missing capability)
 *   buildAegisPrint buildSkillDetail buildMemoryEmbeddings
 *
 * ── Honest stubs (capability absent in this client) ──────────────────────────
 *   buildDoctor       — needs the local environment diagnostic suite (runDoctor),
 *                       which belongs to aegiscodex-dev; /doctor is unavailable.
 *   buildBuildPanel   — needs a local multi-model agent build loop this client
 *                       does not host.
 */

const { span, getSize, lineWidth } = require('./screen.js');
const { themeOf, BOLD, BOLD_OFF, GLYPH } = require('./theme.js');

// ── local helpers (this file stays self-contained apart from theme/screen) ────

/** Finite number or 0 — never NaN (which would print as "NaN"). */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A safe display string: null/undefined become '', everything else String()s. */
function str(v) {
  return v == null ? '' : String(v);
}

/** Group digits: 1562 -> "1,562". Matches the CLI's format.js rule. */
function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  return Math.round(v)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** € amount, 4dp below a cent (per-call spend) and 2dp at or above it. */
function fmtEur(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '€?';
  const abs = Math.abs(v);
  return `€${abs < 0.01 ? abs.toFixed(4) : abs.toFixed(2)}`;
}

/** Relative-time stamp, ported verbatim from the reference's `ago()`. */
function ago(ts) {
  if (!ts) return '';
  const ms = Date.now() - new Date(String(ts)).getTime();
  if (!(ms >= 0) || Number.isNaN(ms)) return '';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/** A `█`-filled progress bar as a span line (the reference's contextBar). */
function contextBar(used, window, t, width = 50) {
  const pct = Math.max(0, Math.min(1, window > 0 ? num(used) / window : 0));
  const filled = Math.round(pct * width);
  return [
    span('', ' '),
    span(t.green, '█'.repeat(filled)),
    span(t.dim, '█'.repeat(Math.max(0, width - filled))),
    span(t.gray, ` ${Math.round(pct * 100)}% used`),
  ];
}

/** Aligned key/value rows, the reference's `k + ' '.repeat(maxK-len) + ' : '`. */
function kv(t, rows, { indent = ' ', keyStyle = null, valStyle = null } = {}) {
  const maxK = rows.reduce((m, r) => Math.max(m, [...r[0]].length), 0);
  return rows.map(([k, v]) => [
    span(keyStyle != null ? keyStyle : t.gray, indent + k + ' '.repeat(maxK - [...k].length) + ' : '),
    span(valStyle != null ? valStyle : t.white, str(v)),
  ]);
}

/** The `state` argument, guaranteed to be an object. */
function obj(state) {
  return state && typeof state === 'object' ? state : {};
}

/** An object that looks like ÆGIS memory stats, from either `state.memory` or
 *  `state` itself (the reference passed the stats object directly). */
function statsFrom(state) {
  const s = obj(state);
  if (s.stats && typeof s.stats === 'object') return s.stats;
  if (s.memory && typeof s.memory === 'object' && (s.memory.total != null || s.memory.tiers || s.memory.sessions != null || s.memory.roles)) {
    return s.memory;
  }
  if (s.total != null || s.tiers || s.roles) return s;
  return null;
}

/** Category labels, copied from the reference registry's CATEGORIES table. */
const CATEGORY_LABELS = {
  session: 'Session & context',
  workspace: 'Workspace',
  model: 'Model & behavior',
  data: 'Data',
  auth: 'Auth',
  support: 'Support',
  fun: 'Fun',
  aegis: 'Aegis plugin',
  custom: 'Custom',
};

function categoryLabel(cmd) {
  if (cmd && cmd.categoryLabel) return String(cmd.categoryLabel);
  const id = str(cmd && cmd.category);
  if (CATEGORY_LABELS[id]) return CATEGORY_LABELS[id];
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Commands';
}

// ── /help ────────────────────────────────────────────────────────────────────

/** @param {Array} commands [{name,aliases,desc,hint,args,category,unavailable}] */
function buildHelp(commands, ctx = {}) {
  const t = themeOf(ctx);
  const list = Array.isArray(commands)
    ? commands
    : Array.isArray(obj(commands).commands)
      ? commands.commands
      : [];
  const out = [];
  out.push([span(t.gold + BOLD, 'Commands'), span(BOLD_OFF, '')]);
  out.push([span(t.gray, '─'.repeat(30))]);
  let lastCat = null;
  for (const cmd of list) {
    if (!cmd || !cmd.name) continue;
    const cat = str(cmd.category);
    if (cat !== lastCat) {
      out.push([span('', '')]);
      out.push([span(t.gray + BOLD, categoryLabel(cmd)), span(BOLD_OFF, '')]);
      lastCat = cat;
    }
    const name = String(cmd.name);
    const pad = ' '.repeat(Math.max(1, 16 - [...name].length));
    const desc = str(cmd.desc != null ? cmd.desc : cmd.help);
    const nameStyle = cmd.unavailable ? t.gray : t.white;
    const descStyle = cmd.unavailable ? t.dim : t.gray;
    const tail = cmd.unavailable ? '  (unavailable)' : '';
    out.push([span(nameStyle, '/' + name), span(descStyle, pad + desc + tail)]);
  }
  if (!list.length) {
    out.push([span('', '')]);
    out.push([span(t.gray, 'No commands registered.')]);
  }
  out.push([span('', '')]);
  out.push([
    span(t.gray, 'Shortcuts: '), span(t.white, '?'), span(t.gray, ' shortcuts · '),
    span(t.white, '/help'), span(t.gray, ' commands · '), span(t.white, '↑↓'), span(t.gray, ' history · '),
    span(t.white, 'Ctrl-L'), span(t.gray, ' clear · '), span(t.white, 'Ctrl-D'), span(t.gray, ' exit'),
  ]);
  return out;
}

// ── /status ──────────────────────────────────────────────────────────────────

/**
 * @param {object} state session state (see the module header in the task)
 * @param {{light?: boolean, caps?: Array<[string,string]>}} [ctx] `caps` is the
 *   `caps.describe()` row list, rendered as the terminal-capability rows.
 */
function buildStatus(state, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(state);
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Status'), span(BOLD_OFF, '')]);

  const rows = [];
  const add = (k, v) => {
    const value = str(v);
    if (value !== '') rows.push([k, value]);
  };
  add('Session ID', s.sessionId);
  add('Working directory', s.cwd);
  add('Home', s.home);
  add('Model', s.model);
  // `null` = auto: the pool sizes each turn from the ask, so the row says so
  // rather than vanishing (add() skips empty values).
  add('Effort', s.effort || 'auto');
  if (s.thinking != null) add('Thinking', s.thinking ? 'on' : 'off');
  if (s.stream != null) add('Streaming', s.stream === false ? 'off' : 'on');
  if (s.vim != null) add('Vim keymap', s.vim ? 'on' : 'off');
  add('Theme', s.theme ? str(s.theme) : (ctx && ctx.light ? 'Light mode' : 'Dark mode'));
  add('Backend', s.backend);
  add('Base', s.base);
  add('Plan', s.plan);
  add('Account', s.account);
  if (s.online != null) add('Online', s.online ? 'yes' : 'no');
  if (s.turns != null) add('Turns', str(num(s.turns)));
  if (s.calls != null) add('Tool calls', str(num(s.calls)));
  if (s.version != null) add('Version', 'v' + str(s.version));
  add('Node', process.version);
  add('Platform', `${process.platform} ${process.arch}`);
  // Terminal capabilities, read off the same `caps.describe()` rows `/terminal`
  // renders — passed in on `ctx` so this builder stays pure (no caps.js require)
  // and the two reports cannot drift. Absent in tests and headless runs; `add()`
  // skips empty values, so the rows simply do not appear.
  const capsRows = Array.isArray(ctx.caps) ? ctx.caps : [];
  const cap = (k) => {
    const hit = capsRows.find((r) => Array.isArray(r) && String(r[0]) === k);
    return hit ? str(hit[1]) : '';
  };
  add('Terminal', cap('terminal'));
  add('Mark', cap('mark'));
  add('Star', cap('star'));
  add('Color', cap('color'));
  add('Control', cap('control'));
  add('Frame', cap('size'));

  for (const l of kv(t, rows, { keyStyle: t.gray, valStyle: t.white })) lines.push(l);

  lines.push([span('', '')]);
  const mode = s.permissions && s.permissions.mode ? str(s.permissions.mode) : 'default';
  lines.push([span(t.gray, `Permissions: ${mode} — tool use follows your AEGIS settings.`)]);
  return lines;
}

// ── /cost — the session's euro tally ─────────────────────────────────────────

/** @param {object} state {tokens, costEur, balance, model, turns, calls} */
function buildCost(state, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(state);
  const { cols } = getSize();
  const W = Math.max(30, cols - 2);
  const tok = s.tokens && typeof s.tokens === 'object' ? s.tokens : {};
  const input = num(tok.input);
  const output = num(tok.output);
  const total = num(tok.total) || input + output;
  const cost = num(s.costEur);
  const model = str(s.model) || 'the pinned model';
  const window = num(s.contextWindow) || 200000;
  const pct = window > 0 ? Math.min(100, Math.round((total / window) * 100)) : 0;

  const lines = [];
  lines.push([span(t.gray, '─'.repeat(W))]);
  lines.push([
    span('', ' '), span(t.white + BOLD, 'Session'), span(BOLD_OFF, ''),
    span(t.gray, '  Status   Config   Usage Stats'),
  ]);
  lines.push([span('', ' '), span(t.gray, 'Session')]);
  lines.push([span('', ' '), span(t.white, 'Total cost:'), span(t.gray, ' ' + ' '.repeat(Math.max(0, 14 - fmtEur(cost).length)) + fmtEur(cost))]);
  if (s.balance != null) {
    lines.push([span('', ' '), span(t.white, 'Balance:'), span(t.gray, ' ' + ' '.repeat(Math.max(0, 14 - fmtEur(s.balance).length)) + fmtEur(s.balance))]);
  }
  if (s.turns != null || s.calls != null) {
    lines.push([span('', ' '), span(t.white, 'Turns:'), span(t.gray, ` ${num(s.turns)} turns · ${num(s.calls)} calls`)]);
  }
  lines.push([span('', ' '), span(t.white, '  Usage by model:')]);
  lines.push([span('', ' '), span(t.gray, `   ${model}:  ${fmtTokens(input)} input, ${fmtTokens(output)} output (${fmtEur(cost)})`)]);
  lines.push([span('', ' ')]);
  lines.push([span('', ' '), span(t.white + BOLD, 'Current session'), span(BOLD_OFF, '')]);
  lines.push(contextBar(total, window, t));
  lines.push([span('', ' ')]);
  lines.push([span('', ' '), span(t.gray, `Session context: ${pct}% of ${fmtTokens(window)} used.`)]);
  lines.push([span('', ' '), span(t.dim, 'Cost is metered from the AEGIS token bank; tokens are counted this session.')]);
  return lines;
}

// ── /context — token usage by bucket ─────────────────────────────────────────

/** @param {object} state {tokens} */
function buildContext(state, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(state);
  const { cols } = getSize();
  const W = Math.max(30, cols - 2);
  const tok = s.tokens && typeof s.tokens === 'object' ? s.tokens : {};
  const input = num(tok.input);
  const output = num(tok.output);
  const total = num(tok.total) || input + output;
  const window = num(s.contextWindow) || 200000;

  const lines = [];
  lines.push([span(t.gold + BOLD, 'Context usage'), span(BOLD_OFF, '')]);
  lines.push([span('', ' '), span(t.gray, '─'.repeat(Math.max(1, W - 2)))]);
  const row = (label, tokens) => [
    span('', ' '), span(t.white, label),
    span('', ' '.repeat(Math.max(1, 16 - [...label].length))),
    span(t.gray, fmtTokens(tokens)),
    span('', ' '.repeat(Math.max(1, 10 - fmtTokens(tokens).length))),
    ...contextBar(tokens, window, t),
  ];
  lines.push(row('Prompt tokens', input));
  lines.push(row('Output tokens', output));
  lines.push([span('', ' ')]);
  lines.push([span('', ' '), span(t.gray, '─'.repeat(Math.max(1, W - 2)))]);
  lines.push([
    span('', ' '), span(t.white + BOLD, 'Total'), span('', ' '.repeat(9)),
    span(t.gray, fmtTokens(total)),
    span('', ' '.repeat(Math.max(1, 10 - fmtTokens(total).length))),
    ...contextBar(total, window, t),
  ]);
  lines.push([span('', ' ')]);
  lines.push([span('', ' '), span(t.gray, `Context window: ${fmtTokens(window)} tokens`)]);
  return lines;
}

// ── agents / sessions overlay ────────────────────────────────────────────────

/** @param {object} state {version, model, cwd, sessions} */
function renderSessionsOverlay(state, width, height, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(state);
  const W = Math.max(30, num(width) ? num(width) - 4 : 76);
  const ver = str(s.version);
  const model = str(s.model) || 'default model';
  const cwd = str(s.cwd).split('/').filter(Boolean).pop() || '~';
  const sessions = Array.isArray(s.sessions) ? s.sessions.filter(Boolean) : [];
  const awaiting = sessions.filter((x) => x.awaiting || x.needsInput).length;
  const working = sessions.filter((x) => x.working).length;
  const completed = sessions.filter((x) => x.completed).length;

  const line = (spans) => [
    span(t.gray, '│'), span('', ' '), ...spans,
    span('', ' '.repeat(Math.max(0, W - 1 - lineWidth(spans)))),
    span(t.gray, '│'),
  ];
  const box = [];
  box.push([span(t.coral, '╭─── Aegiscode v' + ver + ' ' + '─'.repeat(Math.max(0, W - 24)) + '╮')]);
  box.push(line([span(t.white, model), span(t.gray, ' · '), span(t.white, cwd)]));
  box.push(line([span(t.gray, `${awaiting} awaiting input · ${working} working · ${completed} completed`)]));
  box.push([span(t.gray, '├' + '─'.repeat(W) + '┤')]);
  box.push(line([span(t.white + BOLD, 'Needs input'), span(BOLD_OFF, '')]));
  box.push(line([span(t.gray, 'Sessions that have a question or need your decision land here')]));
  box.push(line([span(t.coral, GLYPH.bloom), span(t.gray, ' current session   send a prompt to start   '), span(t.gray, '—')]));
  box.push(line([span(t.white + BOLD, 'Working'), span(BOLD_OFF, '')]));
  box.push(line([span(t.gray, 'Sessions AEGIS is actively working on — they keep running even if you close the terminal')]));
  box.push(line([span(t.white + BOLD, 'Completed'), span(BOLD_OFF, '')]));
  box.push(line([span(t.gray, 'Finished sessions wait here for you to review')]));
  box.push([span(t.gray, '╰' + '─'.repeat(W) + '╯')]);
  box.push([span('', ' '), span(t.gray, 'Sub-agents that keep working in the background need a local agent loop;')]);
  box.push([span('', ' '), span(t.gray, 'this build hands a bigger task to the pooled brain instead.')]);
  return box;
}

/** @param {object} state /agents — the sessions overlay at the terminal size. */
function buildAgents(state, ctx = {}) {
  const { cols, rows } = getSize();
  return renderSessionsOverlay(state, cols, rows, ctx);
}

// ── /permissions ─────────────────────────────────────────────────────────────

/** @param {object} rules {allow,deny,ask,defaultMode,_path} @param {string} [mode] */
function buildPermissions(rules, mode, ctx = {}) {
  const t = themeOf(ctx);
  const r = obj(rules);
  const list = (v) => (Array.isArray(v) ? v : []);
  const def = mode != null && mode !== '' ? String(mode) : (r.defaultMode != null ? String(r.defaultMode) : 'default');

  const lines = [];
  lines.push([span(t.gold + BOLD, 'Permissions'), span(BOLD_OFF, '')]);
  lines.push([span('', ' '), span(t.gray, 'Default mode: '), span(t.white, def)]);
  lines.push([span('', ' ')]);
  const section = (name, patterns) => {
    const out = [[span('', ' '), span(t.white + BOLD, name), span(BOLD_OFF, '')]];
    if (!patterns.length) out.push([span('', '  '), span(t.gray, '(none)')]);
    for (const p of patterns) out.push([span('', '    '), span(t.gray, str(p))]);
    return out;
  };
  for (const l of section('Allow', list(r.allow))) lines.push(l);
  for (const l of section('Deny', list(r.deny))) lines.push(l);
  for (const l of section('Ask', list(r.ask))) lines.push(l);
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'Usage:')]);
  lines.push([span(t.gray, '  /permissions allow "Bash(npm run *)"')]);
  lines.push([span(t.gray, '  /permissions deny "Edit(src/**)"')]);
  lines.push([span(t.gray, '  /permissions ask "Read(**/*.env)"')]);
  lines.push([span(t.gray, '  /permissions default ask  ·  /permissions clear')]);
  lines.push([span('', '')]);
  lines.push([span(t.dim, `Stored in ${str(r._path) || '~/.aegiscode/permissions.json'}`)]);
  return lines;
}

// ── /model list ──────────────────────────────────────────────────────────────

/** @param {string} currentId @param {Array} models [{id,name,model}] */
function buildModelList(currentId, models, ctx = {}) {
  const t = themeOf(ctx);
  const list = Array.isArray(models) ? models : [];
  const cur0 = str(currentId);
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Models'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  for (const m of list) {
    if (!m) continue;
    const idv = str(m.id) || str(m.model);
    const cur = idv !== '' && idv === cur0;
    const id = (cur ? '▶ ' : '  ') + idv;
    const name = str(m.name || m.label || m.model);
    const model = str(m.model) || '(default)';
    lines.push([
      span(t.white, id), span('', ' '.repeat(Math.max(1, 26 - [...id].length))),
      span(t.gray, name), span('', ' '.repeat(Math.max(1, 22 - [...name].length))),
      span(t.gray, model),
    ]);
  }
  if (!list.length) lines.push([span('', ' '), span(t.gray, '(no models configured)')]);
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'Switch: /model <id> · Add: /model add <id> <name> <model> <baseURL> [apiKey] · Remove: /model remove <id>')]);
  return lines;
}

// ── /rewind ──────────────────────────────────────────────────────────────────

/** @param {Array} items [{idx,depth,words,ts}] */
function buildRewindList(items, ctx = {}) {
  const t = themeOf(ctx);
  const list = Array.isArray(items) ? items : [];
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Rewind'), span(BOLD_OFF, '')]);
  lines.push([span('', ' '), span(t.gray, 'Snapshots are taken after every exchange.')]);
  lines.push([span('', ' ')]);
  for (const it of list) {
    if (!it) continue;
    const idx = str(num(it.idx));
    lines.push([
      span('', ' '), span(t.green, idx),
      span('', ' '.repeat(Math.max(1, 4 - [...idx].length))),
      span(t.white, `${num(it.depth)} messages`),
      span(t.gray, ` · ${num(it.words)} words · ${ago(it.ts)}`),
    ]);
  }
  if (!list.length) lines.push([span('', ' '), span(t.gray, '(no checkpoints)')]);
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'Usage: /rewind N to restore that checkpoint (0 = session start)')]);
  return lines;
}

// ── /hooks ───────────────────────────────────────────────────────────────────

/** @param {object} stats {enabled,hooks,events,byEvent,fromPaths} */
function buildHooksStatus(stats, ctx = {}) {
  const t = themeOf(ctx);
  const st = obj(stats);
  const events = Array.isArray(st.events) ? st.events : [];
  const byEvent = st.byEvent && typeof st.byEvent === 'object' ? st.byEvent : {};
  const fromPaths = Array.isArray(st.fromPaths) ? st.fromPaths : Array.isArray(st.sources) ? st.sources : [];

  const lines = [];
  lines.push([span(t.gold + BOLD, 'Hooks status'), span(BOLD_OFF, '')]);
  const rows = [
    ['status', st.enabled ? 'enabled' : 'disabled'],
    ['hooks', str(num(st.hooks))],
    ['events', str(events.length)],
  ];
  for (const l of kv(t, rows, { keyStyle: t.gray, valStyle: t.white })) lines.push(l);
  if (num(st.hooks) > 0) {
    lines.push([span('', '')]);
    lines.push([span('', ' '), span(t.white + BOLD, 'by event'), span(BOLD_OFF, '')]);
    for (const [event, count] of Object.entries(byEvent)) {
      lines.push([span('', '  '), span(t.green, GLYPH.bullet), span(t.white, ` ${event}`), span(t.gray, ` ${num(count)}`)]);
    }
  }
  lines.push([span('', '')]);
  lines.push([span(t.gray, '/hooks list for full config')]);
  lines.push([span('', '')]);
  lines.push([span(t.dim, fromPaths.length
    ? `Settings: ${fromPaths.join(', ')}`
    : 'Settings: no settings.json with hooks found (checked ~/.aegis, .aegis, ~/.aegiscode, .aegiscode, ~/.claude)')]);
  lines.push([span(t.gray, 'Aegiscode reads hook config but does not manage hooks — edit the files above.')]);
  return lines;
}

/** @param {object} config {hooks:{event:[{name,matcher,hooks}]}} */
function buildHooksList(config, ctx = {}) {
  const t = themeOf(ctx);
  const cfg = obj(config);
  const hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Hooks config'), span(BOLD_OFF, '')]);
  let hasAny = false;
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers) || matchers.length === 0) continue;
    hasAny = true;
    lines.push([span('', '')]);
    lines.push([span('', ' '), span(t.white + BOLD, event), span(BOLD_OFF, '')]);
    for (const matcher of matchers) {
      if (!matcher) continue;
      lines.push([span('', '  '), span(t.lavender, str(matcher.name) || '(unnamed)')]);
      if (matcher.matcher) {
        if (matcher.matcher.tools) lines.push([span('', '    - tools: '), span(t.gray, str(matcher.matcher.tools))]);
        if (matcher.matcher.paths) lines.push([span('', '    - paths: '), span(t.gray, str(matcher.matcher.paths))]);
        if (matcher.matcher.commands) lines.push([span('', '    - commands: '), span(t.gray, str(matcher.matcher.commands))]);
      }
      lines.push([span('', `    - hooks: ${Array.isArray(matcher.hooks) ? matcher.hooks.length : 0}`)]);
      lines.push([span('', '')]);
    }
  }
  if (!hasAny) {
    lines.push([span('', ' '), span(t.gray, 'no hooks configured.')]);
    lines.push([span('', '')]);
    lines.push([span('', ' '), span(t.gray, 'add hooks to settings.json:')]);
    lines.push([span('', '   '), span(t.gray, '- ~/.aegis/settings.json (user)')]);
    lines.push([span('', '   '), span(t.gray, '- .aegis/settings.json (project)')]);
  } else {
    lines.push([span('', '')]);
    lines.push([span(t.gray, '/hooks status for the summary')]);
  }
  return lines;
}

// ── support panels ───────────────────────────────────────────────────────────

function buildTroubleshooting(state, ctx = {}) {
  const t = themeOf(ctx);
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Troubleshooting'), span(BOLD_OFF, '')]);
  const tips = [
    ['No output / blank screen', 'Run with TERM=xterm-256color, or switch to a lighter theme (/theme light).'],
    ['Keys not responding', 'This client needs a real TTY — run it from a terminal, not a CI job.'],
    ['401 / unauthorized', 'Check the account line with /status, or set a provider key with /byok-set.'],
    ['No answers from the brain', 'Confirm the token-bank balance with /billing.'],
    ['Memory looks empty', 'Recall is per-topic — try /aegis-recall <topic> or save one with /aegis-remember <note>.'],
  ];
  for (const [issue, fix] of tips) {
    lines.push([span(t.green, GLYPH.bullet), span(t.white, ' ' + issue)]);
    lines.push([span('', '  '), span(t.gray, fix)]);
  }
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'Run /status for account state. Help: https://github.com/aegisinfo/aegiscode-plugin')]);
  return lines;
}

function buildOnboarding(state, ctx = {}) {
  const t = themeOf(ctx);
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Getting started'), span(BOLD_OFF, '')]);
  const tips = [
    ['/help', 'list every command'],
    ['/', 'open the command palette'],
    ['?', 'shortcuts'],
    ['/model <id>', 'pin a model'],
    ['/theme light|dark', 'switch the colour theme'],
    ['/aegis-ask', 'ask the pooled brain a question'],
    ['/memory', 'show your AEGIS cloud memory'],
    ['Ctrl-D', 'exit'],
  ];
  for (const [key, what] of tips) {
    lines.push([span('', ' '), span(t.lavender, key), span('', ' '.repeat(Math.max(1, 20 - [...key].length))), span(t.gray, what)]);
  }
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'Try "summarize this file for me" to see the full flow.')]);
  return lines;
}

function buildShellCompletion(state, ctx = {}) {
  const t = themeOf(ctx);
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Shell completion'), span(BOLD_OFF, '')]);
  lines.push([span('', ' '), span(t.gray, 'Aegiscode completes /commands with Tab inside the app.')]);
  lines.push([span('', ' '), span(t.gray, 'For shell-level completion of the aegiscode CLI itself:')]);
  lines.push([span('', ' ')]);
  const rows = [
    ['bash', 'eval "$(aegiscode shell-completion bash)"'],
    ['zsh', 'eval "$(aegiscode shell-completion zsh)"'],
    ['fish', 'aegiscode shell-completion fish | source'],
  ];
  for (const [shell, cmd] of rows) {
    lines.push([span('', ' '), span(t.white + BOLD, shell), span('', ' '.repeat(Math.max(1, 6 - shell.length))), span(t.gray, cmd)]);
  }
  lines.push([span('', '')]);
  lines.push([span(t.dim, 'Add the eval line to your ~/.bashrc or ~/.zshrc to make it persist.')]);
  return lines;
}

function buildTerminalSetup(state, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(state);
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const { cols, rows } = getSize();
  const shell = str(s.shell) || str(env.SHELL).split('/').pop();
  const table = [
    ['TERM', str(s.term) || str(env.TERM) || '(unset)'],
    ['LANG', str(s.lang) || str(env.LANG) || '(unset)'],
    ['Shell', shell || 'unknown'],
    ['Size', `${cols}x${rows}`],
  ];
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Terminal setup'), span(BOLD_OFF, '')]);
  for (const l of kv(t, table, { keyStyle: t.white, valStyle: t.gray })) lines.push(l);
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'Tips:')]);
  lines.push([span(t.gray, '  • TERM=xterm-256color enables full color + resize handling')]);
  lines.push([span(t.gray, '  • Set LANG (e.g. en_US.UTF-8) for correct glyphs and word wrap')]);
  lines.push([span(t.gray, '  • Resize mid-session is handled (SIGWINCH); overlays adapt')]);
  return lines;
}

// ── /terminal ────────────────────────────────────────────────────────────────

/**
 * The capability report — the same rows `aegiscode --terminal` prints, because
 * both render `caps.describe()`. Taking the rows as an argument keeps this
 * builder pure (see the module header): no `require('./caps.js')` here, so
 * `/terminal` and the launcher flag cannot drift into two different reports.
 *
 * This is the panel the CLI help promised at `aegiscode.js:63` ("`/terminal
 * ascii` toggles it mid-session") long before the command existed.
 *
 * @param {Array<[string,string]>} report rows from `caps.describe()`
 * @param {{pinned?: boolean, light?: boolean}} [ctx] `pinned` adds the warning
 *   shown after `/terminal width`, which turns off resize re-reads.
 */
function buildTerminalCaps(report, ctx = {}) {
  const t = themeOf(ctx);
  const rows = (Array.isArray(report) ? report : [])
    .filter((r) => Array.isArray(r) && r.length >= 2)
    .map(([k, v]) => [str(k), str(v)]);
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Terminal capabilities'), span(BOLD_OFF, '')]);
  if (!rows.length) {
    lines.push([span('', ' '), span(t.gray, 'No capability report available.')]);
    return lines;
  }
  for (const l of kv(t, rows, { keyStyle: t.white, valStyle: t.gray })) lines.push(l);
  lines.push([span('', '')]);
  if (ctx && ctx.pinned) {
    lines.push([span(t.coral, GLYPH.warn), span(t.gold, ' width is pinned — resizes are ignored until /terminal auto')]);
    lines.push([span('', '')]);
  }
  lines.push([span(t.gray, 'Override: /terminal ascii | unicode | color | no-color | star <native|narrow>')]);
  lines.push([span(t.gray, '          /terminal width <cols> | auto | status')]);
  lines.push([span(t.gray, 'At launch: --ascii --unicode --no-color --width <cols> --terminal')]);
  return lines;
}

function buildPRs(ghOutput, ctx = {}) {
  const t = themeOf(ctx);
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Open pull requests'), span(BOLD_OFF, '')]);
  const trimmed = str(ghOutput).trim();
  if (!trimmed) {
    lines.push([span('', ' '), span(t.gray, 'No open PRs in this repository.')]);
    return lines;
  }
  for (const l of trimmed.split('\n').slice(0, 10)) {
    lines.push([span('', ' '), span(t.white, l)]);
  }
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'Review with /review · comments via /pr-comments')]);
  return lines;
}

// ── /benchmark ───────────────────────────────────────────────────────────────

/** @param {Array} results [[label, ms], ...] */
function buildBenchmark(results, ctx = {}) {
  const t = themeOf(ctx);
  const list = Array.isArray(results) ? results : [];
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Benchmark'), span(BOLD_OFF, '')]);
  lines.push([span('', ' '), span(t.gray, 'In-app micro-benchmarks (this process, this machine):')]);
  lines.push([span('', ' ')]);
  for (const item of list) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const label = str(item[0]);
    lines.push([span('', ' '), span(t.white, label), span('', ' '.repeat(Math.max(1, 30 - [...label].length))), span(t.gray, `${num(item[1])} ms`)]);
  }
  if (!list.length) lines.push([span('', ' '), span(t.gray, '(no benchmarks run)')]);
  lines.push([span('', '')]);
  lines.push([span(t.dim, 'Spoiler: the terminal renders faster than you type.')]);
  return lines;
}

// ── /waifu ───────────────────────────────────────────────────────────────────

const WAIFU_ART = [
  '        ▄▄▄▄▄▄▄▄▄▄▄▄',
  '      ▄█▓▓▓▓▓▓▓▓▓▓▓▓█▄',
  '     █▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓█',
  '     █▓▓▓█▓▓▓▓▓▓▓█▓▓▓█',
  '     █▓▓█▓▓█▓▓▓█▓▓█▓▓█',
  '      █▓▓█▓█▓▓▓█▓█▓▓█',
  '       █▓▓▓█▓▓▓█▓▓▓█',
  '     ██▓▓▓▓▓▓▓▓▓▓▓▓▓██',
  '    █▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓█',
  '    █▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓█',
  '    █▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓█',
  '     ▀█▓▓▓▓▓▓▓▓▓▓▓▓▓█▀',
  '       ▀▀▀███████▀▀▀',
];

function buildWaifu(ctx = {}) {
  const t = themeOf(ctx);
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Waifu'), span(BOLD_OFF, '')]);
  for (const row of WAIFU_ART) lines.push([span(t.lavender, row)]);
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'A distinguished gentleman, rendered in block characters.')]);
  return lines;
}

// ── /aegis-* panels ──────────────────────────────────────────────────────────

/** @param {object} state {stats|memory, cloud, cloudNote, version, backend} */
function buildAegisStatus(state, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(state);
  const stats = statsFrom(s);
  const cloud = s.cloud && typeof s.cloud === 'object' ? s.cloud : null;
  const cloudNote = str(s.cloudNote);
  const version = str(s.version);
  const backend = str(s.backend || s.store);

  const lines = [];
  lines.push([span(t.gold + BOLD, 'ÆGIS Status'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  const total = stats ? num(stats.total) : 0;
  const sessions = stats ? num(stats.sessions) : 0;
  lines.push([span(t.white, `Memory: ${total.toLocaleString()} entries across ${sessions} sessions`)]);
  if (stats && stats.roles && (stats.roles.user != null || stats.roles.assistant != null)) {
    const roles = stats.roles;
    const parts = [];
    if (roles.user != null) parts.push(`${num(roles.user)} user`);
    if (roles.assistant != null) parts.push(`${num(roles.assistant)} assistant`);
    if (roles.other) parts.push(`${num(roles.other)} other`);
    if (parts.length) lines.push([span(t.gray, `  roles: ${parts.join(' · ')}`)]);
  }
  if (stats && stats.tiers) lines.push([span(t.gray, `  tiers: ${JSON.stringify(stats.tiers)}`)]);
  if (backend) lines.push([span(t.gray, `  store: ${backend}`)]);
  if (stats && stats.total != null) {
    const withEmb = num(stats.withEmbeddings);
    const pct = total ? Math.round((withEmb / total) * 100) : 0;
    if (stats.embeddingsEnabled === true) {
      const eng = (stats.embeddingModels && Object.keys(stats.embeddingModels)[0]) || 'embedding';
      lines.push([span(t.gray, `  embed: ${eng} · ${pct}% coverage`)]);
    } else if (stats.embeddingsEnabled === false && total) {
      lines.push([span(t.gray, '  embed: keyword-only')]);
    }
    if (stats.stale) lines.push([span(t.gray, `  stale: ${num(stats.stale)} entries >90d`)]);
  }
  if (cloud) {
    const key = cloud.key ? '✓ connected' : '✗ no API key';
    const sync = cloud.sync ? 'sync on' : 'sync off';
    lines.push([span(t.white, `Cloud:  ${key}, ${sync}`)]);
  } else if (cloudNote) {
    lines.push([span(t.gray, `Cloud:  ${cloudNote}`)]);
  } else {
    lines.push([span(t.gray, 'Cloud:  not checked (aegis /cloud status unavailable)')]);
  }
  if (version) lines.push([span(t.gray, `CLI:    aegis ${version}`)]);
  return lines;
}

/** @param {Array} results [{content,timestamp,source,tags}] */
function buildAegisRecall(results, ctx = {}) {
  const t = themeOf(ctx);
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  const lines = [];
  lines.push([span(t.gold + BOLD, 'ÆGIS Memory'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  if (!list.length) {
    lines.push([span(t.gray, 'No memory found for this topic.')]);
    lines.push([span(t.gray, 'Nothing relevant is stored yet — /aegis-remember <note> saves one.')]);
    return lines;
  }
  for (const r of list.slice(0, 10)) {
    const first = str(r.content).split('\n')[0].slice(0, 90);
    lines.push([span(t.white + BOLD, `• ${first}`), span(BOLD_OFF, '')]);
    const when = r.timestamp ? str(r.timestamp).slice(0, 10) : '';
    const src = r.source ? ` (${str(r.source)})` : '';
    const tags = Array.isArray(r.tags) && r.tags.length ? ' · tags: ' + r.tags.join(', ') : '';
    lines.push([span(t.gray, `  ${when}${src}${tags}`)]);
  }
  if (list.length > 10) lines.push([span(t.gray, `…and ${list.length - 10} more`)]);
  return lines;
}

/** @param {string} task */
function buildAegisMulti(task, ctx = {}) {
  const t = themeOf(ctx);
  const subject = str(task);
  const lines = [];
  lines.push([span(t.gold + BOLD, 'ÆGIS Multi — compose'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  lines.push([span(t.gray, 'Paste into your aegis-cli session (the confirmation prompt works there):')]);
  lines.push([span(t.white, `  /multi ${subject}`)]);
  lines.push([span(t.gray, '  /multiyolo ' + subject + '  — auto-approved variant')]);
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'Optional flags: --save-as <name> · --template <id>')]);
  lines.push([span(t.gray, 'Add "run" to execute headless here instead: /aegis-multi <task> run')]);
  return lines;
}

/** Shared renderer for --print slash results (/council, /ask, /multi run). */
function buildAegisPrint(title, opts = {}, ctx = {}) {
  const t = themeOf(ctx);
  const o = obj(opts);
  const lines = [];
  lines.push([span(t.gold + BOLD, str(title)), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  for (const l of str(o.result).split('\n')) lines.push([span(t.white, l)]);
  if (o.model || o.provider) {
    lines.push([span(t.gray, `  via ${str(o.provider) || 'aegis'}${o.model ? ' · ' + str(o.model) : ''}`)]);
  }
  return lines;
}

// ── /billing ─────────────────────────────────────────────────────────────────

/** @param {object} state {balance,plan,account,costEur} */
function buildBilling(state, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(state);
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Billing'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  const rows = [];
  if (s.balance != null) rows.push(['Balance', fmtEur(s.balance)]);
  if (s.plan != null) rows.push(['Plan', str(s.plan)]);
  if (s.account != null) rows.push(['Account', str(s.account)]);
  if (s.costEur != null) rows.push(['This session', fmtEur(s.costEur)]);
  if (rows.length) {
    for (const l of kv(t, rows, { indent: '  ', keyStyle: t.gray, valStyle: t.white })) lines.push(l);
  } else {
    lines.push([span('', ' '), span(t.gray, 'No billing data available.')]);
  }
  lines.push([span('', '')]);
  lines.push([span(t.white, 'AEGIS pooled inference'), span(t.gray, '  metered against your token bank')]);
  lines.push([span(t.gray, '  AEGIS has no subscription of its own — /cost shows this session\'s spend.')]);
  lines.push([span(t.gray, '  Top-ups and invoices: https://aegiscloud.org/billing')]);
  return lines;
}

// ── /tokens ──────────────────────────────────────────────────────────────────

/** @param {object} state {tokens, costEur} */
function buildTokens(state, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(state);
  const { cols } = getSize();
  const W = Math.max(24, cols - 2);
  const tok = s.tokens && typeof s.tokens === 'object' ? s.tokens : {};
  const input = num(tok.input);
  const output = num(tok.output);
  const cacheRead = num(tok.cacheRead);
  const cacheWrite = num(tok.cacheWrite);
  const total = num(tok.total) || input + output;
  const cost = num(s.costEur);
  const window = num(s.contextWindow) || 200000;
  const pct = window > 0 ? Math.min(100, Math.round((total / window) * 100)) : 0;

  const lines = [];
  lines.push([span(t.gold + BOLD, 'Token usage'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(Math.min(30, W)))]);
  const max = Math.max(input, output, cacheRead, cacheWrite, 1);
  const bar = (label, tokens) => {
    const frac = Math.min(1, tokens / max);
    const filled = Math.max(0, Math.round(frac * 24));
    return [
      span('', ' '), span(t.white, label),
      span('', ' '.repeat(Math.max(1, 11 - [...label].length))),
      span(t.green, '█'.repeat(filled)),
      span(t.dim, '█'.repeat(Math.max(0, 24 - filled))),
      span(t.gray, ` ${fmtTokens(tokens)}`),
    ];
  };
  lines.push(bar('input', input));
  lines.push(bar('output', output));
  lines.push(bar('cache read', cacheRead));
  lines.push(bar('cache write', cacheWrite));
  lines.push([span('', ' ')]);
  lines.push([
    span('', ' '), span(t.white, 'Total:'), span(t.gray, ` ${fmtTokens(total)}`),
    span('', ' '.repeat(8)), span(t.white, 'Est. cost:'), span(t.gray, ` ${fmtEur(cost)}`),
  ]);
  lines.push([span('', ' '), span(t.gray, `Context: ${pct}% of ${fmtTokens(window)} window`)]);
  lines.push([span('', ' '), span(t.gray, 'Tokens are counted from this session; cost is metered in euro.')]);
  return lines;
}

// ── /skills ──────────────────────────────────────────────────────────────────

/** @param {Array} skills [{source,name,namespace,description}] @param {Array} scannedDirs */
function buildSkills(skills, scannedDirs, ctx = {}) {
  const t = themeOf(ctx);
  const list = Array.isArray(skills) ? skills.filter(Boolean) : [];
  const dirs = Array.isArray(scannedDirs) ? scannedDirs : [];
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Skills'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  if (!list.length) {
    lines.push([span(t.gray, 'No skills found.')]);
    lines.push([span(t.gray, 'Skill dirs scanned:')]);
    for (const d of dirs) lines.push([span(t.dim, `  ${str(d)}`)]);
    lines.push([span('', '')]);
    lines.push([span(t.gray, 'Add one: mkdir -p .aegis/skills/<name> and drop a SKILL.md inside.')]);
    return lines;
  }
  let lastSource = null;
  for (const s of list) {
    if (s.source !== lastSource) {
      lines.push([span(t.gray + BOLD, s.source === 'user' ? 'User' : 'Project'), span(BOLD_OFF, '')]);
      lastSource = s.source;
    }
    const name = s.namespace ? `${str(s.namespace)}/${str(s.name)}` : str(s.name);
    const desc = str(s.description) || '(no description)';
    lines.push([span(t.white, `  ${name}`), span(t.gray, ' '.repeat(Math.max(1, 18 - [...name].length)) + desc)]);
  }
  lines.push([span('', '')]);
  lines.push([span(t.gray, '/skills <name> for details · /skills refresh to rescan')]);
  return lines;
}

/** /skills <name> — one skill's frontmatter + body excerpt. */
function buildSkillDetail(skill, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(skill);
  const name = s.namespace ? `${str(s.namespace)}/${str(s.name)}` : str(s.name);
  const lines = [];
  lines.push([span(t.gold + BOLD, `Skill: ${name}`), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  if (s.description) lines.push([span(t.gray, str(s.description))]);
  lines.push([span(t.dim, str(s.path))]);
  lines.push([span('', '')]);
  const body = str(s.content);
  const bodyLines = body.split('\n');
  const excerpt = bodyLines.slice(0, 8).join('\n');
  for (const l of excerpt.split('\n')) lines.push([span(t.white, l)]);
  if (bodyLines.length > 8) lines.push([span(t.gray, `… (${bodyLines.length} lines)`)]);
  return lines;
}

// ── /mcp ─────────────────────────────────────────────────────────────────────

/** @param {Array|object} servers @param {Array} fromPaths */
function buildMcp(servers, fromPaths, ctx = {}) {
  const t = themeOf(ctx);
  const entries = Array.isArray(servers)
    ? servers.map((srv, i) => [str(srv && srv.name) || String(i), srv])
    : servers && typeof servers === 'object'
      ? Object.entries(servers)
      : [];
  const paths = Array.isArray(fromPaths) ? fromPaths : [];
  const lines = [];
  lines.push([span(t.gold + BOLD, 'MCP servers'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  if (!entries.length) {
    lines.push([span(t.gray, 'No MCP servers configured.')]);
  } else {
    for (const [name, srv] of entries) {
      const cmd = typeof srv === 'string'
        ? srv
        : (str(srv && srv.command) + ' ' + (Array.isArray(srv && srv.args) ? srv.args.join(' ') : '')).trim();
      lines.push([span(t.white, `  ${str(name)}`), span(t.gray, ' '.repeat(Math.max(1, 14 - [...str(name)].length)) + cmd)]);
    }
  }
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'This build has no MCP runtime — servers are configuration only.')]);
  lines.push([span(t.gray, '/mcp add <name> <command> [args…] · /mcp remove <name>')]);
  if (paths.length) lines.push([span(t.dim, 'Sources: ' + paths.join(', '))]);
  return lines;
}

// ── /router ──────────────────────────────────────────────────────────────────

/** @param {object} state {autoRouter|router:{enabled,tiers}} */
function buildRouter(state, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(state);
  const router = s.autoRouter && typeof s.autoRouter === 'object'
    ? s.autoRouter
    : s.router && typeof s.router === 'object'
      ? s.router
      : { enabled: false, tiers: {} };
  const tiers = router.tiers && typeof router.tiers === 'object' ? router.tiers : {};
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Model router'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  lines.push([span(t.white, `auto-router: ${router.enabled ? 'on' : 'off'}`)]);
  lines.push([span(t.gray, `  simple   ${str(tiers.simple) || '(auto)'}`)]);
  lines.push([span(t.gray, `  medium   ${str(tiers.medium) || '(auto)'}`)]);
  lines.push([span(t.gray, `  complex  ${str(tiers.complex) || '(auto)'}`)]);
  lines.push([span('', '')]);
  lines.push([span(t.gray, '/router on|off · /router set <simple|medium|complex> <modelId>')]);
  lines.push([span(t.dim, 'Routing config is persisted for the real CLI; this build serves the model chosen by /model.')]);
  return lines;
}

// ── /billing (provider list) + /memory ───────────────────────────────────────

/** @param {object} state {memory|stats, embedStatus, compactState, compactCfg} */
function buildMemory(state, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(state);
  const stats = statsFrom(s);
  const embedStatus = s.embedStatus && typeof s.embedStatus === 'object' ? s.embedStatus : null;
  const compact = s.compactState && typeof s.compactState === 'object' ? s.compactState : (s.at ? s : null);
  const cfg = s.compactCfg && typeof s.compactCfg === 'object' ? s.compactCfg : null;

  const lines = [];
  lines.push([span(t.gold + BOLD, 'ÆGIS Memory'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  const total = stats ? num(stats.total) : 0;
  const sessions = stats ? num(stats.sessions) : 0;
  lines.push([span(t.white, `${total.toLocaleString()} memories across ${sessions} sessions`)]);
  if (stats && stats.roles && typeof stats.roles === 'object') {
    const parts = [];
    if (stats.roles.user != null) parts.push(`${num(stats.roles.user)} user`);
    if (stats.roles.assistant != null) parts.push(`${num(stats.roles.assistant)} assistant`);
    if (stats.roles.other) parts.push(`${num(stats.roles.other)} other`);
    if (parts.length) lines.push([span(t.gray, `  roles: ${parts.join(' · ')}`)]);
  }
  if (stats && stats.tiers) lines.push([span(t.gray, `  tiers: ${JSON.stringify(stats.tiers)}`)]);
  if (stats && stats.total != null) {
    const pct = total ? Math.round((num(stats.withEmbeddings) / total) * 100) : 0;
    if (embedStatus && embedStatus.engine) {
      lines.push([span(t.gray, `  embed: ${str(embedStatus.engine)} · ${pct}% coverage`)]);
    } else if (embedStatus) {
      lines.push([span(t.gray, '  embed: keyword-only')]);
    }
    if (stats.stale) lines.push([span(t.gray, `  stale: ${num(stats.stale)} entries >90d`)]);
  }
  if (compact) {
    lines.push([span(t.gray, compact.at ? `  last compact: ${str(compact.at).slice(0, 10)}` : '  auto-compact: never run')]);
  }
  if (cfg) {
    lines.push([span(t.gray, `  auto-compact: ${cfg.enabled ? 'on' : 'off'} (min ${num(cfg.minL1)} L1 · ${num(cfg.cooldownMin)}m cooldown)`)]);
  }
  lines.push([span('', '')]);
  lines.push([span(t.gray, '/memory tiers · /memory embeddings · /memory recall <q>')]);
  lines.push([span(t.gray, '/memory compact · /memory profile · /aegis-remember <note> to save')]);
  return lines;
}

/** @param {object} state {memory|stats, pending, compactState, compactCfg} */
function buildMemoryTiers(state, ctx = {}) {
  const t = themeOf(ctx);
  const s = obj(state);
  const stats = statsFrom(s);
  const pending = Array.isArray(s.pending) ? s.pending : [];
  const compact = s.compactState && typeof s.compactState === 'object' ? s.compactState : null;
  const cfg = s.compactCfg && typeof s.compactCfg === 'object' ? s.compactCfg : null;

  const lines = [];
  lines.push([span(t.gold + BOLD, 'Memory Tiers'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  if (stats && stats.tiers) {
    lines.push([span(t.white, `L0 turns    ${num(stats.tiers.L0)}   raw session turns, volatile`)]);
    lines.push([span(t.white, `L1 atomic   ${num(stats.tiers.L1)}   facts · decisions · breakthroughs`)]);
    lines.push([span(t.white, `L2 scenario ${num(stats.tiers.L2)}   distilled reusable context`)]);
    lines.push([span(t.white, `L3 profile  ${num(stats.tiers.L3)}   single distilled identity row`)]);
  }
  lines.push([span('', '')]);
  lines.push([span(t.gray, `pending L1 (auto-compact trigger): ${pending.length}`)]);
  if (compact && compact.at) {
    const sc = Array.isArray(compact.scenarios) ? compact.scenarios.length : 0;
    lines.push([span(t.gray, `last auto-compact: ${str(compact.at).slice(0, 16)} · ${sc} scenario${sc === 1 ? '' : 's'}`)]);
  } else {
    lines.push([span(t.gray, 'last auto-compact: never')]);
  }
  lines.push([span(t.gray, cfg
    ? `auto-compact: ${cfg.enabled ? 'on' : 'off'} · min ${num(cfg.minL1)} L1 · ${num(cfg.cooldownMin)}m cooldown`
    : 'auto-compact: on · min 5 L1 · 15m cooldown')]);
  lines.push([span('', '')]);
  lines.push([span(t.gray, '/memory compact runs maintenance manually')]);
  return lines;
}

/** /memory embeddings [status] — engine chain + vector coverage panel. */
function buildMemoryEmbeddings(status, stats, ctx = {}) {
  const t = themeOf(ctx);
  const st = status && typeof status === 'object' ? status : null;
  const s = stats && typeof stats === 'object' ? stats : null;
  const lines = [];
  lines.push([span(t.gold + BOLD, 'Memory Embeddings'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  if (st && st.engine) {
    lines.push([span(t.white, `engine: ${str(st.engine)} · ${str(st.model)}`)]);
    if (st.dim) lines.push([span(t.gray, `  dim: ${num(st.dim)}`)]);
  } else {
    lines.push([span(t.white, 'engine: keyword-only (no embedder resolved)')]);
    if (st && st.reason) lines.push([span(t.gray, `  reason: ${str(st.reason)}`)]);
  }
  lines.push([span(t.gray, `mode: ${st ? str(st.mode) || 'auto' : 'auto'} (env AEGIS_MEMORY_EMBED or memoryConfig.embedMode)`)]);
  if (s && s.total != null) {
    const total = num(s.total);
    const withEmb = num(s.withEmbeddings);
    const pct = total ? Math.round((withEmb / total) * 100) : 0;
    lines.push([span(t.gray, `coverage: ${withEmb}/${total} rows (${pct}%)`)]);
    if (s.embeddingModels && Object.keys(s.embeddingModels).length) {
      const parts = Object.entries(s.embeddingModels).map(([m, n]) => `${m}: ${num(n)}`);
      lines.push([span(t.gray, `  models: ${parts.join(' · ')}`)]);
    }
    if (s.stale) lines.push([span(t.gray, `  stale (>90d): ${num(s.stale)}`)]);
  }
  lines.push([span('', '')]);
  lines.push([span(t.gray, '/memory embeddings on|off toggles the engine chain')]);
  return lines;
}

// ── /yolo ────────────────────────────────────────────────────────────────────

function buildYolo(state, ctx = {}) {
  const t = themeOf(ctx);
  const lines = [];
  lines.push([span(t.gold + BOLD, '⚠ YOLO mode enabled'), span(BOLD_OFF, '')]);
  lines.push([span(t.gray, '─'.repeat(30))]);
  lines.push([span(t.white, 'All tool executions are auto-approved: file writes,')]);
  lines.push([span(t.white, 'bash commands, and network requests run without asking.')]);
  lines.push([span('', '')]);
  lines.push([span(t.gray, 'Run /yolo off to restore confirmations.')]);
  return lines;
}

// ── /release-notes ───────────────────────────────────────────────────────────

function buildReleaseNotes(state, ctx = {}) {
  const t = themeOf(ctx);
  const out = [];
  out.push([span(t.gold + BOLD, "What's new"), span(BOLD_OFF, '')]);
  out.push([span(t.gray, '─'.repeat(30))]);
  const bullets = [
    '• v0.1.0 — aegiscode CLI: the aegiscode design system on the AEGIS pooled brain.',
    '•   /help /status /cost /tokens /context /models /model /theme /stream (local).',
    '•   /aegis-ask /aegis-status /aegis-recall /aegis-remember /memory /billing (tool-backed).',
    '•   /byok /byok-set /byok-rm — bring your own provider keys (never echoed).',
    '•   /tool <name> [json] — call any registry tool directly.',
    '• Cost and tokens are metered in euro (€4dp below a cent).',
    '• Config persists to ~/.aegiscode/config.json (theme/model/stream).',
    '• Unavailable here: /login /doctor /permissions /mcp /skills /hooks /agents',
    '•   /resume /rewind /compact /init /export /vim /yolo /confirm — each says why.',
    '• Repo: github.com/aegisinfo/aegiscode-plugin',
  ];
  for (const text of bullets) out.push([span(t.green, '•'), span(t.white, ' ' + text.slice(1))]);
  out.push([span('', '')]);
  out.push([span(t.gray, '/release-notes for more')]);
  return out;
}

// ── honest stubs (capability absent in this client) ──────────────────────────

/** Two-line honest panel: a heading and the reason it is absent. */
function stubPanel(ctx, name, reason) {
  const t = themeOf(ctx);
  return [
    [span(t.gold + BOLD, name), span(BOLD_OFF, '')],
    [span(t.gray, ` ${name} is not available in aegiscode — ${reason}`)],
  ];
}

function buildDoctor(state, ctx = {}) {
  return stubPanel(ctx, 'Doctor', 'it needs the local environment diagnostic suite.');
}

function buildBuildPanel(args, ctx = {}) {
  const o = obj(args);
  const t = themeOf(ctx);
  return [
    [span(t.gold + BOLD, `⬡ Build: ${str(o.plan && o.plan.appName) || 'build'}`), span(BOLD_OFF, '')],
    [span(t.gray, ' Build is not available in aegiscode — it needs a local multi-model agent build loop.')],
  ];
}

module.exports = {
  buildHelp,
  buildStatus,
  buildCost,
  buildContext,
  buildTokens,
  buildAgents,
  buildPermissions,
  buildModelList,
  buildRewindList,
  buildOnboarding,
  buildShellCompletion,
  buildTerminalSetup,
  buildTerminalCaps,
  buildPRs,
  buildBenchmark,
  buildWaifu,
  buildAegisStatus,
  buildAegisRecall,
  buildAegisMulti,
  buildBilling,
  buildMemory,
  buildMemoryTiers,
  buildRouter,
  buildYolo,
  buildSkills,
  buildMcp,
  buildHooksStatus,
  buildHooksList,
  buildTroubleshooting,
  buildReleaseNotes,
  renderSessionsOverlay,
  // pure reference helpers with no missing capability
  buildAegisPrint,
  buildSkillDetail,
  buildMemoryEmbeddings,
  // honest stubs
  buildDoctor,
  buildBuildPanel,
  // local formatting helpers (exported for the panel tests)
  fmtEur,
  fmtTokens,
};
