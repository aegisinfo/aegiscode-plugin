'use strict';

/**
 * Slash commands — the CLI's face on the shared tool registry, using the
 * command vocabulary of the sibling `aegiscodex-dev` client.
 *
 * Three kinds of entry live in one table:
 *
 *   (a) tool-backed  — names a tool from `mcp/tools.js` and carries a
 *       `build(arg) -> object` that turns the typed argument into the tool's
 *       JSON. `test/cli-tools.test.mjs` asserts both directions: no command
 *       points at a tool that does not exist, and no tool in the registry is
 *       unreachable from the prompt, so a new capability added to the registry
 *       shows up here or fails the build.
 *   (b) local        — no server call; handled in `app.js` by `cmd.local`.
 *   (c) unavailable  — a `aegiscodex-dev` command whose capability this client
 *       genuinely does not have (it needs a local agent loop, Claude Code auth,
 *       or a repo tool). These carry an honest `why` and are *not* fakes:
 *       `parseLine` returns `{ kind: 'unavailable' }` and `app.js` prints the
 *       reason plus a working alternative.
 *
 * The names, aliases, categories and descriptions come from
 * `aegiscodex-dev/src/registry.js` (`COMMANDS`, `CATEGORIES`). Where our
 * capability differs from the reference's (e.g. `memory` here lists *cloud*
 * memory, not the reference's local tier store) the description says what this
 * client actually does rather than copying a sentence that would be untrue.
 *
 * Plain text (no leading `/`) is a prompt: it goes to the pooled brain.
 */

