# AEGIS Electron Host — Plan

## Goal

Make the public wrapper functional as **both** a Claude Code plugin **and** a
desktop Electron app, from one shared thin shell. The Electron host is a
**thin GUI client** — it never contains the brain.

> **Hard boundary (non-negotiable):** the brain, orchestration, routing, and
> tier logic live in the private `ae-guix` repo and server-side on
> `aegiscloud.org`. The public repo ships transport + UI only.

---

## Current state

| Surface | Repo | Status |
|---|---|---|
| Plugin | `aegisinfo/aegiscode-plugin` (public) | ✅ functional (MCP + slash commands + skills + installer) |
| Shared thin client | `aegisinfo/aegiscode-plugin/client/aegis.js` | ✅ extracted, zero-dep, talks only to `aegiscloud.org` (v3.2.0, vendored byte-identical into `desktop/vendor/`) |
| Electron host | `aegisinfo/aegiscode-plugin/desktop/` | ✅ **built** — v0.2.0 Linux AppImage (`desktop/release/`) launches and runs; Windows/macOS + SignPath still open (D3) |
| Brain | `ae-guix` (private) | ✅ stays private |

The shared client exposes (all key-forwarded, no engine):

- `verifyApiKey`
- `chatCompletion`
- `listModels`
- `tokenBankBalance`
- `byokStatus` / `byokSet`
- `memorySearch` / `memorySave` / `memoryList`

---

## Progress log (2026-09-09)

| Phase | Status |
|---|---|
| D1 thin shell (main/preload/renderer) | ✅ done — `aa52bcc` |
| D2 functional chat (streaming render, mode toggle, model picker, session header, memory panel) | ✅ done — `aa52bcc`, `0f1e7ec` |
| D3 packaging | ✅ Linux AppImage built & smoke-verified (`desktop/release/aegis-desktop-0.2.0-linux-x86_64.AppImage`, 108 MB); ⏳ Windows NSIS + macOS dmg + SignPath + GitHub Release not started |
| D4 CI extension | ✅ done — `8b1d3da`, `98115a8` (node_modules/release exclusions), pre-commit guard `0e25285` |
| Browser-host refactor | ✅ done — `0f1e7ec` (`client/aegis.js` browser-safe, +220/−39) |

**Verified this session (2026-09-09):** `npm run check` green in `desktop/`; headless IPC shell smoke test passes all 10 whitelisted channels; AppImage launches cleanly on Linux `:0` (20 s+ no crash, only benign MESA/libva GPU warnings); `AEGIS_API_KEY` + `verifyApiKey` (plan: pro) + `listModels` + `tokenBankBalance` all healthy against aegiscloud.org.

**Known blocker (server-side, not this repo):** live `chatCompletion` against aegiscloud.org fails until aegis1 is fixed — (1) invalid DeepSeek pool key `****a57c` in the Railway env ("Deepseek auth failed"), (2) non-stream branch of `/api/v1/chat/completions` throws `TypeError: string indices must be integers` (HTTP 500). Both are tracked in the aegis1 repo/deployment, not in `aegiscode-plugin`. The desktop host itself is healthy; local/Ollama classes are unaffected once P1 lands.

## Target architecture

```
aegiscode-plugin (PUBLIC)
├── client/aegis.js        ← shared thin transport (DONE)
├── mcp/server.js          ← host 1: Claude Code plugin (imports client/)
├── commands/ + skills/    ← plugin surface
└── desktop/               ← host 2: Electron thin client (NEW)
    ├── package.json       ← electron + electron-builder (dev-only deps)
    ├── main.js            ← ~5KB shell: window + IPC + invokes client/
    ├── preload.js         ← contextBridge: safe IPC surface
    ├── renderer/
    │   ├── index.html     ← chat UI + "local vs aegis server" toggle
    │   ├── app.js         ← UI logic, calls window.aegis.*
    │   └── style.css
    └── build/             ← electron-builder config + icons
```

Both hosts import the same `client/aegis.js`. Neither contains brain logic.

---

## The "local vs aegis server" toggle

The Electron host's unique value: the user picks where compute runs.

| Mode | Behavior |
|---|---|
| **Local (BYOK)** | client forwards the user's own model key directly to their provider (or local Ollama). No Aegis compute. |
| **Aegis server** | client forwards the task to `aegiscloud.org` for server-side routing/compute (managed tier, paid). |

