#!/usr/bin/env node
/**
 * The budget control, in both hosts.
 *
 * Aegis Cloud sizes each call server-side from `effort` (aegis1
 * services/pool_brain.py: the ladder is low/medium/high → 16384/32768/65536
 * tokens *total* across the worker fan-out + synthesis pass). Neither host
 * wired that up:
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
 * Static half: the renderer's control swap is real (functions exist, are
 * called, and the markup + CSS can actually hide a row). The behavioural half
 * lives in test/local-engine.test.mjs (effort travels, workers do not),
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

// ── 1. The renderer has one budget control, and it follows the class ────────
assert(/function updateBudgetControls\s*\(/.test(app), 'app.js defines updateBudgetControls()');
assert(
  /updateBudgetControls\s*\(\s*cls\s*\)/.test(app),
  'loadModels() applies the budget control for the class it just loaded'
);
assert(
  /updateBudgetControls\s*\(\s*els\.classSelect\.value\s*\)/.test(app),
  'the class-change handler applies it synchronously, without waiting for the model list'
);
assert(/function effortFor\s*\(/.test(app), 'app.js defines effortFor()');

// ── 2. The markup offers both, and neither is shown for the wrong class ─────
assert(/id="effort-row"/.test(html), 'index.html carries an #effort-row');
assert(/id="max-tokens-row"/.test(html), 'and the #max-tokens-row it replaces');
assert(
  /<div class="max-tokens-row" id="effort-row" hidden>/.test(html),
  '#effort-row starts hidden — it must not show before the class is known'
);
// The hide has to actually work: `.max-tokens-row { display: flex }` is an
// author rule and outranks the UA stylesheet's `[hidden] { display: none }`,
// so the attribute alone is a no-op. (test/hidden-toggle.test.mjs audits this
// too; asserted here as well because THIS feature depends on it directly —
// without the override both controls stay on screen at once.)
assert(
  /\.max-tokens-row\[hidden\][\s\S]{0,40}display:\s*none/.test(css),
  'a .max-tokens-row[hidden] override exists, so hiding the row really hides it'
);

// ── 3. The pooled class sends effort, and no token cap ──────────────────────
assert(
  /cls === AUTONOMOUS_CLASS\s*\?\s*undefined[\s\S]{0,80}parseInt\(els\.maxTokens\.value/.test(app),
  'the Aegis class sends no max_tokens of its own; other classes keep the dropdown'
);
assert(
  /const effort = effortFor\(cls\)/.test(app),
  'effort is resolved through effortFor(cls), not read straight off the control'
);
assert(
  !/const effort = autonomous \?/.test(app),
  'effort is no longer gated on the autonomous checkbox'
);
assert(
  /els\.autonomousEffort\.value === 'auto'|!== 'auto'/.test(app),
  "effortFor() treats the 'auto' row as 'no rung pinned'"
);
assert(
  /id="autonomous-effort"[\s\S]*?<option value="auto"/.test(html),
  "the effort control offers 'auto' — the default state has to be selectable"
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
  'Effort-budget tests passed: renderer control swap wired, pooled class sends effort not a cap, CLI effort on the wire.'
);
