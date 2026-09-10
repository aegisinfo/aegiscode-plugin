#!/usr/bin/env node
/**
 * Unit tests for client/foreign-memory.js — the "import memory from other AI
 * tools" scanner.
 *
 * Fixtures are real files laid out in a temp HOME, so these tests exercise the
 * actual walk/extract path. Crucially they pin the contract that a re-scan
 * produces *identical ids* (aegis1 upserts on (user_id, id) — new ids on every
 * run would duplicate the user's entire memory).
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const memory = require('../client/foreign-memory.js');
const { scan, listSources, describe, chunk, stableId, sourceById, SOURCES, DEFAULTS, _internal } = memory;

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  passed += 1;
}

// --- fixture HOME ---------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), 'aegis-foreign-memory-'));

function put(relPath, contents) {
  const file = join(home, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

// Claude Code transcript: the canonical ~/.claude/projects/<slug>/<uuid>.jsonl
const claudeLines = [
  // human turn worth remembering
  { type: 'user', message: { content: 'Refactor the auth module to use a constant time comparison for tokens.' }, timestamp: '2026-01-01T00:00:00.000Z' },
  // assistant text block
  { type: 'assistant', message: { content: [{ type: 'text', text: 'I extracted a helper that compares secrets without leaking length via early return.' }] } },
  // hidden reasoning must NOT be imported
  { type: 'assistant', message: { content: [{ type: 'thinking', text: 'The user probably wants the timeline preserved too, but I should ask before assuming.' }] } },
  // tool calls must NOT be imported
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test --silent' } }] } },
  // sidechain (subagent) chatter must NOT be imported
  { type: 'user', isSidechain: true, message: { content: 'Subagent scratchpad that is never user context and must stay out of memory.' } },
  // noise: a slash-command echo
  { type: 'user', message: { content: '<command-name>commit</command-name>' } },
  // noise: acknowledgement
  { type: 'user', message: { content: 'ok' } },
  // non-message bookkeeping rows carry no text
  { type: 'summary', summary: 'A session summary row that has no message field at all.' },
];
const transcript = claudeLines.map((l) => JSON.stringify(l)).join('\n') + '\n{ "type": "user", "message": {';
put(join('.claude', 'projects', '-home-neo-project', 'session-1.jsonl'), transcript);
put(
  join('.claude', 'projects', '-home-neo-project', 'session-2.jsonl'),
  JSON.stringify({ type: 'user', message: { content: 'The deployment pipeline should gate on a green test run before it promotes.' } }) + '\n'
);

// A symlink loop: the walker must not follow it (or this test hangs).
symlinkSync(join(home, '.claude', 'projects'), join(home, '.claude', 'projects', 'loop'));

// Claude memory files: a JSON store + a markdown note
put(join('.claude', 'memory.json'), JSON.stringify({ entries: [{ content: 'Prefers terse commit messages with no trailing period.' }] }));
put(join('.claude', 'memory', 'notes.md'), 'Remember that the staging database is a nightly restore, never edit it directly.');

// A best-effort (unverified) source: OpenAI-compatible {role, content} JSONL
put(
  join('.codex', 'sessions', 'rollout.jsonl'),
  JSON.stringify({ role: 'user', content: 'The token bucket refills every sixty seconds at a fixed rate.' }) + '\n' +
    JSON.stringify({ role: 'assistant', content: 'Confirmed: the refill rate is fixed, not elastic under burst.' }) + '\n'
);

// --- stableId: the dedupe contract ----------------------------------------
assert(stableId('a', 'b') === stableId('a', 'b'), 'stableId is deterministic');
assert(stableId('a', 'b') !== stableId('b', 'a'), 'stableId is order-sensitive');
assert(stableId('a', 'b') !== stableId('ab', ''), 'stableId cannot be collided by concatenation');
assert(/^import-[0-9a-f]{32}$/.test(stableId('x')), 'stableId has the import-<32 hex> shape');

// --- suffixOf: the regression that silently imported nothing --------------
// '**/*.jsonl'.endsWith() is always false, so passing a glob through matched
// zero files. Any of the 133 transcripts on this machine were skipped.
assert(_internal.suffixOf('**/*.jsonl') === '.jsonl', 'a **/ glob reduces to its literal suffix');
assert(_internal.suffixOf('*.jsonl') === '.jsonl', 'a bare * glob reduces to its literal suffix');
assert(_internal.suffixOf('.json') === '.json', 'a literal pattern is returned unchanged');

// --- cleanText / isNoise --------------------------------------------------
assert(_internal.cleanText('  a\u0000b\n\tc  ') === 'a b c', 'cleanText strips control chars and collapses whitespace');
assert(_internal.cleanText(undefined) === '', 'cleanText tolerates non-strings');
assert(_internal.isNoise('ok') === true, 'bare acknowledgements are noise');
assert(_internal.isNoise('Proceed') === true, 'acknowledgements are case-insensitive');
assert(_internal.isNoise('<command-name>commit</command-name>') === true, 'slash-command echoes are noise');
assert(_internal.isNoise('Refactor the auth module please') === false, 'real prose is not noise');

