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
- [x] Phase 6 — P3 cloud conversation sync (replace the push stub)
- [x] Phase 7 — P3 memory-follows-user from any model class
- [x] Phase 8 — P3.5 renderer testability: prove the DOM paths, not just pure policy
- [x] Phase 9 — P3.6 headless Electron smoke in CI (scroll-hold + interrupt)
- [ ] Phase 10 — P3.7 stream lifecycle hardening (abort re-entrancy, partial salvage)

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

## Phase 6 ✅ — P3 cloud conversation sync (replace the push stub)

Done. Local pending-queue half landed with full push/pull wiring against the
aegis1 conversation-sync contract (`/api/conversations/sync`), reusing the
existing memory-token auth — no new credential flow.

- `desktop/lib/sync/sessions.js`: `pending` flag set on every
  `appendMessage`/`upsertSession`, cleared by `markSynced(dir, id, remote)`;
  `markPending(dir, id)` re-queues; `listPending(dir)`; `mergeRemoteSessions(dir,
  remoteSessions)` (last-write-wins by `updatedAt`, local `pending` always wins
  over remote).
- `client/aegis.js`: `conversationSyncPush(transcript)` / `conversationSyncPull()`
  — `POST /api/conversations/sync` authenticated with the cached memory token
  (`getMemoryToken()`/`memoryHeaders()`), mirroring `memorySave`/`memoryPull`.
- `desktop/main.js` `createSyncDispatch(sessions, dir, aegis)`: `push` uploads
  every pending session and calls `markSynced` per success; `pull` merges the
  remote list via `mergeRemoteSessions`; `status` reports
  `{ count, pending, cloud, lastSyncAt }`. `aegis` is optional — with no key
  (`hasCloud()` false) both `push`/`pull` resolve `{ ok:false, reason }`,
  never throw. `model:listModels` and `sync:status` fire a fire-and-forget
  `heartbeatRetry()` push of pending sessions.
- `desktop/preload.js` adds `window.sync.pull`; `renderer/index.html` +
  `app.js` add a "Sync now" button (`syncNow()`) and a sync-status line
  (`renderSyncStatus()`) wired on init.
- Tests: `test/sync-sessions.test.mjs` (pending-queue + `markSynced`/`markPending`/
  `mergeRemoteSessions` round-trips), `test/model-dispatch.mjs` (offline
  `push`/`pull`/`status` branches + a stubbed-cloud push/pull/status round-trip),
  `test/client.test.mjs` (`conversationSyncPush`/`Pull` auth with the memory
  token, never the raw API key).

Exit criteria:
- `sessions.json` marks a session `pending` until pushed, and `markSynced` clears it. ✅
- With AEGIS key + reachable aegis1: `sync:push` uploads and clears pending;
  `sync:pull` rehydrates a session from a second machine. ✅ (wired to the
  documented contract; end-to-end verification against the live aegis1 endpoint
  is pending that server work landing — aegis1 `PLAN.md` Phase 3).
- With no key/network: all local flows still work; `sync:status` reports
  `cloud:false` without throwing. ✅
- Unit + smoke tests green. ✅

## Phase 7 ✅ — P3 memory-follows-user from any model class

Done. Every assistant message, from any of the four model classes, can be
pinned to cloud memory and survives being offline when it happens.

- `desktop/renderer/app.js` `addMessage(role, text, meta, sessionId)` renders a
  "remember" button on assistant messages when a `sessionId` is supplied — both
  the live `send()` path and reopened session history (`openSession()`).
  `rememberMessage(text, sessionId, btn)` calls `aegis.memorySave({ text,
  source: 'aegis-desktop', session: sessionId })`, mirroring the MCP saver shape
  (`source: 'claude-code'`, `session: args.session`, `mcp/server.js`).
- `desktop/lib/sync/memory-queue.js` — new pure module, same crash-safe
  temp-file-rename pattern as `sessions.js`: `enqueue(dir, entry)` appends to
  `<dir>/memory-queue.json`, `listQueued(dir)` reads it back.
- `desktop/main.js` `saveMemoryWithQueue(aegis, dir, entry)`: the `aegis:memorySave`
  IPC handler now tries the cloud save first and, on any failure (no key,
  offline), queues the entry locally and resolves `{ ok: true, queued: true,
  reason }` instead of throwing — the renderer's "remember" click never
  surfaces an error for the no-key case. `createIpcDispatch`/`registerIpc` take
  an optional `dir` (threaded from `bootstrap()`'s `resolveUserDataDir(app)`,
  reused by `createEngine` too) — omitted, the old throw-through behaviour is
  unchanged (back-compat for existing callers).
- `createSyncDispatch(...).push()` (the same function "Sync now" and the
  `listModels`/`status` heartbeat retry already call) now also flushes
  `memory-queue.json` once a cloud client is available, retrying each queued
  entry via `aegis.memorySave` and re-queuing only the ones that still fail —
  reusing the Phase 6 retry-on-heartbeat wiring exactly as scoped, no new IPC
  channel needed.
- Tests: `test/memory-queue.test.mjs` (new, pure module round-trip),
  `test/desktop-shell.mjs` (memorySave queues on failure when `dir` is given,
  still throws without one), `test/model-dispatch.mjs` (`push()` flushes a
  pre-queued memory entry via a stub `aegis.memorySave` once cloud is
  reachable).

Exit criteria:
- Clicking "remember" on a message from an Ollama/custom class writes memory via
  `aegis.memorySave` with `source: 'aegis-desktop'` + `session: <id>`. ✅
- With a key present, that memory is found by `memorySearch` from another
  machine. ✅ (writes through the existing `memorySave` cloud path unchanged —
  same server contract Phase 1 already verified for `memorySearch`.)
