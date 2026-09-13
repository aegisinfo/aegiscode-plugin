#!/usr/bin/env node
/**
 * The CLI's support modules — config/home redirection, session history, tokens,
 * permissions, checkpoints, export, agents and summarize — driven directly (no
 * TTY, no network, no child process).
 *
 * What it pins: that AEGISCODE_HOME redirects the whole data dir (so a test run
 * never touches the real ~/.aegiscode), the history.jsonl round-trip (append →
 * readOwnSessions / readSessionTranscript / aggregateSessionUsage), the atomic
 * config write landing under that temp home, the token estimator and per-model
 * context window, the agent prompt composition for every role, markdown export,
 * checkpoint snapshots, and the documented 'ask' verdict from the permission
 * evaluator.
 *
 * Style matches test/cli-render.test.mjs: createRequire, a local assert() that
 * throws `ASSERT FAILED: ...`, no test framework.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, '..', 'cli');
const require = createRequire(import.meta.url);

// Redirect the data dir BEFORE the modules are loaded, so nothing below can
// reach the real home directory.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-'));
process.env.AEGISCODE_HOME = HOME;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const config = require(join(cliDir, 'src', 'config.js'));
const tokens = require(join(cliDir, 'src', 'tokens.js'));
const permissions = require(join(cliDir, 'src', 'permissions.js'));
const history = require(join(cliDir, 'src', 'history.js'));
const exportMod = require(join(cliDir, 'src', 'export.js'));
const checkpoint = require(join(cliDir, 'src', 'checkpoint.js'));
const agents = require(join(cliDir, 'src', 'agents.js'));
const summarize = require(join(cliDir, 'src', 'summarize.js'));

// ── home redirection ───────────────────────────────────────────────────────
eq(config.aegisDir(), path.resolve(HOME), 'aegisDir() honours AEGISCODE_HOME');
assert(config.aegisDir().startsWith(HOME), 'the data dir is under the temp home');
assert(!config.aegisDir().includes('.aegiscodex'), 'the data dir is ~/.aegiscode, never ~/.aegiscodex');

// ── config write lands under the temp home ─────────────────────────────────
const merged = config.updateConfig({ model: 'x' });
eq(merged.model, 'x', 'updateConfig returns the merged view');
eq(config.loadConfig().model, 'x', 'loadConfig reads back the written model');
assert(config.configPath().startsWith(HOME), 'config.json lands under the temp home');
assert(fs.existsSync(config.configPath()), 'the config file was actually written');

// ── history round-trip ─────────────────────────────────────────────────────
const sid = 'sess-support-test';
const prompt = 'port the support modules';
const reply = 'done — modules created';
history.appendHistory({
  sessionId: sid,
  prompt,
  reply,
  status: 'done',
  usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, costUsd: 0.001 },
});

const sessions = history.readOwnSessions();
assert(sessions.length >= 1, 'readOwnSessions returns the appended session');
eq(sessions[0].id, sid, 'the session id round-trips');
eq(sessions[0].summary, prompt, 'the session summary is the prompt');
eq(sessions[0].own, true, 'an own session is flagged own');

const transcript = history.readSessionTranscript(sid);
eq(transcript.length, 2, 'the transcript is a user/assistant pair');
eq(transcript[0].role, 'user', 'the first turn is the user prompt');
eq(transcript[0].text, prompt, 'the user text round-trips');
eq(transcript[1].role, 'assistant', 'the second turn is the assistant reply');
eq(transcript[1].text, reply, 'the assistant text round-trips');

const agg = history.aggregateSessionUsage(sid);
eq(agg.entries, 1, 'aggregateSessionUsage counts the appended exchange');
eq(agg.usage.input, 10, 'input tokens total');
eq(agg.usage.output, 5, 'output tokens total');
eq(agg.usage.cacheRead, 2, 'cache-read tokens total');
eq(agg.usage.cacheWrite, 1, 'cache-write tokens total');
eq(agg.real, true, 'a live-usage record aggregates as real');
assert(history.historyPath().startsWith(HOME), 'history.jsonl lands under the temp home');

// ── tokens ─────────────────────────────────────────────────────────────────
const est = tokens.estimateTokens('abcd');
assert(Number.isInteger(est) && est > 0, `estimateTokens returns a positive integer (got ${est})`);
assert(typeof tokens.contextWindowFor('deepseek-v4') === 'number', 'contextWindowFor returns a number for a known model');
assert(typeof tokens.contextWindowFor('totally-unknown-model') === 'number', 'contextWindowFor returns a number for an unknown model');
eq(tokens.contextWindowFor('deepseek-v4'), 1_048_576, 'a known provider prefix maps to its real window');

// ── agents ─────────────────────────────────────────────────────────────────
const roles = agents.agentRoles();
assert(Array.isArray(roles) && roles.length >= 1, 'agentRoles lists the presets');
for (const role of roles) {
  const p = agents.composeAgentPrompt(role, 'task');
  assert(typeof p === 'string' && p.length > 0, `composeAgentPrompt('${role}', …) is a non-empty string`);
}
assert(agents.composeAgentPrompt('x', 'task').length > 0, 'an unknown role still composes a non-empty prompt');

// ── export ─────────────────────────────────────────────────────────────────
const md = exportMod.transcriptToMarkdown([{ role: 'user', text: 'hi' }]);
assert(md.includes('hi'), 'the markdown export contains the transcript text');

// ── checkpoints ────────────────────────────────────────────────────────────
const cpSid = 'sess-checkpoint-test';
checkpoint.snapshotCheckpoint(cpSid, [{ role: 'user', text: 'hello world' }]);
const cps = checkpoint.listCheckpoints(cpSid);
assert(Array.isArray(cps) && cps.length >= 1, 'listCheckpoints returns the snapshot');
assert(cps[0].depth === 1, 'the checkpoint records the transcript depth');

// ── permissions ────────────────────────────────────────────────────────────
const askVerdict = permissions.evalPermission('Bash', { command: 'npm run build' }, { ask: ['Bash(npm run *)'] });
eq(askVerdict, 'ask', 'an explicit ask rule yields the documented "ask" verdict');
assert(['allow', 'deny', 'ask'].includes(askVerdict), 'evalPermission returns one of allow|deny|ask');
eq(permissions.evalPermission('Bash', { command: 'rm -rf /' }, { deny: ['Bash(rm *)'] }), 'deny', 'a deny rule wins');
eq(permissions.evalPermission('Bash', { command: 'ls' }, { allow: ['Bash(ls)'], ask: ['Bash(*)'] }), 'allow', 'an allow rule beats a later ask rule');

// ── summarize (dependency-free, injected backend) ──────────────────────────
const turns = [{ role: 'user', text: 'what is 2+2?' }, { role: 'assistant', text: 'four' }];
const local = await summarize.summarizeTranscript(turns);
assert(typeof local === 'string' && local.length > 0, 'summarizeTranscript falls back locally without a backend');
const stubbed = await summarize.summarizeTranscript(turns, { callModel: async () => 'a model summary' });
eq(stubbed, 'a model summary', 'summarizeTranscript uses the injected callModel');
const recap = await summarize.recapLine(turns, { callModel: async () => { throw new Error('boom'); } });
assert(typeof recap === 'string' && recap.length > 0, 'a failing backend falls back instead of throwing');

console.log('CLI support test passed');
console.log(`  home: ${HOME} (AEGISCODE_HOME honoured, real ~/.aegiscode untouched)`);
console.log('  history: append → readOwnSessions / readSessionTranscript / aggregateSessionUsage');
console.log(`  agents: ${roles.length} roles compose a prompt`);
