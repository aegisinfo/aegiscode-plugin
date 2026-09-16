#!/usr/bin/env node
/**
 * Effort is the budget control, in both hosts — and nothing else is.
 *
 * Aegis Cloud sizes each call server-side from `effort` (aegis1
 * services/pool_brain.py: the ladder is low/medium/high → 16384/32768/65536
 * tokens *total* across the worker fan-out + synthesis pass). Neither host
 * wired that up at first:
 *
 *   - the desktop showed a "Max tokens" dropdown, read it on every send, and
 *     the server raised it to the ladder anyway — so the number on screen was
 *     never the budget the call ran on, and the one control that does size a
 *     pooled call (effort) was gated behind the "work autonomously" checkbox
 *     even though the fan-out is triggered by the model id and ran without it;
 *   - the CLI stored an effort level, drew it in the status line, and never put
 *     it on the wire, while its default was a *pin* on the top rung — the most
 *     expensive turn it could make, as the default, for every user.
 *
 * The dropdown is now removed rather than repaired, because the question it
 * asked — how long will the answer be? — has no answer before the answer
 * exists. Static half: the row is gone from markup and CSS, no dead element
 * handles or clamps survive in app.js, and send() derives its budget from the
 * rung through budgetFor() (whose value table is audited in test/budget.test.mjs
 * against the engine's own copy). The behavioural half lives in
 * test/local-engine.test.mjs (effort travels, workers do not),
 * test/client.test.mjs (no invented token ceiling) and test/cli-run.test.mjs
 * (a one-shot turn sends no cap unless asked).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);

const renderer = join(root, 'desktop', 'renderer');
const app = readFileSync(join(renderer, 'app.js'), 'utf8');
const html = readFileSync(join(renderer, 'index.html'), 'utf8');
const css = readFileSync(join(renderer, 'style.css'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ── 1. One budget control, and it follows the class ─────────────────────────
assert(/function updateBudgetControls\s*\(/.test(app), 'app.js defines updateBudgetControls()');
assert(
  /updateBudgetControls\s*\(\s*cls\s*\)/.test(app),
  'loadModels() applies the budget surface for the class it just loaded'
);
assert(
  /updateBudgetControls\s*\(\s*els\.classSelect\.value\s*\)/.test(app),
  'the class-change handler repaints it synchronously, without waiting for the model list'
);
assert(/function effortFor\s*\(/.test(app), 'app.js defines effortFor()');
assert(
  !/effortFor\(\s*cls/.test(app),
  'effortFor() takes no class: every class sizes from the rung now, not just the pooled one'
);
assert(/id="budget-hint"/.test(html), 'the markup carries the line that states what the rung buys');

// ── 2. The max-tokens control is gone from every layer ─────────────────────
assert(!/max-tokens-row/.test(html), 'index.html no longer declares a max-tokens row');
assert(!/max-tokens-row/.test(css), 'style.css no longer styles one');
assert(!/id="max-tokens-row"/.test(html), 'and no element keeps the id');
assert(
  !/els\.maxTokens|applyMaxTokensClamp|maxTokensAdaptive|MAX_TOKENS_KEY|MAX_TOKENS_ADAPTIVE_KEY/.test(app),
  'no dead element handle, clamp or storage key survives in app.js'
);
assert(
  !/parseInt\(els\.maxTokens/.test(app) && !/\|\|\s*4096/.test(app),
  'send() no longer reads a dropdown value or invents a 4096 fallback'
);
assert(
  !/maxTokensCeiling\(meta\)/.test(app) || /maxTokensCeiling\(modelMeta\.get\(/.test(app),
  'the ceiling is read from model metadata for display, not from a control'
);

// The row that remains is never hidden: with nothing to swap it for, a `hidden`
// attribute (or the old class-swap override in CSS) would be a latent bug.
assert(/id="effort-row"/.test(html), 'index.html carries an #effort-row');
assert(
  !/id="effort-row"[^>]*hidden/.test(html),
  '#effort-row is always on screen — there is no second control to show instead'
);
assert(
  /<select id="effort-select">[\s\S]*?<option value="auto"/.test(html),
  "the effort control offers 'auto' — the default state has to be selectable"
);
assert(/\.budget-row\s*\{[\s\S]{0,60}display:\s*flex/.test(css), '.budget-row is laid out like the row it replaced');

// budget.js has to be loaded BEFORE app.js: app.js reads budgetFor /
// EFFORT_TOKEN_BUDGET / DEEPSEEK_REASONING_MODEL_RE off the global scope those
// classic scripts share, and a later <script> would leave all three undefined —
// a ReferenceError inside updateBudgetControls, i.e. a dead UI on model change.
assert(/<script src="budget\.js"><\/script>/.test(html), 'index.html loads budget.js');
assert(
  html.indexOf('src="budget.js"') < html.indexOf('src="app.js"'),
  'budget.js loads before app.js'
);

// ── 3. send() states the budget it derived, and no cap of its own ──────────
assert(
  /const maxTokens = budgetFor\(cls, model, undefined, effort\)/.test(app),
  'send() derives the budget from the rung through budgetFor()'
);
assert(
  /const effort = effortFor\(\)/.test(app),
  'effort is resolved through effortFor(), not read straight off the control'
);
assert(
  !/const effort = autonomous \?/.test(app),
  'effort is not gated on the autonomous checkbox'
);
assert(
  /els\.effortSelect\.value === 'auto'|value !== 'auto'/.test(app),
  "effortFor() treats the 'auto' row as 'no rung pinned'"
);
// An empty Workers field is the client saying "size the fan-out yourself"
// (parse_brain_request's auto path). A hardcoded value here made every turn a
// fixed fan-out no matter how small the ask was.
assert(
  !/id="autonomous-workers"[^>]*value=/.test(html),
  'the workers field carries no fixed default value'
);

// ── 4. The CLI's effort reaches the wire, and defaults to auto ─────────────
const cliApp = readFileSync(join(root, 'cli', 'src', 'app.js'), 'utf8');
const cliConfig = readFileSync(join(root, 'cli', 'src', 'config.js'), 'utf8');
const { EFFORT_LEVELS } = require(join(root, 'cli', 'src', 'commands.js'));
const overlays = require(join(root, 'cli', 'src', 'overlays.js'));

assert(
  /effort: commandCtx\.effort \|\| undefined/.test(cliApp),
  'the CLI turn puts its effort on the request'
);
assert(
  /effort: null/.test(cliConfig),
  'the CLI config defaults to no effort pin (auto), not the top rung'
);
assert(
  !/effort: 'high'/.test(cliConfig) && !/effort: 'high'/.test(cliApp),
  "no host still defaults the budget to 'high'"
);
assert(Array.isArray(EFFORT_LEVELS) && EFFORT_LEVELS[0] === null,
  `the CLI effort list leads with auto (got ${JSON.stringify(EFFORT_LEVELS)})`);
assert(
  EFFORT_LEVELS.includes('high') && EFFORT_LEVELS.includes('low') && EFFORT_LEVELS.includes('medium'),
  'and still lists every rung'
);
// One table for the picker and the values it stores: the flag handler used to
// re-declare the level names while the overlay drew its own rows.
assert(
  Array.isArray(overlays.EFFORT_VALUES) && overlays.EFFORT_VALUES.length === overlays.EFFORT_LEVELS.length,
  'the picker rows and the values a selection stores come from one table'
);
const chatflow = readFileSync(join(root, 'cli', 'src', 'chatflow.js'), 'utf8');
assert(
  /overlays\.EFFORT_VALUES\[overlay\.sel/.test(chatflow),
  'chatflow resolves an effort selection through that shared table'
);
assert(
  !/const levels = \['low', 'medium', 'high'\]/.test(chatflow),
  'chatflow no longer keeps its own copy of the level names'
);

console.log(
  'Effort-budget tests passed: the max-tokens control is gone, effort sizes every class, and CLI effort is on the wire.'
);