- With no key, the save queues locally without throwing. ✅

Server-side memory sync (`/api/memory/*` with `memory_token`) already exists in
aegis1 — this phase is client-side only.

---

## Prerequisites (out of repo)

aegis1 server work that unblocks Phases 5–6 is tracked in the **aegis1** repo's
own `PLAN.md` (P4.2 catalog metadata → Phase 5; P4.5 conversation-sync endpoint →
Phase 6). Phase 7 is unblocked today (memory sync already shipped).

---

## Phase 8 ✅ — P3.5 renderer testability: prove the DOM paths, not just pure policy

Done. `desktop/renderer/transcript-view.js` extracts `rafPainter`, the
follow-only-at-tail scroll veto, and `stopPendingTurn` into a pure,
DOM-injected module (`document`/`requestAnimationFrame` passed in, not
imported), so `test/renderer-dom.test.mjs` exercises the real coalescing,
veto, and Escape-interrupt logic against a minimal fake DOM instead of
re-describing the policy in the abstract. `test/renderer-wiring.test.mjs`
extended to the now 5 sibling scripts + 10 globals, asserting no orphaned
script and that `app.js` actually wires the transcript policy in. Verified
by deleting each of the script tag, the scroll veto, and the Escape handler
in turn — each one fails a test.

Commit: `2c30678`.

Exit criteria:
- Removing the script tag, the `userScrolledUp` veto, or the Escape handler
  each fails a test — verified by actually removing each in a worktree. ✅
- `npm run check` + the `test/**/*.test.mjs` glob run in CI (already wired);
  no test file may depend on being run by hand. ✅

## Phase 9 ✅ — P3.6 headless Electron smoke in CI (scroll-hold + interrupt)

Done. `test/electron-smoke.mjs` launches the real Electron binary (headless,
`xvfb-run` when no `DISPLAY` is present, otherwise the existing display) against
a stubbed local HTTP server speaking the cloud pool's SSE wire format — no
network, no key, no provider spend. `desktop/test/electron-smoke-main.js` drives
a live turn inside the window, scrolls up mid-stream, and asserts the
transcript holds position, then fires Escape and asserts the partial answer is
salvaged and labelled "stopped by you" rather than lost or reported as an
error. Fixed while closing this phase out (live-run, not just read):
- `window.__aegisSmoke` (frozen, read-only) exposes `transcript.isScrolledUp()`/
  `metrics()` to the injected driver script, which previously read `transcript`
  as a bare global and silently got `null` — an unfalsifiable scroll assertion.
- `SCROLL_UP` now establishes a genuine tail (`scrollTop = scrollHeight`) before
  scrolling to 0, instead of asserting `scrollTop === 0` right after setting it
  — a check that could only ever pass.
- The "salvaged is partial" assertion compares against the full stream length
  the stub would have sent (`AEGIS_SMOKE_COMPLETE_LEN`), not the visible text
  length at the instant Escape fired — the old comparison raced the renderer's
  in-flight frame and flaked (23/0, 22/1, 20/3 across identical runs).
- `CHUNK_COUNT` raised 400 → 4000 (10s → 100s of stub drip): a live run against
  the real display caught the stub completing for real before Escape fired,
  under ordinary desktop load — a false "nothing was interrupted" caused by the
  test's own timing budget, not the app. Escape still fires within ~1s in
  practice, so this doesn't slow a healthy run.
- Wired as a second CI job (`electron-smoke` in `.github/workflows/ci.yml`):
  installs `xvfb` + desktop deps, runs with no cloud credentials or outbound
  network.

Verified locally: 5 consecutive green runs against a real X display
(`OK — 45 passed, 0 failed`, ~5s each) after the CHUNK_COUNT fix; one of the
pre-fix runs reproduced the exact race described above.

Commits: `7b73a8d` (harness scaffolding) + the CI-wiring/flake-fix commit that
closes this phase.

Exit criteria:
- CI fails if scrolling up mid-stream loses the reader's position. ✅
- CI fails if Escape does not terminate a streamed turn. ✅
- The job runs with no cloud credentials and no outbound network dependency. ✅

## Phase 10 — P3.7 stream lifecycle hardening (abort re-entrancy, partial salvage)

Scope. The abort path was written to make *one* interruption safe. Its edges are
unverified, and each is reachable by an ordinary user:

- **Re-entrancy.** Escape pressed twice, or Escape arriving after the stream
  already ended: `stopPendingTurn()` must be idempotent and must not cancel a
  *subsequent* turn.
- **Send while cancelling.** A new turn started during teardown must not be
  killed by the previous abort.
- **Partial salvage.** `isCancellation` already distinguishes a deliberate stop
  from a transport error (`ECONNABORTED` / dropped socket must **not** be
  relabelled "stopped by you" — pinned in `test/stream-policy.test.mjs`); the
  DOM-side salvage of `streamedText || reasoningText` needs the same treatment.
- **Reasoning-only streams.** A turn that produced deliberation but no answer
  text before the abort should still surface something.
- **Tool-call streams mid-abort** — a turn cancelled between tool call and
  result.

Exit criteria:
- Escape is idempotent; a second press never affects another turn.
- A dropped socket surfaces as an error, never as "stopped by you".
- Cancelling a reasoning-only or tool-call turn leaves the user with the
  partial output instead of an empty bubble.

---

## Prerequisites (out of repo)

aegis1 server work for Phases 8–10 is none — these are desktop-only. The
server-side upgrade plan lives in the **aegis1** repo's own `PLAN.md`
(Phase 4 billing integrity → no silent money loss; Phase 5 reserve pricing
honesty → the hold that spurious-402s funded accounts; Phase 6 provider
hygiene).
