'use strict';

/**
 * Real enforcement for the /permissions rules (src/config.js) in the
 * direct-provider tool loop. The `claude` CLI path already has its own real
 * approval UX from the real binary, so this only applies to
 * Bash/Read/Write/Edit/Glob/Grep run by a provider model.
 *
 * Scope decision (Phase 12): the multi-directory-change Bash heuristic,
 * explicit /permissions allow|deny|ask rules, and `defaultMode: 'ask'` when
 * the permissions file *explicitly* writes it (rules.explicitAsk) are
 * enforced here. The file-free default ('ask' in DEFAULT_PERMISSIONS) is
 * NOT consulted — honoring the implicit default would prompt on every tool
 * call out of the box and make the agentic loop unusable by default.
 * /confirm and /yolo still toggle defaultMode for the explicit case.
 *
 * Not tools.js's Glob-tool globToRegex: that one is filesystem-glob (`*`
 * stops at `/`, matching one path segment) because it walks a directory
 * tree. Rule subjects here are just as often a Bash command string, where
 * `/` is ordinary text ("rm -rf /tmp/x") — a `Bash(npm run *)` rule (see
 * DEFAULT_PERMISSIONS's own example) needs `*` to match the rest of the
 * line, slashes included. So `*` and `?` here are plain "match anything"
 * wildcards, not path-segment-bounded ones; reimplemented rather than
 * imported so this module has no import-cycle with tools.js (executeTool's
 * home, which calls into this one).
 *
 * Ported from aegiscodex-dev/src/permissions.js (ESM → CommonJS).
 */

const RULE_RE = /^(\w+)(?:\((.*)\))?$/;

/**
 * Tool-name aliases. The shipped engine (desktop/lib/local/tools.js) names its
 * tools readFile/writeFile/editFile/listDir/glob/grep/exec/task, while this
 * module was ported from the reference and keyed on that CLI's names —
 * Read/Write/Edit/Glob/Grep/Bash/Task. Those reference names are also what
 * users write into /permissions, so both spellings must fold onto one
 * capability. Keying on the reference's spelling alone meant subjectFor()
 * returned '' for every tool the engine actually calls: `exec(git *)` never
 * matched its subject, `Read(*.env)` never matched a readFile, and the
 * multi-directory rail never fired — a permission system blind to the very
 * tools it was meant to govern.
 */
const TOOL_ALIAS = {
  exec: 'shell', Bash: 'shell',
  readFile: 'read', Read: 'read',
  writeFile: 'write', Write: 'write',
  editFile: 'edit', Edit: 'edit',
  listDir: 'list', LS: 'list',
  glob: 'glob', Glob: 'glob',
  grep: 'grep', Grep: 'grep',
  task: 'task', Task: 'task',
};

/** Fold either registry's name for a tool onto the capability it names. */
function canonTool(name) {
  const key = String(name == null ? '' : name);
  return TOOL_ALIAS[key] || key;
}

/** True for the engine's `exec` and the reference's `Bash` alike. */
function isShellTool(toolName) {
  return canonTool(toolName) === 'shell';
}

function globToRegex(pattern) {
  let re = '^';
  for (const c of pattern) {
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (/[.+^${}()|[\]\\]/.test(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(re + "$");
}

/** The subject a rule's pattern matches against, per tool. */
function subjectFor(toolName, args = {}) {
  switch (canonTool(toolName)) {
    case 'shell': return String(args.command || '');
    case 'read': case 'write': case 'edit': return String(args.file_path || '');
    case 'glob': case 'grep': return String(args.pattern || '');
    case 'list': return String(args.path || '');
    default: return '';
  }
}

function matchRule(rule, toolName, subject) {
  const m = RULE_RE.exec(String(rule || '').trim());
  if (!m) return false;
  const [, tool, pattern] = m;
  // A rule spelled with the reference's name governs the engine's tool and
  // vice versa: `Bash(git *)` and `exec(git *)` are one rule, not two.
  if (canonTool(tool) !== canonTool(toolName)) return false;
  if (pattern === undefined) return true; // bare "Bash"/"exec" matches every call
  try { return globToRegex(pattern).test(subject); } catch { return false; }
}

const matchesAny = (list, toolName, subject) =>
  Array.isArray(list) && list.some((r) => matchRule(r, toolName, subject));

/**
 * A Bash command that changes directory more than once needs a second look:
 * each `&&`/`;`/`|`/newline-separated segment starting with `cd` counts.
 * Mirrors the captured Claude Code 2.1.228 heuristic ("Multiple directory
 * changes in one command require approval for clarity") — a hardcoded UX
 * safety rail, not a configurable rule.
 */
function isMultiDirCommand(command) {
  const segments = String(command || '').split(/&&|\|\||;|\n/).map((s) => s.trim());
  const cdCount = segments.filter((s) => /^cd(\s|$)/.test(s)).length;
  return cdCount > 1;
}

/**
 * Evaluate a tool call against the persisted /permissions rules.
 * Returns 'allow' | 'deny' | 'ask'. Precedence: an explicit deny rule always
 * wins (a security floor). An explicit allow rule is the real "always
 * allow" escape hatch, so it's checked next and suppresses the multi-cd
 * heuristic below it — same as upstream, where an always-allow rule for
 * Bash stops it asking again. With no allow rule, the multi-cd heuristic
 * forces 'ask' on its own; then explicit ask rules. Anything left
 * unmatched falls through to rules.explicitAsk (an explicitly written
 * `defaultMode: 'ask'` prompts on the residual); otherwise 'allow' — see
 * the scope note above, the implicit defaultMode is intentionally not
 * consulted.
 */
function evalPermission(toolName, args, rules = {}) {
  const subject = subjectFor(toolName, args);
  if (matchesAny(rules.deny, toolName, subject)) return 'deny';
  if (matchesAny(rules.allow, toolName, subject)) return 'allow';
  if (isShellTool(toolName) && isMultiDirCommand(args && args.command)) return 'ask';
  if (matchesAny(rules.ask, toolName, subject)) return 'ask';
  if (rules.explicitAsk && rules.defaultMode === 'ask') return 'ask';
  return 'allow';
}

module.exports = {
  canonTool,
  isShellTool,
  subjectFor,
  matchRule,
  isMultiDirCommand,
  evalPermission,
};
