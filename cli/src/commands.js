'use strict';

/**
 * Slash commands — the CLI's full command vocabulary, ported from the sibling
 * `aegiscodex-dev` client (`src/registry.js`), on top of the AEGIS tool registry
 * (`mcp/tools.js`).
 *
 * Three kinds of entry live in one table:
 *
 *   (a) handler      — a local `async (c, args) => bool` that runs against the
 *       frozen command context `c` (see `cli/src/app.js`). It returns false to
 *       end the session. This is the reference's own contract, so a handler
 *       body reads the same here as it does in aegiscodex-dev — only the panels
 *       and support modules it calls are this client's.
 *   (b) tool-backed  — names a tool from `mcp/tools.js` and carries a
 *       `build(arg) -> object` that turns the typed argument into the tool's
 *       JSON. `test/cli-tools.test.mjs` asserts both directions: no command
 *       points at a tool that does not exist, and no tool in the registry is
 *       unreachable from the prompt (the `/tool` escape hatch keeps the latter
 *       true for tools with no dedicated command).
 *   (c) unavailable  — a command whose whole premise is the Claude Code CLI's
 *       own auth loop (`login`, `logout`). These carry an honest `unavailable`
 *       reason and a working `alt`; `parseLine` returns `{ kind: 'unavailable' }`
 *       and `app.js` prints the reason rather than a fake success.
 *
 * The names, aliases, categories and descriptions come from aegiscodex-dev's
 * `COMMANDS`/`CATEGORIES`. Where this client's capability genuinely differs from
 * the reference's the handler says so honestly (a note, an honest panel, or a
 * real command run through the ported support modules) rather than copying a
 * sentence that would be untrue.
 *
 * Every command is defined against the FROZEN command context `c`:
 *   c.ctx (mutable session context), c.sessionId, c.transcript,
 *   c.push/note/panel, c.render, c.openOverlay, c.closeOverlay, c.askInput,
 *   c.withWorking, c.runPrompt, c.ask, c.runTool, c.refreshSpend, c.state,
 *   c.setInput, c.exit, c.client, c.TOOLS, c.saveConfig, c.showThemePicker.
 *
 * Plain text (no leading `/`) is a prompt: it goes to the pooled brain.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { span } = require('./screen.js');
const { C, BOLD, BOLD_OFF } = require('./theme.js');
// `caps.js` is dependency-free (it requires nothing), so this cannot cycle the
// way a `theme.js` → `art.js` → `theme.js` require would.
const { caps, setCaps, resetCaps, describe } = require('./caps.js');
const panels = require('./panels.js');
const overlays = require('./overlays.js');
const {
  updateConfig, loadConfig, loadPermissions, savePermissions, addPermissionRule,
  DEFAULT_PERMISSIONS, permissionsPath, configPath,
  memoryPersistState, setMemoryPersist,
} = require('./config.js');
const { copyToClipboard } = require('./clipboard.js');
const { snapshotCheckpoint, listCheckpoints, loadCheckpoint } = require('./checkpoint.js');
const screens = require('./screens.js');
const { summarizeTranscript, recapLine } = require('./summarize.js');
const { sessionAccounting, accountingFromUsage, estimateTokens } = require('./tokens.js');
const { transcriptToMarkdown, transcriptToJSON, writeExportFile, lastAssistantText } = require('./export.js');
const { detectDevCommand, runDevServer } = require('./devrun.js');
const credentials = require('./credentials.js');
const cloudsync = require('./cloudsync.js');
const { maskKey, fmtTokens } = require('./format.js');
const { openUrl, URLS } = require('./system.js');
const { sniffProject, buildAegisMd } = require('./init.js');
const {
  AGENT_PRESETS, agentRoles, composeAgentPrompt, composeResearchPrompt, composeDebatePrompt,
} = require('./agents.js');
const {
  aggregateSessionUsage, pruneSessionHistory, readResumeList,
} = require('./history.js');

// Guarded: a concurrent workstream owns ./markdown.js.
let markdownModule = null;
try {
  // eslint-disable-next-line global-require
  markdownModule = require('./markdown.js');
} catch {
  markdownModule = null;
}

const VERSION = require('../package.json').version;

// ── Categories ────────────────────────────────────────────────────────────────

const CATEGORIES = [
  { id: 'session', label: 'Session & context' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'model', label: 'Model & behavior' },
  { id: 'data', label: 'Data' },
  { id: 'auth', label: 'Auth' },
  { id: 'support', label: 'Support' },
  { id: 'fun', label: 'Fun' },
  { id: 'aegis', label: 'Aegis plugin' },
  { id: 'custom', label: 'Custom' },
];

const categoryLabel = (id) => (CATEGORIES.find((cat) => cat.id === id) || {}).label || id;

// One table, shared with the picker that draws it. The two used to be separate
// lists — this one a string array, chatflow.js's own copy of the same three
// strings, and overlays.js's label/note rows — so adding a level meant editing
// three places, and the index a picker row reported was mapped back to a value
// through whichever list happened to be in scope. EFFORT_VALUES is the picker's
// own order, `null` first for "auto".
const EFFORT_LEVELS = overlays.EFFORT_VALUES;

// ── Small handler helpers ─────────────────────────────────────────────────────

const note = (c, text) => c.push({ role: 'note', text });
const panel = (c, lines) => c.push({ role: 'panel', lines });
const tip = (c, text) => c.push({ role: 'tip', text });
const done = (c, text) => c.push({ role: 'done', text });
const shortCwd = () => process.cwd().split('/').filter(Boolean).pop() || '~';

/**
 * Refresh the pinnable-model list on the session context before reading it.
 * `c.loadModels()` (owned by the app/chatflow) fetches from the server and
 * records the result on `c.state().models`; it is best-effort — offline it
 * rejects, and the caller falls through to the honest empty note rather than
 * opening an empty picker.
 */
async function loadModels(c) {
  try {
    await c.loadModels();
  } catch {}
}

/**
 * The ÆGIS LLM routes are gated on the pooled brain being reachable — exactly
 * as the reference hides its ÆGIS routes when the backend is absent. `hidden`
 * is a function so visibility follows the environment at call time.
 *
 * It reads the *resolved* credential, not the environment: a key saved by
 * `aegiscode login` lives in credentials.json, and checking only
 * `process.env.AEGIS_API_KEY` here hid every AEGIS route from a user who had
 * just successfully set one.
 */
const cloudReady = () => credentials.hasApiKey();

// ── BYOK provider catalog ────────────────────────────────────────────────────

/**
 * The server's BYOK provider catalog, or null when it cannot be reached.
 *
 * The catalog is the *server's* answer to "which keys do you accept, for which
 * models, and where do I get one". It is deliberately not key-gated, so this
 * works before an account key exists — which is the whole point, since it is
 * the screen that tells a user which key to go buy. Returning null rather than
 * throwing keeps every caller free to fall back to the prose description it
 * used before the catalog existed.
 */