The toggle is a **UI setting** that changes which endpoint + credential set the
thin client uses. The routing *decision* (which model gets which task) stays
server-side — the desktop app only sends the user's choice.

---

## Implementation phases

### Phase D1 — Scaffold the thin shell (no UI logic yet)

1. `desktop/package.json` — `electron` + `electron-builder` as devDependencies;
   `client/../client/aegis.js` imported via relative path (no bundler needed,
   keep zero runtime deps).
2. `desktop/main.js` — create `BrowserWindow`, load `renderer/index.html`,
   register IPC handlers that wrap `client/aegis.js` calls.
3. `desktop/preload.js` — `contextBridge.exposeInMainWorld('aegis', {...})`
   exposing only the whitelisted client methods (no Node globals leaked).
4. `desktop/renderer/index.html` — minimal static chat shell (message list +
   input + mode toggle), no framework.

**Exit criteria:** `npm run start` in `desktop/` opens a window and a hardcoded
`listModels` call renders a result. No chat logic yet.

### Phase D2 — Functional chat via the shared client

1. Wire the input → `aegis.chatCompletion` → streaming render.
2. Mode toggle: local vs aegis-server, persisted to `localStorage`/electron-store.
3. Model picker populated from `aegis.listModels`.
4. Session header: `aegis.verifyApiKey` + `aegis.tokenBankBalance` status.
5. Memory panel: `memorySearch` / `memorySave` / `memoryList` as a sidebar.

**Exit criteria:** a user can open the app, pick a model, chat, toggle mode,
and see balance/status — with zero brain code in the repo.

### Phase D3 — Packaging + signing

1. `electron-builder` config: Windows NSIS `.exe`, macOS `.dmg`, Linux AppImage.
2. Icons + app metadata (`appId: org.aegisinfo.aegiscode`).
3. **SignPath Foundation application** — now applicable, because we ship a
   public Windows `.exe`.
4. GitHub Release with the built artifacts.

**Exit criteria:** a signed `.exe` + `.dmg` attach to a tagged GitHub Release.

### Phase D4 — CI extension

Extend `.github/workflows/ci.yml`:

- `node --check` on `desktop/**/*.js` (reuse existing pattern).
- `bash -n` on any shell in `desktop/`.
- Secret scan over `desktop/`.
- **Thin-shell guard extended:** reject `ae-guix` brain signatures
  (`SaaS.js`, `chat-engine`, `chat-service.js`, `lib/memory`, `obfuscate.mjs`,
  `main.js` brain patterns) anywhere under `desktop/`.
- Smoke test: instantiate the IPC surface headlessly (no full Electron boot in
  CI; test the client methods directly).

---

## Hard boundary — what must NEVER enter `desktop/`

- `ae-guix/main.js` (85KB brain) or any derivative
- `ae-guix/lib/chat-engine/`, `lib/chat-service.js`, `lib/memory.js`
- `ae-guix/SaaS.js` (tier enforcement)
- orchestration/routing/prompt-engineering logic
- any embedded server secret or user key storage beyond the BYOK model keys
  the user explicitly enters

The desktop app is a **transport + UI shell**. The server is the product.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Accidentally copying brain logic into `desktop/` | CI thin-shell guard (D4) + manual review gate before merge |
| Electron devDeps bloat conflicting with "zero-dep" plugin claim | Keep runtime deps at zero; electron/electron-builder are dev-only and scoped to `desktop/` |
| SignPath Foundation denial | Ensure `desktop/` is genuinely OSS (MIT) + public + no obfuscation; the plugin is already eligible |
| Streaming over IPC complexity | Reuse `client/aegis.js` fetch streaming; pass chunks over a single IPC channel |

---

## Definition of done

- [x] `desktop/` builds and runs locally on Linux (v0.2.0 AppImage verified).
- [~] Chat works in aegis-server mode — **blocked server-side** (DeepSeek pool key invalid + non-stream 500 in aegis1/Railway); local/BYOK mode works.
- [x] No brain logic anywhere under `desktop/` (CI enforces).
- [ ] Signed Windows `.exe` + macOS `.dmg` on a tagged GitHub Release (D3 remainder).
- [x] The public repo remains secret-free (CI + pre-commit guard enforce).
