# AEGISCODE-PLUGIN — PRODUCT PLAN

**Title:** Ship aegiscode-plugin as the single product that handles every model class —
local, OpenAI-compatible, Anthropic-compatible, and Aegis's own cloud models — with
greater output and cloud sync.

**Date:** 2025-09-09 · **Owner:** aegiscode-plugin (this repo, the product)

**Related repos:**
- `aegiscode-plugin` — THE PRODUCT (this repo: MCP plugin + Electron desktop host + shared thin client)
- `aegis1` — private server behind aegiscloud.org (owns catalog, routing, billing)
- `ae-guix` — private desktop app that already contains local/anthropic/openai engine code (donor only)
- `aegiscode-pub` — public marketing / pricing site

---

## 0. Executive summary

aegiscode-plugin already ships cloud-pool chat, BYOK relay chat, cloud memory, and a
streaming Electron chat UI. What it does **not** ship today is real compatibility with
*all* model sources:

| Model class | In plugin today? |
|---|---|
| Aegis Cloud pool (`aegiscloud.org`) | ✅ `client/aegis.js` `chatCompletion()` |
| BYOK relay through the pool | ✅ `byokChatCompletion()` + `byokSet()` (but schema locks 3 providers) |
| **OpenAI-compatible endpoints — local (Ollama/llama.cpp/LM Studio) or remote (OpenRouter/Together/vLLM)** | ❌ never direct — only relayed through the pool |
| **Anthropic-compatible endpoints (Claude, or any Messages-format gateway)** | ❌ never direct — only relayed through the pool |
| True on-device inference (no network) | ❌ none |

This plan closes that gap in four shippable workstreams:

- **P0 — Cloud pass-through:** delete the client-fabricated `nexus-<tier>` model ids; the
  server's `/api/v1/models` list becomes the single source of model truth; MCP `mode`
  enum → free-form string. *(plugin-only, ~all in `client/` + `mcp/`)*
- **P1 — Desktop 4-class provider layer:** a new local-transport engine in the Electron
  main process that speaks direct OpenAI-compatible and Anthropic-compatible wire
  formats (local Ollama included), behind a new IPC surface. The renderer's
  server/local toggle becomes a model-class picker. *(the bulk of the work)*
- **P2 — Greater output:** higher output defaults, per-model caps from server metadata,
  client-side context budgeting for very large inputs.
- **P3 — Cloud sync:** conversation persistence + cross-machine sync on top of the
  existing memory sync; memory written from *any* model class follows the user.
- **P4 — Out-of-repo prerequisites:** server (aegis1) catalog/model-pinning/schema
  widening that the client work assumes.

---

## 1. Architecture rule — the one decision everything hangs on

Today the repo's rule is: *"thin shell — no engine, no routing, no tier logic in this
repo; everything lives behind aegiscloud.org."* That rule is correct for **cloud**
capabilities and **must stay**: cloud routing/tier/brain logic never enters this repo.

But a localhost Ollama daemon or a private OpenAI-compatible base URL **cannot be
reached from aegiscloud.org** (the server pool is on Railway; a user's `localhost` is
not routable from it). Therefore shipping "local / OpenAI-compatible / Anthropic-
compatible" as first-class means the Electron desktop host grows one new, narrow
capability:

> **Direct transport from the desktop main process to user-configured endpoints.**
> Keys/base URLs live only in the main process (same privilege model as the AEGIS key
> today). The renderer never sees them. No orchestration, routing, tier, or brain logic
> is added — only wire-format transport and per-model settings.

New guard wording for the CI thin-shell check: *no cloud routing/tier/brain logic is
allowed; direct transport to user-configured model endpoints is explicitly permitted,
keys held in main.* The MCP/Claude Code surface stays **cloud-only** (Claude Code runs
inside a host that already has models).

---

## 2. Model-class matrix — where each class runs

| Class | Transport | Auth | Endpoint(s) | Held in |
|---|---|---|---|---|
| **Aegis Cloud** (auto or pinned) | aegiscloud.org pool | `X-API-Key` / Bearer | `POST /api/v1/chat/completions`, `GET /api/v1/models` | main (existing) |
| **BYOK relay** | aegiscloud.org relay | per-request `X-Provider-Key` | `POST /api/v1/byok/chat/completions`, `/api/user/api-keys` | main + server (existing) |
| **OpenAI-compatible direct** | direct from desktop | keyless (Ollama) or user baseURL key | `{baseURL}/v1/chat/completions` (SSE) | main — **new** |
| **Anthropic-compatible direct** | direct from desktop | Anthropic key | `{baseURL}/v1/messages` (SSE) | main — **new** |

