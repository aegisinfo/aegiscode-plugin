#!/usr/bin/env node
/**
 * AEGIS MCP server — exposes aegiscloud capabilities to any Claude Code user.
 *
 * Zero dependencies: raw JSON-RPC 2.0 over stdio (newline-delimited), Node's
 * global fetch. Runs from a bare `node server.js` — no npm install required.
 *
 * This is a thin HOST: all transport lives in ../client/aegis.js. This file
 * only defines tool schemas, formats results, and speaks MCP JSON-RPC.
 */

'use strict';

const { createClient } = require('../client/aegis.js');

const aegis = createClient();
const API_KEY = aegis.apiKey;
const API_BASE = aegis.apiBase;
const SERVER_NAME = 'aegis';
// Keep in sync with .claude-plugin/plugin.json "version".
const SERVER_VERSION = '0.2.0';

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

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
        `API base:  ${API_BASE}`,
      ].filter(Boolean);
      return lines.join('\n');
    },
  },

  aegis_ask: {
    description:
      "Send a prompt to AEGIS pooled inference, billed against the account's token bank. Either pick an exact model with `model` (call aegis_list_models to see choices — e.g. 'anthropic', 'deepseek', 'groq'), or leave it unset and let `mode` auto-route to the cheapest capable provider: 'fast' for quick/cheap, 'smart' (default) for balanced, 'neo' for hardest reasoning.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user prompt / question.' },
        model: {
          type: 'string',
          description:
            "Exact model id to pin, from aegis_list_models (e.g. 'anthropic', 'deepseek', 'groq'). Takes priority over mode.",
        },
        mode: {
          type: 'string',
          enum: ['fast', 'smart', 'neo'],
          description: "Auto-routing tier, used only when `model` is not set. Default 'smart'.",
        },
        system: { type: 'string', description: 'Optional system instruction.' },
        max_tokens: {
          type: 'integer',
          description: 'Max output tokens. Default 1024.',
          minimum: 1,
          maximum: 8192,
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async run(args) {
      // Use the OpenAI-compatible endpoint (stream:false): it returns structured
      // JSON errors (e.g. 402 insufficient_quota) instead of the opaque 502 that
      // /api/v1/complete emits. An exact `model` id pins that provider directly;
      // otherwise `nexus-${mode}` selects the auto-routing tier.
      const mode = args.mode || 'smart';
      const data = await aegis.chatCompletion({
        prompt: args.prompt,
        system: args.system,
        model: args.model,
        mode,
        maxTokens: args.max_tokens || 1024,
      });
      const choice = (data.choices && data.choices[0]) || {};
      const text = (choice.message && choice.message.content) || '(empty response)';
      const meta = [
        data.model ? `model: ${data.model}` : null,
        args.model ? null : `mode: ${mode}`,
        data.usage ? `tokens: ${data.usage.total_tokens}` : null,
      ]
        .filter(Boolean)
        .join('  ·  ');
      return `${text}\n\n— ${meta}`;
    },
  },

  aegis_list_models: {
    description:
      "List the exact models available to pin with aegis_ask's `model` argument, instead of letting `mode` auto-route to the cheapest provider.",
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
      const lines = [`Balance: €${data.balance_eur ?? '0'}`];
      const ledger = (data.ledger || []).slice(0, 5);
      if (ledger.length) {
        lines.push('', 'Recent activity:');
        for (const l of ledger) {
          const cost = ((l.charged_micros || 0) / 1_000_000).toFixed(4);
          lines.push(`  ${l.created_at || ''}  ${l.model_key || l.kind || ''}  -€${cost}`);
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
      "List which providers (anthropic, groq, openai) have a Bring-Your-Own-Key configured on this AEGIS account. A configured BYOK key is used automatically by aegis_ask instead of the pooled balance for that provider, so calls no longer cost AEGIS token-bank funds.",
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
      "Set or remove a Bring-Your-Own-Key API key for a provider (anthropic, groq, or openai) on this AEGIS account. Once set, aegis_ask uses that key directly for that provider instead of the pooled AEGIS balance — unlimited use at the user's own cost. Omit api_key to remove a previously set key.",
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['anthropic', 'groq', 'openai'], description: 'Which provider this key is for.' },
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

function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP plumbing
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// Track in-flight handlers so we don't exit while a fetch is pending.
let pending = 0;
let stdinClosed = false;
function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // no response for notifications

      case 'ping':
        if (!isNotification) reply(id, {});
        return;

      case 'tools/list':
        reply(id, { tools: toolList() });
        return;

      case 'tools/call': {
        const name = params && params.name;
        const tool = TOOLS[name];
        if (!tool) {
          reply(id, {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          });
          return;
        }
        if (!API_KEY) {
          reply(id, {
            content: [
              {
                type: 'text',
                text:
                  'No AEGIS_API_KEY is set. Add your aegis_ key to the environment (see the plugin README) and restart Claude Code. Get a key at https://aegiscloud.org.',
              },
            ],
            isError: true,
          });
          return;
        }
        try {
          const text = await tool.run((params && params.arguments) || {});
          reply(id, { content: [{ type: 'text', text }], isError: false });
        } catch (err) {
          reply(id, {
            content: [{ type: 'text', text: `AEGIS error: ${err.message}` }],
            isError: true,
          });
        }
        return;
      }

      default:
        if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
        return;
    }
  } catch (err) {
    if (!isNotification) replyError(id, -32603, err.message);
  }
}

// ---------------------------------------------------------------------------
// stdin loop — newline-delimited JSON-RPC
// ---------------------------------------------------------------------------

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    pending++;
    Promise.resolve(handleMessage(msg)).finally(() => {
      pending--;
      maybeExit();
    });
  }
});
process.stdin.on('end', () => {
  stdinClosed = true;
  maybeExit();
});
