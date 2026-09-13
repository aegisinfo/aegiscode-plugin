'use strict';

/**
 * AEGIS tool registry — the one definition of what the AEGIS surface can do.
 *
 * Both hosts build from this file: `mcp/server.js` (the MCP host) and `cli/`
 * (the terminal host). A capability can therefore never exist in one host and
 * be silently missing from the other, and the JSON schemas the model sees are
 * literally the same objects the CLI's /commands dispatch against.
 *
 * This module is pure: names, schemas, and the text each tool returns. It holds
 * no JSON-RPC, no ANSI, and no terminal state. The transport is injected rather
 * than created here, so each host passes its own configured client — and a test
 * can pass a stub.
 *
 * The tool bodies are indented one level deeper than they were when they lived
 * in mcp/server.js; the shift is whitespace only (no template literal in the
 * block spans a line).
 */

const foreignMemory = require('../client/foreign-memory.js');

/**
 * Build the registry against a client instance.
 *
 * @param {object} client A client from client/aegis.js (or a stub with the same
 *   method surface). Required — a host owns its own key handling, so this
 *   module never reads the environment itself.
 * @returns {{TOOLS: object, toolList: () => Array<{name: string, description: string, inputSchema: object}>}}
 */
function createTools(client) {
  if (!client || typeof client !== 'object') {
    throw new TypeError('createTools(client): a client instance is required');
  }

  // The moved bodies call through this name, so the registry cannot reach any
  // other module state.
  const aegis = client;

  const TOOLS = {
    aegis_status: {
      description:
        "Check the current AEGIS account: validates the API key and reports the plan, email, and whether cloud memory is enabled. Call this first to confirm setup.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const info = await aegis.verifyApiKey();
        const lines = [
          `Key valid: ${info.valid ? 'yes' : 'no'}`,
          `Plan:      ${info.plan || 'unknown'}`,
          info.email ? `Account:   ${info.email}` : null,
          `Memory:    ${info.memory_token ? 'enabled (cloud sync available)' : 'not enabled'}`,
          `API base:  ${aegis.apiBase}`,
        ].filter(Boolean);
        return lines.join('\n');
      },
    },

    aegis_ask: {
      description:
        "Send a prompt to AEGIS pooled inference, billed against the account's token bank. List models with aegis_list_models and pass any id as `model`; omit `model` to let the server pick its default. `mode` is a legacy server-side shorthand and is never required.",
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The user prompt / question.' },
          model: {
            type: 'string',
            description:
              'Pin any model id from aegis_list_models — or omit for the server default.',
          },
          mode: {
            type: 'string',
            description:
              "Legacy server-side shorthand (e.g. 'fast', 'smart', 'neo'). Optional — never defaulted client-side.",
          },
          system: { type: 'string', description: 'Optional system instruction.' },
          max_tokens: {
            type: 'integer',
            description:
              'Max output tokens. The server enforces the true ceiling; omit for the server default.',
            minimum: 1,
            maximum: 64000,
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      async run(args) {
        // Use the OpenAI-compatible endpoint (stream:false): it returns structured
        // JSON errors (e.g. 402 insufficient_quota) instead of the opaque 502 that
        // /api/v1/complete emits. An exact `model` id pins that provider directly;
        // omitting `model` lets the server route to its default.
        const data = await aegis.chatCompletion({
          prompt: args.prompt,
          system: args.system,
          model: args.model,
          mode: args.mode,
          maxTokens: args.max_tokens,
        });
        const choice = (data.choices && data.choices[0]) || {};
        const text = (choice.message && choice.message.content) || '(empty response)';
        const meta = [
          data.model ? `model: ${data.model}` : null,
          data.usage ? `tokens: ${data.usage.total_tokens}` : null,
        ]
          .filter(Boolean)
          .join('  ·  ');
        return `${text}\n\n— ${meta}`;
      },
    },

    aegis_list_models: {
      description:
        "List the exact models available to pin with aegis_ask's `model` argument — the server's model list is the truth, and omitting `model` uses the server default.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const data = await aegis.listModels();
        const models = data.models || [];
        if (!models.length) return 'No pinnable models are currently configured on AEGIS.';
        return [
          'Pass one of these as aegis_ask\'s `model` argument:',
          '',
          ...models.map((m) => `  ${m.id}  (${(m.capabilities || []).join(', ')})`),
        ].join('\n');
      },
    },

    aegis_balance: {
      description:
        "Check the AEGIS token bank balance and recent spend. Call this before aegis_ask if you're unsure whether the account has funds, or to see what recent calls cost.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const data = await aegis.tokenBankBalance();
        const lines = [`Balance: €${Number(data.balance_eur || 0).toFixed(2)}`];
        const ledger = (data.ledger || []).slice(0, 5);
        if (ledger.length) {
          lines.push('', 'Recent activity:');
          for (const l of ledger) {
            // The balance endpoint returns `amount_eur`, signed from the user's
            // side: negative = spent on a call, positive = top-up/rebate. This
            // used to read `charged_micros`, which the endpoint does not return
            // at all — every row rendered as "-€0.0000" no matter how many
            // tokens the call consumed. Only fall back to the raw micros column
            // (opposite sign) if a future server drops amount_eur.
            const eur = l.amount_eur != null
              ? Number(l.amount_eur)
              : -Number(l.charged_micros || 0) / 1_000_000;
            // Sub-cent calls are the norm here, so keep 4dp below a cent and
            // fall back to 2dp for cash-sized rows.
            const abs = Math.abs(eur);
            const amount = `${eur < 0 ? '-' : '+'}€${abs < 0.01 ? abs.toFixed(4) : abs.toFixed(2)}`;
            const kind = l.kind === 'topup' ? 'top-up' : (l.kind || '');
            const model = l.model_key || kind || '';
            const tokens = (l.tokens_in || l.tokens_out)
              ? `  ${l.tokens_in || 0}/${l.tokens_out || 0} tok`
              : '';
            lines.push(`  ${l.created_at || ''}  ${model}${tokens}  ${amount}`);
          }
        } else {
          lines.push('No spend yet.');
        }
        if ((data.balance_eur || 0) <= 0) {
          lines.push(
            '',
            'Balance is empty — top up at https://aegiscloud.org/subscribe, or set your own ' +
              'provider key with aegis_byok_set to use aegis_ask for free at cost.'
          );
        }
        return lines.join('\n');
      },
    },

    aegis_byok_status: {
      description:
        "List which providers have a Bring-Your-Own-Key configured on this AEGIS account (known ids: openai, anthropic, groq, openrouter, together, deepseek, gemini, …). A configured BYOK key is used automatically by aegis_ask instead of the pooled balance for that provider, so calls no longer cost AEGIS token-bank funds.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const data = await aegis.byokStatus();
        const rows = Object.entries(data || {}).map(([provider, info]) => {
          const set = info && info.set;
          return `  ${provider}: ${set ? `set (${info.masked})` : 'not set'}`;
        });
        return `BYOK keys:\n${rows.join('\n')}`;
      },
    },

    aegis_byok_set: {
      description:
        "Set or remove a Bring-Your-Own-Key API key for a provider on this AEGIS account (known ids: openai, anthropic, groq, openrouter, together, deepseek, gemini, …; the server validates what it supports). Once set, aegis_ask uses that key directly for that provider instead of the pooled AEGIS balance — unlimited use at the user's own cost. Omit api_key to remove a previously set key.",
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description:
              "Which provider this key is for (known ids: openai, anthropic, groq, openrouter, together, deepseek, gemini, …).",
          },
          api_key: { type: 'string', description: "The provider's own API key. Omit to delete the stored key instead." },
        },
        required: ['provider'],
        additionalProperties: false,
      },
      async run(args) {
        const data = await aegis.byokSet(args.provider, args.api_key);
        return data.message || (args.api_key ? `${args.provider} key saved.` : `${args.provider} key removed.`);
      },
    },

    aegis_memory_search: {
      description:
        "Search the user's AEGIS cloud memory (persists across machines and sessions). Returns the most relevant stored entries for a query.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text. Empty returns most recent.' },
          limit: { type: 'integer', description: 'Max entries (1-50). Default 5.', minimum: 1, maximum: 50 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args) {
        const data = await aegis.memorySearch(args.query, args.limit || 5);
        const entries = data.entries || [];
        if (!entries.length) return `No memory entries matched "${args.query}".`;
        return entries
          .map((e, i) => {
            const when = e.timestamp || e.createdAt || '';
            const tags = (e.tags && e.tags.length) ? ` [${e.tags.join(', ')}]` : '';
            return `${i + 1}. ${e.content}${tags}${when ? `\n   (${when})` : ''}`;
          })
          .join('\n');
      },
    },

    aegis_memory_save: {
      description:
        "Save a note to the user's AEGIS cloud memory so it persists across machines and future sessions. Use for durable facts, decisions, or preferences the user asks you to remember.",
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact/note to store.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
          importance: { type: 'integer', description: 'Optional 1-10 salience. Default 5.', minimum: 1, maximum: 10 },
          session: { type: 'string', description: 'Optional session/label to group under.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      async run(args) {
        const entry = {
          id: aegis.randomUUID(),
          content: args.content,
          role: 'assistant',
          source: 'claude-code',
          session: args.session || 'claude-code',
          tags: args.tags || [],
          importance: typeof args.importance === 'number' ? args.importance : 5,
          timestamp: new Date().toISOString(),
        };
        const data = await aegis.memorySave(entry);
        return `Saved ${data.saved || 1} memory entry (id ${entry.id}).`;
      },
    },

    aegis_memory_import: {
      description:
        "Import memory and past conversation context from OTHER AI coding tools installed on this machine (Claude Code, Codex, Cursor, Gemini CLI, Continue, Goose, opencode, Windsurf, Zed, and a local AEGIS engine) into the user's AEGIS cloud memory. Scans read-only; nothing in the other tools' directories is modified. Defaults to a DRY RUN that only reports what it found — pass confirm:true to actually save. Entries are content-addressed, so re-running never duplicates.",
      inputSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description: 'false (default) = report only. true = actually write the entries to AEGIS memory.',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional subset of source ids to import (e.g. ["claude-code"]). Omit for every source found on this machine.',
          },
          limit: { type: 'integer', description: 'Max entries to import (1-5000). Default 1000.', minimum: 1, maximum: 5000 },
        },
        additionalProperties: false,
      },
      async run(args) {
        const limit = args.limit || 1000;
        const report = foreignMemory.scan({ sources: args.sources, limit });
        const summary = foreignMemory.describe(report);

        if (!report.entries.length) {
          return `${summary}\n\nNothing to import.`;
        }

        if (!args.confirm) {
          return [
            summary,
            '',
            `Dry run — ${report.totals.entries} entries would be saved to AEGIS memory under ${report.totals.sourcesWithEntries} session(s) (${report.totals.skipped} skipped as too short/noise).`,
            'Call this tool again with confirm:true to save them.',
          ].join('\n');
        }

        let saved = 0;
        const failures = [];
        for (const batch of foreignMemory.chunk(report.entries, 200)) {
          try {
            const data = await aegis.memorySaveBatch(batch);
            saved += (data && data.saved) || batch.length;
          } catch (err) {
            // A 402 here means the free-tier session cap; surface it verbatim
            // rather than pretending part of the import worked.
            failures.push(err.message);
            break;
          }
        }

        if (failures.length) {
          return `${summary}\n\nSaved ${saved} of ${report.totals.entries} entries, then stopped: ${failures[0]}`;
        }
        return `${summary}\n\nSaved ${saved} entries to AEGIS memory. They are searchable now with aegis_memory_search.`;
      },
    },

    aegis_memory_list: {
      description:
        "List the most recent entries in the user's AEGIS cloud memory. Useful to review what AEGIS already remembers.",
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max entries (1-50). Default 10.', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      async run(args) {
        const data = await aegis.memoryList(args.limit || 10);
        const entries = data.entries || [];
        if (!entries.length) return 'AEGIS cloud memory is empty.';
        const body = entries.map((e, i) => `${i + 1}. ${e.content}`).join('\n');
        return `Recent ${entries.length} entries:\n${body}`;
      },
    },
  };


  /** The MCP `tools/list` payload — and the CLI's command index. */
  function toolList() {
    return Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  return { TOOLS, toolList };
}

module.exports = { createTools };