Streaming for all four classes flows over the existing `CHAT_DELTA_CHANNEL`
(`aegis:chatDelta`) push channel — one renderer painting path.

---

## 3. Per-file audit — what is already true in this repo

Facts verified against current code (used as the baseline for the change list):

- `client/aegis.js` (516 lines) — shared thin client, zero-dependency, runs under
  MCP + Electron + browser. `chatCompletion()` (lines 251–275) **fabricates the model**
  when none is given: `requestedModel = model || 'nexus-' + (mode || 'smart')`
  (lines 263–264), and defaults `max_tokens: 1024` (line 268). It forwards an exact
  `model` verbatim the moment one is supplied.
- `byokChatCompletion()` (lines 284–312) is **already generic**: any `provider` string +
  optional `model` pass straight through with `X-Provider-Key`; no client whitelist.
- `postStream()` (lines 333–433) parses OpenAI-format SSE deltas, falls back to plain
  JSON, and normalises — one wire parser used by every host.
- `listModels()` → `GET /api/v1/models`; the client hardcodes **no** model list.
- Memory APIs exist: `memorySearch` / `memorySave` / `memoryList` (lines 459–483),
  bearer-authed with a `memory_token` obtained from `/api/verify-api-key`
  (`getMemoryToken`, lines 199–210). **Cloud memory sync is built and shipped.**
- `desktop/vendor/aegis.js` is a byte-identical vendored copy made by
  `desktop/scripts/predist.mjs`; every change to `client/aegis.js` must land in the
  vendor copy too (regenerate, never hand-edit).
- `mcp/server.js` (381 lines) — zero-dep MCP host. `aegis_ask` schema locks the tier
  vocabulary: `mode` `enum: ['fast','smart','neo']` (line 59), `max_tokens` capped at
  **8192** (line 68), default 1024; `run()` force-defaults `mode='smart'` (line 78).
  `aegis_byok_set` locks providers: `enum: ['anthropic','groq','openai']` (line 163).
- `desktop/main.js` (200 lines) — thin Electron shell. Single `aegis:` IPC dispatch
  (`createIpcDispatch`, lines 69–112) wrapping the **cloud client only**; streaming
  pushed over `aegis:chatDelta` (`registerIpc`, lines 115–144); `maskKey()` (lines
  59–63) is the existing key-masking pattern to reuse. Sandbox + contextIsolation are
  already on (lines 165–171).
- `desktop/preload.js` (64 lines) — whitelisted `window.aegis.*` bridge; no Node leaks.
- `desktop/renderer/app.js` (338 lines) — thin UI. The **server/local toggle is the
  gate**: `mode-toggle` + `COMPUTE_KEY = 'aegis.compute'` (line 51), `setMode()`
  disables the model select in server mode (lines 184–193), and `send()` (lines
  239–295) sends `{ prompt, maxTokens: 1024 }` plus either `model` (local/BYOK) or the
  hardcoded `payload.mode = 'smart'` (line 253). Streaming paint already works.
- Docs: `docs/electron-host-plan.md`, `commands/aegis-ask.md` (and siblings),
  README tool table, `.claude-plugin/plugin.json` (version `0.2.0`, mirrored by
  `SERVER_VERSION` in `mcp/server.js:21`) all repeat the `fast/smart/neo` vocabulary.
- Repo has an existing CI + pre-commit guard pipeline (D1–D4 history: thin-shell guard,
  shell smoke test, secret/runtime-state/build-artifact scans) that must be updated in
  lockstep with the guard wording change in §1.

---

## 4. Workstream P0 — cloud pass-through & model-first vocabulary (plugin-only)

Goal: the plugin never decides a model; the server's model list is the truth; clients
that omit `model` get the server default instead of a client-invented tier id.

### 4.1 `client/aegis.js` (+ regenerate `desktop/vendor/aegis.js`)

- `chatCompletion()` lines 263–264 — delete the fabrication:
  - if `model` is provided → `body.model = model` (verbatim, unchanged);
  - if not → **omit `model` entirely**; server picks its default (requires aegis1
    change, §8).
  - `mode` stays accepted as an optional field that is forwarded verbatim **only** if
    the caller supplies it — never defaulted, never string-interpolated into a model id.
- Line 268 (and BYOK line 300) — `max_tokens: maxTokens || 1024` → default **4096**
  (per-call override preserved).
