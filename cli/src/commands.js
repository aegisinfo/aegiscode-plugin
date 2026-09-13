'use strict';

/**
 * Slash commands — the CLI's face on the shared tool registry.
 *
 * Every command that talks to AEGIS names a tool from `mcp/tools.js`, and
 * `test/cli-tools.test.mjs` asserts both directions: no command points at a
 * tool that does not exist, and no tool is unreachable from the prompt. A new
 * capability added to the registry therefore shows up here or fails the build,
 * which is the failure mode we want (the alternative is a capability that
 * exists in the MCP host and is invisible in the terminal).
 *
 * Plain text (no leading `/`) is a prompt: it goes to the pooled brain.
 */

const COMMANDS = [
  {
    name: 'ask',
    args: '<prompt>',
    help: 'Send a prompt to the AEGIS pool (same as typing it plainly).',
    tool: 'aegis_ask',
    build: (arg) => ({ prompt: arg }),
  },
  {
    name: 'status',
    help: 'Validate the API key; show plan, account and memory state.',
    tool: 'aegis_status',
    build: () => ({}),
  },
  {
    name: 'models',
    aliases: ['model-list'],
    help: 'List the model ids you can pin with /model.',
    tool: 'aegis_list_models',
    build: () => ({}),
  },
  {
    name: 'balance',
    aliases: ['spend'], // not `cost` — that name is the local session tally below
    help: 'Token-bank balance and recent spend (tokens beside €).',
    tool: 'aegis_balance',
    build: () => ({}),
  },
  {
    name: 'recall',
    args: '<query>',
    help: 'Search your AEGIS cloud memory.',
    tool: 'aegis_memory_search',
    build: (arg) => ({ query: arg }),
  },
  {
    name: 'remember',
    args: '<text>',
    help: 'Save a durable note to cloud memory.',
    tool: 'aegis_memory_save',
    build: (arg) => ({ content: arg }),
  },
  {
    name: 'memory',
    aliases: ['memories'],
    help: 'List the most recent cloud-memory entries.',
    tool: 'aegis_memory_list',
    build: () => ({}),
  },
  {
    name: 'import',
    args: '[--confirm]',
    help: 'Import memory from other tools on this machine (dry run unless --confirm).',
    tool: 'aegis_memory_import',
    build: (arg) => ({ confirm: /--confirm\b/.test(arg) }),
  },
  {
    name: 'byok',
    help: 'Show which providers have your own key configured.',
    tool: 'aegis_byok_status',
    build: () => ({}),
  },
  {
    name: 'byok-set',
    args: '<provider>',
    help: 'Set YOUR provider key (prompted, never echoed, never in history).',
    tool: 'aegis_byok_set',
    secret: 'key',
    build: (arg) => ({ provider: arg.trim() }),
  },
  {
    name: 'byok-rm',
    args: '<provider>',
    help: 'Remove a stored provider key.',
    tool: 'aegis_byok_set',
    build: (arg) => ({ provider: arg.trim() }),
  },
  {
    name: 'tool',
    args: '<name> [json]',
    help: 'Call any registry tool directly (escape hatch for new tools).',
    generic: true,
    build: (arg) => {
      const sp = arg.indexOf(' ');
      const name = (sp === -1 ? arg : arg.slice(0, sp)).trim();
      const rest = sp === -1 ? '' : arg.slice(sp + 1).trim();
      let args = {};
      if (rest) {
        try {
          args = JSON.parse(rest);
        } catch (err) {
          throw new Error(`/tool: arguments must be JSON — ${err.message}`);
        }
      }
      return { tool: name, args };
    },
  },

  // --- local commands: no server call, handled by app.js --------------------
  {
    name: 'model',
    args: '[id]',
    help: 'Pin a model id (no argument shows the current pin and clears it with `-`).',
    local: 'model',
  },
  { name: 'stream', args: '[on|off]', help: 'Toggle streaming output.', local: 'stream' },
  { name: 'theme', args: '[dark|light]', help: 'Switch the colour theme.', local: 'theme' },
  { name: 'cost', aliases: ['usage'], help: 'This session: tokens, spend and call count.', local: 'cost' },
  { name: 'clear', aliases: ['cls'], help: 'Clear the screen.', local: 'clear' },
  { name: 'help', aliases: ['?', 'h'], help: 'Show this list.', local: 'help' },
  { name: 'quit', aliases: ['exit', 'q'], help: 'Exit.', local: 'quit' },
];

const BY_NAME = new Map();
for (const c of COMMANDS) {
  BY_NAME.set(c.name, c);
  for (const a of c.aliases || []) BY_NAME.set(a, c);
}

function findCommand(name) {
  return BY_NAME.get(String(name || '').toLowerCase()) || null;
}

/**
 * Classify one input line.
 * @returns {{kind:'empty'}|{kind:'command',command:object,arg:string}|{kind:'prompt',text:string}}
 */
function parseLine(line) {
  const raw = String(line == null ? '' : line);
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };
  if (trimmed[0] !== '/') return { kind: 'prompt', text: trimmed };
  const sp = trimmed.indexOf(' ');
  const name = (sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp)).trim();
  const arg = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
  const command = findCommand(name);
  if (!command) {
    return { kind: 'unknown', name, text: trimmed };
  }
  return { kind: 'command', command, arg };
}

/** Commands that map to a registry tool, for the coverage test. */
function toolBackedCommands() {
  return COMMANDS.filter((c) => c.tool);
}

module.exports = { COMMANDS, findCommand, parseLine, toolBackedCommands };
