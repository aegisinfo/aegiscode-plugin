# AEGISCODE-PLUGIN — PLAN

Canonical execution plan for this repo (MCP plugin + Electron desktop host +
shared thin client). The full product spec lives in `docs/product-plan.md`
(§4–§10); this file is the reconciler-driven queue of the remaining work.

A phase is **done** when its heading carries ✅ *and* its line in the Status
checklist is `[x]`. The first unchecked phase is the next unit of autonomous
work.

Status:

- [x] Phase 1 — P0 cloud pass-through & model-first vocabulary
- [x] Phase 2 — P1 desktop 4-class engine modules (transport + storage)
- [x] Phase 3 — P1 IPC + preload + renderer class picker + packaging
- [x] Phase 4 — §9 tests + thin-shell guard re-wording
- [x] Phase 5 — P2 metadata-driven per-model output ceiling
- [ ] Phase 6 — P3 cloud conversation sync (replace the push stub)
- [ ] Phase 7 — P3 memory-follows-user from any model class

---

## Phase 1 ✅ — P0 cloud pass-through & model-first vocabulary

Done. The client no longer fabricates model ids and never invents a tier.

- `client/aegis.js` `chatCompletion()` omits `model` when absent (server default);
  `mode` forwarded verbatim only when supplied; `max_tokens` default 1024 → 4096.
- `mcp/server.js` `mode` enum → free-form string; `max_tokens` cap 8192 → 64000;
  `aegis_byok_set` provider enum → free-form string.
- Docs/vocabulary swept (`nexus-*` spellings removed).

Commits: `5b47346`, `92178a6`, `f00705c`, `86b122f`, `88e2e0a`.

## Phase 2 ✅ — P1 desktop 4-class engine modules (transport + storage)

Done. Pure-core modules land test-first, no Electron imports.

- `desktop/lib/local/{context,providers,ollama,engine}.js` — OpenAI-compatible +
  Anthropic Messages direct streaming transport, Ollama probe/list/chat,
  model-class registry with per-session `AbortController`.
- `desktop/lib/settings.js` — main-process key store (safeStorage-aware, masked previews).
- `desktop/lib/sync/sessions.js` — crash-safe local session persistence with a
  monotonic `seq` tiebreaker (fixes same-millisecond ordering).

Commit: `e1001bf`. Unit tests: `test/local-context`, `test/local-providers`,
`test/local-engine`, `test/settings`, `test/sync-sessions` — green.

## Phase 3 ✅ — P1 IPC + preload + renderer class picker + packaging

Done. One UI, four model classes, all streaming, all key-safe.

- `desktop/main.js` `model:`/`sync:` dispatch backed by the transport modules;
  `model:chat` streams deltas over `CHAT_DELTA_CHANNEL` like the cloud path.
- `desktop/preload.js` `window.models.*` / `window.sync.*`; full keys never cross the bridge.
- `desktop/renderer/*` 5-class picker (Aegis Cloud / BYOK / Ollama / OpenAI-compat /
  Anthropic), always-on model select, maxTokens picker, provider settings pane,
  sessions pane, cancel button; dropped legacy `payload.mode='smart'`.
- `electron-builder.yml` + version 0.2.0 → 0.3.0; `predist.mjs` packages `lib/**`.

Commit: `ab1bcf7`. Tests: `test/model-dispatch.mjs`, `test/desktop-shell.mjs` (15-channel whitelist) — green.

## Phase 4 ✅ — §9 tests + thin-shell guard re-wording

Done.

- `test/client.test.mjs` asserts body-builder model omission, no `nexus-*`, BYOK
  defaults, messages-supersede-prompt/system (commit `86822ab`).
- CI thin-shell guard re-worded to an explicit path allowlist: transport permitted
  (`desktop/lib/local/*`, `desktop/lib/sync/*`, `desktop/lib/settings.js`), brain
  forbidden (commit `410c380`).

---

## Phase 5 ✅ — P2 metadata-driven per-model output ceiling

Done. `listModels()` was already pass-through raw (asserted, not assumed); the
desktop maxTokens picker now clamps to each model's real ceiling.

