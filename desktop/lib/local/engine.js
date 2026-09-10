'use strict';

/**
 * engine.js — the desktop LocalEngine registry (plan P1 §5.2). Transport-only:
 * it owns the provider settings/credentials and routes a chat payload to the
 * cloud client, the local Ollama module, or a custom OpenAI/Anthropic-
 * compatible endpoint. No tier/brain/routing decisions are made here — the
 * chosen class is the user's explicit selection.
 *
 * Pure Node + dependency-injected (aegis client, settings store, ollama,
 * providers) so it unit-tests without Electron.
 */

const { randomUUID } = require('node:crypto');

/** Classes whose transport is a user-supplied endpoint + credential. */
const CUSTOM_CLASSES = Object.freeze(['openai-compat', 'anthropic']);

const CLASSES = [
  { class: 'aegis', label: 'Aegis Cloud', kind: 'cloud' },
  { class: 'byok', label: 'BYOK relay', kind: 'cloud' },
  { class: 'ollama', label: 'Ollama (local)', kind: 'local' },
  { class: 'openai-compat', label: 'Custom OpenAI-compatible', kind: 'custom' },
  { class: 'anthropic', label: 'Anthropic-compatible', kind: 'custom' },
];

/** Relay model entries arrive as ids or objects; keep only real model ids. */
function normalizeCatalog(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && m.id);
}

/**
 * The Aegis Cloud catalog (`/api/v1/models`) also lists internal routing
 * aliases — per-provider variants like `openai-gpt4o-mini`/`anthropic-haiku`,
 * and six pooled-brain tier ids (`{aegis,nexus}-brain[-smart|-neo]`) that all
 * run the same worker pool on the same backend model. None of those are a
 * human's model choice; picking between them put six near-duplicate "brain"
 * entries in the desktop dropdown. Surface only the four platform models the
 * user actually selects between, plus one collapsed "Nexus" entry standing
 * in for whichever brain tier the pool advertises.
 */
const AEGIS_PLATFORM_MODELS = Object.freeze(['openai', 'anthropic', 'groq', 'gemini']);
const NEXUS_BRAIN_ID = 'aegis-brain';
const NEXUS_LABEL = 'Nexus (Aegis brain)';

function filterAegisCatalog(models) {
  const platform = models.filter((m) => AEGIS_PLATFORM_MODELS.includes(m.id));
  const nexus = models.find((m) => m.id === NEXUS_BRAIN_ID);
  return nexus ? [...platform, { ...nexus, label: NEXUS_LABEL }] : platform;
}

/** True when a BYOK-status entry says "a key is stored for this provider". */
function keyedEntry(info) {
  if (info == null) return false;
  if (typeof info === 'boolean') return info;
  if (typeof info === 'string') return Boolean(info);
  if (info.set !== undefined) return Boolean(info.set);
  if (info.configured !== undefined) return Boolean(info.configured);
  return true; // an object entry without an explicit flag means "set"
}

/**
 * Provider names that have a stored BYOK key. The relay has shipped both
 * `{ keys: { openai: { set: true } } }` and the bare map, so accept either.
 */
function keyedProviders(status) {
  const raw = (status && (status.keys || status.providers || status)) || {};
  if (Array.isArray(raw)) {
    return raw
      .map((p) => (typeof p === 'string' ? p : p && p.provider))
      .filter(Boolean);
  }
  if (typeof raw !== 'object') return [];
  return Object.keys(raw).filter((p) => keyedEntry(raw[p]));
}