- `listModels()` — when the backend enriches models with metadata (`context_window`,
  `max_output`), expose them (they already pass through raw — do not strip).
- No new endpoints in this repo. No model whitelist. No routing.
- Bump `CLIENT_VERSION` (line 95) → `3.2.0`; regenerate vendor copy via
  `desktop/scripts/predist.mjs`; confirm byte-identical (`cmp` in CI).

### 4.2 `mcp/server.js`

- `aegis_ask` schema (lines 45–72):
  - `mode`: `enum ['fast','smart','neo']` → `{ type: 'string' }`, described as a
    *legacy server-side shorthand* — optional, no default applied client-side.
  - `model`: description becomes *"pin any model id returned by aegis_list_models —
    or omit to let the server route"* (no tier vocabulary).
  - `max_tokens`: `maximum: 8192` → **64000** (server still enforces the true ceiling);
    drop `maximum` duplication risk by documenting server-side enforcement.
  - `run()` (lines 73–97): remove `const mode = args.mode || 'smart'` (line 78) and
    the `payload.mode` default; pass `maxTokens: args.max_tokens` (no `|| 1024`);
    drop `args.model ? null : 'mode: …'` meta (line 90) — report only the model the
    server actually answered with (`data.model`).
- `aegis_byok_set` schema line 163 — `enum ['anthropic','groq','openai']` →
  free-form `string` with description listing known ids
  (`openai`, `anthropic`, `groq`, `openrouter`, `together`, `deepseek`, `gemini` …);
  the server validates/store supports (§8). Same for `aegis_byok_status` description.
- `aegis_status` — unchanged (server reports plan).
- Bump `SERVER_VERSION` (line 21) + `.claude-plugin/plugin.json` together → `0.3.0`.

### 4.3 Docs/commands (vocabulary sweep)

- `commands/aegis-ask.md`, README tool table, `docs/electron-host-plan.md` header:
  replace `fast/smart/neo` tiers with the model-first rule:
  *"list models with aegis_list_models and pass any id; omit model to let the server
  pick."* Remove "nexus-" id spellings.

---

## 5. Workstream P1 — desktop 4-class provider layer (bulk of the work)

Goal: one chat UI where the model selector offers every class — Aegis Cloud, BYOK
relay, local Ollama, and any OpenAI-/Anthropic-compatible endpoint — all streaming,
all key-safe.

### 5.1 New modules: `desktop/lib/local/` and `desktop/lib/sync/`

Small, pure-core modules (unit-testable in plain Node; no Electron imports):

- `desktop/lib/local/ollama.js` — detect/start/probe `ollama serve`
  (`http://localhost:11434`), list tags (`GET /api/tags`), and chat over its
  OpenAI-compatible `/v1/chat/completions` (keyless). Model: port the pattern from
  ae-guix `lib/ollama.js` (donor), simplified to the wire calls only.
- `desktop/lib/local/providers.js` — direct streaming chat for two wire formats:
  - **OpenAI-compatible** (`{baseURL}/v1/chat/completions`, Bearer or no key) and
  - **Anthropic Messages** (`{baseURL}/v1/messages`, `x-api-key` +
    `anthropic-version` header, `content_block_delta` SSE events).
  Reuse the SSE parsing shape from `client/aegis.js postStream()` (lines 333–433),
  parameterised by wire format; normalise both to `{ delta }` chunks + a final result.
  Note `fetch` streams only work in Electron main (Node ≥ 18) — fine, this is main-only.
- `desktop/lib/local/context.js` — token-budget trimmer for very large inputs (port
  ae-guix `trimContext()` pattern): estimate tokens, keep system + newest turns,
  summarise/drop oldest beyond the budget. This is the client half of "handles high
  data volumes".
- `desktop/lib/sync/sessions.js` — session persistence (below, §7).
- `desktop/lib/settings.js` — provider-config store in `app.getPath('userData')`
  (`~/.aegiscode/…`): base URLs, keyed providers. **Keys encrypted-at-rest or
  OS-keychain via safeStorage when available** (Electron `safeStorage`); always shown
  masked via `maskKey()`.

### 5.2 `desktop/main.js`

- Keep the entire existing `aegis:` dispatch + `CHAT_DELTA_CHANNEL` untouched
  (back-compat: existing renderer + shell tests keep passing).