- `client/aegis.js` `listModels()` unchanged — `apiGet` returns parsed JSON
  verbatim, no stripping. Asserted by a new `listModels()` pass-through
  fetch-stub test in `test/client.test.mjs` (`max_output`/`context_window`
  survive the round trip; models without metadata aren't backfilled).
- `desktop/renderer/max-tokens.js` — new standalone pure helper,
  `maxTokensCeiling(meta) = min(64000, meta.max_output)` when `max_output` is
  a positive finite number, else the flat 64000 fallback. Dual
  CommonJS/browser export like `client/aegis.js`, loaded as a sibling classic
  `<script>` before `app.js` (`index.html`) so it's unit-testable without
  `window.aegis`/`window.models`.
- `desktop/renderer/app.js` `loadModels()` now records raw model objects in a
  `modelMeta` map and calls `applyMaxTokensClamp()`, which disables
  `max-tokens` `<option>`s above the selected model's ceiling (clamping the
  current selection down if needed) and appends `· max output: N` to the
  model hint when the ceiling is below 64k. A `model-select` change listener
  re-clamps when the user switches models mid-class; custom classes
  (openai-compat/anthropic, no metadata available) always get the flat
  fallback.
- `test/max-tokens.test.mjs` — new unit test for the pure ceiling helper
  (below/above/absent/non-numeric/zero/negative `max_output`).

Exit criteria:
- `listModels()` output with `max_output`/`context_window` is returned unmodified. ✅
- The maxTokens picker reflects a selected model's `max_output` when metadata is
  present, and 64k otherwise. ✅
- `cd desktop && npm run check` and `node test/*.mjs` stay green. ✅

## Phase 6 — P3 cloud conversation sync (replace the push stub)

Scope (`docs/product-plan.md` §7 + §8.5, decision §12.7). Replace the no-op
`sync:push` stub in `desktop/main.js` `createSyncDispatch()` with real push/pull
against aegis1's conversation-sync surface, reusing the **memory-token** auth that
already powers `client/aegis.js` memory calls (`getMemoryToken()`, lines 198–210).
Do **not** invent a new protocol — mirror the aegis1 endpoint contract.

- Extend `desktop/lib/sync/sessions.js`:
  - `pending` flag per session (set on every `appendMessage`/`upsert`, cleared on push);
  - `markSynced(id)` / `markPending(id)`;
  - a local pending-session queue (`listPending(dir)`).
- Wire `sync:push` / `sync:pull` / `sync:status` in `createSyncDispatch`:
  - `push` — upload pending sessions (with the memory token), store the returned
    `session_id` per conversation, clear `pending`.
  - `pull` — list remote sessions and merge/rehydrate locally.
  - `status` — `{ count, pending, cloud, lastSyncAt }`.
- Offline-first: with no AEGIS key or no network, `push` returns
  `{ ok:false, reason }` without throwing and everything stays local; retry on a
  heartbeat (next `listModels`/`status`) or an explicit "Sync now" button in the
  sessions pane (`renderer/app.js` + `index.html`).
- Add a unit test for pending-queue + `markSynced` round-trip against a temp dir.

Exit criteria:
- `sessions.json` marks a session `pending` until pushed, and `markSynced` clears it.
- With AEGIS key + reachable aegis1: `sync:push` uploads and clears pending;
  `sync:pull` rehydrates a session from a second machine.
- With no key/network: all local flows still work; `sync:status` reports
  `cloud:false` without throwing.
- Unit + smoke tests green.

Blocked-on: aegis1 conversation-sync endpoint accepting the thin client's
memory-token auth (aegis1 `PLAN.md`, Phase 3). The local pending-queue half of this
phase is unblocked and can land first.

## Phase 7 — P3 memory-follows-user from any model class

Scope (`docs/product-plan.md` §7). Memory written from a *local* model class
(Ollama / custom OpenAI / Anthropic) must follow the user across machines through
the existing cloud memory path.

- Today `saveMemory()` writes `{ text, source: 'aegis-desktop' }` with no session.
  Add a "remember" affordance on assistant messages produced by **any** class that
  calls `aegis.memorySave` with `source: 'aegis-desktop'` **and** `session: <id>`,
  mirroring the MCP saver shape (`source: 'claude-code'`, `session: args.session`).
- Thread the current session id through the renderer so saves carry it (the
  `send()` path already has `sessionId`; make it available to the remember button).
- No-key path: queue locally (reuse the pending queue from Phase 6 where it fits)
  and flush on the next successful key check / "Sync now".

Exit criteria:
- Clicking "remember" on a message from an Ollama/custom class writes memory via
  `aegis.memorySave` with `source: 'aegis-desktop'` + `session: <id>`.
- With a key present, that memory is found by `memorySearch` from another machine.
- With no key, the save queues locally without throwing.

Server-side memory sync (`/api/memory/*` with `memory_token`) already exists in
aegis1 — this phase is client-side only.

---

## Prerequisites (out of repo)

aegis1 server work that unblocks Phases 5–6 is tracked in the **aegis1** repo's
own `PLAN.md` (P4.2 catalog metadata → Phase 5; P4.5 conversation-sync endpoint →
Phase 6). Phase 7 is unblocked today (memory sync already shipped).
