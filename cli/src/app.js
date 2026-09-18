'use strict';

/**
 * The CLI application: session state, the ask/stream path, and the command
 * dispatcher.
 *
 * Split from `bin/aegiscode.js` so the whole app is constructible with injected
 * IO (`out`, `err`, `readline`) and a stub client — the tests drive real turns,
 * real streaming and real command dispatch without a TTY and without a child
 * process. Bin entry = argument parsing and process lifecycle; everything else
 * lives here.
 *
 * Commands come from `./commands.js`. Each entry is either handler-backed
 * (`cmd.handler(c, args)`, the reference aegiscodex-dev contract), tool-backed
 * (`cmd.tool` + `cmd.build`), a generic escape hatch (`cmd.generic`, `/tool`),
 * or `unavailable` (a Claude Code auth-loop command this client cannot honour).
 * Handlers run against the FROZEN command context built below; the tool path
 * and the `/tool` escape hatch are unchanged from the previous revision.
 */

const readline = require('node:readline');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createTools, createClient, usageTokens, buildSystemPrompt } = require('./deps.js');
const { createEngine, HOST_CLASSES, DEFAULT_CLASS, byokNamespace } = require('./engine.js');
const { GLYPH, VERBS, themeOf, RESET, THEME_TABLE } = require('./theme.js');
const { LiveRegion, termWidth, w } = require('./screen.js');
const { editPreview } = require('./diff.js');
const { defaultOpen } = require('./diffview.js');
const { parseLine, COMMANDS, visibleCommands } = require('./commands.js');
const {
  updateConfig,
  loadPermissions,
  loadConfig,
  configExists,
  memoryPersistState,
  memoryPersistEnabled,
  setMemoryPersist,
} = require('./config.js');
const credentials = require('./credentials.js');
const cloudsync = require('./cloudsync.js');
const { readSecret } = require('./secret.js');
const customModelsCatalog = require('./custommodels.js');
const { normalizeModelCatalog, pickerEntries, catalogIds } = require('./models.js');
const { appendHistory, readSessionTranscript, readOwnSessions } = require('./history.js');
const { snapshotCheckpoint } = require('./checkpoint.js');
const screens = require('./screens.js');
const chatflow = require('./chatflow.js');
const overlays = require('./overlays.js');
const render = require('./render.js');
const { fmtTokens, fmtEur, maskKey } = require('./format.js');

const VERSION = require('../package.json').version;

/**
 * The persona for a turn this host did not get an explicit system prompt for.
 *
 * Built once and cached: it is the stable head of every request, and a prompt
 * that changed between turns would defeat the provider's prompt cache for the
 * whole conversation behind it.
 */
let _defaultSystem = null;
function defaultSystemPrompt() {
  if (_defaultSystem === null) {
    try {
      _defaultSystem = buildSystemPrompt({
        platform: process.platform,
        arch: process.arch,
        homedir: os.homedir(),
        cwd: process.cwd(),
      });
    } catch {
      _defaultSystem = ''; // never let persona construction break a turn
    }
  }
  return _defaultSystem || undefined;
}

// The engine accepts exactly 'once' | 'session' and coerces anything else to
// 'deny' (vendor/desktop/lib/local/engine.js → respondApproval). Bridging the
// vocabularies here, rather than trusting every prompter to speak the engine's
// dialect, is what stops an approval from silently becoming a denial. The
// failure mode is invisible from the outside: the tool is refused, the model
// is told the user declined, and it retries against a gate that can only ever
// say no — the turn burns its whole budget.
//
// Module scope on purpose: this must exist before createApp() runs, because it
// is re-exported for the conformance tests. A nested copy here previously left
// the export binding undefined and threw on require.
function normalizeDecision(decision) {
  const v = typeof decision === 'string' ? decision.trim().toLowerCase() : '';
  if (v === 'session') return 'session';
  if (v === 'once' || v === 'allow' || v === 'yes' || v === 'approve' || v === 'approved') {
    return 'once';
  }
  return 'deny';
}