- Add a second prefix `model:` whose dispatch is backed by a **LocalEngine registry**
  that owns settings + credentials:
  - `model:listClasses` → `[{ class: 'aegis'|'byok'|'ollama'|'openai-compat'|'anthropic',
    label, configured }]`
  - `model:listModels(class)` → Aegis Cloud → `aegis.listModels()`; Ollama →
    ollama tags; others → stored settings
  - `model:chat(class, { model, messages/prompt, maxTokens, … }, onStream)` → routes
    to cloud client, ollama module, or providers module; SSE deltas forwarded over
    `CHAT_DELTA_CHANNEL` exactly like today's `chatCompletion` special case
    (lines 124–138)
  - `model:settings.get/set` (set takes keys, get returns only masked previews)
  - `model:cancel(sessionId)` — abort a stream via `AbortController` per session
- The registry is transport-only: no tier/brain/routing decisions here; cloud class
  delegates to the shared client verbatim.

### 5.3 `desktop/preload.js`

- Keep `window.aegis.*` exactly as-is (existing consumers + tests).
- Add `window.models.*` (listClasses / listModels / chat with `onDelta` over
  `CHAT_DELTA_CHANNEL` / settings CRUD with masked values) and `window.sync.*`
  (§7). Update the whitelist comment to state the mirrored-dispatch rule
  (main.js + preload.js must be edited together).

### 5.4 `desktop/renderer/app.js` + `index.html` + `style.css`

- Remove the two-state gate: `mode-toggle` element, `COMPUTE_KEY` (line 51),
  `setMode()` (lines 184–193), and the change listener (lines 308–312).
- Add a **provider-class select** whose options are grouped:
  1. `Aegis Cloud` → model list from `aegis.listModels()` + the "server default" entry
     (sends **no** model);
  2. `BYOK relay` → models that require a stored provider key (from
     `aegis.byokStatus()` / `model:listModels('byok')`);
  3. `Ollama (local)` → live tags from the local daemon;
  4. `Custom OpenAI-compatible` and `Anthropic-compatible` → user-typed base URL +
     model (settings panel; keys never rendered, only `masked`).
- The model `<select>` is **always enabled**; population swaps with the chosen class.
- `send()` (lines 239–295): drop the `payload.mode = 'smart'` branch (line 253) and
  the `local = toggle.checked` read (line 247). Build `payload = { prompt, maxTokens }`
  + `model` only when a model was explicitly picked. Route through `window.aegis`
  (cloud/BYOK) or `window.models` (local classes) with the same streaming paint path.
- Add a `maxTokens` picker (1k / 4k / 16k / 64k; default 4096 after P0).
- `addMessage` meta line (lines 144–170): append class badge —
  `model: deepseek-v4-pro · ollama`.
- Add a Settings pane (provider base URLs + key status + "remove key") and (after P3)
  a Sessions pane.
- Add a **cancel** button on pending bubbles → `model:cancel` / abort.

### 5.5 Packaging / vendoring

- `desktop/scripts/predist.mjs`: in addition to copying `client/aegis.js` →
  `desktop/vendor/aegis.js`, copy the new `desktop/lib/local`, `desktop/lib/sync`,
  `desktop/lib/settings.js` into the packaged app dir (electron-builder cannot reach
  outside the app dir — same reason the vendor copy exists today).
- `desktop/package.json`: version bump; no new runtime deps required (Node fetch +
  Electron safeStorage cover everything — keep zero-dependency ethos).

---

## 6. Workstream P2 — greater output

Concrete, measurable:

1. Default `max_tokens` **1024 → 4096** in `client/aegis.js` chat + BYOK (P0 §4.1).
2. MCP `aegis_ask` cap **8192 → 64000** (P0 §4.2) — long documents/agents can now
   request real output; server enforces the true ceiling per model.
3. Desktop `maxTokens` picker (P1 §5.4) with per-model ceiling shown from
   `/api/v1/models` metadata when present (`max_output`), falling back to 64k.
4. Context budgeting client-side (`desktop/lib/local/context.js`) so **very large
   inputs** (the 1M-window flagship models being added server-side — P4) are trimmed
   to the model's budget *before* hitting the wire; full text stays in the local
   session record for the user.
5. Streaming stays the default path for all four classes (one `CHAT_DELTA_CHANNEL`
   painter) — long outputs paint live instead of buffering (already built for cloud).

---

## 7. Workstream P3 — cloud sync

