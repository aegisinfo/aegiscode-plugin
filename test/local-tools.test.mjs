#!/usr/bin/env node
/**
 * Unit tests for the desktop agent loop (client half of aegiscodex-dev's tool
 * calling): desktop/lib/local/tools.js, the message builders in
 * providers.js, the loop in engine.js, and client/aegis.js's buildMessages.
 *
 * These are the tests that would have caught the three defects this port
 * fixed:
 *   1. providers.openAIMessages/buildAnthropicMessages replaced the whole
 *      message list whenever `prompt` was set — dropping the system prompt and
 *      any tool traffic.
 *   2. client/aegis.js buildMessages returned a non-empty history verbatim,
 *      dropping `system` on the Aegis transport alone.
 *   3. engine.chat sent no system prompt and no tools, so no model could ever
 *      touch the machine or know which machine it was on.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tools = require('../desktop/lib/local/tools.js');
const prompt = require('../desktop/lib/local/prompt.js');
const providers = require('../desktop/lib/local/providers.js');
const { createLocalEngine, MAX_TOOL_ROUNDS, extractToolCalls } = require('../desktop/lib/local/engine.js');
const { ShellSession } = require('../desktop/lib/local/shell.js');
const { createClient } = require('../client/aegis.js');

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`ASSERT FAILED: ${msg}`);
  } else {
    console.log(`  ok  ${msg}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-loop-'));
const file = path.join(tmp, 'nested', 'hello.txt');

// ── 1. Schemas ──────────────────────────────────────────────────────────────
console.log('tools.js — schemas');

const openai = tools.toolsFor('openai');
const anthropicSchemas = tools.toolsFor('anthropic');
const names = tools.toolNames();
assert(names.join(',') === 'readFile,writeFile,editFile,listDir,glob,grep,exec,task', `tool names: ${names.join(',')}`);
assert(openai.length === 8, `openai advertises 8 tools, got ${openai.length}`);
assert(
  openai.every((t) => t.type === 'function' && t.function && t.function.parameters.type === 'object'),
  'openai tools carry {type:function, function:{parameters}}'
);
assert(
  anthropicSchemas.every((t) => t.name && t.input_schema && t.input_schema.type === 'object'),
  'anthropic tools carry {name, input_schema}'
);
assert(!('type' in anthropicSchemas[0]) && !('function' in anthropicSchemas[0]), 'anthropic tools are not OpenAI-shaped');
assert(
  JSON.stringify(tools.openaiToAnthropicTools(openai)) === JSON.stringify(anthropicSchemas),
  'openaiToAnthropicTools is the exact projection (no schema drift)'
);
assert(
  JSON.stringify(tools.anthropicToOpenaiTools(anthropicSchemas)) === JSON.stringify(openai),
  'anthropicToOpenaiTools round-trips'
);

// ── 2. Executors ────────────────────────────────────────────────────────────
console.log('tools.js — executors');

const wrote = await tools.executeTool('writeFile', { file_path: file, content: 'alpha\nbeta\n' });
assert(wrote.ok && fs.readFileSync(file, 'utf8') === 'alpha\nbeta\n', 'writeFile creates parents and writes');

const read = await tools.executeTool('readFile', { file_path: file });
assert(read.ok && read.output.includes('1| alpha'), `readFile line-numbers: ${JSON.stringify(read.output)}`);

const listed = await tools.executeTool('listDir', { path: tmp });
assert(listed.ok && listed.output.includes('nested/'), 'listDir marks directories with a slash');

const globbed = await tools.executeTool('glob', { pattern: '**/*.txt', path: tmp });
assert(globbed.ok && globbed.output.includes('nested/hello.txt'), `glob finds nested files: ${globbed.output}`);

const edited = await tools.executeTool('editFile', { file_path: file, old_string: 'alpha', new_string: 'ALPHA' });
assert(edited.ok && fs.readFileSync(file, 'utf8') === 'ALPHA\nbeta\n', `editFile replaces the exact string: ${JSON.stringify(edited)}`);

