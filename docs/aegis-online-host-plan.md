# AEGIS Online — Plan

## Goal

Make the shared thin client a **first-class browser host** — a static,
zero-build, zero-dependency SPA that runs the same `client/aegis.js` transport
in any browser via a `<script>` tag. It is the web counterpart of the Electron
desktop host: **transport + UI only, never the brain.**

> **Hard boundary (non-negotiable):** the brain, orchestration, routing, and
> tier logic live in the private `ae-guix` repo and server-side on
> `aegiscloud.org`. The public repo ships transport + UI only.

---

## Current state

| Surface | Repo | Status |
|---|---|---|
| Shared thin client | `client/aegis.js` | ✅ browser-safe, zero-dep, exposes `window.AegisClient` in a `<script>` tag (v3.2.0) |
| Electron host | `desktop/` | ✅ built (v0.3.0) — thin GUI client |
| **Browser host** | **`online/`** | ⏳ **this plan** — static SPA over the same client |
| Brain | `ae-guix` (private) | ✅ stays private |

`client/aegis.js` already documents the browser host ("aegis-online — browser
SPA, vendored copy → `window.AegisClient`") and is genuinely browser-safe: no
`require`/`process`/`module` at load time, `fetch`-based, Web-Crypto UUID with a
sandboxed fallback. This plan just ships the host.

---

## Why cloud-only (the one decision)

The Electron host's value is its **direct** transport to localhost/OpenAI/
Anthropic endpoints — possible because Electron main is a Node process with OS
key storage and no CORS. A browser can do none of that safely:

- a browser page cannot reach `http://localhost:11434` (Ollama) from a
  cross-origin site, and must not hold arbitrary provider keys for direct
  upstream calls (no safeStorage, no OS keychain);
- CORS + mixed-content make a direct OpenAI/Anthropic SDK client fragile.

So the browser host is **cloud-only**, exactly like the MCP (Claude Code)
surface. Every model class reachable from a browser is reachable through the
pool/BYOK relay on `aegiscloud.org`. The brain stays server-side — which is the
same boundary the whole repo already enforces.

| Capability | Browser host |
|---|---|
| Aegis Cloud pool (pinned or server-default model) | ✅ `chatCompletion` |
| BYOK relay (per-request provider key) | ✅ `byokChatCompletion` |
| Model catalog | ✅ `listModels` |
| Account / plan / balance | ✅ `verifyApiKey` + `tokenBankBalance` |
| Cloud memory | ✅ `memorySearch` / `memorySave` / `memoryList` |
| Conversation sync | ✅ `conversationSyncPush` / `conversationSyncPull` |
| Direct Ollama / OpenAI-compat / Anthropic-compat | ❌ out of scope (Electron-only) |

---

## Key storage caveat (documented, accepted)

Electron holds keys in the main process (`safeStorage`) and never sends them to
the renderer. A browser has no equivalent, so the API key and any BYOK provider
key live in **`localStorage` on the user's own machine** and are sent only to
the configured API base over HTTPS. This is the standard web-SPA token model.

Mitigations, all shipped in this plan:

- **CSP** pins `script-src 'self'` + `style-src 'self'` (no third-party JS/CSS),
  so the only code that can read the key is this repo's own `app.js`.
- `connect-src https:` (plus `localhost` for dev) — the key cannot leave over
  plain HTTP.
- No telemetry, no analytics, no third-party fonts/scripts — the page makes
  requests only to the configured API base.
- The key is never logged, never written to `document`, and rendered only as a
  masked preview.

---

## Target architecture

```
aegiscode-plugin (PUBLIC)
├── client/aegis.js              ← shared thin transport (DONE, browser-safe)
├── online/                      ← host 3: static browser SPA (NEW)
│   ├── package.json             ← zero-dep scripts (check/predist/serve)
│   ├── scripts/
│   │   ├── predist.mjs          ← vendor client/aegis.js → vendor/aegis.js
│   │   └── serve.mjs            ← zero-dep static dev server (localhost)
│   ├── vendor/aegis.js          ← byte-identical vendored client
│   ├── index.html               ← chat UI + CSP (no external requests)
│   ├── app.js                   ← UI logic, calls window.AegisClient
│   └── style.css                ← self-contained styling
├── mcp/server.js                ← host 1: Claude Code plugin
└── desktop/                     ← host 2: Electron thin client
```

The browser host imports the exact same `client/aegis.js`; it contains no
brain logic.

---

## Implementation phases

### Phase O1 — Scaffold the static host

1. `online/package.json` — `check`/`predist`/`serve` scripts, **zero runtime
   deps** (Node's built-in `http` for the dev server).
2. `online/scripts/predist.mjs` — copy `client/aegis.js` →
   `online/vendor/aegis.js` (same byte-identity rule as `desktop/vendor/`).
3. `online/scripts/serve.mjs` — static file server for `npm run serve`.
4. `online/index.html` — CSP meta, chat shell, no external resources.

**Exit criteria:** `npm run serve` serves `index.html`; `window.AegisClient` is
defined in the page.

### Phase O2 — Functional chat via the shared client

1. Wire input → `aegis.chatCompletion` → streaming render (SSE deltas).
2. Model picker from `aegis.listModels` + "server default" entry.
3. Mode: **Aegis Cloud** vs **BYOK relay** (`byokChatCompletion`, per-request
   provider key).
4. Status: `aegis.verifyApiKey` + `aegis.tokenBankBalance`, key entry/clear.
5. Memory panel: `memorySearch` / `memorySave` / `memoryList` + "remember" on
   assistant replies.
6. Conversation sync: push transcript / pull remote sessions.

**Exit criteria:** open the page, paste a key, pick a model, chat (streaming),
toggle BYOK, save/search memory — with zero brain code in the repo.

### Phase O3 — CI + vendoring guard

Extend `.github/workflows/ci.yml`:

- `node --check` already covers `online/**` via the repo-wide find.
- **Vendor byte-identity:** `cmp client/aegis.js online/vendor/aegis.js` (and
  keep the existing `desktop/vendor/aegis.js` check).
- **SPA smoke test:** assert `window.AegisClient` is referenced by `app.js` and
  `index.html`, the vendored copy is byte-identical, and the CSP is present.
- Thin-shell guard already covers the whole tree via the banned-name scan;
  `online/` has no `desktop/lib/`-style engine dir, so nothing to widen.

---

## Hard boundary — what must NEVER enter `online/`

- `ae-guix/main.js` (85KB brain) or any derivative
- `ae-guix/lib/chat-engine/`, `lib/chat-service.js`, `lib/memory.js`
- `ae-guix/SaaS.js` (tier enforcement)
- orchestration/routing/prompt-engineering logic
- any embedded server secret

The browser host is a **transport + UI shell**. The server is the product.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| API key in `localStorage` | CSP `script-src 'self'`, no third-party code, masked render, `connect-src https:` |
| Accidentally shipping brain logic | repo-wide thin-shell guard + `cmp` byte-identity on the vendor copy |
| Vendor copy drifts from `client/aegis.js` | `predist` + CI `cmp` fails the build |
| CORS/SSE quirks in browsers | `client/aegis.js` already parses SSE + JSON fallback; the SPA is plain `fetch`, no framework |

---

## Definition of done

- [ ] `online/` serves a static SPA (`npm run serve`), zero runtime deps.
- [ ] Chat streams in Aegis Cloud and BYOK modes; model picker + memory work.
- [ ] `cmp client/aegis.js online/vendor/aegis.js` passes (vendored copy in sync).
- [ ] No brain logic under `online/` (repo-wide guard + vendor identity).
- [ ] The public repo remains secret-free (CI + pre-commit guard enforce).