**Memory sync already exists** (`client/aegis.js` `getMemoryToken` +
`memorySearch/Save/List`; desktop memory panel, app.js lines 96–142). Productise it:
- Tag entries written from the desktop with `source: 'aegis-desktop'` + `session` id so
  the panel can filter (memorySave already accepts free-form entries; the MCP saver
  sets `source: 'claude-code'`, `session: args.session` — mirror that shape).
- **Memory from any model class follows the user**: when the user clicks "remember"
  on a message produced by an *Ollama/custom/anthropic* session, write it through the
  same `memorySave` cloud path — local-chat facts become cross-machine facts. If no
  AEGIS key is present, queue locally and sync later (§ "offline first").

**Conversation sync is new** (`desktop/lib/sync/sessions.js`):
- Every session (any model class) persists to `~/.aegiscode/sessions.json` on each
  message (append + periodic flush; crash-safe via temp-file rename).
- With an AEGIS key configured: mark sessions `pending` and push to the server's
  conversation-sync endpoint (reuse what ae-guix already talks to — do not invent a
  new API; §8 makes it available to this client). Store `session_id` per conversation
  (the shared client already has `randomUUID` for ids).
- On a second machine: pull session list; "continue this conversation" rehydrates the
  transcript and lets the next reply append on top of the synced history.
- Offline first: with no key or no network, everything works locally; the sync engine
  retries on the next `listModels`/`status` heartbeat or explicit "Sync now".

IPC additions (`main.js`/`preload.js`): `sync:listSessions`, `sync:open(sessionId)`,
`sync:push`, `sync:status`.

---

## 8. Workstream P4 — out-of-repo prerequisites (aegis1 / ae-guix / aegiscode-pub)

The client work above assumes server capabilities. These are tracked here so the repo
plan is complete and the server work can be scheduled alongside:

**aegis1 (server):**
1. Accept `model` **absent** in `/api/v1/chat/completions` → server default (no
   `nexus-*` requirement). Keep `nexus-*` tier aliases working for old clients.
2. Ship a `LISTABLE_MODELS` catalog of flagship ids with high context windows
   (e.g. `deepseek-v4-pro`, `grok-4.20`/1M-class, `claude-sonnet-5`, `gemini-3.1-pro`)
   exposed by `GET /api/v1/models` **with `context_window` + `max_output` metadata**.
3. Exact-model-id pinning in the chat dispatch: exact id → provider+model pinned;
   provider id → provider default; otherwise tier routing.
4. `/api/user/api-keys` (+ BYOK relay): widen from 3 providers to arbitrary
   `provider` strings; relay accepts any upstream OpenAI- or Anthropic-compatible
   shape needed (validate against a server-side provider table).
5. Conversation-sync endpoint (push/pull transcripts) that ae-guix's cloud toggle
   already uses — make it available to the thin client with the memory-token auth.

**ae-guix (donor only):** port its local/Ollama/Anthropic/context-trim/session-store
modules into this repo per §5.1/§7 rather than maintaining two copies.

**aegiscode-pub (site):** model list pages + pricing tiers (§ pricing plan) describe
the four model classes; `/pricing` is the upgrade URL surfaced by the desktop when a
cloud plan limit is hit.

---

## 9. Tests, CI, guards (this repo)

- **Thin-shell guard re-wording** (the CI check added in D1–D4): the forbidden list is
  *cloud routing/tier/brain logic and server logic*; the **permitted** list is now the
  transport modules `desktop/lib/local/*`, `desktop/lib/sync/*`, `desktop/lib/settings.js`
  — pure wire-format clients + storage, no orchestration. Keep the guard as a literal
  blocklist/allowlist of paths so it does not fight the feature.
- **Pre-commit guard** (secrets/runtime-state/artifacts): extend its secret patterns to
  any new key fields (settings store sample keys are masked/absent in git).
- New unit tests (plain Node, no Electron):
  - `client/aegis.js`: request body builder now omits `model` when absent and never
    emits `nexus-…` (assert on a stub `fetch`).
  - `desktop/lib/local/context.js`: budget math + oldest-drop ordering.
  - `desktop/lib/local/providers.js`: SSE fixture parsing for OpenAI and Anthropic
    wire formats (both delta and plain-JSON fallback paths).
  - `desktop/lib/sync/sessions.js`: round-trip with a temp dir; crash-safe write.
  - `desktop/main.js` `createIpcDispatch`: unchanged contract tests still pass; new
    `model:` dispatch maps to stub engines.
- **Smoke tests** keep running headless (`node --check`, shell drive of dispatch).

---

## 10. Phase acceptance checklists