const editMissing = await tools.executeTool('editFile', { file_path: file, old_string: 'not-there', new_string: 'x' });
assert(!editMissing.ok && /not found/.test(editMissing.error), 'editFile fails loudly when old_string is absent');

const grepped = await tools.executeTool('grep', { pattern: '^ALPHA$', path: tmp });
assert(grepped.ok && /hello\.txt:1: ALPHA/.test(grepped.output), `grep finds the match with file:line: ${grepped.output}`);

const ran = await tools.executeTool('exec', {
  command: `"${process.execPath}" -e "process.stdout.write('from-exec')"`,
  cwd: tmp,
});
assert(ran.ok && ran.output === 'from-exec', `exec captures stdout: ${JSON.stringify(ran.output)}`);

const bad = await tools.executeTool('exec', { command: 'exit 3' });
assert(!bad.ok && /exit 3/.test(bad.error), `exec reports a non-zero exit: ${bad.error}`);

const unknown = await tools.executeTool('nope', {});
assert(!unknown.ok && /unknown tool/.test(unknown.error), 'unknown tool is an error, never a throw');

const missing = await tools.executeTool('readFile', {});
assert(!missing.ok, 'a missing argument is an error, never a throw');

assert(
  tools.toolResultText({ ok: false, error: 'boom' }) === 'error: boom' &&
    tools.toolResultText({ ok: true, output: 'hi' }) === 'hi',
  'toolResultText feeds `error: …` back like the CLI does'
);

// ── 2b. Persistent shell (exec via ctx.getShell) ────────────────────────────
console.log('shell.js — persistent session');

{
  const shell = new ShellSession({ cwd: tmp });
  const ctx = { getShell: () => shell };
  await tools.executeTool('exec', { command: 'cd nested' }, ctx);
  const pwd = await tools.executeTool('exec', { command: 'pwd' }, ctx);
  assert(pwd.ok && pwd.output.endsWith('nested'), `cd carries to the next exec call: ${JSON.stringify(pwd)}`);
  await tools.executeTool('exec', { command: 'export AEGIS_TEST_VAR=carried' }, ctx);
  const echoed = await tools.executeTool('exec', { command: 'echo $AEGIS_TEST_VAR' }, ctx);
  assert(echoed.ok && echoed.output.trim() === 'carried', `exported env carries to the next exec call: ${JSON.stringify(echoed)}`);
  shell.dispose();

  // Without ctx.getShell, exec falls back to a one-shot process — no session,
  // no persisted state (the pre-port behavior, still exercised above).
  const noCtx = await tools.executeTool('exec', { command: 'pwd' }, {});
  assert(noCtx.ok, 'exec with no ctx.getShell still works (one-shot fallback)');
}

// ── 3. Message builders (defect 1) ──────────────────────────────────────────
console.log('providers.js — message builders');

const keepSystem = providers.openAIMessages([{ role: 'user', content: 'hi' }], 'sys', null);
assert(keepSystem[0].role === 'system' && keepSystem[0].content === 'sys', 'OpenAI system first');

const both = providers.openAIMessages([{ role: 'user', content: 'first' }], 'sys', 'second');
assert(
  both.length === 3 && both[1].content === 'first' && both[2].content === 'second',
  'OpenAI keeps history AND appends the prompt (the regression)'
);
assert(both[0].role === 'system', 'OpenAI keeps the system turn when a prompt is given (the regression)');

const dedup = providers.openAIMessages([{ role: 'user', content: 'same' }], null, 'same');
assert(dedup.length === 1, 'an identical trailing prompt is not duplicated');

const anthropic = providers.buildAnthropicMessages([{ role: 'user', content: 'first' }], 'second');
assert(
  anthropic.length === 2 && anthropic[1].content === 'second',
  'Anthropic keeps history AND appends the prompt (the regression)'
);
assert(
  !anthropic.some((m) => m.role === 'system'),
  'Anthropic never carries a system turn (it is a top-level field)'
);