async function byokCatalog(client) {
  if (!client || typeof client.byokProviders !== 'function') return null;
  try {
    const data = await client.byokProviders();
    const providers = (data && data.providers) || [];
    return providers.length ? providers : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a typed provider id against the catalog.
 *
 * Exact id first, then a unique case-insensitive match on id, label or alias, so
 * `/byok-set OpenAI` and `/byok-set together-ai` both land. A non-unique match
 * returns `{ ambiguous }` rather than silently picking one: storing a key
 * against the wrong provider is the failure this whole path exists to prevent,
 * and it is not visible until a call 401s upstream.
 */
function findByokProvider(providers, typed) {
  const want = String(typed || '').trim().toLowerCase();
  if (!providers) return { provider: null, exact: false };
  const exact = providers.find((p) => p.id === want);
  if (exact) return { provider: exact, exact: true };
  const loose = providers.filter((p) => {
    const names = [p.id, p.label, ...(p.aliases || [])].filter(Boolean);
    return names.some((n) => String(n).toLowerCase() === want);
  });
  if (loose.length === 1) return { provider: loose[0], exact: false };
  if (loose.length > 1) return { ambiguous: loose.map((p) => p.id) };
  return { provider: null, exact: false };
}

/** One catalog row: id, whether it is already set, its models, and key guidance.
 *
 * Every line is an array of span objects, never a plain string — panel/paint
 * (`screen.js` `padLine`/`paint`) iterate a line as spans and read `.t`/`.w`
 * off each entry. A plain string here gets walked character-by-character
 * instead, each "span" comes out `{t: undefined, w: undefined}`, and paint's
 * `sp.s + sp.t` prints the literal text "NaN" once per character.
 */
function byokProviderLines(providers) {
  const lines = [];
  for (const p of providers) {
    const state = p.configured
      ? span(C.green, `set${p.masked ? ` (${p.masked})` : ''}`)
      : span(C.gray, 'not set');
    const row = [span(C.gold + BOLD, `  ${p.id}`)];
    if (p.label) row.push(span(C.gray, ` — ${p.label}`));
    row.push(span('', '  '), state);
    lines.push(row);
    // `models` arrives as bare ids. The catalog used to be read here as if each
    // one were an object with `.id`, which silently rendered nothing — a
    // provider listed with an empty model line reads as "no models", not as a
    // bug, so tolerate both shapes rather than repeat the mistake.
    const models = (p.models || [])
      .map((m) => (typeof m === 'string' ? m : m && m.id))
      .filter(Boolean);
    if (models.length) lines.push([span(C.gray, `      models: ${models.join(', ')}`)]);
    if (p.key_prefix) lines.push([span(C.gray, `      key starts with ${p.key_prefix}`)]);
    if (p.key_url) lines.push([span(C.gray, `      ${p.key_url}`)]);
  }
  return lines;
}

// ── account key + cloud sync handlers ────────────────────────────────────────

/** The account-key panel body, shared by /key, /login and /cloud. */
function keyPanelLines(c, title = 'AEGIS account key') {
  const st = c.keyStatus();
  const lines = [
    [span(C.gold + BOLD, title), span(BOLD_OFF, '')],
    [span(C.gray, '─'.repeat(34))],
    [
      span(st.configured ? C.green : C.coral, `  ${st.configured ? '✔' : '⚠'}`),
      span(C.white, '  key: '),
      span(st.configured ? C.white : C.gray, st.configured ? maskKey(st.key) : 'not set'),
      span(C.gray, `  (${credentials.sourceLabel(st.source)})`),
    ],
    [span(C.gray, `  stored in: ${st.path}${st.fileMode ? `  ${st.fileMode}` : ''}`)],
  ];
  if (st.verifiedAt) lines.push([span(C.gray, `  verified:  ${st.verifiedAt}`)]);
  if (st.account && (st.account.plan || st.account.email)) {
    lines.push([
      span(C.gray, '  account:   '),
      span(C.white, [st.account.plan, st.account.email].filter(Boolean).join(' · ')),
    ]);
  }
  lines.push([
    span(C.gray, '  memory:    '),
    span(st.memoryToken ? C.green : C.gray, st.memoryToken ? 'token held (cloud sync ready)' : 'no token yet'),
  ]);
  if (!st.configured) {
    lines.push([span(C.gray, '')]);
    lines.push([span(C.white, '  Set one with /key <api_key>, or press Enter on /key to paste it.')]);
    lines.push([span(C.gray, '  Free keys: https://aegiscloud.org')]);
  }
  if (st.legacyPlaintext) {
    lines.push([span(C.gray, '')]);
    lines.push([
      span(C.coral, '  ⚠ a plaintext copy of the key is still in config.json (another AEGIS CLI wrote it).'),
    ]);
    lines.push([span(C.gray, '    Re-save with /key <api_key> and delete that block when convenient.')]);
  }
  return lines;
}

/**
 * Take a key from the argument or an echo-off prompt, save it, and report what
 * the account said. Shared by `/key`, `/login` and `/cloud key` so all three
 * behave identically — the whole point is that there is one way to set a key.
 */
async function applyAccountKey(c, raw, { label = 'AEGIS API key' } = {}) {
  let key = String(raw || '').trim();
  if (!key) {
    key = await c.readSecret(`${label} (kept off screen, Enter to cancel): `);
  }
  if (!key) {
    note(c, 'no key given — /key <api_key> takes it inline, or press Enter on a bare /key to paste it');
    return { ok: false };
  }
  const res = await c.setApiKey(key);
  if (!res.ok) {
    note(c, res.message || 'that key could not be saved');
    return res;
  }
  if (res.error) {
    note(c, `saved, but the account check failed: ${res.error.message}`);
    note(c, 'the key is stored — /key status shows it; re-run /key <api_key> if it was mistyped');
    return res;
  }
  const acct = (res.account && (res.account.email || res.account.plan)) || null;
  done(c, `AEGIS key saved to ${res.path}${acct ? ` — signed in as ${acct}` : ' and verified'}`);
  // The catalog is key-gated, so a freshly authenticated session should offer
  // /model's picker without the user having to know to re-run it.
  try {
    await c.loadModels({ force: true });
    const n = (c.state().models || []).length;
    if (n) note(c, `${n} pinnable model${n === 1 ? '' : 's'} available — /model to pin one`);
  } catch {}
  return res;
}

/** Human token count for the sync quota: 1000000 -> "1M", 42800 -> "43k".
 *  The ceiling is denominated in tokens (aegis1 FREE_SYNC_TOKENS = 1 MB,
 *  PRO_SYNC_TOKENS = 10 MB), which for stored prose is about one per
 *  character — "1000000" at a glance tells a user nothing about how close they
 *  are to it. */
function fmtQuotaTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '?';
  if (v >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  return fmtTokens(v);
}

/**
 * The persisting-memory gate, read off the command context (the live app
 * exposes `cloudSyncState()`) with a fallback for callers that only pass the
 * older boolean probe — `/cloud` and `/sync` predate the rename, and a stub
 * context in a test must not have to grow a method to render a panel.
 */
function memoryGate(c) {
  if (c && typeof c.cloudSyncState === 'function') {
    try {
      return c.cloudSyncState();
    } catch {
      /* fall through to the boolean */
    }
  }
  const enabled =
    c && typeof c.cloudSyncEnabled === 'function' ? c.cloudSyncEnabled() === true : true;
  return { enabled, source: 'default' };
}

/**
 * Flip the gate through the command context (app.js's `setCloudSync` is
 * `config.setMemoryPersist`), which is what keeps the setting and the running
 * session agreeing. Guarded because a context stub that never flips anything
 * still has to be able to *run* the handler — the command smoke test drives
 * every handler with no arguments.
 */
function setMemoryGate(c, on) {
  if (c && typeof c.setCloudSync === 'function') return c.setCloudSync(on);
  try {
    return setMemoryPersist(on);
  } catch {
    return null;
  }
}

/**
 * The persisting-memory block every cloud surface shows: the switch, the
 * ceiling, and — the part that was missing — what a stopped write does and
 * does not cost.
 *
 * The honesty requirement is not cosmetic. aegis1 meters WRITES only
 * (`_memory_sync_access`), so a free account that passes ~1 MB of transcript
 * keeps every entry it stored and simply stops accumulating new ones. The old
 * rollout printed nothing at all, so "memory is free with any account" and
 * "nothing is being stored any more" were both true and indistinguishable.
 * These lines make the ceiling a state the user can see: the number, whose
 * limit it is, and the one sentence that separates the working half (reads)
 * from the stopped half (new writes).
 */
function memoryStatusLines(c) {
  const gate = memoryGate(c);
  const st = cloudsync.status();
  const q = st.quota;
  const used = q && q.used != null ? fmtQuotaTokens(q.used) : null;
  const limit = q && q.limit != null ? fmtQuotaTokens(q.limit) : null;
  const how =
    gate.source === 'legacy'
      ? '  (kept from your old cloudSync setting)'
      : gate.source === 'default'
        ? '  (default)'
        : '';
  const rows = [
    // Both names, one gate. The commit that flipped the default renamed the
    // panel to say what is being stored, but `/sync`, `/cloud sync` and the
    // docs all still call it cloud sync — a panel that only answers to its new
    // name makes the setting unfindable to anyone who learned the old one.
    [span(C.white + BOLD, 'Persisting memory'), span(C.gray, ' · Cloud sync'), span(BOLD_OFF, '')],
    [span(C.gray, '─'.repeat(34))],
    [
      span(C.white, `  ${gate.enabled ? 'on' : 'off'}`),
      span(C.gray, `${how}  ·  ${gate.enabled ? 'each session is stored so an interrupted turn can be resumed' : 'nothing new is stored'}`),
    ],
  ];
  if (limit) {
    rows.push([
      span(C.gray, '  quota:  '),
      span(C.white, `${used} of ${limit} tokens synced`),
      span(C.gray, '  (aegis1 charges writes; reads are always served)'),
    ]);
  } else {
    rows.push([span(C.gray, '  quota:  not reported yet — /sync now asks the server for the current numbers')]);
  }
  if (st.overQuota) {
    rows.push([span(C.coral, '  writes: paused — the plan’s ceiling is reached, so new memory is not being stored')]);
    rows.push([span(C.green, '  reads:  still work — everything already stored stays readable (/aegis-recall <topic>)')]);
    rows.push([span(C.gray, '          free room at https://aegiscloud.org/subscribe, or /cloud memory off to stop trying')]);
  }
  if (gate.enabled && st.pending > 0) {
    rows.push([span(C.gray, `  pending: ${st.pending} session(s) waiting to sync`)]);
  }
  rows.push([span(C.gray, `  /cloud memory on | off   ·   /sync now pushes once by hand`)]);
  return rows;
}

/** Push + pull once, and report the counts (or the quota refusal). */
async function runCloudSync(c, o = {}) {
  if (!c.client.apiKey) {
    note(c, `no key — ${credentials.HOW_TO_SET}`);
    return null;
  }
  const res = await c.withWorking(() => cloudsync.syncNow(c.client, o));
  const pushed = (res.push && res.push.pushed) || [];
  const failed = [...((res.push && res.push.failed) || []), ...((res.pull && res.pull.failed) || [])];
  const pulled = (res.pull && res.pull.imported) || 0;
  if (pushed.length) {
    done(c, `pushed ${pushed.length} session${pushed.length === 1 ? '' : 's'} (${pushed[0].messages} messages in the first)`);
  } else if (res.push && res.push.skipped && res.push.skipped.length) {
    note(c, `${res.push.skipped.length} session(s) had nothing to send`);
  } else {
    note(c, 'nothing to push — every local session is already in the cloud');
  }
  if (pulled) done(c, `pulled ${pulled} record${pulled === 1 ? '' : 's'} into the local store — /resume lists them`);
  else if (res.pull && res.pull.ok) note(c, `cloud has ${res.pull.remote || 0} session(s); nothing newer locally`);
  for (const f of failed) {
    note(c, `${f.kind === 'quota' ? 'quota' : 'failed'}: ${f.message}`);
    if (f.hint) note(c, f.hint);
  }
  return res;
}

/** Read + merge hook config from the standard settings files. */
function readHooks() {
  const sources = [
    path.join(os.homedir(), '.aegis', 'settings.json'),
    path.join(process.cwd(), '.aegis', 'settings.json'),
    path.join(os.homedir(), '.aegiscode', 'settings.json'),
    path.join(process.cwd(), '.aegiscode', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  const hooks = {};
  const from = [];
  for (const p of sources) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && j.hooks && typeof j.hooks === 'object') {
        from.push(p.replace(os.homedir(), '~'));
        for (const [ev, arr] of Object.entries(j.hooks)) {
          hooks[ev] = [...(hooks[ev] || []), ...(Array.isArray(arr) ? arr : [])];
        }
      }
    } catch {}
  }
  return { hooks, from };
}

/** {enabled,hooks,events,byEvent} from a merged hooks map. */
function hookStats(hooks) {
  const events = Object.keys(hooks);
  let count = 0;
  const byEvent = {};
  for (const [ev, arr] of Object.entries(hooks)) {
    const n = Array.isArray(arr) ? arr.length : 0;
    byEvent[ev] = n;
    count += n;
  }
  return { enabled: count > 0, hooks: count, events, byEvent };
}

/** Scan the standard skill dirs for SKILL.md files. */
function scanSkills() {
  const dirs = [
    path.join(os.homedir(), '.aegis', 'skills'),
    path.join(process.cwd(), '.aegis', 'skills'),
    path.join(os.homedir(), '.aegiscode', 'skills'),
    path.join(process.cwd(), '.aegiscode', 'skills'),
    path.join(os.homedir(), '.claude', 'skills'),
  ];
  const found = [];
  for (const dir of dirs) {
    const source = dir.startsWith(process.cwd()) ? 'project' : 'user';
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { continue; }
    for (const name of names) {
      const skillPath = path.join(dir, name, 'SKILL.md');
      try {
        const raw = fs.readFileSync(skillPath, 'utf8');
        const desc = (/^description:\s*(.+)$/m.exec(raw) || [])[1] || '';
        found.push({ source, name, namespace: null, description: desc.trim(), path: skillPath, content: raw });
      } catch {}
    }
  }
  return found;
}

// ── Command definitions ───────────────────────────────────────────────────────
// Order here is the palette order.

const COMMANDS = [
  // ── session & context ───────────────────────────────────────────────────────
  {
    name: 'run', hint: '', category: 'workspace',
    desc: "Launch and drive this project's app to see a change working",
    handler: async (c) => {
      const cmd = detectDevCommand(process.cwd());
      if (!cmd) {
        note(c, 'No dev command detected (no package.json scripts, go.mod, Cargo.toml or Makefile). Try /init first.');
        c.render();
        return true;
      }
      note(c, `Running ${cmd} in ${shortCwd()} — output streams below, Esc stops it.`);
      const job = runDevServer(cmd, {
        cwd: process.cwd(),
        onLine: (line) => c.push({ role: 'note', text: `  ${line}` }),
      });
      // Bind the job to the session so the status line draws "esc to stop" and
      // Esc actually stops it (the reference's openStream/closeStream contract).
      if (!job.label) job.label = cmd;
      c.openStream(job);
      job.done.then(({ code, stopped }) => {
        c.closeStream(job);
        done(c, stopped ? `${cmd} stopped` : `${cmd} exited (code ${code})`);
        c.render();
      });
      c.render();
      return true;
    },
  },
  {
    name: 'schedule', hint: '', category: 'session',
    desc: 'Create, update, list, or run scheduled cloud agents (routines)',
    handler: async (c) => {
      note(c, 'Scheduled routines run on the AEGIS cloud. Sign in with `aegis login`, then manage routines at aegiscloud.org.');
      c.render();
      return true;
    },
  },
  {
    name: 'build', aliases: ['forge'], args: ['task'], hint: '<description>', category: 'workspace',
    desc: 'Build an app with the agent loop — /build <what to build>',
    handler: async (c, args) => {
      const task = (args._rest || args.task || '').trim();
      if (!task) {
        note(c, 'Usage: /build <what to build>');
        note(c, 'Example: /build a REST API for a todo app');
        c.render();
        return true;
      }
      note(c, '⬡ AEGIS BUILD');
      note(c, `Task: ${task}`);
      c.render();
      await c.runPrompt(`Build the following, creating every file it needs and running the build to verify it works: ${task}`);
      return true;
    },
  },
  {
    name: 'cd', args: ['path'], hint: '<path>', category: 'workspace',
    desc: 'Move this session to a new working directory',
    handler: async (c, args) => {
      const dir = args.path || (args._rest || '').trim();
      if (!dir) { note(c, 'Usage: /cd <path>'); c.render(); return true; }
      try {
        process.chdir(dir);
        c.ctx.cwd = process.cwd();
        updateConfig({ lastCwd: process.cwd() });
        note(c, `Changed directory to ${process.cwd()}`);
      } catch (e) {
        note(c, `/cd: ${e.message}`);
      }
      c.render();
      return true;
    },
  },
  {
    name: 'copy', aliases: ['cp'], args: ['n'], hint: '[N]', category: 'data',
    desc: "Copy the last response to the clipboard",
    handler: async (c, args) => {
      const n = parseInt(args.n || '1', 10) || 1;
      const text = lastAssistantText(c.transcript, n);
      if (!text) { note(c, 'Nothing to copy yet.'); c.render(); return true; }
      const r = copyToClipboard(text);
      if (r.ok) {
        note(c, r.via.startsWith('tool:')
          ? `Copied the last response to the clipboard (${r.via.split(':')[1]}).`
          : `No clipboard tool found — response saved to ${r.path}`);
      } else {
        note(c, 'Clipboard unavailable; nothing copied.');
      }
      c.render();
      return true;
    },
  },
  {
    name: 'clear', aliases: ['cls'], hint: '', category: 'session',
    desc: 'Start a new session with empty context',
    handler: async (c) => {
      c.transcript.length = 0;
      // Prune the session's history rows so /cost resets with /clear.
      pruneSessionHistory(c.sessionId);
      note(c, 'Session cleared — transcript empty.');
      c.render();
      return true;
    },
  },
  {
    name: 'compact', hint: '', category: 'session',
    desc: 'Compact the conversation history',
    handler: async (c) => {
      const has = c.transcript.some((m) => m.role === 'user' || m.role === 'assistant');
      if (!has) { note(c, 'Nothing to compact yet.'); c.render(); return true; }
      note(c, 'Compacting conversation history…');
      c.render();
      const summary = await c.withWorking((signal) =>
        summarizeTranscript(c.transcript, {
          callModel: (p, opts) => c.ask(p, opts).then((r) => r.text),
          model: c.ctx.model,
          signal,
        }));
      if (summary === null) { note(c, 'Compaction cancelled.'); c.render(); return true; }
      c.transcript.length = 0;
      note(c, 'Compacted. Earlier context summarized into the message below.');
      c.transcript.push({ role: 'user', text: summary });
      c.render();
      return true;
    },
  },
  {
    name: 'cost', hint: '', category: 'data',
    desc: 'Show the cost of the current session',
    handler: async (c) => {
      const agg = aggregateSessionUsage(c.sessionId);
      const acct = agg.entries
        ? accountingFromUsage(agg.usage, c.ctx.model, {
            exchanges: agg.entries,
            real: agg.real,
            costUsd: agg.real && agg.costUsd ? agg.costUsd : undefined,
          })
        : sessionAccounting(c.transcript, c.ctx.model);
      panel(c, panels.buildCost({ ...c.state(), contextWindow: acct.contextWindow, costEur: acct.cost }, c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'context', hint: '', category: 'session',
    desc: 'Show context usage for the current session',
    handler: async (c) => {
      const acct = sessionAccounting(c.transcript, c.ctx.model);
      panel(c, panels.buildContext({ ...c.state(), contextWindow: acct.contextWindow }, c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'effort', args: ['level'], hint: '[auto|low|medium|high]', category: 'model',
    desc: 'Set the token budget the pool sizes each turn from',
    handler: async (c, args) => {
      const level = (args.level || '').toLowerCase();
      if (level && level !== 'auto' && !EFFORT_LEVELS.includes(level)) {
        note(c, `Unknown effort level "${args.level}". Use auto, ${EFFORT_LEVELS.filter(Boolean).join(', ')}.`);
        c.render();
        return true;
      }
      if (!level) {
        c.openOverlay({ type: 'effort', sel: Math.max(0, EFFORT_LEVELS.indexOf(c.ctx.effort)) });
        return true;
      }
      // 'auto' is the absence of a pin, not a fourth rung: it is stored as null
      // so nothing is sent and the server sizes the turn from the ask.
      const pinned = level === 'auto' ? null : level;
      c.ctx.effort = pinned;
      c.saveConfig({ effort: pinned });
      note(c, pinned
        ? `Effort level: ${pinned} — the pool sizes this turn's token budget from it`
        : 'Effort level: auto — the pool sizes each turn from the ask');
      c.render();
      return true;
    },
  },
  {
    name: 'exit', aliases: ['quit'], hint: '', category: 'session',
    desc: 'Exit the CLI',
    handler: async () => false,
  },
  {
    name: 'export', args: ['format', 'target'], hint: '[markdown|json] [file|clipboard]', category: 'data',
    desc: 'Export the current conversation to a file or clipboard',
    handler: async (c, args) => {
      const fmt = (args.format || 'markdown').toLowerCase();
      const target = (args.target || 'file').toLowerCase();
      if (!['markdown', 'md', 'json'].includes(fmt) || !['file', 'clipboard'].includes(target)) {
        note(c, 'Usage: /export [markdown|json] [file|clipboard]');
        c.render();
        return true;
      }
      const isJson = fmt === 'json';
      const body = isJson ? transcriptToJSON(c.transcript) : transcriptToMarkdown(c.transcript);
      if (target === 'clipboard') {
        const r = copyToClipboard(body);
        note(c, r.ok
          ? `Exported conversation (${isJson ? 'json' : 'markdown'}) to the clipboard.`
          : 'Clipboard unavailable; nothing copied.');
      } else {
        try {
          // Honour the command context's cwd. The handler used to fall through
          // to writeExportFile's own `process.cwd()` default, so /export wrote
          // into whatever directory the process happened to be in — which meant
          // running the command smoke test (it invokes every handler) littered
          // the repository root with aegiscodex-export-*.md files.
          const p = writeExportFile(body, isJson ? 'json' : 'md', c.ctx.cwd || process.cwd());
          note(c, `Exported conversation to ${p}`);
        } catch (e) {
          note(c, `/export: ${e.message}`);
        }
      }
      c.render();
      return true;
    },
  },
  {
    name: 'help', aliases: ['?', 'h'], hint: '', category: 'support',
    desc: 'Show help',
    handler: async (c) => {
      panel(c, panels.buildHelp(visibleCommands(), c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'init', args: ['file'], hint: '[file]', category: 'workspace',
    desc: 'Create an AEGIS.md file in the project',
    handler: async (c, args) => {
      const file = (args.file || 'AEGIS.md').trim();
      // The command context's cwd, not process.cwd(): /cd moves the session to
      // another directory, and a handler that reads process.cwd() then writes
      // the file into the directory the user just left. It also means the
      // command smoke test (which invokes every handler) no longer drops an
      // AEGIS.md into the repository root.
      const cwd = c.ctx.cwd || process.cwd();
      const p = path.resolve(cwd, file);
      // Refuse a path that resolves outside the project — the reference's /init
      // takes no argument, and `path.join(cwd, '../../x')` writes outside it.
      const root = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
      if (p !== cwd && !p.startsWith(root)) {
        note(c, `/init: refusing to write outside the project directory (${p}).`);
        c.render();
        return true;
      }
      if (fs.existsSync(p)) { note(c, `${file} already exists — not overwriting.`); c.render(); return true; }
      const sniff = sniffProject(cwd);
      try {
        fs.writeFileSync(p, buildAegisMd(sniff) + '\n');
      } catch (e) {
        note(c, `/init: ${e.message}`);
        c.render();
        return true;
      }
      note(c, `Created ${p} (${sniff.lang})`);
      if (fs.existsSync(path.join(cwd, 'node_modules')) && !fs.existsSync(path.join(cwd, '.gitignore'))) {
        tip(c, 'Add "node_modules/" to a .gitignore before committing.');
      }
      c.render();
      return true;
    },
  },
  {
    name: 'login', aliases: ['signin'], args: ['value'], hint: '[<api_key>]', category: 'auth',
    desc: 'Save your AEGIS API key',
    handler: async (c, args) => {
      // This used to be `unavailable` with `/byok-set` as its alternative —
      // which was worse than useless: /byok-set stores a *provider* key
      // server-side, so a user following that advice pasted their AEGIS key
      // into a BYOK provider slot. Signing in to AEGIS Cloud *is* handing over
      // an API key, and this is now where you give it one.
      const arg = String(args.value || args._rest || '').trim();
      await applyAccountKey(c, arg, { label: 'AEGIS API key' });
      c.render();
      return true;
    },
  },
  {
    name: 'logout', args: [], hint: '', category: 'auth',
    desc: 'Remove the saved AEGIS API key',
    handler: async (c) => {
      const res = c.forgetApiKey();
      done(c, res.cleared ? `key removed from ${res.path}` : 'there was no saved key to remove');
      if (credentials.legacyKeyOnDisk()) {
        note(c, `a copy is still in ${configPath()} (another AEGIS CLI wrote it) — delete its "aegiscloud" block too`);
      }
      c.render();
      return true;
    },
  },
  {
    name: 'model', aliases: ['m'], args: ['sub'], hint: '[id|-]', category: 'model',
    desc: 'Switch AI model — pin an id ("-" clears it)',
    handler: async (c, args) => {
      const id = (args.sub || '').trim();
      // Which class the pin applies to — /model is class-scoped, because the
      // id spaces are disjoint: the pooled catalog is server-advertised ids,
      // byok is `provider:model`. Every branch below reads the live class, so
      // the copy and the picker's contents describe the route the next turn
      // will actually take (app.js's buildState().models is class-scoped too).
      const cls = (c.ctx && c.ctx.modelClass) || 'aegis';
      const byok = cls === 'byok';
      if (!id) {
        note(c, `model: ${c.ctx.model || 'server default'}`);
        // Populate the picker from the server first — app.js's state().models
        // is empty until loadModels() has run, so an unguarded read renders an
        // empty picker whose Enter does nothing.
        await loadModels(c);
        const models = c.state().models || [];
        if (!models.length) {
          // Say why, and what unblocks it: an unreachable catalog is almost
          // always a missing key or no network, and "no models advertised"
          // read as "the platform has none" rather than "this client could not
          // ask". On byok "no models" has a third cause — the relay is fine and
          // the account is fine, this machine simply holds no provider key yet,
          // which is exactly what /byok-key fixes.
          note(c, byok
            ? 'No relayable models — this machine holds no provider key yet. Save one with /byok-key <provider>, then retry /model.'
            : c.state().online
              ? 'Could not read the model catalog (offline, or the server refused it) — /models retries.'
              : // The key travels in the environment only (client/aegis.js reads
                // AEGIS_API_KEY); /login is an unavailable command here, so
                // pointing at it would send the user to a refusal.
                'No API key set, so the model catalog cannot be read — export AEGIS_API_KEY (free at https://aegiscloud.org), then retry /model.');
          c.render();
          return true;
        }
        // A pin that is not in the catalog is not honoured — the pool answers
        // from its own default with no error. Say so where the pin is visible
        // rather than letting the reply look like the pinned model. On byok the
        // failure mode is different and louder (the relay 400s on a provider it
        // has no key for), so the sentence names the right one.
        if (c.ctx.model && !models.some((m) => m.id === c.ctx.model)) {
          note(c, byok
            ? `pinned model "${c.ctx.model}" is not one this machine can relay — pick from the list below.`
            : `pinned model "${c.ctx.model}" is not in the catalog — the pool will answer with its own default; pick one below.`);
        }
        // The overlay's own copy promises /model add|remove (overlays.js, a
        // separate workstream); this build refuses both, so say here how a
        // model is actually selected.
        note(c, byok
          ? '/model <id> pins one for this session; /models lists what this machine can relay.'
          : '/model <id> pins one for this session; /models lists what the server advertises.');
        // `cls` rides on the overlay so the picker's title and subtitle render
        // for the class that opened it, even if /class moves while it is open.
        c.openOverlay({ type: 'model', items: models, sel: 0, current: c.ctx.model, cls });
        return true;
      }
      if (id === 'list') {
        await loadModels(c);
        const models = c.state().models || [];
        if (!models.length) note(c, 'No pinnable models advertised — /models lists the server\'s ids.');
        else panel(c, panels.buildModelList(c.ctx.model, models, c.ctx));
        c.render();
        return true;
      }
      if (id === 'add' || id === 'remove' || id === 'rm') {
        note(c, byok
          ? 'Model add/remove isn\'t supported in this build — on the byok class the list follows the provider keys you hold (/byok-key <provider>), then /model <provider>:<model>.'
          : 'Model add/remove isn\'t supported in this build — pin an existing server id with /model <id>.');
        c.render();
        return true;
      }
      if (id === '-') {
        c.ctx.model = null;
        c.saveConfig({ model: null, currentModelId: null });
        note(c, byok
          // There is no such thing as a byok default: the relay addresses a
          // provider by the id itself, so "nothing pinned" is not a fallback
          // here, it is a turn that will 400 with "model must be
          // <provider>:<model>". Said now rather than at the next send.
          ? 'Model pin cleared. The byok class has no server default — the next turn needs <provider>:<model>, so pin one from /models before sending.'
          : 'Model pin cleared — the server will choose.');
        c.render();
        return true;
      }
      c.ctx.model = id;
      // Persist, so the next launch restores it. app.js's restorePrefs() reads
      // this on startup; without the write it had nothing to restore and the
      // pin silently evaporated at exit. Tests point AEGISCODE_HOME at a temp
      // dir, so the write stays inside that dir.
      c.saveConfig({ model: id, currentModelId: id });
      note(c, `Pinned model: ${id}`);
      // A pin the class cannot honour is the same problem on both classes and
      // only the consequence differs, so both branches say the consequence.
      // Pooled: the server accepts an id it does not advertise and answers from
      // its own default — no error, a different model, and the spend attributed
      // to the id that was pinned. Byok: the id is parsed as a provider name,
      // so a pooled id becomes "no key saved for <that id>" at the relay.
      // Warn, never refuse: the catalog is cached, and refusing would break a
      // pin made against a server that is briefly unreachable.
      await loadModels(c);
      const models = c.state().models || [];
      if (models.length && !models.some((m) => m.id === id)) {
        note(c, byok
          ? `"${id}" is not one this machine can relay — a byok id is "<provider>:<model>", and the relay will refuse anything else. /models lists the real ids.`
          : `"${id}" is not in the AEGIS Cloud catalog — the pool will answer with its own default. /models lists the real ids.`);
      }
      c.render();
      return true;
    },
  },
  {
    name: 'radio', hint: '', category: 'fun',
    desc: 'Listen to AEGIS FM lo-fi radio',
    handler: async (c) => {
      note(c, 'Opening AEGIS FM lo-fi radio in your browser…');
      if (!openUrl(URLS.radio)) note(c, `AEGIS FM: ${URLS.radio}`);
      c.render();
      return true;
    },
  },
  {
    name: 'recap', hint: '', category: 'session',
    desc: 'Generate a one-line session recap now',
    handler: async (c) => {
      if (!c.transcript.some((m) => m.role === 'user' || m.role === 'assistant')) {
        note(c, 'No exchanges yet — send a prompt first.');
        c.render();
        return true;
      }
      note(c, 'Recapping session…');
      c.render();
      const line = await c.withWorking((signal) =>
        recapLine(c.transcript, {
          callModel: (p, opts) => c.ask(p, opts).then((r) => r.text),
          model: c.ctx.model,
          signal,
        }));
      if (line === null) { note(c, 'Recap cancelled.'); c.render(); return true; }
      c.ctx.lastRecap = { sessionId: c.sessionId, ts: new Date().toISOString(), text: line };
      c.saveConfig({ lastRecap: c.ctx.lastRecap });
      note(c, `Session recap: ${line}`);
      c.render();
      return true;
    },
  },
  {
    name: 'resume', hint: '', category: 'session',
    desc: 'Switch to a previous session',
    handler: async (c) => {
      const items = readResumeList();
      if (!items.length) { note(c, 'No previous sessions found — conversations from this host and from AEGIS Desktop both land in ~/.aegiscode/sessions.json'); c.render(); return true; }
      c.openOverlay({ type: 'resume', items, sel: 0 });
      return true;
    },
  },
  {
    name: 'rewind', args: ['n'], hint: '[N]', category: 'session',
    desc: 'Revert the conversation to a checkpoint',
    handler: async (c, args) => {
      const items = listCheckpoints(c.sessionId);
      if (!args.n) {
        if (!items.length) { note(c, 'No checkpoints yet — snapshots are taken after each exchange.'); c.render(); return true; }
        panel(c, panels.buildRewindList(items, c.ctx));
        c.render();
        return true;
      }
      const n = parseInt(args.n, 10);
      if (Number.isNaN(n) || n < 0 || n >= items.length) {
        note(c, `Unknown checkpoint ${args.n}. /rewind shows the list (indices 0..${Math.max(0, items.length - 1)}).`);
        c.render();
        return true;
      }
      snapshotCheckpoint(c.sessionId, c.transcript); // make the rewind undoable
      const restored = loadCheckpoint(c.sessionId, n);
      if (!restored) { note(c, 'Checkpoint unreadable — nothing restored.'); c.render(); return true; }
      c.transcript.length = 0;
      for (const m of restored) c.transcript.push(m);
      note(c, `Rewound to checkpoint ${n} (${restored.length} messages). /rewind N again to undo.`);
      c.render();
      return true;
    },
  },
  {
    name: 'agents', aliases: ['sessions'], args: ['role', 'task'], hint: '[role] [task]', category: 'session',
    desc: 'Show the agents panel, or run a sub-agent role preset — /agents <role> <task>',
    handler: async (c, args) => {
      const role = (args.role || '').trim().toLowerCase();
      if (role) {
        const task = (args._rest || '').trim().replace(/^\S+\s*/, '').trim();
        if (!task) { note(c, `Usage: /agents <role> <task> — roles: ${agentRoles().join(', ')}`); c.render(); return true; }
        if (!AGENT_PRESETS[role]) { note(c, `Unknown agent role "${role}". Roles: ${agentRoles().join(', ')}`); c.render(); return true; }
        await c.runPrompt(composeAgentPrompt(role, task));
        return true;
      }
      panel(c, panels.buildAgents(c.state(), c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'status', aliases: ['st'], hint: '', category: 'session',
    desc: 'Show account and session status',
    handler: async (c) => {
      // This client's /status surface is the account-status tool (the same
      // tool /aegis-status names) plus the local session panel below it.
      await c.runTool('aegis_status', {});
      panel(c, panels.buildStatus(c.state(), Object.assign({}, c.ctx, { caps: describe() })));
      c.render();
      return true;
    },
  },
  {
    name: 'teleport', hint: '', category: 'session',
    desc: 'Resume a session from aegiscloud.org',
    handler: async (c) => {
      note(c, 'Teleport requires an AEGIS cloud account with sessions. Sign in with `aegis login`, then run aegiscloud.org/teleport.');
      c.render();
      return true;
    },
  },
  {
    name: 'theme', aliases: ['t'], args: ['mode'], hint: '[dark|light]', category: 'model',
    desc: 'Change the color theme',
    handler: async (c, args) => {
      const m = (args.mode || '').toLowerCase();
      if (m === 'dark' || m === 'light') {
        // Resolve through the theme table rather than hardcoding an index, so
        // "light" names the same row the picker would have named: index 2
        // ("Light mode"), not index 0 ("Auto"). themeIndex is what the
        // colorblind/ANSI palettes key off, so a wrong index silently selects
        // the wrong palette rather than merely displaying a wrong label.
        const want = m === 'light' ? 2 : 1;
        screens.applyTheme(c.ctx, want);
      } else {
        await c.showThemePicker();
      }
      c.saveConfig({ themeIndex: c.ctx.themeIndex });
      note(c, `Theme: ${c.ctx.light ? 'light' : 'dark'}`);
      c.render();
      return true;
    },
  },
  {
    name: 'terminal', aliases: ['tty'], args: ['mode', 'mode2'],
    hint: '[ascii|unicode|color|no-color|star <native|narrow>|width <cols>|auto|status]', category: 'model',
    desc: 'Show or override how this terminal is drawn (mark, colour, width)',
    handler: async (c, args) => {
      // The same report `aegiscode --terminal` prints, and the same switch the
      // `--ascii` flag sets — so a session can be re-styled without restarting
      // when a paste from PowerShell turns out to render badly in this host.
      // `args` is positional (app.js `parseArgs`), so the second token is
      // `mode2` for both `star narrow` and `width 100`.
      const sub = (args.mode || '').toLowerCase();
      const second = args.mode2 != null ? String(args.mode2).trim() : '';

      if (sub === '' || sub === 'status') {
        panel(c, panels.buildTerminalCaps(describe(), { pinned: !!caps().pinned }));
        c.render();
        return true;
      }

      // The patch pins every *axis* but never the frame: `cols`/`rows` must stay
      // absent so `setCaps` leaves `sizePinned` false and a live resize keeps
      // re-reading the stream (see caps.js). Copying the whole caps object here
      // would freeze the width at the moment the command ran.
      const cur = caps();
      const axes = {
        glyphs: cur.glyphs, face: cur.face, star: cur.star,
        depth: cur.depth, vt: cur.vt, wideRunes: cur.wideRunes,
        reasons: Object.assign({}, cur.reasons),
      };

      if (sub === 'auto') {
        // Drop every override, including any the session inherited from the
        // flags/env it was started with — "auto" means "probe again", not
        // "restore what you were launched with".
        resetCaps();
        note(c, 'Terminal: auto — capabilities re-probed from the environment.');
        c.render();
        return true;
      }
      // `why` in the report must describe what the session is actually doing,
      // not the probe it started from: after `/terminal ascii` on a truecolor
      // host, `why: TERM=xterm-256color` would contradict `mark: ascii`.
      if (sub === 'ascii' || sub === 'unicode') {
        axes.glyphs = sub === 'ascii' ? 'ascii' : 'unicode';
        axes.face = sub === 'ascii' ? 'edges' : 'native';
        axes.star = sub === 'ascii' ? 'narrow' : 'native';
        if (axes.reasons) axes.reasons.glyphs = `/terminal ${sub}`;
      } else if (sub === 'color' || sub === 'no-color' || sub === 'nocolor') {
        axes.depth = sub === 'color' ? 24 : 0;
        if (axes.reasons) axes.reasons.depth = `/terminal ${sub}`;
      } else if (sub === 'star') {
        const want = second.toLowerCase();
        if (!['native', 'narrow'].includes(want)) { note(c, 'Usage: /terminal star <native|narrow>'); c.render(); return true; }
        axes.star = want;
        if (axes.reasons) axes.reasons.star = `/terminal star ${want}`;
      } else if (sub === 'width') {
        // A pinned width is a frame override, so it goes in as cols — the one
        // key that deliberately trips `sizePinned`.
        const width = Number(second);
        if (!Number.isFinite(width) || width < 20) { note(c, 'Usage: /terminal width <cols> (>= 20)'); c.render(); return true; }
        setCaps(Object.assign({}, axes, { cols: Math.round(width) }));
        note(c, `Terminal: width pinned to ${Math.round(width)} columns.`);
        panel(c, panels.buildTerminalCaps(describe(), { pinned: !!caps().pinned }));
        c.render();
        return true;
      } else {
        note(c, 'Usage: /terminal [ascii|unicode|color|no-color|star <native|narrow>|width <cols>|auto|status]');
        c.render();
        return true;
      }

      setCaps(axes);
      panel(c, panels.buildTerminalCaps(describe(), { pinned: !!caps().pinned }));
      // Already-painted scrollback keeps the glyphs it was drawn with — a
      // terminal has no way to rewrite what it has scrolled past. Everything
      // from here on (and this viewport) uses the new mark.
      note(c, 'Terminal updated — the current viewport is redrawn; text already scrolled past keeps its old glyphs.');
      c.render();
      return true;
    },
  },
  {
    name: 'version', aliases: ['v'], hint: '', category: 'session',
    desc: 'Show version',
    handler: async (c) => {
      note(c, `aegiscode v${VERSION}`);
      c.render();
      return true;
    },
  },
  {
    name: 'doctor', hint: '', category: 'support',
    desc: 'Run diagnostic checks on this environment',
    handler: async (c) => {
      const checks = [];
      const ok = (label, good, detail) => checks.push([good, label, detail]);
      ok('Node', true, process.version);
      ok('CWD', fs.existsSync(process.cwd()), process.cwd());
      let git = false;
      try { execSync('git rev-parse --git-dir', { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'], timeout: 4000 }); git = true; } catch {}
      ok('git repo', git, git ? 'inside a work tree' : 'not a git repository');
      const ks = credentials.keyStatus();
      ok(
        'AEGIS key',
        ks.configured,
        ks.configured
          ? `${maskKey(ks.key)} via ${credentials.sourceLabel(ks.source)}`
          : `not set — ${credentials.HOW_TO_SET} (free at https://aegiscloud.org)`
      );
      ok('credentials', true, `${ks.path}${ks.fileMode ? ` (${ks.fileMode})` : ''}`);
      ok('cloud memory', ks.memoryToken, ks.memoryToken ? 'token held' : 'no memory token — /cloud activate');
      if (ks.legacyPlaintext) {
        ok('plaintext key', false, `a copy also sits in ${configPath()} (another AEGIS CLI) — /key re-saves it to ${ks.path}`);
      }
      ok('config path', true, configPath());
      const lines = [[span(C.gold + BOLD, 'Doctor'), span(BOLD_OFF, '')], [span(C.gray, '─'.repeat(30))]];
      for (const [good, label, detail] of checks) {
        lines.push([
          span(good ? C.green : C.coral, `  ${good ? '✔' : '⚠'}`),
          span(C.white, ` ${label}: `),
          span(C.gray, String(detail)),
        ]);
      }
      panel(c, lines);
      c.render();
      return true;
    },
  },
  {
    name: 'vim', args: ['mode'], hint: '[on|off]', category: 'model',
    desc: 'Toggle vim keymap',
    handler: async (c, args) => {
      const mode = (args.mode || '').toLowerCase();
      if (mode && !['on', 'off'].includes(mode)) { note(c, 'Usage: /vim [on|off]'); c.render(); return true; }
      const want = mode === 'on' ? true : mode === 'off' ? false : !c.ctx.vim;
      c.ctx.vim = want;
      c.saveConfig({ vim: want });
      note(c, `Vim keymap: ${want ? 'on' : 'off'}`);
      c.render();
      return true;
    },
  },
  {
    name: 'permissions', args: ['mode', 'pattern'],
    hint: '[allow|deny|ask "<pattern>" | default <ask|allow|deny> | clear]', category: 'model',
    desc: 'Set permissions for tool use',
    handler: async (c, args) => {
      const rules = loadPermissions();
      const mode = (args.mode || '').toLowerCase();
      const pattern = args.pattern;
      if (!mode) {
        panel(c, panels.buildPermissions({ ...rules, _path: permissionsPath() }, null, c.ctx));
        c.render();
        return true;
      }
      if (mode === 'clear') {
        savePermissions({ ...DEFAULT_PERMISSIONS, allow: [], deny: [], ask: [] });
        note(c, 'Permissions reset to defaults (no rules).');
        c.render();
        return true;
      }
      if (mode === 'default' && ['ask', 'allow', 'deny'].includes(pattern)) {
        savePermissions({ ...rules, defaultMode: pattern });
        note(c, `Default permission mode: ${pattern}`);
        c.render();
        return true;
      }
      if (['allow', 'deny', 'ask'].includes(mode) && pattern) {
        const { added, rules: next } = addPermissionRule(mode, pattern, rules);
        savePermissions(next);
        note(c, added ? `Added ${mode} rule: ${pattern}` : `Rule already present: ${pattern}`);
        c.render();
        return true;
      }
      note(c, 'Usage: /permissions [allow|deny|ask "<pattern>" | default <ask|allow|deny> | clear]');
      c.render();
      return true;
    },
  },
  {
    name: 'hooks', args: ['sub'], hint: '[status|list]', category: 'model',
    desc: 'View hooks configuration status and configured hook list',
    handler: async (c, args) => {
      const sub = (args.sub || '').toLowerCase();
      const { hooks, from } = readHooks();
      if (sub === 'list') {
        panel(c, panels.buildHooksList({ hooks }, c.ctx));
        c.render();
        return true;
      }
      if (sub === '' || sub === 'status') {
        panel(c, panels.buildHooksStatus({ ...hookStats(hooks), fromPaths: from }, c.ctx));
        c.render();
        return true;
      }
      note(c, `unknown subcommand: ${args.sub}`);
      note(c, 'available: status, list');
      c.render();
      return true;
    },
  },
  {
    name: 'credentials', hint: '', category: 'model',
    desc: 'Show where credentials are stored',
    handler: async (c) => {
      const p = path.join(os.homedir(), '.claude', '.credentials.json');
      const loc = p.replace(os.homedir(), '~');
      if (!fs.existsSync(p)) {
        note(c, 'No credential file found. The Claude Code CLI manages auth (OS keychain or ~/.claude/.credentials.json).');
      } else {
        note(c, `Credentials live in ${loc} (managed by the Claude Code CLI). aegiscode reads them but never writes them.`);
      }
      c.render();
      return true;
    },
  },
  {
    name: 'install-github-app', hint: '', category: 'model',
    desc: 'Install the GitHub App for PR workflows',
    handler: async (c) => {
      note(c, 'The GitHub App is installed through the Claude Code CLI: run `claude --install-github-app` once.');
      c.render();
      return true;
    },
  },
  {
    name: 'troubleshooting', hint: '', category: 'support',
    desc: 'Troubleshoot common issues',
    handler: async (c) => {
      panel(c, panels.buildTroubleshooting(c.state(), c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'feedback', hint: '', category: 'support',
    desc: 'Send feedback to the AEGIS team',
    handler: async (c) => {
      note(c, 'Opening the feedback form…');
      if (!openUrl(URLS.feedback)) note(c, `Feedback: ${URLS.feedback}`);
      c.render();
      return true;
    },
  },
  {
    name: 'bug', hint: '', category: 'support',
    desc: 'Report a bug (opens a GitHub issue)',
    handler: async (c) => {
      note(c, `Opening a GitHub issue… (aegiscode v${VERSION}, ${process.version}, ${os.platform()})`);
      if (!openUrl(URLS.issues)) note(c, `Issues: ${URLS.issues}`);
      c.render();
      return true;
    },
  },
  {
    name: 'issue', aliases: ['bugs'], hint: '', category: 'support',
    desc: 'Report an issue',
    handler: async (c) => {
      note(c, 'Opening a GitHub issue…');
      if (!openUrl(URLS.issues)) note(c, `Issues: ${URLS.issues}`);
      c.render();
      return true;
    },
  },
  {
    name: 'onboarding', hint: '', category: 'support',
    desc: 'Show getting-started tips',
    handler: async (c) => {
      panel(c, panels.buildOnboarding(c.state(), c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'shell-completion', hint: '', category: 'support',
    desc: 'Set up shell completion',
    handler: async (c) => {
      panel(c, panels.buildShellCompletion(c.state(), c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'terminal-setup', hint: '', category: 'support',
    desc: 'Check and fix terminal setup',
    handler: async (c) => {
      panel(c, panels.buildTerminalSetup(c.state(), c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'pr-comments', hint: '', category: 'support',
    desc: 'Review and reply to pull request comments',
    handler: async (c) => {
      note(c, 'PR comments need GitHub auth. Run /prs to check connectivity, then use the `gh` CLI or the GitHub web UI.');
      c.render();
      return true;
    },
  },
  {
    name: 'prs', hint: '', category: 'support',
    desc: 'List pull requests in this repo',
    handler: async (c) => {
      try {
        const out = execSync('gh pr list --limit 8', { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
        panel(c, panels.buildPRs(out.toString(), c.ctx));
      } catch {
        note(c, 'gh not authenticated (or not installed) — run `gh auth login` first.');
      }
      c.render();
      return true;
    },
  },
  {
    name: 'review', hint: '', category: 'support',
    desc: 'Review a pull request',
    handler: async (c) => {
      note(c, '/review needs GitHub auth via gh. Run /prs to list open PRs, then open one in the browser.');
      c.render();
      return true;
    },
  },
  {
    name: 'benchmark', hint: '', category: 'support',
    desc: 'Run in-app micro-benchmarks',
    handler: async (c) => {
      const t = (fn) => {
        const s = process.hrtime.bigint();
        fn();
        return (Number(process.hrtime.bigint() - s) / 1e6).toFixed(2);
      };
      const sample = '# Heading\n\nSome **bold** and `code` with a [link](https://x.test).\n\n- a\n- b\n- c\n';
      const results = [
        ['2,000 span() calls', t(() => { for (let i = 0; i < 2000; i++) span(C.white, 'x'); })],
        ['estimateTokens × 20 (500 chars)', t(() => { for (let i = 0; i < 20; i++) estimateTokens('x'.repeat(500)); })],
      ];
      if (markdownModule && typeof markdownModule.renderMarkdown === 'function') {
        results.push(['renderMarkdown × 200', t(() => { for (let i = 0; i < 200; i++) markdownModule.renderMarkdown(sample, 80); })]);
      }
      panel(c, panels.buildBenchmark(results, c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'waifu', hint: '', category: 'fun',
    desc: 'Summon a waifu',
    handler: async (c) => {
      panel(c, panels.buildWaifu(c.ctx));
      c.render();
      return true;
    },
  },

  // ── Phase 6 (part 2) families ─────────────────────────────────────────────
  {
    name: 'new', aliases: ['start'], hint: '', category: 'session',
    desc: 'Start a new session (clears the transcript, fresh session id)',
    handler: async (c) => {
      c.transcript.length = 0;
      const id = 'aegis-' + Math.random().toString(36).slice(2, 10);
      c.sessionId = id;
      c.ctx.sessionId = id;
      note(c, `New session started (${id}) — earlier context cleared.`);
      c.render();
      return true;
    },
  },
  {
    name: 'tokens', aliases: ['tok'], hint: '', category: 'data',
    desc: 'Show token usage breakdown and estimated spend',
    handler: async (c) => {
      const acct = sessionAccounting(c.transcript, c.ctx.model);
      panel(c, panels.buildTokens({ ...c.state(), contextWindow: acct.contextWindow, costEur: acct.cost }, c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'skills', aliases: ['sk'], args: ['sub'], hint: '[name|refresh]', category: 'session',
    desc: 'List skills (SKILL.md in the standard skill dirs)',
    handler: async (c, args) => {
      const sub = (args.sub || '').trim().toLowerCase();
      const found = scanSkills();
      const dirs = [
        path.join(os.homedir(), '.aegis', 'skills'),
        path.join(process.cwd(), '.aegis', 'skills'),
        path.join(os.homedir(), '.aegiscode', 'skills'),
        path.join(process.cwd(), '.aegiscode', 'skills'),
        path.join(os.homedir(), '.claude', 'skills'),
      ].map((d) => d.replace(os.homedir(), '~'));
      if (sub === 'refresh' || sub === 'reload') {
        note(c, `Skills refreshed — ${found.length} found (${dirs.length} dirs scanned).`);
        c.render();
        return true;
      }
      if (sub) {
        const skill = found.find((s) => s.name === sub);
        if (!skill) { note(c, `Unknown skill "${sub}". /skills lists what exists on disk.`); c.render(); return true; }
        panel(c, panels.buildSkillDetail(skill, c.ctx));
        c.render();
        return true;
      }
      panel(c, panels.buildSkills(found, dirs, c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'thinking', args: ['mode'], hint: '[on|off]', category: 'model',
    desc: 'Toggle thinking blocks expanded/collapsed',
    handler: async (c, args) => {
      const mode = (args.mode || '').toLowerCase();
      if (mode && !['on', 'off'].includes(mode)) { note(c, 'Usage: /thinking [on|off]'); c.render(); return true; }
      const want = mode === 'on' ? true : mode === 'off' ? false : !(c.ctx.thinking === true);
      c.ctx.thinking = want;
      c.saveConfig({ thinking: want });
      note(c, `Thinking blocks: ${want ? 'expanded' : 'collapsed'}`);
      c.render();
      return true;
    },
  },
  {
    name: 'mcp', args: ['sub', 'name', 'command'], hint: '[add <name> <command> [args…]|remove <name>|<name>]', category: 'model',
    desc: 'Show MCP server configuration',
    handler: async (c, args) => {
      const cfg = loadConfig();
      const servers = cfg.mcpServers || {};
      const sub = (args.sub || '').toLowerCase();
      if (sub === 'add') {
        const name = (args.name || '').trim();
        const command = (args.command || '').trim();
        if (!name || !command) { note(c, 'Usage: /mcp add <name> "<command with args>"'); c.render(); return true; }
        const parts = command.split(/\s+/).filter(Boolean);
        updateConfig({ mcpServers: { ...servers, [name]: { command: parts[0], args: parts.slice(1) } } });
        note(c, `Added MCP server "${name}" (${parts[0]}). Configuration only — this build has no MCP runtime.`);
        c.render();
        return true;
      }
      if (sub === 'remove' || sub === 'rm') {
        const name = (args.name || '').trim();
        if (!name) { note(c, 'Usage: /mcp remove <name>'); c.render(); return true; }
        if (!servers[name]) { note(c, `No MCP server "${name}". /mcp lists the configured ones.`); c.render(); return true; }
        const next = { ...servers };
        delete next[name];
        updateConfig({ mcpServers: next });
        note(c, `Removed MCP server "${name}".`);
        c.render();
        return true;
      }
      if (sub && servers[sub]) {
        const srv = servers[sub];
        panel(c, [
          [span(C.gold, `MCP server: ${sub}`)],
          [span(C.gray, '─'.repeat(30))],
          [span(C.white, `  command: ${`${srv.command || ''} ${(srv.args || []).join(' ')}`.trim()}`)],
          [span('', '')],
          [span(C.gray, 'Configuration only — this build has no MCP runtime.')],
        ]);
        c.render();
        return true;
      }
      panel(c, panels.buildMcp(servers, [configPath(), permissionsPath()], c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'memory', aliases: ['memories'], hint: '', category: 'model',
    desc: 'List the most recent AEGIS cloud-memory entries',
    tool: 'aegis_memory_list',
    build: () => ({}),
  },
  {
    name: 'memory-deep', aliases: ['recall-deep'], args: ['mode'], hint: '[on|off]', category: 'model',
    desc: 'Toggle DEEP recall for this session — brain corrections + cached answers (metered: one embedding per turn)',
    handler: async (c, args) => {
      const mode = (args.mode || '').toLowerCase();
      if (mode && !['on', 'off'].includes(mode)) { note(c, 'Usage: /memory-deep [on|off]'); c.render(); return true; }
      const want = mode === 'on' ? true : mode === 'off' ? false : !(c.ctx.recallDeep === true);
      c.ctx.recallDeep = want;
      // Deliberately session-scoped: nothing is written to config.json, because
      // this flag meters every turn (aegis1 services/brain_memory.py embeds the
      // query once per turn) and a silent restore on a later launch would bill
      // for a decision made in a session that has ended. Contrast /thinking,
      // which persists — it costs nothing. The cheap read half (`aegis_recall`)
      // is always on and has no toggle.
      note(c, `Deep recall: ${want ? 'on — brain corrections + cached answers, one embedding per turn' : 'off (only the cheap recall read)'}${want ? ' · this session only' : ''}`);
      c.render();
      return true;
    },
  },
  {
    name: 'confirm', aliases: ['confirmations'], args: ['mode'], hint: '[on|off]', category: 'model',
    desc: 'Toggle tool-call confirmation prompts',
    handler: async (c, args) => {
      const rules = loadPermissions();
      const mode = (args.mode || '').toLowerCase();
      if (mode && !['on', 'off'].includes(mode)) { note(c, 'Usage: /confirm [on|off]'); c.render(); return true; }
      const want = mode === 'on' ? true : mode === 'off' ? false : rules.defaultMode !== 'allow';
      savePermissions({ ...rules, defaultMode: want ? 'ask' : 'allow' });
      note(c, `Confirmation prompts: ${want ? 'on' : 'off'} (default permission mode: ${want ? 'ask' : 'allow'})`);
      c.render();
      return true;
    },
  },
  {
    name: 'yolo', args: ['mode'], hint: '[on|off]', category: 'model',
    desc: 'Toggle YOLO mode — auto-approve all tool executions',
    handler: async (c, args) => {
      const rules = loadPermissions();
      const mode = (args.mode || '').toLowerCase();
      if (mode && !['on', 'off'].includes(mode)) { note(c, 'Usage: /yolo [on|off]'); c.render(); return true; }
      const want = mode === 'on' ? true : mode === 'off' ? false : rules.defaultMode !== 'allow';
      savePermissions({ ...rules, defaultMode: want ? 'allow' : 'ask' });
      if (want) panel(c, panels.buildYolo(c.state(), c.ctx));
      else note(c, 'YOLO mode off — confirmations restored.');
      c.render();
      return true;
    },
  },
  {
    name: 'multiyolo', args: ['task'], hint: '<task>', category: 'session',
    desc: 'Multi-agent orchestration with YOLO mode — /multiyolo <task>',
    handler: async (c, args) => {
      const task = (args._rest || args.task || '').trim();
      if (!task) { note(c, 'Usage: /multiyolo <task>'); c.render(); return true; }
      const rules = loadPermissions();
      savePermissions({ ...rules, defaultMode: 'allow' });
      panel(c, panels.buildYolo(c.state(), c.ctx));
      note(c, 'Composing ÆGIS /multiyolo — run it in aegis-cli (the confirmation prompt works there):');
      panel(c, panels.buildAegisMulti(task, c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'router', args: ['sub', 'tier', 'modelId'], hint: '[on|off|set <tier> <modelId>|stats]', category: 'model',
    desc: 'Show or manage the model router config',
    handler: async (c, args) => {
      const cfg = loadConfig();
      const router = cfg.autoRouter || { enabled: false, tiers: {} };
      const sub = (args.sub || '').toLowerCase();
      const persist = (next) => updateConfig({ autoRouter: next });
      if (sub === 'on') { persist({ ...router, enabled: true }); note(c, 'Auto-router: on.'); c.render(); return true; }
      if (sub === 'off') { persist({ ...router, enabled: false }); note(c, 'Auto-router: off.'); c.render(); return true; }
      if (sub === 'set') {
        const tier = (args.tier || '').toLowerCase();
        const modelId = (args.modelId || '').trim();
        if (!['simple', 'medium', 'complex'].includes(tier) || !modelId) {
          note(c, 'Usage: /router set <simple|medium|complex> <modelId>');
          c.render();
          return true;
        }
        persist({ ...router, tiers: { ...(router.tiers || {}), [tier]: modelId } });
        note(c, `Auto-router: ${tier} -> ${modelId}`);
        c.render();
        return true;
      }
      if (sub === 'stats') {
        panel(c, [
          [span(C.gold + BOLD, 'Router stats'), span(BOLD_OFF, '')],
          [span(C.gray, '─'.repeat(30))],
          [span(C.gray, 'No learned outcomes yet — this build does not auto-route.')],
          [span(C.gray, 'Tiers: simple/medium/complex via /router set.')],
        ]);
        c.render();
        return true;
      }
      panel(c, panels.buildRouter(cfg, c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'multi', args: ['task', 'mode'], hint: '<task> [run]', category: 'session',
    desc: 'Compose a multi-agent task (add "run" to execute)',
    handler: async (c, args) => {
      let task = (args._rest || args.task || '').trim();
      let mode = (args.mode || '').toLowerCase();
      if (mode !== 'run' && /\s+run$/i.test(task)) { mode = 'run'; task = task.replace(/\s+run$/i, '').trim(); }
      if (!task) { note(c, 'Usage: /multi <task> [run]'); c.render(); return true; }
      if (mode !== 'run') { panel(c, panels.buildAegisMulti(task, c.ctx)); c.render(); return true; }
      note(c, 'Running the task through the pooled brain (single-model — the reference fans it out).');
      await c.runPrompt(task);
      return true;
    },
  },
  {
    name: 'research', args: ['question'], hint: '<question>', category: 'session',
    desc: 'Research a topic with a multi-perspective council prompt',
    handler: async (c, args) => {
      const q = (args._rest || args.question || '').trim();
      if (!q) { note(c, 'Usage: /research <question>'); c.render(); return true; }
      await c.runPrompt(composeResearchPrompt(q, process.cwd()));
      return true;
    },
  },
  {
    name: 'debate', aliases: ['db'], args: ['topic'], hint: '<topic>', category: 'session',
    desc: 'Run a structured debate on the current model',
    handler: async (c, args) => {
      const topic = (args._rest || args.topic || '').trim();
      if (!topic) { note(c, 'Usage: /debate <topic>'); c.render(); return true; }
      await c.runPrompt(composeDebatePrompt(topic, c.ctx.model || ''));
      return true;
    },
  },
  {
    name: 'billing', aliases: ['balance', 'spend'], hint: '', category: 'support',
    desc: 'Show billing info — token-bank balance and recent spend',
    handler: async (c) => {
      // The account is the source of truth for the balance and ledger; the
      // session panel below adds this session's spend.
      await c.runTool('aegis_balance', {});
      const spend = await c.refreshSpend();
      const st = c.state();
      panel(c, panels.buildBilling({
        ...st,
        balance: spend && spend.balance != null ? spend.balance : st.balance,
      }, c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'cloud', args: ['sub', 'value'], hint: '[status|key <api_key>|activate|deactivate|memory [on|off]|sync [on|off|now]]', category: 'support',
    desc: 'Show and control ÆGIS cloud sync',
    handler: async (c, args) => {
      const sub = (args.sub || '').toLowerCase();
      const rest = (args.value || args._rest || '').trim();

      if (sub === 'key') {
        await applyAccountKey(c, rest);
        c.render();
        return true;
      }

      if (sub === 'activate') {
        if (!c.client.apiKey) {
          note(c, `no key — ${credentials.HOW_TO_SET}`);
          c.render();
          return true;
        }
        try {
          const res = await c.withWorking(() => c.client.memoryActivate());
          const token = await c.client.getMemoryToken();
          if (token) credentials.saveMemoryToken(token, { memorySubscribed: true });
          done(c, res && res.ok === false ? 'the server refused activation' : 'cloud memory activated for this account');
          if (res && res.token_limit) note(c, `quota: ${res.tokens_used || 0} / ${res.token_limit} synced tokens`);
        } catch (e) {
          note(c, `activation failed: ${e.message}`);
        }
        c.render();
        return true;
      }

      if (sub === 'deactivate') {
        // There is no /api/memory/deactivate on the server, so this clears the
        // credential this host holds rather than pretending to unenrol the
        // account. Saying which one it did is the difference between a control
        // and a lie.
        credentials.clearMemoryToken();
        c.client.setApiKey(c.client.apiKey);
        note(c, 'cloud memory token cleared locally — sync stops until /cloud activate re-issues one');
        note(c, 'the account itself is still subscribed; manage the subscription at https://aegiscloud.org/subscribe');
        c.render();
        return true;
      }

      if (sub === 'memory' || sub === 'persist' || sub === 'memory-persist') {
        // The write half's one switch. `/cloud sync on|off` and `/sync on|off`
        // still work (they always meant "should this host store my sessions"),
        // but this is the name that says what is actually being flipped.
        const mode = (rest || 'status').toLowerCase();
        if (mode === 'on' || mode === 'off') {
          const on = mode === 'on';
          setMemoryGate(c, on);
          if (on) {
            done(c, 'persisting memory on — sessions are stored to your account so an interrupted turn can be resumed');
            note(c, '/cloud memory shows the quota; past the plan’s ceiling reads keep working and only new writes pause');
          } else {
            note(c, 'persisting memory off — nothing new is stored');
            note(c, 'everything already in the cloud stays readable (/aegis-recall <topic>), and /sync now still pushes once by hand');
          }
          c.render();
          return true;
        }
        panel(c, memoryStatusLines(c));
        c.render();
        return true;
      }

      if (sub === 'sync' || sub === 'push' || sub === 'pull') {
        const mode = sub === 'sync' ? (rest || 'status').toLowerCase() : sub;
        if (mode === 'on' || mode === 'off') {
          const on = mode === 'on';
          setMemoryGate(c, on);
          note(c, on ? 'persisting memory on — sessions are stored after each turn (this is the old "cloud sync")' : 'persisting memory off — nothing new is stored; /sync now still runs a manual pass');
          c.render();
          return true;
        }
        if (mode === 'now') {
          await runCloudSync(c);
          c.render();
          return true;
        }
        const st = cloudsync.status();
        panel(c, [
          ...memoryStatusLines(c),
          [span(C.gray, '')],
          [span(C.white + BOLD, 'Sync ledger'), span(BOLD_OFF, '')],
          [span(C.gray, `  local sessions: ${st.local}  ·  pending push: ${st.pending}  ·  in sync: ${st.synced}`)],
          [span(C.gray, `  last push: ${st.lastPushAt ? new Date(st.lastPushAt).toLocaleString() : 'never'}  ·  last pull: ${st.lastPullAt ? new Date(st.lastPullAt).toLocaleString() : 'never'}`)],
          [span(C.gray, `  state: ${st.path}`)],
        ]);
        for (const e of st.errors.slice(0, 3)) {
          panel(c, [[span(C.coral, `  ⚠ ${e.error}`)]]);
        }
        c.render();
        return true;
      }

      // Default: the whole picture — key plus sync state.
      const st = cloudsync.status();
      panel(c, [
        ...keyPanelLines(c, 'AEGIS cloud'),
        [span(C.gray, '')],
        ...memoryStatusLines(c),
        [span(C.gray, '')],
        [span(C.white + BOLD, '  Sync'), span(BOLD_OFF, '')],
        [span(C.gray, `  ${st.pending} pending  ·  ${st.synced} in sync  ·  ${st.importedRemote} pulled from cloud`)],
        // Both names, because both work: `/cloud memory` is the new one that
        // says what is being flipped, and `/cloud sync` is what every user who
        // has ever turned this off typed (it dispatched here before the flip
        // renamed the panel, and still does — see the `sub === 'sync'` branch).
        // Advertising only the new name hides a working control behind a
        // rename, which is how a setting becomes a rumour.
        [span(C.gray, '  /cloud memory on | off   ·   /cloud sync on | off   ·   /sync now')],
      ]);
      c.render();
      return true;
    },
  },
  {
    name: 'key', aliases: ['apikey', 'api-key'], args: ['value'], hint: '[<api_key>|status|clear]', category: 'auth',
    desc: 'Save or show the AEGIS account key',
    handler: async (c, args) => {
      const arg = String(args.value || args._rest || '').trim();
      const lower = arg.toLowerCase();
      if (lower === 'status') {
        panel(c, keyPanelLines(c));
        c.render();
        return true;
      }
      if (lower === 'clear' || lower === 'remove' || lower === 'rm') {
        const res = c.forgetApiKey();
        done(c, res.cleared ? `key removed from ${res.path}` : 'there was no saved key to remove');
        if (credentials.legacyKeyOnDisk()) {
          note(c, `a copy is still in ${configPath()} (written by another AEGIS CLI) — delete the "aegiscloud" block to finish the job`);
        }
        c.render();
        return true;
      }
      await applyAccountKey(c, arg);
      c.render();
      return true;
    },
  },
  {
    name: 'sync', aliases: ['cloudsync', 'cloud-sync'], args: ['mode'], hint: '[now|on|off|status]', category: 'data',
    desc: 'Store sessions in AEGIS Cloud (cross-session memory)',
    hidden: (c) => !cloudReady(),
    handler: async (c, args) => {
      const mode = (args.mode || '').toLowerCase();
      if (mode === 'on' || mode === 'off') {
        setMemoryGate(c, mode === 'on');
        note(c, mode === 'on' ? 'persisting memory on — sessions are stored so an interrupted turn can be resumed' : 'persisting memory off — nothing new is stored; /sync now still runs a manual pass');
        c.render();
        return true;
      }
      if (mode === 'status') {
        const st = cloudsync.status();
        const rows = memoryStatusLines(c);
        rows.push([span(C.gray, '')]);
        rows.push([span(C.gray, `  local ${st.local}  ·  pending ${st.pending}  ·  in sync ${st.synced}`)]);
        panel(c, rows);
        c.render();
        return true;
      }
      // Bare /sync and /sync now both do the thing: this is the command a user
      // reaches for when they want their sessions in the cloud right now.
      await runCloudSync(c);
      c.render();
      return true;
    },
  },
  {
    name: 'gmail', hint: '', category: 'support',
    desc: 'Link Gmail to conversations',
    handler: async (c) => {
      note(c, 'Gmail integration needs Google OAuth — not available in this build. Use /export to save conversations to files instead.');
      c.render();
      return true;
    },
  },
  {
    name: 'clone', aliases: ['fetch-site', 'websnap'], args: ['url'], hint: '<url>', category: 'workspace',
    desc: 'Clone a website into a local project',
    handler: async (c, args) => {
      const url = (args._rest || args.url || '').trim();
      if (!url) { note(c, 'Usage: /clone <url>'); c.render(); return true; }
      note(c, `/clone needs a web-fetch tool and a chat service — not available in this build. Use /init to scaffold a fresh project instead of ${url}.`);
      c.render();
      return true;
    },
  },
  {
    name: 'release-notes', hint: '', category: 'support',
    desc: "What's new",
    handler: async (c) => {
      panel(c, panels.buildReleaseNotes(c.state(), c.ctx));
      c.render();
      return true;
    },
  },

  // ── /aegis-* family ───────────────────────────────────────────────────────
  {
    name: 'aegis-status', hint: '', category: 'aegis',
    desc: 'Show account status — API key, plan, account and cloud memory',
    tool: 'aegis_status',
    build: () => ({}),
  },
  {
    name: 'aegis-ask', aliases: ['ask'], args: ['question'], hint: '<question>', category: 'aegis',
    desc: 'Ask ÆGIS pooled inference a question (auto-routed)',
    tool: 'aegis_ask',
    build: (arg) => ({ prompt: arg }),
  },
  {
    name: 'aegis-recall', aliases: ['recall'], args: ['topic'], hint: '<topic>', category: 'aegis',
    desc: 'Recall cross-session memory about a topic (cloud)',
    tool: 'aegis_memory_search',
    build: (arg) => ({ query: arg }),
  },
  {
    name: 'aegis-remember', aliases: ['remember'], args: ['note'], hint: '<note>', category: 'aegis',
    desc: 'Save a note or decision to cross-session memory',
    tool: 'aegis_memory_save',
    build: (arg) => ({ content: arg }),
  },
  {
    name: 'aegis-council', aliases: ['council'], args: ['question'], hint: '<question>', category: 'aegis',
    desc: 'Put a question to the ÆGIS council (multi-perspective deliberation)',
    hidden: () => !cloudReady(),
    handler: async (c, args) => {
      const q = (args._rest || args.question || '').trim();
      if (!q) { note(c, 'Usage: /aegis-council <question>'); c.render(); return true; }
      await c.runPrompt(composeResearchPrompt(`Deliberate as a council and vote on: ${q}`, process.cwd()));
      return true;
    },
  },
  {
    name: 'aegis-print', args: ['question'], hint: '<question>', category: 'aegis',
    desc: 'Ask pooled inference and print the answer cleanly',
    hidden: () => !cloudReady(),
    handler: async (c, args) => {
      const q = (args._rest || args.question || '').trim();
      if (!q) { note(c, 'Usage: /aegis-print <question>'); c.render(); return true; }
      const res = await c.ask(q);
      panel(c, panels.buildAegisPrint('ÆGIS', { result: res.text, model: res.model, provider: 'aegis' }, c.ctx));
      c.render();
      return true;
    },
  },
  {
    name: 'aegis-multi', args: ['task', 'mode'], hint: '<task> [run]', category: 'aegis',
    desc: 'Compose an ÆGIS /multi multi-agent task (add "run" to execute)',
    hidden: () => !cloudReady(),
    handler: async (c, args) => {
      let task = (args._rest || args.task || '').trim();
      let mode = (args.mode || '').toLowerCase();
      if (mode !== 'run' && /\s+run$/i.test(task)) { mode = 'run'; task = task.replace(/\s+run$/i, '').trim(); }
      if (!task) { note(c, 'Usage: /aegis-multi <task> [run]'); c.render(); return true; }
      if (mode !== 'run') { panel(c, panels.buildAegisMulti(task, c.ctx)); c.render(); return true; }
      note(c, 'Running /multi headless — this skips aegis-cli\'s confirmation step.');
      await c.runPrompt(task);
      return true;
    },
  },

  // ── cloud-only additions (not in the reference vocabulary) ────────────────
  {
    // A bare `provider -> info` map is the wrong shape for a picker: it can only
    // describe providers you have ALREADY set, and the question this command
    // answers is "which key should I go buy". A command is either handler- or
    // tool-backed, never both (`cli-commands.test.mjs` enforces exactly one), so
    // this is handler-backed and reaches for the tool by name only as the
    // fallback for a server that predates the catalog — the command still works,
    // just with the older, sparser answer.
    name: 'byok', hint: '', category: 'auth',
    desc: 'List every provider you can bring your own key for, and which are set',
    handler: async (c) => {
      const providers = await byokCatalog(c.client);
      if (!providers) {
        await c.runTool('aegis_byok_status', {});
        return true;
      }
      const set = providers.filter((p) => p.configured).length;
      const lines = [
        [span(C.gold + BOLD, 'Bring your own key'), span(BOLD_OFF, '')],
        [span(C.gray, '─'.repeat(34))],
        [
          span(set ? C.green : C.gray, `  ${set} of ${providers.length} providers set`),
          span(C.gray, '  — /byok-key <provider>'),
        ],
        '',
        ...byokProviderLines(providers),
      ];
      panel(c, lines);
      c.render();
      return true;
    },
  },
  {
    name: 'byok-set', args: ['provider'], hint: '<provider>', category: 'auth',
    desc: 'Store your provider key on your AEGIS ACCOUNT (pooled route) — for the byok class use /byok-key',
    tool: 'aegis_byok_set',
    secret: 'key',
    build: (arg) => ({ provider: String(arg || '').trim() }),
    /**
     * Say which key this is and where to get it, before the prompt.
     *
     * The old prompt was `provider key for openai:` — which assumes the reader
     * already knows that a provider id is a company, and leaves them nothing to
     * check a pasted key against. Here the catalog names the provider, lists the
     * models the key unlocks, links the place to create it, and states the
     * prefix a valid key begins with, so a key for the wrong vendor is visible
     * before it is stored rather than as an upstream 401 later.
     *
     * Resolved against aliases too, so the prompt agrees with the id that will
     * actually be sent (`/byok-set OpenAI` → `openai`, not `OpenAI`).
     */
    async secretDescribe(args, client) {
      const typed = String(args.provider || '').trim();
      const providers = await byokCatalog(client);
      if (!providers) {
        // No catalog: still refuse to prompt for an empty provider, and keep the
        // words "provider key" so the request is intelligible on its own.
        return typed ? null : { note: 'Usage: /byok-set <provider> — /byok lists them.', prompt: 'provider key: ' };
      }
      const match = findByokProvider(providers, typed);
      if (match.ambiguous) {
        return {
          note: `"${typed}" matches ${match.ambiguous.join(', ')} — retype the exact id. Nothing was sent.`,
          prompt: null,
        };
      }
      const p = match.provider;
      if (!p) {
        const ids = providers.map((x) => x.id).join(', ');
        return { note: `unknown provider "${typed}". Known ids: ${ids}`, prompt: null };
      }
      if (p.configured) {
        return {
          note: `${p.id} already has a key${p.masked ? ` (${p.masked})` : ''} — pasting a new one replaces it.`,
          prompt: `new ${p.label || p.id} key: `,
        };
      }
      const bits = [`${p.label || p.id}`];
      const models = (p.models || [])
        .map((m) => (typeof m === 'string' ? m : m && m.id))
        .filter(Boolean);
      if (models.length) bits.push(`unlocks ${models.join(', ')}`);
      if (p.key_prefix) bits.push(`key starts with ${p.key_prefix}`);
      if (p.key_url) bits.push(`create one at ${p.key_url}`);
      return { note: bits.join(' · '), prompt: `${p.id} key: ` };
    },
  },
  {
    name: 'byok-rm', args: ['provider'], hint: '<provider>', category: 'auth',
    desc: 'Remove a stored provider key',
    tool: 'aegis_byok_set',
    build: (arg) => ({ provider: String(arg || '').trim() }),
  },
  {
    name: 'class', args: ['class'], hint: '[aegis|byok]', category: 'model',
    desc: 'Show or switch which class turns run on: pooled AEGIS Cloud, or your own key',
    handler: async (c, a) => {
      const args = a || {};
      const cur = (c.ctx && c.ctx.modelClass) || 'aegis';
      const label = (id) => (c.classLabel ? c.classLabel(id) : id);
      const want = String(args.class || '').trim().toLowerCase();
      if (!want) {
        // Awaited: the engine's listClasses() is async (it probes for a local
        // Ollama before answering), and a context that offers no class surface
        // at all falls back to the two static rows below.
        const classes = await Promise.resolve(c.classes ? c.classes() : []).catch(() => []);
        const rows = classes.length ? classes : [{ class: 'aegis' }, { class: 'byok' }];
        const lines = [
          [span(C.gold + BOLD, 'Class'), span(BOLD_OFF, '  — which route the next turn takes')],
          [span(C.gray, '─'.repeat(52))],
        ];
        for (const k of rows) {
          const id = k.class;
          const on = id === cur;
          // The distinction that matters to a user: who pays, and with which
          // credential. Stated per class rather than in a footnote.
          const note =
            id === 'byok'
              ? k.configured
                ? 'your key, relayed by AEGIS — billed a handling fee'
                : 'needs a provider key: /byok-key <provider>'
              : 'the pool — your AEGIS account key pays for it';
          lines.push([
            span(on ? C.green : C.gray, `  ${on ? '●' : '○'} ${String(id).padEnd(6)}`),
            span(on ? C.green : C.gray, label(id)),
            span(C.gray, `  ${note}`),
          ]);
        }
        lines.push('', [span(C.gray, '  switch with /class byok or /class aegis')]);
        panel(c, lines);
        c.render();
        return true;
      }
      const res = c.switchClass(want);
      if (!res.ok) {
        c.push({ role: 'error', text: res.error });
        return true;
      }
      c.push({ role: 'done', text: `class: ${res.class} — ${label(res.class)}` });
      if (res.cleared) {
        c.push({
          role: 'note',
          text: `cleared the pin "${res.cleared}" — it does not belong to this class. /models lists what fits.`,
        });
      }
      // Entering byok with nothing pinned fails the very next turn: the relay's
      // model id must be "<provider>:<model>" and there is no server default to
      // fall back to (engine.js chatCompletion throws a 400 on a bare id). So
      // land on one this machine can actually run — a provider it holds a key
      // for wins, since the alternative 400s on the key rather than the id.
      if (res.class === 'byok' && !(c.ctx && c.ctx.model)) {
        const models = (await c.listModelsFor('byok')) || [];
        const pick = models.find((m) => m.configured) || models[0];
        if (pick) {
          c.ctx.model = pick.id;
          c.saveConfig({ model: pick.id, currentModelId: pick.id });
          c.push({
            role: 'note',
            text: pick.configured
              ? `using ${pick.id} — /models lists the rest.`
              : `using ${pick.id}, but no ${pick.provider} key is saved yet — /byok-key ${pick.provider}.`,
          });
        } else if (models.length === 0) {
          c.push({
            role: 'note',
            text: 'nothing to relay yet — save a provider key with /byok-key <provider>, then /models.',
          });
        }
      }
      return true;
    },
  },
  {
    name: 'models', aliases: ['model-list'], hint: '', category: 'model',
    desc: 'List the model ids you can pin with /model, for the class you are on',
    handler: async (c) => {
      const cls = (c.ctx && c.ctx.modelClass) || 'aegis';
      const models = (await c.listModelsFor(cls)) || [];
      const lines = [
        [span(C.gold + BOLD, 'Models'), span(BOLD_OFF, `  — ${c.classLabel ? c.classLabel(cls) : cls}`)],
        [span(C.gray, '─'.repeat(52))],
      ];
      if (!models.length) {
        lines.push('', [
          span(
            C.gray,
            cls === 'byok'
              ? '  nothing to relay yet — save a provider key with /byok-key <provider>'
              : '  no models advertised — check the account with /status, then retry'
          ),
        ]);
      } else {
        const pinned = c.ctx && c.ctx.model;
        for (const m of models) {
          const on = pinned === m.id;
          lines.push([
            span(on ? C.green : C.gray, `  ${on ? '●' : '○'} `),
            span(on ? C.green : C.gray, String(m.id).padEnd(30)),
            span(C.gray, m.note || m.label || ''),
          ]);
        }
        lines.push('', [span(C.gray, '  pin one with /model <id> — /model alone opens the picker')]);
      }
      panel(c, lines);
      c.render();
      return true;
    },
  },
  {
    name: 'byok-key', args: ['provider'], hint: '<provider> [key]', category: 'auth',
    desc: 'Save YOUR provider key on THIS MACHINE — the key the byok class sends',
    handler: async (c, a) => {
      const args = a || {};
      const typed = String(args.provider || '').trim().toLowerCase();
      if (!typed) {
        c.push({ role: 'error', text: 'Usage: /byok-key <provider> — /byok lists the providers.' });
        return true;
      }
      const store = c.settings && c.settings();
      if (!store || typeof store.set !== 'function') {
        c.push({ role: 'error', text: 'this client has no provider-key store.' });
        return true;
      }
      // Resolve the alias against the server's catalog so the row is written
      // under the id the relay will actually be asked for (`/byok-key OpenAI`
      // and `/byok-key openai` must be one key, not two).
      const providers = await byokCatalog(c.client);
      const match = providers ? findByokProvider(providers, typed) : null;
      if (match && match.ambiguous) {
        c.push({ role: 'error', text: `"${typed}" matches ${match.ambiguous.join(', ')} — retype the exact id.` });
        return true;
      }
      const p = match && match.provider;
      const id = (p && p.id) || typed;
      // A second token is the scriptable path (`/byok-key openai sk-…`); with
      // none we prompt — readSecret never echoes and never enters history.
      const rest = String(args._rest || '').trim();
      const sp = rest.indexOf(' ');
      let key = sp === -1 ? '' : rest.slice(sp + 1).trim();
      if (!key) {
        if (p && p.key_url) c.push({ role: 'note', text: `create a ${p.label || id} key at ${p.key_url}` });
        key = String((await c.readSecret(`${id} key: `)) || '').trim();
      }
      if (!key) {
        c.push({ role: 'note', text: 'nothing saved.' });
        return true;
      }
      if (p && p.key_prefix && !key.startsWith(p.key_prefix)) {
        c.push({ role: 'note', text: `heads up: ${id} keys normally start with "${p.key_prefix}" — saved anyway.` });
      }
      store.set(c.byokNamespace(id), { key });
      c.push({
        role: 'done',
        text: `saved a ${id} key on this machine — /models lists its models, /class byok runs on it.`,
      });
      return true;
    },
  },
  {
    name: 'byok-rm-key', args: ['provider'], hint: '<provider>', category: 'auth',
    desc: 'Forget the provider key saved on this machine',
    handler: async (c, a) => {
      const args = a || {};
      const id = String(args.provider || '').trim().toLowerCase();
      if (!id) {
        c.push({ role: 'error', text: 'Usage: /byok-rm-key <provider> — /byok lists the providers.' });
        return true;
      }
      const store = c.settings && c.settings();
      if (!store || typeof store.remove !== 'function') {
        c.push({ role: 'error', text: 'this client has no provider-key store.' });
        return true;
      }
      const row = c.byokNamespace(id);
      const had = typeof store.rawKey === 'function' ? store.rawKey(row) : null;
      store.remove(row);
      c.push({
        role: had ? 'done' : 'note',
        text: had ? `removed the ${id} key from this machine.` : `no ${id} key was saved on this machine.`,
      });
      return true;
    },
  },
  {
    name: 'tool', args: ['name', 'json'], hint: '<name> [json]', category: 'aegis',
    desc: 'Call any registry tool directly (escape hatch for new tools)',
    generic: true,
    build: (arg) => {
      const s = String(arg || '');
      const sp = s.indexOf(' ');
      const name = (sp === -1 ? s : s.slice(0, sp)).trim();
      const rest = sp === -1 ? '' : s.slice(sp + 1).trim();
      let args = {};
      if (rest) {
        try {
          args = JSON.parse(rest);
        } catch (err) {
          throw new Error(`/tool: arguments must be JSON — ${err.message}`);
        }
      }
      return { tool: name, args };
    },
  },
  {
    name: 'aegis-import', aliases: ['import'], hint: '[--confirm]', category: 'aegis',
    desc: 'Import memory from other AI tools on this machine (dry run unless --confirm)',
    tool: 'aegis_memory_import',
    build: (arg) => ({ confirm: /--confirm\b/.test(String(arg || '')) }),
  },
];

// ── Index + the one invariant a table like this must hold ─────────────────────
// A name or alias registered twice would silently shadow the earlier entry, so
// the collision is a module-load error rather than a runtime surprise.

const BY_NAME = new Map();
for (const c of COMMANDS) {
  for (const n of [c.name, ...(c.aliases || [])]) {
    if (BY_NAME.has(n)) {
      throw new Error(`aegiscode: command name or alias /${n} is registered twice`);
    }
    BY_NAME.set(n, c);
  }
}

/** Every builtin entry, in palette order, with its category label attached. */
function allCommands() {
  return COMMANDS.map((entry) => ({ ...entry, categoryLabel: categoryLabel(entry.category) }));
}

/** Commands shown in the palette, /help and Tab completion. */
function visibleCommands() {
  return allCommands().filter((c) => !(typeof c.hidden === 'function' ? c.hidden() : c.hidden));
}

/** Find by name or alias, case-insensitive. Returns the entry or null. */
function findCommand(name) {
  return BY_NAME.get(String(name || '').toLowerCase()) || null;
}

/** The canonical name of a command, resolving aliases. */
function canonicalName(name) {
  const e = findCommand(name);
  return e ? e.name : name;
}

/**
 * Classify one input line.
 * @returns {{kind:'empty'}
 *   |{kind:'command',command:object,arg:string}
 *   |{kind:'unavailable',command:object,arg:string}
 *   |{kind:'unknown',name:string,text:string}
 *   |{kind:'prompt',text:string}}
 */
function parseLine(line) {
  const raw = String(line == null ? '' : line);
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };
  if (trimmed[0] !== '/') return { kind: 'prompt', text: trimmed };
  const sp = trimmed.indexOf(' ');
  const name = (sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp)).trim();
  const arg = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
  const command = findCommand(name);
  if (!command) return { kind: 'unknown', name, text: trimmed };
  if (command.unavailable) return { kind: 'unavailable', command, arg };
  return { kind: 'command', command, arg };
}

/** Commands that map to a registry tool, for the coverage test. */
function toolBackedCommands() {
  return COMMANDS.filter((c) => c.tool);
}

module.exports = {
  CATEGORIES,
  categoryLabel,
  EFFORT_LEVELS,
  COMMANDS,
  allCommands,
  visibleCommands,
  findCommand,
  canonicalName,
  parseLine,
  toolBackedCommands,
};