// --- listSources: probe-and-skip, never throws ----------------------------
const bareHome = mkdtempSync(join(tmpdir(), 'aegis-empty-home-'));
const nope = listSources(bareHome);
assert(nope.length === SOURCES.length, 'listSources reports every declared source');
assert(nope.every((s) => s.present === false), 'an empty home reports no sources present');
assert(nope.every((s) => Array.isArray(s.roots) && s.roots.length === 0), 'absent sources expose no roots');

const listing = listSources(home);
const cc = listing.find((s) => s.id === 'claude-code');
assert(cc.present === true, 'claude-code is detected from its real directory');
assert(cc.roots.some((r) => r.endsWith('session-1.jsonl')) === false, 'listSources stats directories, not transcripts');
assert(sourceById('claude-code') === SOURCES.find((s) => s.id === 'claude-code'), 'sourceById resolves a known id');
assert(sourceById('does-not-exist') === null, 'sourceById returns null for an unknown id');

// --- scan: extraction -----------------------------------------------------
const report = scan({ home });
assert(report.entries.length > 0, 'the scan imports entries from the fixture home');
assert(typeof report.scannedAt === 'string', 'scan stamps scannedAt');
assert(report.totals.entries === report.entries.length, 'totals.entries matches the entry count');

const fromClaude = report.entries.filter((e) => e.source === 'claude-code');
assert(fromClaude.length === 3, `claude-code yielded 3 entries (2 sessions + 1 more), got ${fromClaude.length}`);

const texts = fromClaude.map((e) => e.content).join('\n');
assert(texts.includes('constant time comparison'), 'human turns are imported');
assert(texts.includes('compares secrets without leaking'), 'assistant text blocks are imported');
assert(!texts.includes('The user probably wants the timeline'), 'hidden thinking is never imported');
assert(!texts.includes('npm test'), 'tool calls are never imported');
assert(!texts.includes('Subagent scratchpad'), 'sidechain subagent chatter is never imported');
assert(!texts.includes('<command-name>'), 'command echoes are never imported');
assert(!fromClaude.some((e) => e.content === 'ok'), 'acknowledgements are never imported');

assert(fromClaude.some((e) => e.role === 'user'), 'user role is preserved');
assert(fromClaude.some((e) => e.role === 'assistant'), 'assistant role is preserved');

// a torn final line must not abort the file
assert(fromClaude.filter((e) => e.content.includes('deployment pipeline')).length === 1, 'a second transcript file is fully read');

// --- scan: bounded session fan-out (the aegis1 402 blocker) ---------------
const sessions = [...new Set(report.entries.map((e) => e.session))];
assert(sessions.every((s) => s.startsWith('import:')), 'every imported session is namespaced with import:');
assert(new Set(fromClaude.map((e) => e.session)).size === 1, 'all entries from one source collapse to ONE session');
assert(sessions.length <= SOURCES.filter((s) => s.present !== false).length, 'session count is bounded by the source count');

// --- scan: entry shape ----------------------------------------------------
const entry = fromClaude[0];
assert(/^import-[0-9a-f]{32}$/.test(entry.id), 'imported entries carry a deterministic id');
assert(typeof entry.content === 'string' && entry.content.length >= DEFAULTS.minChars, 'content respects minChars');
assert(entry.tags.includes('imported') && entry.tags.includes('claude-code'), 'entries are tagged imported + source');
assert(entry.source === 'claude-code' && entry.session === 'import:claude-code', 'source and session identify the origin');
assert(typeof entry.timestamp === 'string' && entry.timestamp.length > 0, 'entries carry a timestamp');

// --- scan: id stability across runs (upsert, not duplicate) ---------------
const again = scan({ home });
assert(
  JSON.stringify(again.entries.map((e) => e.id)) === JSON.stringify(report.entries.map((e) => e.id)),
  'a re-scan produces identical ids in identical order (so the server upserts)'
);
assert(
  again.entries.filter((e) => e.content.includes('constant time comparison')).length === 1,
  'the same text is deduped within a single scan'
);

// --- scan: per-source restriction ----------------------------------------
const onlyClaude = scan({ home, sources: ['claude-code'] });
assert(onlyClaude.entries.every((e) => e.source === 'claude-code'), 'the sources option restricts the scan');
assert(onlyClaude.sources.length === 1, 'the sources option narrows the reported source list');
assert(onlyClaude.sources[0].id === 'claude-code', 'the only reported source is the requested one');
assert(onlyClaude.sources[0].label === 'Claude Code', 'reported sources keep their label');
assert(onlyClaude.entries.length === report.sources.find((s) => s.id === 'claude-code').count, 'a restricted scan matches the unrestricted count');