function createLocalEngine({ aegis, settings, ollama, providers }) {
  const controllers = new Map(); // sessionId -> AbortController

  /**
   * Custom endpoints are only usable when they are actually configured:
   * a base URL is mandatory for both, and Anthropic additionally needs its own
   * key (the wire format authenticates with x-api-key). Reporting them as
   * always-ready made chat() POST to `${undefined}/v1/…` (defect #2).
   */
  function customStatus(cls) {
    const cfg = settings.get(cls) || {};
    const baseURL = typeof cfg.baseURL === 'string' ? cfg.baseURL.trim() : '';
    const hasBase = Boolean(baseURL);
    const hasKey = Boolean(cfg.configured);
    return {
      configured: cls === 'anthropic' ? hasBase && hasKey : hasBase,
      baseURL,
      keyMask: cfg.keyMask || null,
    };
  }

  async function listClasses() {
    const status = await ollama.probe().catch(() => ({ running: false }));
    return CLASSES.map((c) => {
      if (c.class === 'ollama') return { ...c, configured: Boolean(status.running) };
      if (c.class === 'aegis' || c.class === 'byok') {
        return { ...c, configured: Boolean(aegis.apiKey) };
      }
      return { ...c, ...customStatus(c.class) };
    });
  }

  async function listModels(cls) {
    if (cls === 'aegis') {
      const data = await aegis.listModels();
      return { class: cls, models: filterAegisCatalog(normalizeCatalog(data && data.models)) };
    }
    if (cls === 'ollama') {
      const tags = await ollama.listTags();
      return { class: cls, models: tags.map((t) => ({ id: t.id })) };
    }
    if (cls === 'byok') {
      // The relay's /api/user/api-keys payload lists *keyed providers*, not
      // models — surfacing those as model ids put provider names in the BYOK
      // model picker (defect #4). Models now come from the relay's model list
      // (the same ids byokChatCompletion's `model` accepts); the keyed provider
      // names are reported separately, as `providers`, for labelling only.
      let status = null;
      try {
        status = await aegis.byokStatus();
      } catch {
        status = null; // relay unreachable — fall back to the plain catalog
      }
      const providers = status ? keyedProviders(status) : null;
      const catalog = await aegis.listModels().catch(() => null);
      const models = normalizeCatalog(catalog && catalog.models).filter((m) => {
        if (providers === null) return true; // key state unknown
        if (!providers.length) return false; // no BYOK key → nothing usable
        if (!m.provider) return true; // relay did not tag a provider
        return providers.includes(m.provider);
      });
      return { class: cls, models, providers: providers || [] };
    }
    // Custom endpoints: the model id is the *user's* choice — a provider model
    // name, never a URL. Offering the configured base URL as an `id` meant that
    // leaving the default selection POSTed `model: "https://api.openai.com/v1"`,
    // an upstream 400 invalid-model on every call (defect B). There is nothing
    // to enumerate, so the list stays empty and `needsModelId` tells the
    // renderer to prompt for a typed id instead. The base URL still travels
    // along for display only.
    const cfg = settings.get(cls) || {};
    const baseURL = typeof cfg.baseURL === 'string' ? cfg.baseURL.trim() : '';
    return { class: cls, models: [], needsModelId: true, baseURL };
  }

  async function chat(payload, onDelta) {
    const cls = payload && payload.class;
    const model = payload && payload.model;
    const maxTokens = payload && payload.maxTokens;
    const sessionId = (payload && payload.sessionId) || randomUUID();

    const controller = new AbortController();
    controllers.set(sessionId, controller);
    const signal = controller.signal;

    try {
      if (cls === 'aegis' || cls === 'byok') {
        if (cls === 'byok') {
          return await aegis.byokChatCompletion({
            prompt: payload.prompt,
            system: payload.system,
            messages: payload.messages,
            model,
            maxTokens,
            stream: true,
            onStream: onDelta,
            signal,
          });
        }
        return await aegis.chatCompletion({
          prompt: payload.prompt,
          system: payload.system,
          messages: payload.messages,
          model,
          mode: payload.mode,
          maxTokens,
          stream: true,
          onStream: onDelta,
          signal,
          // aegis_memory: automatic, no button — the server both reads prior
          // synced memory into context AND writes this turn back to it, the
          // same flag aegis-online sets. Matches aegiscodex-dev's own
          // cross-session memory (auto-indexed, no manual tagging); pooled
          // AEGIS-class chat only — BYOK's relay is stateless by contract.
          extra: { aegis_memory: true, session: sessionId },
        });
      }

      if (cls === 'ollama') {
        return await ollama.chat({
          model,
          prompt: payload.prompt,
          system: payload.system,
          messages: payload.messages,
          maxTokens,
          signal,
          onDelta,
        });
      }

      const cfg = settings.get(cls) || {};
      const apiKey = settings.rawKey(cls);
      // Custom classes carry no enumerable model list (see listModels), so a
      // blank id here means the user never typed one. Fail loudly in-process
      // instead of shipping `model: undefined` upstream (defect B).
      if (typeof model !== 'string' || !model.trim()) {
        const err = new Error(
          `${cls}: a model id is required — type the provider's model name ` +
            '(the base URL is not a model).'
        );
        err.status = 400;
        throw err;
      }
      const common = {
        baseURL: cfg.baseURL,
        apiKey,
        model,
        prompt: payload.prompt,
        system: payload.system,
        messages: payload.messages,
        maxTokens,
        signal,
        onDelta,
      };

      if (cls === 'anthropic') {
        return await providers.anthropicMessages(common);
      }
      return await providers.openaiCompatible(common);
    } finally {
      controllers.delete(sessionId);
    }
  }

  function cancel(sessionId) {
    const controller = controllers.get(sessionId);
    if (controller) controller.abort();
    return { ok: Boolean(controller) };
  }

  return {
    CLASSES,
    listClasses,
    listModels,
    chat,
    cancel,
    settings,
  };
}

module.exports = { CLASSES, createLocalEngine };
