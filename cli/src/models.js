'use strict';

/**
 * AEGIS Cloud model catalog shaping — the one place `/model`, the alt+p picker
 * and `/models` agree on what a pinnable model is.
 *
 * The ids a user may pin are the *server's*, never ours: the pool adds, renames
 * and retires providers without a client release, so the catalog is fetched
 * (`client.listModels()` → GET /api/v1/models on aegiscloud.org) and this module
 * only normalises the payload. It deliberately invents no id, and has no
 * fallback list: an offline client offers nothing rather than a model name that
 * would silently route somewhere else.
 *
 * The platform lists per-provider ids (`deepseek`, `anthropic`, `groq`, …) plus
 * the pooled-brain tiers. The desktop host collapsed all of that to a single
 * "Nexus" entry because its dropdown *is* the model choice and surfacing
 * per-provider routing invites pinning a provider that happens to be dead right
 * now (see desktop/lib/local/engine.js selectBrainEntry). This host keeps every
 * distinct id — a CLI user pinning `deepseek` explicitly is a legitimate
 * request — but drops the pure-alias duplicates the server itself marks
 * `hidden: true, alias_of: "<id>"` (`aegis-brain`, `nexus-brain-smart`, …),
 * which are the same model advertised under another spelling.
 */

/** A pinned id of `null` means "no pin — let the pool choose" (the server's own default). */
const NO_PIN = null;

/**
 * Labels for catalog ids the platform advertises without capabilities or a
 * label of their own — `openai-gpt4o-mini` reads like a typo next to `openai`,
 * and the brain tier is the one id whose *cost shape* a user needs before
 * pinning it: verified live 2026-09-14, `model: "nexus-brain"` streams
 * `pool-brain: 3 workers · effort=high · tier=brain · passes=4`, i.e. four
 * billed provider calls per turn, where a provider id is one.
 */
const ID_NOTES = Object.freeze({
  'openai-gpt4o-mini': 'OpenAI gpt-4o-mini, pooled',
  'anthropic-haiku': 'Anthropic Haiku, pooled',
  'nexus-brain': 'pooled brain · 3 workers + synthesis',
});

/** One raw entry (string id or object) → a catalog entry, or null when unusable. */
function normalizeModel(entry) {
  const m = typeof entry === 'string' ? { id: entry } : entry;
  if (!m || typeof m !== 'object') return null;
  const id = typeof m.id === 'string' ? m.id.trim() : '';
  if (!id) return null;
  const aliasOf =
    typeof m.alias_of === 'string' && m.alias_of.trim() ? m.alias_of.trim() : null;
  const capabilities = Array.isArray(m.capabilities)
    ? m.capabilities.filter((c) => typeof c === 'string' && c)
    : [];
  const label =
    (typeof m.label === 'string' && m.label.trim()) ||
    (typeof m.name === 'string' && m.name.trim()) ||
    id;
  // The picker's right-hand column: what this entry *is*. An alias says so —
  // otherwise a user reads five brain tiers and assumes five different models.
  const note = aliasOf
    ? `alias of ${aliasOf}`
    : ID_NOTES[id] || capabilities.join(', ');
  return {
    id,
    label,
    note,
    hidden: m.hidden === true,
    aliasOf,
    capabilities,
  };
}

/** Normalise a raw `/api/v1/models` payload (`{models: [...]}` or the array). */
function normalizeModelCatalog(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.models) ? raw.models : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const m = normalizeModel(entry);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * The entries the picker and `/models` offer: every distinct advertised model,
 * minus the alias duplicates — unless the catalog is *only* aliases, in which
 * case the aliases are all the server advertises and are offered rather than
 * leaving the user with an empty list.
 */
function pickerEntries(catalog) {
  const all = Array.isArray(catalog) ? catalog.filter(Boolean) : [];
  const distinct = all.filter((m) => !m.aliasOf);
  return distinct.length ? distinct : all;
}

/** The catalog entry for `id`, or null — the "is this a real id?" question. */
function findModel(catalog, id) {
  const want = typeof id === 'string' ? id.trim() : '';
  if (!want) return null;
  return (Array.isArray(catalog) ? catalog : []).find((m) => m && m.id === want) || null;
}

/**
 * The set of ids the server accepts, lower-cased: a catalog id and a pinned id
 * are the same thing only when they match byte-for-byte, but `/model Nexus-Brain`
 * is a typo a user will make and the server's routing is case-insensitive
 * enough that warning about it would be noise.
 */
function catalogIds(catalog) {
  return new Set((Array.isArray(catalog) ? catalog : []).map((m) => String((m && m.id) || '').toLowerCase()).filter(Boolean));
}

module.exports = {
  NO_PIN,
  ID_NOTES,
  normalizeModel,
  normalizeModelCatalog,
  pickerEntries,
  findModel,
  catalogIds,
};