const toolThread = providers.normalizeMessages([
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'readFile', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'result' },
]);
assert(
  toolThread[0].tool_calls && toolThread[1].tool_call_id === 'c1' && toolThread[1].role === 'tool',
  'tool_calls and tool_call_id survive normalisation verbatim'
);

// ── 4. The loop (defect 3) ──────────────────────────────────────────────────
console.log('engine.js — agent loop');

function fakeEngine(script) {
  const seen = [];
  let i = 0;
  const providersFake = {
    async openaiCompatible(args) {
      seen.push(args);
      return script[Math.min(i++, script.length - 1)];
    },
    async anthropicMessages(args) {
      seen.push(args);
      return script[Math.min(i++, script.length - 1)];
    },
  };
  const engine = createLocalEngine({
    aegis: { apiKey: 'k', async listModels() { return { models: [] }; }, async chatCompletion(args) { seen.push(args); return script[Math.min(i++, script.length - 1)]; } },
    settings: { get: () => ({ baseURL: 'http://local', configured: true }), rawKey: () => 'k' },
    ollama: { async probe() { return { running: true }; }, async listTags() { return []; }, async chat(args) { seen.push(args); return script[Math.min(i++, script.length - 1)]; } },
    providers: providersFake,
  });
  return { engine, seen };
}

const target = path.join(tmp, 'loop.txt');
fs.writeFileSync(target, 'loop-content\n');

const callOnce = {
  model: 'm',
  choices: [{ message: { content: '' } }],
  toolCalls: [{ id: 'call_1', name: 'readFile', args: { file_path: target } }],
};
const final = { model: 'm', choices: [{ message: { content: 'done reading' } }] };

{
  const { engine, seen } = fakeEngine([callOnce, final]);
  const res = await engine.chat(
    { class: 'openai-compat', prompt: 'read it', model: 'gpt-x' },
    () => {}
  );
  assert(res.choices[0].message.content === 'done reading', 'the loop returns the final text answer');
  assert(seen.length === 2, `the loop made 2 rounds, got ${seen.length}`);
  assert(Array.isArray(seen[0].tools) && seen[0].tools.length === 8, 'round 1 advertised the 8 tool schemas');
  assert(
    typeof seen[0].system === 'string' && seen[0].system.includes('Aegiscodex') && seen[0].system.includes('# Environment'),
    'round 1 carried the persona + environment preamble (no more "which OS are you on?")'
  );
  assert(/platform:/.test(seen[0].system), 'the preamble names the platform');
  const second = seen[1].messages;
  const assistant = second.find((m) => m.role === 'assistant' && m.tool_calls);
  const result = second.find((m) => m.role === 'tool');
  assert(assistant && assistant.tool_calls[0].function.name === 'readFile', 'the assistant tool_calls turn is threaded back');
  assert(result && result.tool_call_id === 'call_1', 'the tool result carries its tool_call_id');
  assert(result.content.includes('loop-content'), `the tool actually ran and fed output back: ${JSON.stringify(result.content)}`);
  assert(seen[1].prompt === '', 'round 2 sends history, not a duplicate prompt');
  assert(
    seen[1].messages.length === 3 &&
      seen[1].messages[0].role === 'user' &&
      seen[1].messages[0].content === 'read it',
    'round 2 keeps the original user question in the history'
  );
}

{
  const { engine } = fakeEngine([callOnce]);
  const forever = { ...callOnce, toolCalls: [{ id: 'x', name: 'listDir', args: { path: tmp } }] };
  let rounds = 0;
  const e = createLocalEngine({
    aegis: { apiKey: 'k', async listModels() { return { models: [] }; }, async chatCompletion() { return {}; } },
    settings: { get: () => ({ baseURL: 'http://local', configured: true }), rawKey: () => 'k' },
    ollama: { async probe() { return { running: false }; }, async listTags() { return []; }, async chat() { return {}; } },
    providers: { async openaiCompatible() { rounds++; return forever; }, async anthropicMessages() { return {}; } },
  });
  const res = await e.chat({ class: 'openai-compat', prompt: 'go', model: 'm' }, () => {});
  assert(rounds === MAX_TOOL_ROUNDS + 1, `the round cap bounds the loop (${rounds} rounds vs cap ${MAX_TOOL_ROUNDS})`);
  assert(res && res.choices, 'hitting the cap still returns the last response instead of throwing');
  void engine;
}