**P0 (cloud pass-through)**
- [ ] No `nexus-` string is built anywhere in `client/aegis.js` or `mcp/server.js`.
- [ ] `chatCompletion({prompt})` (no model) sends a body **without** `model`; stub
      fetch test asserts this.
- [ ] `aegis_ask` with no `model` and no `mode` succeeds end-to-end once the server
      accepts absent model (P4.1); `aegis_list_models` output can be pinned verbatim.
- [ ] Vendor copy byte-identical (`cmp`), versions bumped, docs vocabulary swept.
- [ ] Verify: `node --check client/aegis.js mcp/server.js`, unit suite green, manual
      `tools/call` against a test MCP session shows `model: <server-chosen>` meta.

**P1 (4-class desktop)**
- [ ] Desktop launches; class picker shows Aegis Cloud / BYOK / Ollama / custom
      OpenAI-compat / Anthropic groups.
- [ ] Chat streams live for: cloud (existing), Ollama with `ollama serve` running,
      a dummy OpenAI-compat server (test fixture), and an Anthropic-compat fixture.
- [ ] Renderer devtools: `window.models.settings.get()` returns only masked keys;
      full keys never cross the bridge.
- [ ] Cancel stops an in-flight stream (AbortController).
- [ ] Verify: desktop smoke test script + `cmp` on vendored files + CI green.

**P2 (greater output)**
- [ ] New default 4096 observed in outbound bodies; MCP accepts `max_tokens: 60000`
      and streams/paints a long answer; metadata-driven ceiling shown in picker.
- [ ] A synthetic 200k-token input through `context.js` fits the target budget.

**P3 (cloud sync)**
- [ ] `sessions.json` written for an Ollama chat; restart reopens the session.
- [ ] With AEGIS key: session appears on a second machine after pull; memory saved
      from a local-model session is found by `memorySearch` on the other machine.

**P4 (server)** — tracked in aegis1; P0/P1 desktop work must not block on it beyond
the two items marked as prerequisites (absent-model acceptance, model metadata).

---

## 11. Sequencing

| # | Workstream | Depends on | Effort | Result |
|---|---|---|---|---|
| 1 | P0 cloud pass-through | — | small | model list = truth; no tier fabrication |
| 2 | P4a server: absent-model + metadata + catalogs | — (parallel) | medium | client P0 has a server to talk to |
| 3 | P1 local engine modules (ollama/providers/context) | P0 | medium | direct OpenAI/Anthropic/Ollama transport, tested |
| 4 | P1 IPC + preload + renderer class picker | P1 modules | medium | one UI, four model classes |
| 5 | P2 output scaling | P0 + P1 | small | 4k default, 64k MCP cap, input budgeting |
| 6 | P3 session store + conversation sync | P1 + P4a(5) | medium | cross-machine conversations + memory |
| 7 | P4b server BYOK widening + sync endpoint | P4a | medium | non-3-provider BYOK, sync API |
| 8 | Docs sweep, guard update, release (0.3.x → 0.4.x) | 1–7 | small | ship |

Each milestone is independently shippable; P1 is the biggest and is broken into
"engine modules" → "UI wiring" so engine work lands test-first.

---

## 12. Decisions to lock before building

1. **MCP (Claude Code) surface stays cloud-only** — local/direct classes surface only
   in the desktop host, which already has its own models context. (Recommended: yes.)
2. **Local = direct from desktop; cloud = relay through pool.** A localhost endpoint is
   never routed through aegiscloud.org, and the pool never needs to reach localhost.
3. **Keys live in the main process only** — masked previews cross the bridge; full
   keys never reach the renderer (unchanged from today's AEGIS-key handling).
4. **Back-compat:** `window.aegis.*` + `aegis:` IPC + the shared client stay intact;
   new surface is additive (`model:`/`sync:` prefixes, `window.models`/`window.sync`).
5. **`mode` is retired as a client concept** (legacy server shorthand at most) —
   no tier vocabulary in this repo after P0.
6. **Thin-shell guard is amended** (transport allowed, brain forbidden) — this single
   rule change is the enabler for the whole plan; it must be explicit before CI is
   updated.
7. Cloud conversations sync through the **existing ae-guix sync API**, not a new
   protocol invented in this repo.

---

*End of plan. Changes land in this repo per P0 → P1 → P2 → P3, with aegis1 tracked in
parallel as P4 prerequisites. The plugin remains the MIT thin client + desktop host;
everything paid/cloud stays server-side on aegiscloud.org.*
