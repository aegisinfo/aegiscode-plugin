# Keys, BYOK, and the Cloud API

AEGIS Desktop talks to models over **three independent lanes**. They are not
variations of one setting — they differ in who holds the key, who pays, and
whether AEGIS ever sees a credential. Pick the lane that matches where your key
lives, and read only that section.

| Lane | Key belongs to | Who pays | Leaves your machine? | AEGIS account? |
|---|---|---|---|---|
| **1. AEGIS Cloud** | aegiscloud.org | your token bank | key goes to AEGIS, never to the renderer | yes |
| **2. Local provider config** | you | you (direct to provider) | no — main process only | no |
| **3. BYOK relay** | you | you (direct to provider) | key is forwarded per request, never stored | yes (for transport) |

Everything below is verified against `client/aegis.js`, `desktop/main.js`,
`desktop/preload.js`, and `desktop/lib/settings.js`. Where a feature exists in
the API but has no button yet, it is called out explicitly.

---

## Lane 1 — AEGIS Cloud key

Use this when you want pooled multi-provider inference, cross-machine memory,
and server-side autonomous fan-out without managing provider accounts. One key
covers every model class AEGIS pools.

### Get a key

1. Open **https://aegiscloud.org/login#register** and create a free account.
2. The dashboard issues an AEGIS API key. Copy it — it is shown in full once.
3. Optionally top up the token bank on the same page; pooled inference and
   autonomous runs spend from that balance.

### Put it in the app

1. Launch AEGIS Desktop: `npm install -g aegis-desktop` then `aegis`.
2. In the left sidebar, find the **Status** card. It shows `client`,
   `endpoint`, `key`, `plan`, and `balance`.
3. Paste the key into the **AEGIS API key** field (it is a password input, so
   it stays masked on screen).
4. Click **Save**. The key is written by the **main process** via
   `desktop/lib/settings.js` under the reserved `__aegis` namespace — it is
   never handed to the renderer, and the renderer only ever receives masked
   previews for display.
5. Click **Verify**. The Status card's `key`, `plan`, and `balance` rows fill
   in once the key authenticates. `plan` tells you the tier (`free`,
   `cloud`, `pro`), `balance` shows remaining tokens.

If Verify fails, the hint line under the buttons reports the reason. The two
common ones: a key pasted with surrounding whitespace, and a key from a
different environment (staging vs. production).

### Point the app somewhere else

The client resolves its base URL in this order:

1. `AEGIS_API_BASE` environment variable
2. `DEFAULT_API_BASE`, which is `https://aegiscloud.org`

Set `AEGIS_API_BASE` before launching to target a self-hosted or staging
deployment:

```bash
export AEGIS_API_KEY="your-key"
export AEGIS_API_BASE="https://your-deployment.example.com"
aegis
```

### Headless and scripted use

`client/aegis.js` reads credentials from the environment, so any process that
imports it picks the same settings up without the UI:

```bash
export AEGIS_API_KEY="your-key"          # required
export AEGIS_API_BASE="https://aegiscloud.org"   # optional, this is the default
```

```js
const { createClient } = require('./client/aegis.js');
const aegis = createClient();            // reads AEGIS_API_KEY from env
const out = await aegis.chatCompletion({ prompt: 'hello', model: 'gpt-4o-mini' });
```

Note the deliberate fallback behaviour: an empty or unset `AEGIS_API_BASE`
falls back to the default rather than producing a broken relative URL, so
setting it to `""` will *not* point the client at localhost.

### What the key unlocks

- **Aegis Cloud** as a provider class in the model picker.
- **`work autonomously`** — the checkbox that escalates a turn to server-side
  multi-worker fan-out (with `Effort` and `Workers` controls). This is Aegis
  Cloud only; it is hidden for the other three classes.
- **Cross-machine memory** — sessions sync to AEGIS memory, and the
  *remember* button on any reply pins an entry for recall from other machines.

---

## Lane 2 — Your own provider key, held locally

Use this when you have an OpenAI, Anthropic, or OpenAI-compatible endpoint and
want the desktop app to talk to it **directly**, with no AEGIS round-trip at
all. No AEGIS account is required for this lane, and the key never leaves your
machine.

### Configure it

1. In the sidebar, open the **Provider settings** card.
2. In the **Model** card above it, choose the provider class:
   - **Custom OpenAI-compatible** — LM Studio, OpenRouter, vLLM, Together,
     Groq, DeepSeek, or anything exposing `/v1/chat/completions`.
   - **Anthropic-compatible** — Claude, or any Messages-format gateway.
   - **Ollama** — your local daemon. No key field at all; fully offline.
3. Enter the **base URL** and the **provider key** for that class.
4. Pick a model. The preset dropdown quick-fills a known model id and base URL
   together, which avoids the most common misconfiguration (a model id that
   belongs to a different provider than the base URL).
5. Send a message to confirm.

Provider configs are persisted by `desktop/lib/settings.js` in the main
process, in a namespace separate from the AEGIS key. They are not uploaded
anywhere, not synced to memory, and not exposed over IPC to the renderer — the
UI only ever holds masked previews. Switching classes mid-conversation keeps
the context intact, and each class remembers its own base URL, key, and model.

### Ollama

Pick the Ollama class and the app talks to your local `ollama` daemon on its
default port. No key, no account, no network egress. If the model list is
empty, your daemon is not running or has no models pulled — `ollama serve` and
`ollama pull <model>` fix both.