{
  const { engine, seen } = fakeEngine([final]);
  await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'm', tools: false }, () => {});
  assert(seen[0].tools === undefined, '`tools: false` restores the single-shot turn (no schemas)');
  assert(typeof seen[0].system === 'string' && seen[0].system.length > 0, 'the persona is sent even with tools off');
}

{
  // Anthropic class must be handed Anthropic-shaped schemas, not OpenAI's.
  const { engine, seen } = fakeEngine([callOnce, final]);
  await engine.chat({ class: 'anthropic', prompt: 'read', model: 'claude-x' }, () => {});
  assert(
    seen[0].tools.every((t) => t.input_schema && !t.function),
    'the anthropic transport is handed {name, input_schema} schemas only'
  );
}

{
  // An old Ollama that 400s on `tools` must not break local chat.
  const seen = [];
  let n = 0;
  const e = createLocalEngine({
    aegis: { apiKey: '', async listModels() { return { models: [] }; }, async chatCompletion() { return {}; } },
    settings: { get: () => ({}), rawKey: () => '' },
    ollama: {
      async probe() { return { running: true }; },
      async listTags() { return []; },
      async chat(args) {
        seen.push(args);
        if (args.tools && args.tools.length) {
          const err = new Error('upstream 400: unknown field tools');
          err.status = 400;
          throw err;
        }
        return { model: args.model, choices: [{ message: { content: 'local ok' } }], n: n++ };
      },
    },
    providers: { async openaiCompatible() { return {}; }, async anthropicMessages() { return {}; } },
  });
  const res = await e.chat({ class: 'ollama', prompt: 'hi', model: 'llama3' }, () => {});
  assert(seen.length === 2 && seen[0].tools.length === 8 && !seen[1].tools, 'a tool-rejecting Ollama is retried without tools');
  assert(res.choices[0].message.content === 'local ok', 'the Ollama retry returns the answer');
}

{
  const res = extractToolCalls({ choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'glob', arguments: '{"pattern":"*.js"}' } }] } }] });
  assert(res.length === 1 && res[0].name === 'glob' && res[0].args.pattern === '*.js', 'extractToolCalls reads the provider-native OpenAI shape');
  assert(extractToolCalls({ choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'glob', arguments: 'not json' } }] } }] })[0].args.pattern === undefined, 'malformed arguments degrade to {} instead of throwing');
  assert(extractToolCalls(null).length === 0, 'a null response yields no calls');
}

// ── 4b. Task tool: subagent delegation ──────────────────────────────────────
console.log('engine.js — task subagent');

{
  // Round 1: the top-level turn calls task. Round 2: the nested subagent turn
  // (its own chat() call) answers with text. Round 3: the top-level turn sees
  // the tool result and gives its own final answer.
  const taskCall = {
    model: 'm',
    choices: [{ message: { content: '' } }],
    toolCalls: [{ id: 'call_1', name: 'task', args: { description: 'scan', subagent_type: 'scanner', prompt: 'scan for secrets' } }],
  };
  const subagentFinal = { model: 'm', choices: [{ message: { content: 'no secrets found' } }] };
  const topFinal = { model: 'm', choices: [{ message: { content: 'done — subagent reports no secrets found' } }] };

  const { engine, seen } = fakeEngine([taskCall, subagentFinal, topFinal]);
  const res = await engine.chat({ class: 'openai-compat', prompt: 'audit this repo', model: 'gpt-x' }, () => {});
  assert(res.choices[0].message.content === 'done — subagent reports no secrets found', 'the top-level turn answers after the subagent returns');
  assert(seen.length === 3, `task delegation made 3 rounds (top, subagent, top again), got ${seen.length}`);
  assert(seen[1].system.includes('Vulnerability Scanner') || seen[1].system.includes('Security Vulnerability Scanner'), `the subagent got the scanner preset system prompt: ${seen[1].system.slice(0, 80)}`);
  assert(seen[1].prompt === 'scan for secrets', 'the subagent turn carries the task prompt verbatim');
  const toolResult = seen[2].messages.find((m) => m.role === 'tool');
  assert(toolResult && toolResult.content === 'no secrets found', `the subagent's answer is fed back as the tool result: ${JSON.stringify(toolResult)}`);
}

