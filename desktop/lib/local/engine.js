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

const CLASSES = [
  { class: 'aegis', label: 'Aegis Cloud', kind: 'cloud' },
  { class: 'byok', label: 'BYOK relay', kind: 'cloud' },
  { class: 'ollama', label: 'Ollama (local)', kind: 'local' },
  { class: 'openai-compat', label: 'Custom OpenAI-compatible', kind: 'custom' },
  { class: 'anthropic', label: 'Anthropic-compatible', kind: 'custom' },
];

function createLocalEngine({ aegis, settings, ollama, providers }) {
  const controllers = new Map(); // sessionId -> AbortController

  async function listClasses() {
    const status = await ollama.probe().catch(() => ({ running: false }));
    return CLASSES.map((c) => {
      if (c.class === 'ollama') return { ...c, configured: Boolean(status.running) };
      if (c.class === 'aegis' || c.class === 'byok') {
        return { ...c, configured: Boolean(aegis.apiKey) };
      }
      return { ...c, configured: true }; // custom endpoints are always available
    });
  }

  async function listModels(cls) {
    if (cls === 'aegis') {
      const data = await aegis.listModels();
      return { class: cls, models: (data && data.models) || [] };
    }
    if (cls === 'ollama') {
      const tags = await ollama.listTags();
      return { class: cls, models: tags.map((t) => ({ id: t.id })) };
    }
    if (cls === 'byok') {
      const status = await aegis.byokStatus().catch(() => ({}));
      const keys = (status && status.keys) || {};
      return {
        class: cls,
        models: Object.keys(keys).map((p) => ({ id: p, provider: p })),
      };
    }
    // Custom endpoints: models are user-typed; surface the configured base URL.
    const cfg = settings.get(cls);
    return {
      class: cls,
      models: cfg.baseURL ? [{ id: cfg.baseURL, baseURL: cfg.baseURL }] : [],
    };
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

      const cfg = settings.get(cls);
      const apiKey = settings.rawKey(cls);
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