// --- scan: other extractors ----------------------------------------------
assert(report.entries.some((e) => e.source === 'claude-memory'), 'a JSON memory store is imported');
assert(
  report.entries.some((e) => e.content.includes('nightly restore')),
  'a markdown note file becomes one memory entry'
);
assert(report.entries.some((e) => e.source === 'codex'), 'a best-effort generic JSONL source is imported');

// --- scan: bounds ---------------------------------------------------------
const bounded = scan({ home, limit: 2 });
assert(bounded.entries.length === 2, 'the limit option caps entries overall');

const truncated = scan({ home, maxChars: 40 });
assert(truncated.entries.every((e) => e.content.length <= 41), 'maxChars truncates long entries');
assert(truncated.entries.some((e) => e.content.endsWith('…')), 'truncated entries are marked with an ellipsis');

const quiet = scan({ home, minChars: 10000 });
assert(quiet.entries.length === 0, 'minChars filters everything when set impossibly high');

const capped = scan({ home, sources: ['claude-code'], maxEntriesPerSource: 1 });
assert(capped.sources.find((s) => s.id === 'claude-code').count === 1, 'maxEntriesPerSource caps one source');

// --- scan on a machine with nothing installed ----------------------------
const empty = scan({ home: bareHome });
assert(empty.entries.length === 0, 'an empty home imports nothing');
assert(empty.totals.sourcesPresent === 0, 'an empty home reports no present sources');
assert(describe(empty) === 'No other AI tool memory found on this machine.', 'describe explains an empty scan');

// --- describe -------------------------------------------------------------
const summary = describe(report);
assert(summary.includes(`${report.totals.entries} importable entries`), 'describe leads with the entry count');
assert(summary.includes('Claude Code'), 'describe lists detected sources');
assert(summary.includes('(best-effort layout)'), 'describe flags unverified sources honestly');

// --- chunk ----------------------------------------------------------------
const six = [1, 2, 3, 4, 5, 6];
assert(chunk(six, 2).length === 3, 'chunk splits into ceil(n/size) batches');
assert(chunk(six, 2).every((b) => b.length === 2), 'each full batch is exactly `size`');
assert(chunk([1], 200).length === 1, 'chunk keeps a short tail');
assert(chunk([], 200).length === 0, 'chunk of nothing is nothing');
assert(chunk(six, 200)[0].length === 6, 'a small list is one batch');
assert(chunk(six, 4).map((b) => b.length).join(',') === '4,2', 'chunk preserves order and the remainder');

// --- untrusted foreign data must never throw ------------------------------
const hostile = mkdtempSync(join(tmpdir(), 'aegis-hostile-'));
mkdirSync(join(hostile, '.claude', 'projects', 'evil'), { recursive: true });
writeFileSync(join(hostile, '.claude', 'projects', 'evil', 'a.jsonl'), 'not json at all\n{"type":"user"}\n');
writeFileSync(join(hostile, '.claude', 'projects', 'evil', 'b.jsonl'), '\u0000\u0001\u0002 binary-ish garbage \u0003');
writeFileSync(join(hostile, '.claude', 'memory.json'), '{{{ broken json');
writeFileSync(join(hostile, '.claude', 'history.jsonl'), JSON.stringify({ display: 'a history row with no message field' }) + '\n');
const hostileReport = scan({ home: hostile });
assert(Array.isArray(hostileReport.entries), 'a malformed store still returns a report');
assert(hostileReport.entries.length === 0, 'malformed input imports nothing rather than throwing');

// --- the symlink loop in the fixture home terminated the walk -------------
assert(existsSync(join(home, '.claude', 'projects', 'loop')), 'the fixture symlink loop still exists');
assert(report.sources.find((s) => s.id === 'claude-code').files === 2, 'the walk visited 2 transcripts and did not follow the loop');

// --- NUL/control-char scrubbing survives to the entry ---------------------
const dirty = mkdtempSync(join(tmpdir(), 'aegis-dirty-'));
mkdirSync(join(dirty, '.claude', 'projects', 'd'), { recursive: true });
writeFileSync(
  join(dirty, '.claude', 'projects', 'd', 'x.jsonl'),
  JSON.stringify({ type: 'user', message: { content: 'alpha\u0000\u0007 beta\n\n\tgamma delta epsilon zeta' } }) + '\n'
);
const dirtyReport = scan({ home: dirty });
assert(dirtyReport.entries.length === 1, 'a control-char-laced entry survives');
assert(dirtyReport.entries[0].content === 'alpha beta gamma delta epsilon zeta', 'control chars are scrubbed before save');

console.log(`foreign-memory tests passed (${passed} assertions)`);