{
  // A subagent's own turn (depth 1) still offers task (so it can delegate
  // further), but a depth-4 subagent must not — the schema drops it.
  const deep = { model: 'm', choices: [{ message: { content: 'leaf answer' } }] };
  const { engine, seen } = fakeEngine([deep]);
  await engine.chat({ class: 'openai-compat', prompt: 'x', model: 'm', depth: 4 }, () => {});
  assert(!seen[0].tools.some((t) => t.function.name === 'task'), 'a depth-4 turn is not offered the task tool (subagent depth cap)');
}

{
  // Task with neither prompt nor description is a tool error, not a throw.
  const script = [
    { model: 'm', choices: [{ message: { content: '' } }], toolCalls: [{ id: 'c1', name: 'task', args: {} }] },
    { model: 'm', choices: [{ message: { content: 'handled the empty task' } }] },
  ];
  const { engine, seen } = fakeEngine(script);
  const res = await engine.chat({ class: 'openai-compat', prompt: 'go', model: 'm' }, () => {});
  assert(res.choices[0].message.content === 'handled the empty task', 'an empty task call resolves as a tool error, not a crash');
  assert(seen.length === 2, 'an empty task never spawns a nested chat() round');
}

// ── 5. prompt.js ────────────────────────────────────────────────────────────
console.log('prompt.js');
const sys = prompt.buildSystemPrompt({ platform: 'linux', homedir: '/home/x', roots: ['/home/x/repo'] });
assert(sys.includes('Aegiscodex') && sys.includes('exec'), 'the persona names the assistant and its tools');
assert(sys.includes('/home/x/repo') && sys.includes('platform: linux'), 'the preamble lists env facts and repo roots');
assert(prompt.buildSystemPrompt({}).includes('Aegiscodex'), 'the persona is never empty, even with no env');

// ── 6. client/aegis.js buildMessages (defect 2) ─────────────────────────────
console.log('client/aegis.js — buildMessages');

{
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ model: 'm', choices: [{ message: { content: 'ok' } }] }),
      text: async () => '{}',
    };
  };
  try {
    const aegis = createClient({ apiKey: 'k', apiBase: 'http://x' });
    await aegis.chatCompletion({
      messages: [{ role: 'user', content: 'history turn' }],
      system: 'persona',
      prompt: 'live prompt',
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  const sent = bodies[0].messages;
  assert(sent[0].role === 'system' && sent[0].content === 'persona', 'aegis keeps the system turn with a non-empty history (the regression)');
  assert(sent.some((m) => m.content === 'history turn'), 'aegis keeps the history');
  assert(sent[sent.length - 1].content === 'live prompt', 'aegis appends the prompt');
}

{
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      text: async () => '{}',
    };
  };
  try {
    const aegis = createClient({ apiKey: 'k', apiBase: 'http://x' });
    await aegis.chatCompletion({ prompt: 'single shot' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert(
    bodies[0].messages.length === 1 && bodies[0].messages[0].role === 'user',
    'the single-shot shorthand still yields exactly one user turn'
  );
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\nlocal-tools test FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log('\nLocal tool-calling test passed: schemas, executors, message builders, agent loop, round cap.');