function createApp(options = {}) {
  const opts = {
    model: null,
    stream: true,
    light: false,
    maxTokens: undefined,
    system: undefined,
    interactive: true,
    ...options,
  };
  const out = options.out || process.stdout;
  const err = options.err || process.stderr;
  // The key comes from the credential store (env → credentials.json →
  // config.json) rather than from the environment alone: an export does not
  // survive a new shell, and until it is *stored* every one of those launches
  // is "no key" with no in-band way to set one. An injected client keeps
  // whatever key it was built with.
  const client = options.client || createClient(credentials.clientOptions());
  const { TOOLS, toolList } = options.tools || createTools(client);

  // Tool-approval gate (exec/writeFile/editFile confirm before running).
  // Read per call, so /permissions and /yolo take effect on the very next tool
  // round rather than needing a restart. The mode is read LIVE from the
  // permission store rather than from a boolean captured at construction:
  // `/yolo` and `/confirm` write the store, so a captured flag made both
  // commands cosmetic — the panel changed while the engine kept asking.
  let confirmMode = options.confirmMode !== false;
  const engine =
    options.engine ||
    createEngine({
      client,
      // The live class — read per turn rather than captured, for the same
      // reason confirmMode is a callback: a captured value made `/class`
      // cosmetic, changing the panel and not what the next turn ran on.
      getClass: () => commandCtx.modelClass,
      getConfirmMode: () => {
        if (options.confirmMode !== undefined) return confirmMode;
        try {
          return loadPermissions().defaultMode !== 'allow';
        } catch {
          return confirmMode;
        }
      },
    });
  // How a class is named in every surface that shows one (the status line, the
  // class panel, the model picker's title). One definition, because the engine
  // owns the label table (CLASS_LABELS) and re-spelling it here would let the
  // picker and /class disagree about what the user is about to run on. Guarded
  // because an injected engine (tests, embedding) may predate the class surface.
  const classLabelOf = (cls) =>
    typeof engine.classLabel === 'function' ? engine.classLabel(cls) : String(cls || '');

  // Set by runInteractive: a question/answer channel for the engine's
  // tool-approval requests. Left null in one-shot (-p) runs, where there is
  // no one to ask — see the approval branch in ask() below.
  let approvalPrompter = null;

  const width = () => (options.width ? options.width() : termWidth());

  // ── live session/command state ─────────────────────────────────────────────
  // `commandCtx` is the FROZEN `c.ctx` a handler receives: the mutable slice of
  // session state a command may set (model, effort, thinking, theme, vim, stream,
  // cwd, lastRecap). The renderers read their colours from it via ctx().
  const commandCtx = {
    light: opts.light,
    model: opts.model,
    // Which class the next turn runs on. 'aegis' is the default because it is
    // the one class an account key alone can run — BYOK additionally needs a
    // provider key, so defaulting to it would break a fresh install.
    modelClass: DEFAULT_CLASS,
    // `null` = "auto": send no effort, so the server sizes the turn from the
    // ask. This is the *budget* control on the pooled class (aegis1 sizes the
    // token ladder from it), which is why it is not defaulted to a rung here —
    // pinning one would make every turn cost what that rung grants.
    effort: null,
    thinking: false,
    // Deep recall (`aegis_recall_deep`) — the metered tier of the read: brain
    // corrections plus the semantic answer cache, and the answer cache costs
    // one provider embedding per turn (aegis1 app.py:8367 →
    // services/brain_memory.py find_cached_answer). This host recalls on every
    // turn already and pays per turn, so the deep tier is NEVER inferred: it is
    // false here, `/memory-deep on` is the only thing that flips it, and that
    // choice is deliberately NOT persisted — a flag that meters every turn must
    // not survive into a session where nobody asked for it.
    recallDeep: false,
    themeIndex: opts.light ? 2 : 1,
    vim: false,
    stream: opts.stream,
    cwd: process.cwd(),
    lastRecap: null,
    sessionId: randomUUID(),
  };
  // The transcript rows a handler reads/pushes (user/assistant/note/panel/…).
  // It is also the source of the engine's conversation history, so /clear and
  // /new genuinely reset context.
  const transcript = [];
  let wantExit = false;

  const ctx = () => ({ light: commandCtx.light });

  const session = {
    turns: 0,
    calls: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0, // € spent, from the ledger rows that landed AFTER the baseline
    balance: null,
    // How many times each ledger-row identity is already accounted for.
    // A COUNT, not a Set — see ledgerRowKey for why identity is content-based
    // and refreshSpend for why the multiplicity matters.
    seenLedgerRows: new Map(),
    // Whether the account's existing ledger has been snapshotted as history.
    // The balance endpoint returns the ACCOUNT's ledger, so the rows visible on
    // the first refresh are everything the customer ever spent. Until this is
    // true, no row may be folded into `cost`: session.cost is rendered as
    // "This session" and would otherwise print the account's lifetime spend
    // under it. See refreshSpend.
    ledgerBaselined: false,
    startedAt: Date.now(),
  };

  let activeSessionId = null;
  let closed = false;

  // --- helpers --------------------------------------------------------------

  /**
   * How much one ledger row is worth to the customer, in EUR (always >= 0).
   *
   * `amount_eur` is signed from the user's side (negative = spent) and is what
   * /api/token-bank/balance actually returns. `charged_micros` is the raw
   * column with the OPPOSITE sign, kept only as a fallback for a server build
   * that drops amount_eur — which is why it is negated here.
   *
   * Returns null for a row that is not a charge at all, or that carries no
   * usable number. Anything non-finite is null rather than NaN: a NaN that
   * reaches a tally poisons it for the rest of the session, and a NaN written
   * into history.jsonl is invisible until /cost renders it.
   */
  function ledgerRowEur(row) {
    if (!row || typeof row !== 'object') return null;
    // A top-up is money IN, not a charge. Folding one into the spend tally
    // would report a customer who just added €20 as having spent €20.
    if (row.kind !== 'usage') return null;
    const raw = row.amount_eur != null ? Number(row.amount_eur) : -Number(row.charged_micros || 0) / 1e6;
    if (!Number.isFinite(raw)) return null;
    // The magnitude is the charge either way; the server's sign convention for
    // a spend row is not something this client should depend on.
    return Math.abs(raw);
  }

  /**
   * The identity of a ledger row, used to decide "is this new?".
   *
   * Deliberately NOT `created_at`. That column is stamped to the second, so two
   * turns inside the same second collide: the second row compared equal to the
   * first, was skipped as "already counted", and — because chatflow persists the
   * turn with whatever this returned — the exchange was written to history.jsonl
   * with NO charge attached. /cost then fell back to the local rate table for
   * that turn and reported a figure that was not the bill. Every column the
   * endpoint returns that can distinguish two rows is folded in here.
   *
   * The endpoint returns no unique row id (see mcp/tools.js, which reads the
   * same columns), so this is content-based and two genuinely identical charges
   * — same model, same token counts, same second — hash the same. That is why
   * callers count occurrences rather than merely testing membership: a Set
   * would treat the second identical charge as already-counted and silently
   * under-bill it, which is the original defect wearing a different hat.
   */
  function ledgerRowKey(row) {
    return [
      row.created_at || '',
      row.kind || '',
      row.amount_eur != null ? row.amount_eur : '',
      row.charged_micros != null ? row.charged_micros : '',
      row.id != null ? row.id : '',
      row.note != null ? row.note : '',
    ].join('|');
  }

  /** Refresh the balance and fold any *new* usage row into the session tally.
   *
   *  The first successful refresh of a session is a BASELINE: it observes the
   *  account's whole ledger and folds nothing. Each entry point therefore calls
   *  this once at session start, so the baseline can never swallow a real
   *  turn's charge. Best-effort: an accounting refresh must never break a turn.
   *
   *  @returns {Promise<{balance:number, lastCost:number|null}|null>} */
  async function refreshSpend() {
    try {
      const data = await client.tokenBankBalance();
      const balance = Number(data.balance_eur);
      if (Number.isFinite(balance)) session.balance = balance;
      let lastCost = null;
      const ledger = Array.isArray(data.ledger) ? data.ledger : [];

      // Fold every row that is new since the last refresh, not just the head of
      // the list. A single refresh can legitimately see more than one unseen
      // charge — a refresh skipped while the balance endpoint was down, a long
      // tool turn that dispatched two billed provider calls, or the first
      // refresh after /billing already consumed the head — and taking only
      // ledger[0] silently dropped the rest from the session tally.
      //
      // Count occurrences within the pass BEFORE folding, so two identical rows
      // are billed twice. Testing membership one row at a time cannot tell the
      // first occurrence from the second and under-charges by one.
      const seenHere = new Map(); // key -> { n, row }
      for (const row of ledger) {
        const key = ledgerRowKey(row);
        const hit = seenHere.get(key);
        if (hit) hit.n += 1;
        else seenHere.set(key, { n: 1, row });
      }

      for (const [key, { n, row }] of seenHere) {
        const already = session.seenLedgerRows.get(key) || 0;
        session.seenLedgerRows.set(key, n);

        // This endpoint returns the ACCOUNT's ledger, so on the opening refresh
        // it holds everything the customer has ever spent. Those rows are
        // history — mark them seen and fold nothing, so `cost` starts at zero.
        //
        // Reaching this loop at all means the endpoint answered, so this pass
        // really did observe the full ledger and it is safe to call it the
        // baseline. That is deliberately self-healing: if the session-start
        // call failed (offline, no balance rights) the NEXT successful refresh
        // becomes the baseline, and the worst case is one turn under-reported.
        // The reverse — folding an unobserved ledger — would report the
        // customer's lifetime spend as "This session", a number they already
        // paid and are not being charged again.
        if (!session.ledgerBaselined) continue;

        // Only the occurrences beyond those already accounted for are new.
        const fresh = n - already;
        if (fresh <= 0) continue;

        const eur = ledgerRowEur(row);
        if (eur != null && eur > 0) {
          session.cost += eur * fresh;
          // The charge to attribute to this turn. The endpoint returns the
          // ledger NEWEST-FIRST (mcp/tools.js takes `.slice(0, 5)` as "Recent
          // activity" and renders those as the latest rows), and the folds above
          // run in that order, so the first charge seen here is the newest —
          // i.e. the row this turn just produced. Taking the first rather than
          // the largest matters when one pass sees several: the max would
          // report an older, pricier call as this turn's cost.
          if (lastCost == null) lastCost = eur;
        }
      }
      session.ledgerBaselined = true;

      return { balance: session.balance, lastCost };
    } catch {
      return null; // no balance rights / offline: keep showing tokens
    }
  }

  // ── the AEGIS account key ─────────────────────────────────────────────────
  //
  // Set/forget at runtime, for `/key` and `aegiscode login`. Both paths are the
  // same three steps — persist, apply to the live client, invalidate the model
  // catalog — because a key that is stored but not applied leaves the current
  // session failing, and one that is applied but not stored is gone next launch.

  /**
   * Persist an account key and start using it immediately.
   *
   * `verify` spends one `/api/verify-api-key` round trip to catch a bad key at
   * the moment it is entered rather than at the first prompt, and is also how
   * the memory token (cloud sync's credential) is obtained — so a successful
   * login leaves both credentials in the store.
   */
  async function setApiKey(raw, { verify = true } = {}) {
    const saved = credentials.saveApiKey(raw);
    if (!saved.ok) return saved;
    client.setApiKey(saved.key);
    modelCache.models = [];
    modelCache.at = 0;
    let account = null;
    let error = null;
    if (verify) {
      try {
        const info = (await client.verifyApiKey()) || {};
        account = info;
        const patch = { verifiedAt: new Date().toISOString() };
        if (info.memory_token) patch.memoryToken = info.memory_token;
        if (info.plan) patch.plan = info.plan;
        patch.account = { plan: info.plan || null, email: info.email || null, valid: info.valid !== false };
        credentials.writeCredentials(patch);
        if (info.plan) session.plan = info.plan;
        if (info.email) session.account = { ...(session.account || {}), email: info.email };
      } catch (e) {
        error = e;
      }
    }
    return { ...saved, account, error };
  }

  /** Drop the stored key and stop authenticating this session. */
  function forgetApiKey() {
    const res = credentials.clearApiKey();
    client.setApiKey('');
    modelCache.models = [];
    modelCache.at = 0;
    return res;
  }

  /**
   * The persisting-memory gate — the WRITE half of aegis_memory, and now ON by
   * default for every account (see config.js `memoryPersistState` for the
   * migration and the reasoning). The name is historical: `/sync`, `/cloud sync`
   * and `cloudSyncEnabled()` predate the flip, and they all mean this one gate,
   * so there is exactly one boolean behind every switch and status line.
   */
  function cloudSyncEnabled() {
    try {
      return memoryPersistEnabled();
    } catch {
      return true; // default on: a corrupt config must not silently stop storage
    }
  }

  /** Where that answer came from — 'config' | 'legacy' | 'default'. */
  function cloudSyncState() {
    try {
      return memoryPersistState();
    } catch {
      return { enabled: true, source: 'default', explicit: false };
    }
  }

  function setCloudSync(on) {
    return setMemoryPersist(on);
  }

  /**
   * Copy a key found in config.json into the 0600 store, once, so the next run
   * reads the tight copy. Never deletes the original — that file belongs to
   * another product and holds the user's key.
   */
  function adoptLegacyKeyOnce() {
    try {
      const resolved = credentials.resolveApiKey();
      if (resolved.source !== 'config') return [];
      return credentials.adoptLegacy().adopted;
    } catch {
      return [];
    }
  }

  // ── the AEGIS Cloud model catalog ──────────────────────────────────────────
  //
  // `/model` (and the alt+p chord that dispatches it) reads the pinnable ids
  // from the server, and `state().models` is where it looks. That path had no
  // source at all: `commands.js` calls `c.loadModels()` inside a `try {} catch
  // {}`, `c.loadModels` was never defined on either command context, and
  // `buildState()` hardcoded `models: []` — so the TypeError was swallowed and
  // both `/model` and the picker reported "no models advertised" on a perfectly
  // healthy account, forever. The ids themselves are the server's (see
  // models.js), fetched here and cached, because the pool adds and retires
  // providers without a client release.
  const MODEL_CACHE_MS = 5 * 60_000;
  const modelCache = { at: 0, models: [] };
  // The BYOK half of the same question. A BYOK model id is `provider:model`
  // (the engine's splitByokModel), built from the server's provider catalog
  // plus the provider rows this machine actually holds a key for — so this list
  // is per-machine, not per-account, and cannot be served by the pooled catalog.
  const byokCache = { at: 0, models: [] };

  async function loadByokModels({ force = false } = {}) {
    const fresh = byokCache.models.length && Date.now() - byokCache.at < MODEL_CACHE_MS;
    if (!force && fresh) return byokCache.models;
    // An injected engine (tests, embedding) may predate the class surface; an
    // empty list is the honest answer then, not a fabricated one.
    if (typeof engine.listModels !== 'function') return [];
    const res = await engine.listModels('byok');
    // The engine's row is `{id: "provider:model", label, provider, configured}`.
    // `note` is added here because it is the field both renderers actually paint
    // (the picker draws `m.note || m.model`, /models draws `m.note || m.label`)
    // and because "openai:gpt-4o" alone does not say whether this machine holds
    // the key the relay would ask for — a row without one is a turn that 400s,
    // so it names the command that fixes it.
    byokCache.models = ((res && res.models) || []).map((m) => ({
      ...m,
      note: m.configured ? 'key on this machine' : `no key — /byok-key ${m.provider}`,
    }));
    byokCache.at = Date.now();
    return byokCache.models;
  }

  /**
   * The ids pinnable on one class — the ONE function `/model`, alt+p and
   * `/models` all read, so the picker cannot offer something the class the turn
   * runs on would reject. Both branches swallow their failure into "nothing to
   * offer": a catalog is a convenience, and an offline client must still be
   * able to chat on the server's own default.
   */
  async function loadCustomModels() {
    // The `custom` catalog is local (config.json + the 0600 key store), so this
    // never touches the network and needs no cache. The engine already returns
    // the picker/`/models` shape ({id, label, note, configured, wire}).
    if (typeof engine.listModels !== 'function') return [];
    const res = await engine.listModels('custom');
    return (res && res.models) || [];
  }

  async function listModelsFor(cls) {
    const want = HOST_CLASSES.includes(cls) ? cls : commandCtx.modelClass;
    try {
      if (want === 'byok') return await loadByokModels();
      if (want === 'custom') return await loadCustomModels();
      return await loadModels();
    } catch {
      return [];
    }
  }

  /**
   * Whether a pinned id can run on `cls`, decided synchronously (switchClass is
   * not async). byok ids are `provider:model`; custom ids are the catalog's
   * own (config.json, read sync); aegis takes anything that is neither — the
   * pooled catalog is validated separately, at launch, by validatePinnedModel.
   */
  function pinBelongsToClass(cls, id) {
    const s = String(id == null ? '' : id);
    if (cls === 'byok') return s.includes(':');
    if (cls === 'custom') return Boolean(customModelsCatalog.getCustom(s));
    // aegis: not a byok id and not a custom-catalog id.
    return !s.includes(':') && !customModelsCatalog.getCustom(s);
  }

  /**
   * Switch the live class. Refuses anything this host cannot run (engine.js's
   * HOST_CLASSES is the authority — the local/custom classes stay stubs).
   *
   * A pin is cleared when it does not belong to the class being entered: a
   * pooled id pinned under byok would be parsed as provider `<pooled id>` and
   * fail at the relay with a confusing "no key saved for …" instead of here,
   * with a reason. Symmetrically, `anthropic:claude-…` under aegis is an id the
   * pooled catalog does not advertise, which is the silent-fallback case
   * validatePinnedModel exists to prevent. The `custom` class owns its own id
   * space (the /model add catalog, resolvable synchronously from config.json),
   * so a pin belongs to it exactly when it is one of those ids.
   */
  function switchClass(next) {
    const want = String(next == null ? '' : next).trim().toLowerCase();
    if (!HOST_CLASSES.includes(want)) {
      return { ok: false, error: `unknown class "${next}" — classes: ${HOST_CLASSES.join(', ')}` };
    }
    const prev = commandCtx.modelClass;
    commandCtx.modelClass = want;
    let cleared = null;
    if (prev !== want && commandCtx.model) {
      if (!pinBelongsToClass(want, commandCtx.model)) {
        cleared = commandCtx.model;
        commandCtx.model = null;
      }
    }
    updateConfig({
      modelClass: want,
      model: commandCtx.model,
      currentModelId: commandCtx.model,
    });
    return { ok: true, class: want, prev, cleared };
  }

  /**
   * Fetch (or return the cached) model catalog. Rejects when the account cannot
   * read it at all — no key, offline, or a server error — which callers treat as
   * "nothing to offer" rather than retrying per keystroke.
   * @returns {Promise<Array<{id:string,label:string,note:string}>>}
   */
  async function loadModels({ force = false } = {}) {
    const fresh = modelCache.models.length && Date.now() - modelCache.at < MODEL_CACHE_MS;
    if (!force && fresh) return modelCache.models;
    const data = await client.listModels();
    modelCache.models = normalizeModelCatalog(data && data.models);
    modelCache.at = Date.now();
    return modelCache.models;
  }

  /**
   * A pinned model id the server does not advertise is a *silent* fallback: the
   * pool answers from its own default with no error, so the pin looks honoured
   * while the reply came from another model — and the cost is attributed to the
   * model that was pinned. Two shipped defaults did exactly that: `sonnet`
   * (written into config.json by onboarding, merged in from DEFAULT_CONFIG, and
   * never advertised by AEGIS Cloud) and any `provider/model` spelling a user
   * typed by hand. Clears such a pin once, says so, and leaves the server's own
   * default in its place.
   *
   * Best-effort and offline-safe: a catalog that cannot be read clears nothing.
   */
  async function validatePinnedModel() {
    const pinned = commandCtx.model;
    if (!pinned) return null;
    // A BYOK pin is validated by shape, not by the pooled catalog: the catalog
    // can never contain a `provider:model` id, so checking it here would clear
    // every legitimate BYOK pin on every launch.
    if (commandCtx.modelClass === 'byok') {
      if (String(pinned).includes(':')) return null;
      commandCtx.model = null;
      updateConfig({ model: null, currentModelId: null });
      emit(
        render.renderNotice(
          ctx(),
          'warn',
          `pinned model "${pinned}" belongs to the pooled class — on BYOK an id is ` +
            '"<provider>:<model>"; pin cleared, /models lists what this machine can relay.'
        )
      );
      return pinned;
    }
    // A custom pin is validated against the local catalog, never the pooled one:
    // its ids are the user's own (from /model add) and the pool has never heard
    // of them, so checking the pooled catalog would clear every custom pin on
    // launch. An empty catalog clears nothing (offline-safe like the pooled path).
    if (commandCtx.modelClass === 'custom') {
      let customModels;
      try {
        customModels = await loadCustomModels();
      } catch {
        return null;
      }
      if (!customModels.length) return null;
      if (customModels.some((m) => m.id === pinned)) return null;
      commandCtx.model = null;
      updateConfig({ model: null, currentModelId: null });
      emit(
        render.renderNotice(
          ctx(),
          'warn',
          `pinned model "${pinned}" is not in your custom catalog — pin cleared; ` +
            '/models lists your endpoints, /model add registers one.'
        )
      );
      return pinned;
    }
    let models;
    try {
      models = await loadModels();
    } catch {
      return null;
    }
    if (!models.length) return null;
    if (catalogIds(models).has(String(pinned).toLowerCase())) return null;
    commandCtx.model = null;
    updateConfig({ model: null, currentModelId: null });
    emit(
      render.renderNotice(
        ctx(),
        'warn',
        `pinned model "${pinned}" is not advertised by AEGIS Cloud — pin cleared, ` +
          'the pool will choose; /models lists what you can pin.'
      )
    );
    return pinned;
  }

  function bannerLines() {
    return render.renderBanner(ctx(), {
      width: width(),
      version: VERSION,
      model: commandCtx.model || 'server default',
      base: client.apiBase,
      key: maskKey(client.apiKey),
      stream: commandCtx.stream,
    });
  }

  /**
   * Write lines out. Accepts a single line as well as a block — a bare string
   * would otherwise be iterated as characters, which renders a notice one
   * character per line.
   */
  function emit(lines) {
    const block = typeof lines === 'string' ? [lines] : lines;
    for (const l of block) out.write(l + '\n');
  }

  // --- the ask path ---------------------------------------------------------

  /**
   * One turn through the agent-loop engine (persistent-shell exec,
   * readFile/writeFile/editFile/listDir/glob/grep, Task subagents), streamed
   * into the live region. `history` is every prior turn's user/assistant pair
   * — never that turn's own tool-call scratchpad, which the engine keeps
   * internally and never returns (see engine.js's `chat()`).
   * @returns {Promise<{text:string, usage:object|null, model:string|null, ms:number, interrupted:boolean}>}
   */
  async function ask(prompt, { history = [], presenter = null, signal = null } = {}) {
    const started = Date.now();
    // A presenter takes over ALL presentation (the chatflow's frame paints the
    // streaming answer into a transcript row), so the linear/inline live region
    // is only built when there is none.
    const live =
      !presenter && opts.interactive && opts.stream && out.isTTY ? new LiveRegion(out) : null;
    let tick = 0;
    let chars = 0;
    let partial = '';
    let reasoning = 0;
    let verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    let sawReasoning = false;
    let usedTools = false;

    const paint = () => {
      if (!live) return;
      live.update([
        render.renderWorking(ctx(), {
          tick: tick++,
          verb,
          elapsedMs: Date.now() - started,
          streamed: chars,
        }),
      ]);
    };

    const timer = live ? setInterval(paint, 90) : null;
    if (timer && timer.unref) timer.unref();
    paint();

    // Presentation hooks. With no presenter these reproduce the linear
    // behaviour exactly (live-region spinner, tool rows written to scrollback).
    const p = presenter || {};
    // The engine opens a tool with a `phase: 'run'` frame BEFORE the executor
    // runs, so a writeFile preview built here still reads the pre-edit file.
    // Cached per tool id so the later `done` frame reuses the same preview
    // instead of re-reading a file the tool has already overwritten (which
    // would diff clean and show nothing).
    const diffCache = new Map();
    const previewFor = (tool) => {
      const key =
        tool && tool.id !== undefined
          ? `id:${tool.id}`
          : `${tool && tool.name}:${JSON.stringify(tool && tool.args)}`;
      if (!diffCache.has(key)) {
        diffCache.set(key, editPreview(tool && tool.name, tool && tool.args, { cwd: process.cwd() }));
      }
      return diffCache.get(key);
    };
    const present = {
      text: (d) => {
        if (p.text) return p.text(d);
        if (live && tick % 2 === 0) paint();
        return undefined;
      },
      reasoning: (r) => {
        if (p.reasoning) return p.reasoning(r);
        return undefined;
      },
      tool: (tool) => {
        if (p.tool) return p.tool(tool);
        if (live) live.clear();
        const diff = previewFor(tool);
        emit(
          render.renderTurn(
            ctx(),
            { role: 'tool', label: tool.name, args: tool.args, ok: tool.ok, diff, diffOpen: defaultOpen(diff) },
            width()
          )
        );
        paint();
        return undefined;
      },
    };

    const sessionId = randomUUID();
    activeSessionId = sessionId;
    let interrupted = false;
    // One cancel path for both callers: a SIGINT from the process, and the
    // chatflow's Esc, which aborts the controller it handed in. Without this
    // second source the full-screen loop's Esc had nothing listening to it —
    // the turn kept running and billing while the UI said "stopped".
    const cancel = () => {
      interrupted = true;
      engine.cancel(sessionId);
    };
    const onSigint = () => cancel();
    process.once('SIGINT', onSigint);
    if (signal) {
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    }

    // A denial with no one to ask it of: -p and any other run with no
    // approvalPrompter set. Fails safe (deny) rather than hanging the tool
    // round forever waiting for an answer nobody can give.
    const denyNoPrompter = (info) => {
      err.write(
        `aegiscode: ${info.tool} needs confirmation but this run has no prompt for it — denied ` +
          '(pass --yolo to auto-approve mutating tools).\n'
      );
      return Promise.resolve('deny');
    };

    // Vocabulary bridging lives at module scope (see normalizeDecision) so the
    // same function the tests import is the one the live path calls.
    const onDelta = (chunk) => {
      if (!chunk) return;
      if (chunk.reasoning) {
        reasoning += w(chunk.reasoning);
        // The pool's worker findings arrive on the reasoning channel before
        // the answer; say so rather than looking stalled.
        if (!sawReasoning) {
          sawReasoning = true;
          verb = 'Reasoning';
          paint();
        }
        present.reasoning(chunk.reasoning);
      }
      if (chunk.delta) {
        chars += w(chunk.delta);
        partial += chunk.delta;
        present.text(chunk.delta);
      }
      if (chunk.tool) {
        usedTools = true;
        present.tool(chunk.tool);
      }
      if (chunk.approval) {
        const info = chunk.approval;
        if (live) live.clear();
        const decide = p.approval || approvalPrompter || denyNoPrompter;
        Promise.resolve(decide(info))
          .catch(() => 'deny')
          .then((decision) => engine.respondApproval(info.id, normalizeDecision(decision)));
      }
    };

    try {
      const res = await engine.chat(
        {
          prompt,
          messages: history,
          model: commandCtx.model || undefined,
          // A caller-supplied system wins; otherwise the shared persona. Sent
          // explicitly rather than left to the server, because the pooled
          // route takes the system prompt from the request and the CLI was
          // sending none — the model got tool schemas and no rule about when
          // to use them.
          system: opts.system || defaultSystemPrompt(),
          maxTokens: opts.maxTokens,
          // `effort` is the pooled budget control, and it travels on every turn
          // — this host only ever runs the 'aegis' class, whose calls are sized
          // server-side from it (aegis1 services/pool_brain.py). It used to be
          // held in the session state and rendered in the status line without
          // ever reaching the wire, so /effort changed the display and nothing
          // about what the turn cost. `null` (auto) is omitted so the server
          // infers the rung from the ask.
          effort: commandCtx.effort || undefined,
          // The deep-recall opt-in travels only when this session turned it on
          // (`/memory-deep on`). Sent as a literal `true` or not at all: the
          // engine treats anything but `true` as off, and an omitted field is
          // what keeps a stray value from ever buying a per-turn embedding.
          recallDeep: commandCtx.recallDeep === true ? true : undefined,
          // false asks the engine for the buffered (non-stream) wire form, so
          // `--no-stream` and piped runs get a single body rather than SSE.
          stream: commandCtx.stream !== false,
          sessionId,
        },
        onDelta
      );

      const choice = (res.choices && res.choices[0]) || {};
      const text = (choice.message && choice.message.content) || partial;
      return {
        text,
        usage: res.usage || null,
        model: res.model || commandCtx.model || null,
        ms: Date.now() - started,
        interrupted,
        reasoningChars: reasoning,
        usedTools,
      };
    } catch (e) {
      // A user interrupt is not a failure: keep what already streamed.
      if (interrupted && partial) {
        return {
          text: partial,
          usage: null,
          model: commandCtx.model || null,
          ms: Date.now() - started,
          interrupted: true,
          reasoningChars: reasoning,
          usedTools,
        };
      }
      throw e;
    } finally {
      if (timer) clearInterval(timer);
      process.removeListener('SIGINT', onSigint);
      if (signal) signal.removeEventListener('abort', cancel);
      if (live) live.clear();
      activeSessionId = null;
    }
  }

  /** Print a completed turn: role block, then the accounting line. */
  function printTurn(turn) {
    emit(render.renderTurn(ctx(), turn, width()));
  }

  /** Prior user/assistant pairs from the live transcript, for the engine. */
  function historyPairs() {
    return transcript
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.text }));
  }

  /** Ask, then account for it. Shared by plain prompts and `/ask`. */
  async function runPrompt(prompt, { label = 'you' } = {}) {
    if (!prompt) {
      emit(render.renderNotice(ctx(), 'warn', 'nothing to ask — give /ask a prompt'));
      return;
    }
    if (!client.apiKey) {
      emit(
        render.renderNotice(
          ctx(),
          'error',
          `no AEGIS account key — ${credentials.HOW_TO_SET} (or set $${credentials.KEY_ENV})`
        )
      );
      return;
    }

    const history = historyPairs();
    printTurn({ role: 'user', text: prompt, label });
    transcript.push({ role: 'user', text: prompt });

    let res;
    try {
      res = await ask(prompt, { history });
    } catch (e) {
      persistTurn(prompt, { text: '', error: e.message }, 'error');
      emit(render.renderTurn(ctx(), { role: 'error', text: e.message }, width()));
      return;
    }

    if (res.text) transcript.push({ role: 'assistant', text: res.text });

    const tokens = recordTurn(res);

    // Ask the ledger what this call settled at BEFORE persisting it. The order
    // is the whole point: the charge is the server's number (pool margin and
    // prompt-cache discount included) and only the ledger knows it. Persisting
    // first wrote the exchange with no charge attached, so /cost recomputed it
    // from a local rate table that knows about neither — and the figure the
    // customer read did not match the bill they paid. Same ordering as the
    // chatflow session loop.
    let settledCost = null;
    try {
      const spend = await refreshSpend();
      settledCost = spend ? spend.lastCost : null;
    } catch {
      /* accounting must never break a turn */
    }
    persistTurn(prompt, res, res.interrupted ? 'stopped' : res.error ? 'error' : 'done', settledCost);

    printTurn({
      role: 'assistant',
      text: res.text || '(the pool returned no text — see /balance for what it charged)',
      meta: {
        model: res.model,
        tokens,
        usage:
          res.usage == null
            ? null
            : {
                input: res.usage.input_tokens ?? res.usage.prompt_tokens,
                output: res.usage.output_tokens ?? res.usage.completion_tokens,
              },
        // What this call settled at, from the ledger row it produced — the
        // number that has to agree with the token count beside it.
        eur: settledCost,
        ms: res.ms,
        calls: 1,
      },
    });

    if (res.interrupted) {
      emit(render.renderNotice(ctx(), 'warn', 'interrupted — the pool may still be running and billing this call'));
    }
  }

  // --- command dispatch -----------------------------------------------------

  async function runTool(name, args) {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`unknown tool: ${name}`);
    if (!client.apiKey) {
      throw new Error(`no AEGIS account key — ${credentials.HOW_TO_SET}`);
    }
    const text = await tool.run(args || {});
    emit(render.renderToolResult(ctx(), name, text, width()));
  }

  /**
   * The nearest routable name to a mistyped one: a prefix of it, or a name it
   * is a prefix of. Deliberately simple — `cli/src/fuzzy.js` is a separate
   * workstream and may not exist, so this must not depend on it.
   */
  function nearest(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    let best = null;
    for (const c of COMMANDS) {
      for (const cand of [c.name, ...(c.aliases || [])]) {
        if (cand === n) continue;
        if (cand.startsWith(n) || n.startsWith(cand)) {
          if (best == null || Math.abs(cand.length - n.length) < Math.abs(best.length - n.length)) {
            best = cand;
          }
        }
      }
    }
    return best;
  }

  /** Tokenize one argument string, honouring single/double quotes. */
  function tokenize(s) {
    const out = [];
    let cur = '';
    let quote = null;
    let has = false;
    for (const ch of String(s || '')) {
      if (quote) {
        if (ch === quote) quote = null;
        else cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
      if (/\s/.test(ch)) {
        if (cur || has) { out.push(cur); cur = ''; has = false; }
        continue;
      }
      cur += ch;
      has = true;
    }
    if (cur || has) out.push(cur);
    return out;
  }

  /** Positional args keyed by the entry's `args` names, plus `_rest`. */
  function parseArgs(cmd, arg) {
    const raw = String(arg == null ? '' : arg);
    const names = Array.isArray(cmd.args) ? cmd.args : [];
    const tokens = tokenize(raw);
    const out = { _rest: raw.trim() };
    names.forEach((n, i) => { if (tokens[i] !== undefined) out[n] = tokens[i]; });
    return out;
  }

  /** A fresh snapshot for panels.js (the frozen `c.state()` shape). */
  function buildState() {
    const rules = loadPermissions();
    return {
      version: VERSION,
      model: commandCtx.model || 'server default',
      class: commandCtx.modelClass,
      effort: commandCtx.effort,
      thinking: commandCtx.thinking,
      theme: commandCtx.light ? 'light' : 'dark',
      themeIndex: commandCtx.themeIndex,
      vim: commandCtx.vim,
      stream: commandCtx.stream,
      cwd: commandCtx.cwd,
      home: os.homedir(),
      sessionId: commandCtx.sessionId,
      base: client.apiBase,
      keyMask: maskKey(client.apiKey),
      online: !!client.apiKey,
      turns: session.turns,
      calls: session.calls,
      startedAt: session.startedAt,
      tokens: { input: session.inputTokens, output: session.outputTokens, total: session.tokens },
      costEur: session.cost,
      balance: session.balance,
      plan: session.plan || null,
      account: session.account || null,
      permissions: { mode: rules.defaultMode, rules },
      // The selectable (pickable) catalog, not the raw payload: alias tiers are
      // dropped, live ids only (see models.js pickerEntries).
      // Whichever class is live decides what is pinnable — the pooled ids the
      // server advertises, or the `provider:model` ids this machine can relay.
      models: pickerEntries(commandCtx.modelClass === 'byok' ? byokCache.models : modelCache.models),
      commands: visibleCommands(),
      transcript: transcript.slice(),
      sessions: [],
      memory: {},
      lastRecap: commandCtx.lastRecap,
      backend: commandCtx.modelClass,
      url: client.apiBase,
    };
  }

  /** Flatten a span line (panels.js/overlays.js output) back to an ANSI row. */
  function flattenSpans(line) {
    if (!Array.isArray(line)) return String(line == null ? '' : line);
    return line.map((sp) => (sp && (sp.s || '') + (sp.t == null ? '' : sp.t)) || '').join('');
  }

  /**
   * Push one transcript row. `c.push(row)`/`c.note`/`c.panel` land here; the
   * linear CLI prints each row once to scrollback (there is no alt-screen).
   */
  function pushRow(row) {
    if (!row || typeof row !== 'object') return;
    const W = width();
    switch (row.role) {
      case 'panel': {
        const lines = Array.isArray(row.lines) ? row.lines : [];
        for (const line of lines) emit(flattenSpans(line));
        return;
      }
      case 'note': emit(render.renderNotice(ctx(), 'info', row.text)); return;
      case 'tip': emit(render.renderNotice(ctx(), 'info', row.text)); return;
      case 'done': emit(render.renderNotice(ctx(), 'ok', row.text)); return;
      case 'error': emit(render.renderNotice(ctx(), 'error', row.text)); return;
      case 'user': emit(render.renderTurn(ctx(), { role: 'user', text: row.text, label: row.label }, W)); return;
      case 'assistant': emit(render.renderTurn(ctx(), { role: 'assistant', text: row.text }, W)); return;
      case 'tool': {
        // A chatflow row carries the preview it built from the run frame
        // (chatflow.js); a row pushed straight from a command handler has none,
        // so build one here rather than re-showing the gray `$ {args}` row.
        if (row.diff === undefined) {
          row.diff = editPreview(row.name || row.label, row.args, { cwd: process.cwd() });
          row.diffOpen = defaultOpen(row.diff);
        }
        emit(render.renderTurn(ctx(), { role: 'tool', label: row.label || row.name, args: row.args, ok: row.ok, diff: row.diff, diffOpen: !!row.diffOpen }, W));
        return;
      }
      default: emit(render.renderNotice(ctx(), 'info', row.text == null ? '' : String(row.text))); return;
    }
  }

  /** A static (non-interactive) print of an overlay's contents. */
  function openOverlay(o) {
    if (!o || typeof o !== 'object') return;
    const W = width();
    const rows = Math.max(5, (process.stdout && process.stdout.rows) || 24);
    let lines = null;
    if (o.type === 'panel') lines = o.lines;
    else if (o.type === 'palette') lines = overlays.renderPalette(visibleCommands(), { query: o.query || '', sel: o.sel || 0 }, W, rows);
    else if (o.type === 'model') lines = overlays.renderModelPicker(o.items || [], o.sel || 0, W, rows, o.current != null ? o.current : commandCtx.model, o.cls || commandCtx.modelClass, classLabelOf);
    else if (o.type === 'effort') lines = overlays.renderEffortPicker(o.sel || 0, W, commandCtx.effort);
    else if (o.type === 'resume') lines = overlays.renderResumeList(o.items || [], o.sel || 0, W, rows);
    else if (o.type === 'confirm') lines = render.renderApproval(ctx(), o.info || {}, W).map((s) => [spanRow(s)]);
    if (!lines) return;
    for (const line of lines) emit(flattenSpans(line));
  }

  /** A single-span row for a pre-styled string (renderApproval output). */
  function spanRow(s) {
    return { t: s, s: '', w: w(s) };
  }

  /** Run `fn(signal)` with the spinner up (interactive TTY only). */
  async function withWorking(fn) {
    const controller = new AbortController();
    const live = opts.interactive && out.isTTY ? new LiveRegion(out) : null;
    let timer = null;
    if (live) {
      let tick = 0;
      const started = Date.now();
      const paint = () => live.update([render.renderWorking(ctx(), { tick: tick++, verb: VERBS[0], elapsedMs: Date.now() - started })]);
      paint();
      timer = setInterval(paint, 90);
      if (timer.unref) timer.unref();
    }
    try {
      return await fn(controller.signal);
    } finally {
      if (timer) clearInterval(timer);
      if (live) live.clear();
    }
  }

  /**
   * The theme picker. On a real terminal this is the onboarding screen; anywhere
   * else (`/theme` in a pipe, a test with no TTY) it stays the light/dark toggle
   * it has always been, so a non-interactive caller never blocks on a key.
   */
  async function showThemePicker() {
    if (options.readline || !process.stdin.isTTY || !process.stdout.isTTY || options.chatflow === false) {
      commandCtx.light = !commandCtx.light;
      commandCtx.themeIndex = commandCtx.light ? 2 : 1;
      emit(render.renderNotice(ctx(), 'ok', `theme: ${commandCtx.light ? 'light' : 'dark'}`));
      return commandCtx.themeIndex;
    }
    return screens.showThemePicker(commandCtx);
  }

  /** Build the FROZEN command context `c` a handler runs against. */
  function makeCommandContext() {
    const c = {
      ctx: commandCtx,
      transcript,
      push: (row) => pushRow(row),
      note: (text) => pushRow({ role: 'note', text }),
      panel: (lines) => pushRow({ role: 'panel', lines }),
      render: () => {},
      openOverlay: (o) => openOverlay(o),
      closeOverlay: () => {},
      askInput: () => Promise.resolve(null),
      withWorking: (fn) => withWorking(fn),
      runPrompt: (text) => runPrompt(text),
      ask: (text) => ask(text),
      runTool: (name, args) => runTool(name, args),
      // The catalog `/model` and alt+p expect. Routed through listModelsFor so
      // it follows the LIVE class: on the pooled class that is the server's
      // catalog (loadModels), on byok the `provider:model` ids this machine can
      // relay. Wired on the app's context so the chatflow's `Object.assign`
      // based context inherits it too — one definition, both hosts, and the
      // picker can never offer something the class would reject.
      loadModels: () => listModelsFor(commandCtx.modelClass),
      // The provider-key store (`byok:<provider>` rows) /byok-key writes. Read
      // through a function, not captured, because an injected engine may not
      // carry one.
      settings: () => engine.settings || null,
      // The one spelling of a provider's settings row, shared with the engine
      // that reads it (`byok:<provider>`) — see engine.js byokNamespace.
      byokNamespace: (p) => byokNamespace(p),
      // The class surface: /class switches, /models lists for whichever class
      // is live (the frozen state carries the current one as c.ctx.modelClass).
      listModelsFor: (cls) => listModelsFor(cls),
      switchClass: (cls) => switchClass(cls),
      classLabel: (cls) => classLabelOf(cls),
      classes: () => (typeof engine.listClasses === 'function' ? engine.listClasses() : []),
      refreshSpend: () => refreshSpend(),
      state: () => buildState(),
      setInput: () => {},
      exit: () => { wantExit = true; },
      client,
      TOOLS,
      saveConfig: (patch) => updateConfig(patch),
      showThemePicker: () => showThemePicker(),
      // Credential + cloud-sync surface for the /key, /cloud and /sync commands.
      // Defined here on the app's context so the chatflow's Object.assign-based
      // context inherits them too — one definition, both hosts.
      keyStatus: () => credentials.keyStatus(),
      setApiKey: (raw, o) => setApiKey(raw, o),
      forgetApiKey: () => forgetApiKey(),
      readSecret: (text) => readSecret(text, { stdin: process.stdin, stdout: out }),
      cloudsync,
      cloudSyncEnabled: () => cloudSyncEnabled(),
      cloudSyncState: () => cloudSyncState(),
      setCloudSync: (on) => setCloudSync(on),
      adoptLegacyKey: () => adoptLegacyKeyOnce(),
    };
    Object.defineProperty(c, 'sessionId', {
      enumerable: true,
      get: () => commandCtx.sessionId,
      set: (v) => { commandCtx.sessionId = v; },
    });
    return c;
  }

  /**
   * Handle one line of input. Returns false when the session should end.
   *
   * `cOverride` lets the chatflow supply the context it owns (its own `push`,
   * `render`, `openOverlay`, `askInput`, `runPrompt`) instead of the linear
   * defaults — the handlers are identical either way, which is the point.
   */
  async function handleLine(line, cOverride = null) {
    const parsed = parseLine(line);

    if (parsed.kind === 'empty') return true;
    if (parsed.kind === 'prompt') {
      await runPrompt(parsed.text);
      return true;
    }
    if (parsed.kind === 'unknown') {
      const alt = nearest(parsed.name);
      emit(
        render.renderNotice(
          ctx(),
          'error',
          `unknown command: /${parsed.name}${alt ? ` — did you mean /${alt}?` : ` — try /help`}`
        )
      );
      return true;
    }
    if (parsed.kind === 'unavailable') {
      const c = parsed.command;
      emit(render.renderNotice(ctx(), 'warn', `/${c.name} is not available in aegiscode — ${c.unavailable}`));
      if (c.alt) emit(render.renderNotice(ctx(), 'info', `try ${c.alt} instead`));
      else {
        const alt = nearest(c.name);
        if (alt) emit(render.renderNotice(ctx(), 'info', `try /${alt} instead`));
      }
      return true;
    }

    const cmd = parsed.command;
    const arg = parsed.arg;

    // The generic escape hatch (/tool <name> [json]).
    if (cmd.generic) {
      let built;
      try {
        built = cmd.build(arg);
      } catch (e) {
        emit(render.renderNotice(ctx(), 'error', e.message));
        return true;
      }
      const { tool, args } = built;
      if (!tool) {
        emit(render.renderNotice(ctx(), 'error', '/tool needs a tool name — see /help'));
        return true;
      }
      try {
        await runTool(tool, args);
      } catch (e) {
        emit(render.renderNotice(ctx(), 'error', e.message));
      }
      return true;
    }

    // Handler-backed (the reference aegiscode-dev contract).
    if (typeof cmd.handler === 'function') {
      const args = parseArgs(cmd, arg);
      const c = cOverride || makeCommandContext();
      try {
        const keep = await cmd.handler(c, args);
        return keep === false ? false : true;
      } catch (e) {
        emit(render.renderNotice(ctx(), 'error', e && e.message ? e.message : String(e)));
        return true;
      }
    }

    // Tool-backed command.
    try {
      let args = cmd.build(arg);
      if (cmd.secret) {
        // A bare "provider key for openai:" tells the user nothing about which
        // key to paste or where to get it, which is exactly the step people get
        // wrong. When a command can describe its own secret it does, and the
        // description is best-effort: a catalog fetch that fails must still
        // leave a working prompt rather than aborting the command.
        const spec = await describeSecret(cmd, args);
        if (spec && spec.note) emit(render.renderNotice(ctx(), 'info', spec.note));
        const key = await askSecret((spec && spec.prompt) || `provider key for ${args.provider}: `);
        if (!key) {
          emit(render.renderNotice(ctx(), 'warn', 'empty key — nothing sent'));
          return true;
        }
        args = { ...args, api_key: key };
      }
      if (cmd.tool === 'aegis_ask') return await runPrompt(args.prompt);
      await runTool(cmd.tool, args);
      // `/memory` is where a user actually looks at what is stored, so the
      // quota state belongs here as well as in /cloud: the ceiling is the one
      // fact about this feature that changes what the account can do, and it is
      // invisible from the entries themselves.
      if (cmd.tool === 'aegis_memory_list' || cmd.tool === 'aegis_memory_search') memoryQuotaNote();
    } catch (e) {
      emit(render.renderNotice(ctx(), 'error', e.message));
    }
    return true;
  }

  /**
   * One line of quota state for the memory read commands. Quiet when the server
   * has not reported a ceiling yet (nothing useful to say), a statement when it
   * has, and — when the account is at it — the two halves spelled out: reads
   * keep working, new writes do not.
   */
  function memoryQuotaNote() {
    let st;
    try {
      st = cloudsync.status();
    } catch {
      return;
    }
    const q = st.quota;
    if (!q) return;
    const used = fmtTokens(q.used || 0);
    const limit = fmtTokens(q.limit || 0);
    if (st.overQuota) {
      emit(
        render.renderNotice(
          ctx(),
          'warn',
          `cloud memory: ${used} of ${limit} synced tokens — at the plan's ceiling. Everything stored stays readable; new writes are paused until there is room. /cloud memory for the full state.`
        )
      );
      return;
    }
    emit(render.renderNotice(ctx(), 'info', `cloud memory: ${used} of ${limit} synced tokens — /cloud memory for the full state`));
  }

  /**
   * Ask the command how to describe the secret it is about to collect.
   *
   * Returns `{ note, prompt }` or null. The command opts in by defining
   * `secretDescribe(args, client)`, which is awaited and therefore free to
   * consult the server. A throw here is swallowed on purpose: guidance is an
   * improvement to a prompt, and a user who typed `/byok-set openai` on a
   * flaky connection should still get the prompt.
   */
  async function describeSecret(cmd, args) {
    if (typeof cmd.secretDescribe !== 'function') return null;
    try {
      const spec = await cmd.secretDescribe(args, client);
      return spec && typeof spec === 'object' ? spec : null;
    } catch {
      return null;
    }
  }

  /**
   * Ask for a secret on this session's streams.
   *
   * The prompt loop itself lives in secret.js, shared with `aegiscode login` in
   * the bin — one implementation, so the terminal host and the non-interactive
   * entry point cannot differ in whether a key is echoed or masked. Only the
   * prompt's colouring is the session's business.
   */
  function askSecret(promptText) {
    const t = themeOf(ctx());
    return readSecret(t.gray + promptText + RESET, { stdin: process.stdin, stdout: out });
  }

  // --- entry points ---------------------------------------------------------

  /** Non-interactive: one prompt, plain output, exit code. */
  async function runOnce(prompt, { json = false } = {}) {
    adoptLegacyKeyOnce();
    if (!client.apiKey) {
      err.write(`aegiscode: no AEGIS account key. ${credentials.HOW_TO_SET}, or set $${credentials.KEY_ENV}.\n`);
      return 2;
    }
    // Snapshot the account's existing ledger BEFORE the billed call. Without
    // this the refresh after the turn would treat every historical row as new,
    // and the reported charge would be whatever the account spent last rather
    // than what this call cost.
    await refreshSpend();
    const res = await ask(prompt);
    await refreshSpend();
    const tokens = usageTokens(res.usage);
    if (json) {
      out.write(
        JSON.stringify(
          {
            text: res.text,
            model: res.model,
            usage: res.usage,
            tokens,
            ms: res.ms,
            interrupted: res.interrupted,
            balance_eur: session.balance,
          },
          null,
          2
        ) + '\n'
      );
    } else {
      out.write(res.text + '\n');
      if (tokens != null) {
        const t = themeOf(ctx());
        out.write(
          t.dim + GLYPH.hook + '  ' + t.blue + (res.model || 'aegis') + RESET +
            t.dim + ' ' + GLYPH.bullet + ' ' + RESET +
            t.white + `${fmtTokens(tokens)} tok` + RESET + '\n'
        );
      }
    }
    return res.interrupted ? 130 : 0;
  }

  /** Fold one completed turn's usage into the session tallies.
   *  @returns {number|null} the total token count for the turn, when known. */
  function recordTurn(res) {
    session.turns++;
    session.calls += Number((res && res.calls) || 1) || 1;
    const usage = res && res.usage;
    const tokens = usageTokens(usage);
    if (tokens != null) {
      session.tokens += tokens;
      session.inputTokens += Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
      session.outputTokens += Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
    }
    return tokens;
  }

  /**
   * Persist one finished exchange: the history row and a transcript checkpoint.
   *
   * `appendHistory` and `snapshotCheckpoint` were both dead code — nothing ever
   * called them, so `history.jsonl` was never created. Every consumer of it
   * degraded silently rather than loudly: `/resume` could never find a stored
   * session, `/cost` summed zero rows, `/clear`'s prune was a no-op, and
   * `/rewind` always answered "No checkpoints yet". The session loop is the only
   * place that sees the prompt *and* its reply, so it is the place that writes.
   *
   * Best-effort by construction: the two writers swallow their own failures, and
   * accounting must never be able to break a turn.
   */
  function persistTurn(prompt, res, status = 'done', costEur = null) {
    try {
      const usage = res && res.usage;
      // What the POOL charged, straight from the ledger — margin and
      // prompt-cache discount already applied. Stored so /cost can report the
      // real bill instead of recomputing from provider rates it cannot see.
      // (The history field is historically named `costUsd`; the value here is
      // EUR, which is what every surface in this client displays.)
      const settled = typeof costEur === 'number' && Number.isFinite(costEur) ? costEur : null;
      appendHistory({
        sessionId: commandCtx.sessionId,
        prompt,
        reply: (res && res.text) || '',
        status,
        usage: usage
          ? {
              input: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0,
              output: Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0,
              cacheRead: Number(usage.cache_read_input_tokens ?? 0) || 0,
              cacheWrite: Number(usage.cache_creation_input_tokens ?? 0) || 0,
              ...(settled != null ? { costUsd: settled } : {}),
            }
          : settled != null
            ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: settled }
            : null,
      });
      snapshotCheckpoint(commandCtx.sessionId, transcript);
    } catch {
      /* persistence is best-effort */
    }
    // Auto-sync hook: one place, reached by both the linear REPL and the
    // chatflow's session loop. On by default — a push is billed against the
    // plan's synced-token ceiling (aegis1 charges the *growth* of a session),
    // so it is a real gate rather than an unconditional write, but the default
    // is on because a session that dies at its tool-round horizon is only
    // recoverable if the transcript exists somewhere the next session can read
    // it. `/cloud memory off` is the opt-out.
    if (cloudSyncEnabled()) autoSync();
  }

  /**
   * Push after a turn, in the background.
   *
   * Deliberately not awaited and deliberately quiet on success: this runs after
   * every turn, and a line per turn would be noise. Failures are reported once
   * per session per session-cycle — a quota refusal that repeats forever is a
   * wall of text, not information — and never thrown, because the user's turn
   * already succeeded by the time this runs.
   *
   * The quota refusal gets its own sentence, and it is the whole point of the
   * default flip being safe: past the plan's ceiling the account does NOT lose
   * anything it already stored (reads keep working — aegis1 meters writes
   * only), and the failure is not "sync failed", it is "there is no room left
   * for new writes". Saying which half stopped is what keeps a silent stop from
   * looking like a broken feature.
   */
  let autoSyncNotes = new Set();
  function autoSync() {
    if (!client.apiKey) return;
    Promise.resolve()
      .then(() => cloudsync.push(client))
      .then((res) => {
        if (res && res.failed && res.failed.length) {
          const f = res.failed[0];
          if (autoSyncNotes.has(f.kind)) return;
          autoSyncNotes.add(f.kind);
          if (f.kind === 'quota') {
            emit(
              render.renderNotice(
                ctx(),
                'warn',
                `cloud memory: the plan's synced-token ceiling is reached — earlier sessions stay readable, only NEW writes pause. /cloud memory shows the quota; /cloud memory off stops trying.`
              )
            );
            return;
          }
          const hint = f.hint ? ` — ${f.hint}` : '';
          emit(render.renderNotice(ctx(), 'error', `cloud sync: ${f.message}${hint}`));
        }
      })
      .catch(() => {
        /* offline is not worth interrupting a session over */
      });
  }

  /**
   * First-run notice for the write half, printed once, right after onboarding.
   *
   * The default flip is invisible otherwise: the read half was already on for
   * everyone, so nothing about the first session looks different — the thing
   * that changed is that the transcript is now being *stored*, and that costs
   * quota on a free plan. One line at the moment the account is set up is the
   * difference between a default and a surprise.
   */
  function memoryFirstRunNotice() {
    const st = cloudSyncState();
    if (!st.enabled) {
      emit(
        render.renderNotice(
          ctx(),
          'info',
          'cross-session memory: off (you turned it off) — /cloud memory on stores sessions so an interrupted turn can be picked up later'
        )
      );
      return;
    }
    const quota = cloudsync.status().quota;
    const usage = quota && quota.limit ? ` (used ${fmtTokens(quota.used || 0)} of ${fmtTokens(quota.limit)} tokens)` : '';
    emit(
      render.renderNotice(
        ctx(),
        'info',
        `cross-session memory: on${usage} — sessions are stored to your account so a turn that is interrupted can be resumed. /cloud memory shows the quota; /cloud memory off stops it. Past the ceiling, saved memory stays readable and only new writes pause.`
      )
    );
  }

  /** One line of session accounting, for ctrl+t and the meta row. */  function tokenSummary() {
    return (
      `${fmtTokens(session.tokens)} tok ` +
      `(${fmtTokens(session.inputTokens)} in / ${fmtTokens(session.outputTokens)} out) · ` +
      `${session.calls} call${session.calls === 1 ? '' : 's'} · ${fmtEur(session.cost)}` +
      (session.balance == null ? '' : ` · balance ${fmtEur(session.balance)}`)
    );
  }

  /** Load a stored session back into the live transcript. */
  async function resumeSession(item) {
    if (!item || !item.id) return;
    const rows = readSessionTranscript(item.id);
    if (!rows.length) {
      emit(render.renderNotice(ctx(), 'warn', `no stored turns for ${item.id}`));
      return;
    }
    // Replace, rather than append: "resume" means continue THIS conversation,
    // and appending would put two sessions' turns in one context window.
    transcript.length = 0;
    for (const r of rows) transcript.push(r);
    commandCtx.sessionId = item.id;
    emit(render.renderNotice(ctx(), 'ok', `resumed ${item.id} — ${rows.length} turn(s)`));
  }

  /**
   * The host the chatflow drives. Everything the loop needs from the app, with
   * no layering of its own — the loop owns the frame and the keys, this owns
   * the transport, the tools, the command table and the tallies.
   */
  function makeHost() {
    return {
      ctx: commandCtx,
      version: VERSION,
      transcript,
      session,
      client,
      TOOLS,
      ask: (prompt, o) => ask(prompt, o),
      makeCommandContext: () => makeCommandContext(),
      loadModels: (o) => loadModels(o),
      buildState: () => buildState(),
      dispatchLine: (line, c) => handleLine(line, c),
      refreshSpend: () => refreshSpend(),
      updateConfig: (patch) => updateConfig(patch),
      showThemePicker: () => showThemePicker(),
      // `costEur` MUST be forwarded. chatflow's session loop passes the settled
      // charge as its fourth argument, and this binding used to accept only
      // three — so the argument was dropped, persistTurn fell back to
      // costEur = null, and every interactive turn was written to
      // history.jsonl with no charge attached. /cost then recomputed each of
      // them from the local rate table (no pool margin, no prompt-cache
      // discount) and reported a number the customer never paid. The parameter
      // is the whole reason the ledger is consulted before persisting.
      persistTurn: (prompt, res, status, costEur) => persistTurn(prompt, res, status, costEur),
      visibleCommands: () => visibleCommands(),
      tokensFor: (usage) => usageTokens(usage),
      recordTurn: (res) => recordTurn(res),
      tokenSummary: () => tokenSummary(),
      resumeSession: (item) => resumeSession(item),
      requestExit: () => {
        wantExit = true;
      },
      wantsExit: () => wantExit,
      isYolo: () => {
        try {
          return loadPermissions().defaultMode === 'allow';
        } catch {
          return false;
        }
      },
    };
  }

  /** The plain (non-alt-screen) REPL: readline, one turn written to scrollback. */
  async function runLinearRepl() {
    emit(bannerLines());
    await refreshSpend();
    out.write('\n');

    const rl = options.readline || readline.createInterface({ input: process.stdin, output: out, terminal: true });
    const promptStr = themeOf(ctx()).gold + GLYPH.cursor + ' ' + RESET;
    rl.setPrompt(promptStr);
    rl.prompt();

    return new Promise((resolve) => {
      rl.on('line', async (line) => {
        rl.pause();
        let keep = true;
        try {
          keep = await handleLine(line);
        } catch (e) {
          emit(render.renderNotice(ctx(), 'error', e.message));
        }
        if (!keep || wantExit) {
          closed = true;
          rl.close();
          return;
        }
        rl.resume();
        rl.prompt();
      });
      rl.on('close', () => {
        if (!closed) out.write('\n');
        resolve(0);
      });
    });
  }

  /**
   * Restore persisted preferences into the live context. The reference does this
   * at startup (`main.js:290-296`); this client never called `loadConfig()` on
   * launch at all, so a model or effort chosen in a previous session was written
   * to disk and then ignored on the next run.
   *
   * An explicit CLI flag always wins over the stored value — `aegiscode -m x`
   * must mean `x`, not "x unless the config disagrees".
   */
  function restorePrefs() {
    // An embedded/injected readline is a programmatic caller: it gets a
    // deterministic context rather than whatever happens to be on disk.
    if (options.readline) return;
    // A fresh install has no expressed preference to restore. Applying
    // DEFAULT_CONFIG here would silently pin the user to a model they never
    // chose, which is the opposite of "remember what I picked".
    if (!configExists()) return;
    let cfg;
    try {
      cfg = loadConfig();
    } catch {
      return;
    }
    // The class first: a stored BYOK pin is only meaningful under byok, and the
    // pin check right after this reads whichever class won.
    if (HOST_CLASSES.includes(cfg.modelClass)) commandCtx.modelClass = cfg.modelClass;
    if (!opts.model && cfg.model) commandCtx.model = cfg.model;
    // `null` in the config is "auto" and is deliberately not assigned over the
    // default — there is nothing to restore, because nothing is pinned.
    if (cfg.effort) commandCtx.effort = cfg.effort;
    if (typeof cfg.vim === 'boolean') commandCtx.vim = cfg.vim;
    if (cfg.lastRecap) commandCtx.lastRecap = cfg.lastRecap;
    // THEME_TABLE lives in theme.js, not screens.js: reading it off the screens
    // module yielded undefined, and only on a *second* launch (the first has no
    // config to restore, so this branch never ran) — so the very first run
    // appeared to work and every run after it died on startup.
    if (!opts.light && typeof cfg.themeIndex === 'number' && THEME_TABLE[cfg.themeIndex]) {
      commandCtx.themeIndex = cfg.themeIndex;
      commandCtx.light = !!THEME_TABLE[cfg.themeIndex].light;
    }
  }

  /**
   * Interactive entry point. On a real terminal this is the full chatflow
   * (alternate screen, header, transcript viewport, spinner, effort line,
   * input line, status line, overlays). Anywhere else — a pipe, a test with an
   * injected readline, `--print` — it stays the linear loop, so output remains
   * pipeable and scriptable.
   */
  async function runInteractive() {
    const tty =
      !options.readline &&
      options.chatflow !== false &&
      process.stdin.isTTY &&
      process.stdout.isTTY;
    if (tty) {
      restorePrefs();
      adoptLegacyKeyOnce();
      // Onboarding runs in the normal buffer, before the session takes the
      // alternate screen — the reference's order. A declined trust check must
      // abort: the reference returns without ever reaching `session(ctx)`.
      const onboard = await screens.runOnboarding(commandCtx, {
        continue: !!options.continue,
        seen: options.seen || configExists,
        save: (patch) => updateConfig(patch),
        // With no key the session can do nothing, so ask for it here where the
        // user is already answering questions — verified on submit, and saved
        // 0600 so the next launch (and every script) has it.
        needsKey: () => !client.apiKey,
        submitKey: (key) => setApiKey(key),
      });
      if (!onboard.ok) return 0;
      if (onboard.key && onboard.key.set) {
        emit(
          render.renderNotice(
            ctx(),
            'info',
            `key saved to ${credentials.credentialsPath()} — no export needed from now on`
          )
        );
      }
      if (onboard.key && onboard.key.skipped && !client.apiKey) {
        emit(
          render.renderNotice(
            ctx(),
            'warn',
            `no key saved — /key <api_key> or \`aegiscode login\` whenever you are ready`
          )
        );
      }
      // The write half of cross-session memory is on by default (see
      // config.js). Say so once, on the run that sets the account up, together
      // with the ceiling and the opt-out — a default nobody is told about is a
      // setting they cannot make a decision about.
      if (onboard.firstRun) memoryFirstRunNotice();
      // A stored pin the platform does not advertise routes elsewhere in
      // silence (see validatePinnedModel) — checked once, here, where the user
      // can act on it. Not on `-p`: a network round-trip ahead of the first
      // token would be a startup cost bought for a warning no script watches.
      await validatePinnedModel();
      // `--continue` must load the last session *before* the loop starts, and
      // it has to be read here rather than captured at construction: the
      // history file is written by the loop itself.
      if (options.continue) {
        const last = readOwnSessions(1)[0];
        if (last) {
          commandCtx.continueSession = last.id;
          await resumeSession({ id: last.id });
        }
      }
      // Snapshot the account's ledger before the loop's first billed turn, so
      // the session tally cannot absorb the customer's existing spend and the
      // first turn's charge is not mistaken for pre-existing history.
      await refreshSpend();
      await chatflow.runSession(makeHost());
      return 0;
    }
    restorePrefs();
    adoptLegacyKeyOnce();
    return runLinearRepl();
  }

  return {
    opts,
    session,
    client,
    TOOLS,
    toolList,
    ctx: commandCtx,
    transcript,
    ask,
    runPrompt,
    handleLine,
    runOnce,
    runInteractive,
    runLinearRepl,
    refreshSpend,
    bannerLines,
    makeHost,
    loadModels,
    validatePinnedModel,
    recordTurn,
    persistTurn,
    restorePrefs,
    setApiKey,
    forgetApiKey,
    adoptLegacyKeyOnce,
    cloudSyncEnabled,
    cloudSyncState,
    setCloudSync,
    cloudsync,
    keyStatus: () => credentials.keyStatus(),
    sessionId: () => commandCtx.sessionId,
    tokenSummary,
    resumeSession,
    makeCommandContext,
    buildState,
    get aborted() {
      return false;
    },
  };
}

module.exports = { createApp, VERSION, normalizeDecision };