const COMMANDS = [
  // ── AEGIS tool-backed family (aegiscodex-dev's `aegis` category) ──────────
  {
    name: 'aegis-ask',
    aliases: ['ask'],
    args: '<question>',
    category: 'aegis',
    desc: 'Ask ÆGIS pooled inference a question (auto-routed)',
    tool: 'aegis_ask',
    build: (arg) => ({ prompt: arg }),
  },
  {
    // aegiscodex-dev splits this into `aegis-status` (local memory stats) and
    // `status` (session status); this client has one account-status tool, so
    // both spellings route to it — `status`/`st` as aliases.
    name: 'aegis-status',
    aliases: ['status', 'st'],
    args: '',
    category: 'aegis',
    desc: 'Show account status — API key, plan, account and cloud memory',
    tool: 'aegis_status',
    build: () => ({}),
  },
  {
    name: 'aegis-recall',
    aliases: ['recall'],
    args: '<topic>',
    category: 'aegis',
    desc: 'Recall cross-session memory about a topic',
    tool: 'aegis_memory_search',
    build: (arg) => ({ query: arg }),
  },
  {
    name: 'aegis-remember',
    aliases: ['remember'],
    args: '<note>',
    category: 'aegis',
    desc: 'Save a note or decision to cross-session memory',
    tool: 'aegis_memory_save',
    build: (arg) => ({ content: arg }),
  },
  {
    name: 'memory',
    aliases: ['memories'],
    args: '',
    category: 'aegis',
    desc: 'List the most recent AEGIS cloud-memory entries',
    tool: 'aegis_memory_list',
    build: () => ({}),
  },
  {
    // No reference equivalent (the reference has no importer); the name follows
    // the `/aegis-*` family. Keeps the `--confirm` dry-run semantics: without
    // the flag the tool only reports what it found.
    name: 'aegis-import',
    aliases: ['import'],
    args: '[--confirm]',
    category: 'aegis',
    desc: 'Import memory from other AI tools on this machine (dry run unless --confirm)',
    tool: 'aegis_memory_import',
    build: (arg) => ({ confirm: /--confirm\b/.test(arg) }),
  },
  {
    // aegiscodex-dev's `model` switches the brain; this client pins a model id
    // (local) and lists the pinnable ids with a tool. `models` is the list
    // action — aegiscodex-dev's `/model list`, surfaced as its own command.
    name: 'models',
    aliases: ['model-list'],
    args: '',
    category: 'model',
    desc: 'List the model ids you can pin with /model',
    tool: 'aegis_list_models',
    build: () => ({}),
  },
  {
    // aegiscodex-dev has no BYOK surface; these are carried over from the
    // registry's byok tools. `billing` below is the reference's name for the
    // balance read the tool performs.
    name: 'byok',
    args: '',
    category: 'auth',
    desc: 'Show which providers have your own key configured',
    tool: 'aegis_byok_status',
    build: () => ({}),
  },
  {
    name: 'byok-set',
    args: '<provider>',
    category: 'auth',
    desc: 'Set YOUR provider key (prompted, never echoed, never in history)',
    tool: 'aegis_byok_set',
    secret: 'key',
    build: (arg) => ({ provider: arg.trim() }),
  },
  {
    name: 'byok-rm',
    args: '<provider>',
    category: 'auth',
    desc: 'Remove a stored provider key',
    tool: 'aegis_byok_set',
    build: (arg) => ({ provider: arg.trim() }),
  },
  {
    // aegiscodex-dev's `billing`; `balance` and `spend` stay routable for
    // muscle memory. Not `cost` — that name is this client's local tally below.
    name: 'billing',
    aliases: ['balance', 'spend'],
    args: '',
    category: 'support',
    desc: 'Show billing info — token-bank balance and recent spend',
    tool: 'aegis_balance',
    build: () => ({}),
  },
  {
    // The escape hatch for any registry tool, including ones added later.
    name: 'tool',
    args: '<name> [json]',
    category: 'aegis',
    desc: 'Call any registry tool directly (escape hatch for new tools)',
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

  // ── local commands: no server call, handled by app.js ─────────────────────
  {
    name: 'model',
    aliases: ['m'],
    args: '[id]',
    category: 'model',
    desc: 'Switch AI model — pin an id (no argument shows the pin; `-` clears it)',
    local: 'model',
  },
  { name: 'stream', args: '[on|off]', category: 'model', desc: 'Toggle streaming output', local: 'stream' },
  { name: 'theme', aliases: ['t'], args: '[dark|light]', category: 'model', desc: 'Change the color theme', local: 'theme' },
  { name: 'version', aliases: ['v'], args: '', category: 'session', desc: 'Show version', local: 'version' },
  { name: 'cost', args: '', category: 'data', desc: 'Show the cost of the current session', local: 'cost' },
  {
    name: 'tokens',
    aliases: ['tok'],
    args: '',
    category: 'data',
    desc: 'Show token usage breakdown and estimated spend',
    local: 'tokens',
  },
  { name: 'clear', aliases: ['cls'], args: '', category: 'session', desc: 'Start a new session with empty context', local: 'clear' },
  { name: 'help', aliases: ['?', 'h'], args: '', category: 'support', desc: 'Show help', local: 'help' },
  { name: 'exit', aliases: ['quit'], args: '', category: 'session', desc: 'Exit the CLI', local: 'exit' },

  // ── unavailable: aegiscodex-dev vocabulary this client cannot honour ───────
  // Not fakes — each names why it is absent and, where one exists, the nearest
  // working command. `parseLine` surfaces these as `kind: 'unavailable'`.
  { name: 'login', args: '', category: 'auth', desc: 'Sign in to Claude Code', unavailable: true, why: 'sign-in uses Claude Code auth, which this client does not have — it authenticates with your AEGIS key', alt: '/byok-set' },
  { name: 'logout', args: '', category: 'auth', desc: 'Sign out', unavailable: true, why: 'there is no Claude Code sign-in here to end' },
  { name: 'doctor', args: '', category: 'support', desc: 'Run diagnostic checks on this environment', unavailable: true, why: 'the diagnostic suite belongs to aegiscodex-dev, not this client', alt: '/status' },
  { name: 'permissions', args: '[mode] [pattern]', category: 'model', desc: 'Set permissions for tool use', unavailable: true, why: 'tool-permission prompts require a local agent loop this client does not run' },
  { name: 'mcp', args: '[sub]', category: 'model', desc: 'Show MCP server configuration', unavailable: true, why: 'this CLI is itself an MCP host, so it has no MCP servers to configure', alt: '/tool' },
  { name: 'skills', aliases: ['sk'], args: '[name|refresh]', category: 'session', desc: 'List skills (SKILL.md in the standard skill dirs)', unavailable: true, why: 'skills run inside the agent loop, which this client does not host' },
  { name: 'hooks', args: '[status|list]', category: 'model', desc: 'View hooks configuration status and configured hook list', unavailable: true, why: 'hooks are a local agent-loop feature this client does not run' },
  { name: 'agents', aliases: ['sessions'], args: '[role] [task]', category: 'session', desc: 'Show the agents panel, or run a sub-agent role preset — /agents <role> <task>', unavailable: true, why: 'sub-agents need a local agent loop this client does not host' },
  { name: 'resume', args: '', category: 'session', desc: 'Switch to a previous session', unavailable: true, why: 'this client keeps no session history to resume' },
  { name: 'rewind', args: '[N]', category: 'session', desc: 'Revert the conversation to a checkpoint', unavailable: true, why: 'checkpoints belong to a session history this client does not keep' },
  { name: 'compact', args: '', category: 'session', desc: 'Compact the conversation history', unavailable: true, why: 'there is no local transcript to compact' },
  { name: 'init', args: '[file]', category: 'workspace', desc: 'Create a CLAUDE.md file in the project', unavailable: true, why: 'project scaffolding is a workspace feature this client does not have', alt: '/aegis-remember' },
  { name: 'export', args: '[markdown|json] [file|clipboard]', category: 'data', desc: 'Export the current conversation to a file or clipboard', unavailable: true, why: 'this client keeps no transcript to export' },
  { name: 'vim', args: '[on|off]', category: 'model', desc: 'Toggle vim keymap', unavailable: true, why: 'input is your terminal readline, which has no vim keymap' },
  { name: 'yolo', args: '[on|off]', category: 'model', desc: 'Toggle YOLO mode — auto-approve all tool executions', unavailable: true, why: 'there is no tool-approval prompt here to auto-approve' },
  { name: 'confirm', aliases: ['confirmations'], args: '[on|off]', category: 'model', desc: 'Toggle tool-call confirmation prompts', unavailable: true, why: 'there is no tool-approval prompt here to toggle' },
];

// ── Index + the one invariant a table like this must hold ────────────────────
// A name or alias registered twice would silently shadow the earlier entry, so
// the collision is a module-load error rather than a runtime surprise. (The
// reference keeps `builtinNames()` for exactly this; its test asserts the same.)

const BY_NAME = new Map();
for (const c of COMMANDS) {
  for (const n of [c.name, ...(c.aliases || [])]) {
    if (BY_NAME.has(n)) {
      throw new Error(`aegiscode: command name or alias /${n} is registered twice`);
    }
    BY_NAME.set(n, c);
  }
}

function findCommand(name) {
  return BY_NAME.get(String(name || '').toLowerCase()) || null;
}

/**
 * Classify one input line.
 * @returns {{kind:'empty'}
 *   |{kind:'command',command:object,arg:string}
 *   |{kind:'unavailable',command:object,arg:string}
 *   |{kind:'unknown',name:string,text:string}
 *   |{kind:'prompt',text:string}}
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
  if (command.unavailable) {
    return { kind: 'unavailable', command, arg };
  }
  return { kind: 'command', command, arg };
}

/** Commands that map to a registry tool, for the coverage test. */
function toolBackedCommands() {
  return COMMANDS.filter((c) => c.tool);
}

module.exports = { COMMANDS, findCommand, parseLine, toolBackedCommands };