---

## Lane 3 — The BYOK relay

Use this when you want a provider key to be used **per request** through AEGIS,
without the key ever being stored server-side. This is different from Lane 2:
here the request is proxied by AEGIS, and the credential rides along in an
`X-Provider-Key` header that is forwarded to the provider and discarded.

### Two distinct mechanisms — don't conflate them

The server exposes **two** BYOK surfaces, and they behave differently:

**A. The stateless relay** — `POST /api/v1/byok/chat/completions`

The caller supplies the provider key in the `X-Provider-Key` request header.
The key is **never stored and never logged**, rate-limited at 20 requests per
minute, and forwarded straight to the provider for that single request. Tools
and `tool_choice` are forwarded, and streaming works the same way as the
standard chat path. From the client:

```js
const aegis = createClient({ apiKey: process.env.AEGIS_API_KEY });

const out = await aegis.byokChatCompletion({
  provider: 'openai',              // default is 'openai'
  model: 'gpt-4o-mini',
  prompt: 'hello',
  providerKey: process.env.OPENAI_API_KEY,   // per-request, not persisted
});
```

You can pass `providerKey` per call, or set `providerKey` once on the client
options. Either way it is a request credential, not stored state.

**B. The stored key** — `GET`/`POST /api/user/api-keys`

This persists your provider key for the account so later server-side calls can
resolve it automatically. It is a genuinely different trade: the key is
**encrypted at rest with AES-256** (derived from the server `SECRET_KEY`) in
the `user_provider_keys` table, and it is used for server-side calls on your
behalf.

- `GET /api/user/api-keys` returns one masked preview per configured provider —
  the full key is never returned in any response, by design.
- `POST /api/user/api-keys` takes `{ provider, api_key }` and upserts it.
- `POST /api/user/api-keys/test` validates a key against the provider.
- Sending an empty `api_key` deletes the stored entry for that provider.

Resolution order at request time is **your own key, then the AEGIS pool key**.
So setting your own key for a provider moves that provider's spend onto your
account.

Format validation runs on save, so a wrong-shaped key is rejected immediately:
`anthropic` must start `sk-ant-`, `groq` must start `gsk_`, `openai` and
`deepseek` must start `sk-`, `gemini` starts `AIza`, and providers with no fixed
prefix are accepted as-is. The accepted provider set is derived from the AEGIS
provider catalog, so DeepSeek, Gemini, Groq, OpenRouter, Mistral, Cerebras,
Fireworks, NVIDIA NIM, xAI/Grok, Together, and Sakana are all valid.

### Driving it from the desktop app

The main process already exposes both stored-key calls over whitelisted IPC:

```js
// renderer → preload → main
await window.aegis.byokStatus();            // → GET  /api/user/api-keys
await window.aegis.byokSet('openai', key);  // → POST /api/user/api-keys
```

**There is no BYOK panel in the desktop UI yet.** `desktop/renderer/app.js`
does not call `byokStatus` or `byokSet` — the handlers exist in `main.js` and
are bridged in `preload.js`, but nothing renders them. Until that lands, use
Lane 2 (Provider settings) for your own key inside the desktop app, and reach
the relay APIs from a script or from the Claude Code plugin, where they are
exposed as the `aegis_byok_set` and `aegis_byok_status` tools.

---

## Which lane should I use?

- **Just want it to work, and want memory + autonomy.** Lane 1. Get a cloud
  key, paste it into Status, click Verify.
- **I already pay OpenAI/Anthropic and want zero AEGIS involvement.** Lane 2.
  Provider settings, key stays in the main process.
- **Running locally with no keys at all.** Ollama in Lane 2.
- **I need my own provider key to work through AEGIS's transport** — for
  server-side calls, or to fan out with my own credential. Lane 3. Use the
  per-request relay if the key must never be stored; use the stored key if you
  want it resolved automatically on later requests.

---

## Key hygiene

- **Rotate a stored key** by saving the new one over it — `POST
  /api/user/api-keys` upserts, so there is no separate rotate step.
- **Revoke a stored key** by posting an empty `api_key` for that provider, or
  by revoking it at the provider itself. A revoked key fails closed: the
  server falls back to the AEGIS pool key rather than erroring the request.
- **A stored key is recoverable only by you re-entering it.** The API returns
  masked previews; there is no "show key" endpoint, deliberately.
- **The relay key is never persisted.** If it leaks, it can only have come from
  the calling process's environment or memory, not from AEGIS storage.
- **The AEGIS key** lives in the main process under the `__aegis` settings
  namespace. Treat it like any bearer token: keep it out of shell history and
  out of committed `.env` files.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Verify fails, key looks right | Leading/trailing whitespace on paste, or a key issued by a different deployment than `AEGIS_API_BASE` |
| `plan` shows `free` but you expect pooled models | The account tier, not the key format — check the dashboard |
| A provider call silently falls back to pooled inference | The stored key was rejected or revoked; a bad key fails closed onto the AEGIS pool |
| Model list empty on the Ollama class | Daemon not running, or no models pulled |
| `byokSet` works from a script but there is no UI for it | Expected — the BYOK panel is not wired into `renderer/app.js` yet |
| 429 on the relay | The BYOK relay is limited to 20 requests per minute |

See also: [`README.md`](../README.md) for installation across all three
surfaces, and [`product-plan.md`](product-plan.md) for where these lanes are
headed.
