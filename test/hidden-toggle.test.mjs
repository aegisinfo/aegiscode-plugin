#!/usr/bin/env node
/**
 * Hidden-toggle test — author `display` rules silently defeating `hidden`.
 *
 * The bug class this locks down has now shipped four times in this renderer:
 * an element sets `display: flex` in style.css, which is an *author* origin
 * declaration. The UA stylesheet's `[hidden] { display: none }` lives in the
 * *UA* origin, so every author declaration wins against it no matter how low
 * its specificity. Setting `el.hidden = true` from JS therefore changes an
 * attribute that has no rendering effect at all, and:
 *
 *   - the element is stuck visible from first paint even though index.html
 *     ships it `hidden`, and
 *   - the button that is supposed to dismiss it looks completely dead,
 *     because it only sets `.hidden = true`.
 *
 * That is exactly how the update banner behaved: `#update-later-btn` "did
 * nothing" and the bar was on screen permanently. The fix is an explicit
 * `SELECTOR[hidden] { display: none }` override, which the codebase already
 * carries for `.autonomous-controls`, `.flow-toggle` and `#autonomous-toggle-wrap`
 * — with comments calling out the gotcha — and was simply missed for the banner.
 *
 * This test derives the element set from the real sources instead of hardcoding
 * it: every element that index.html marks `hidden`, plus every element app.js
 * toggles via `els.X.hidden = …` (resolved through the ELEMENT_IDS map). For
 * each one it finds author rules that target it and set a non-`none` display,
 * then requires a matching `[hidden]` override. That is what catches instance
 * number five rather than waiting for a user to report a dead button again.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(__dirname, '..', 'desktop', 'renderer');
const CSS_SRC = readFileSync(join(RENDERER, 'style.css'), 'utf8');
const HTML_SRC = readFileSync(join(RENDERER, 'index.html'), 'utf8');
const APP_SRC = readFileSync(join(RENDERER, 'app.js'), 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error(`ASSERT FAILED: ${msg}`);
  }
}

/** Strip CSS comments so prose mentioning `display: flex` is never parsed. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

const CSS = stripComments(CSS_SRC);

/**
 * Flat rule parse. style.css has no @media blocks (asserted below), so every
 * `selector { body }` pair is a top-level rule and no nesting model is needed.
 */
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const body = m[2];
    const dm = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(body);
    return {
      selector,
      display: dm ? dm[1].trim() : null,
      hiddenQualified: /\[hidden\]/.test(selector),
    };
  })
  .filter((r) => r.selector && !r.selector.startsWith('@'));

/** Does this selector contain `#id` or `.class` as a whole token? */
function selectorTargets(selector, { id, classes }) {
  const hasToken = (sel, token) => {
    let from = 0;
    for (;;) {
      const at = sel.indexOf(token, from);
      if (at === -1) return false;
      const after = sel[at + token.length];
      // `-` and `_` continue an identifier, so .update-banner-actions must not
      // be read as targeting .update-banner.
      if (!after || !/[A-Za-z0-9_-]/.test(after)) return true;
      from = at + 1;
    }
  };
  return selector
    .split(',')
    .some((part) => (id && hasToken(part.trim(), `#${id}`)) || classes.some((c) => hasToken(part.trim(), `.${c}`)));
}

/** id/class pairs for an HTML tag's attribute string. */
function attrsOf(tagAttrs) {
  const id = /\bid\s*=\s*"([^"]+)"/.exec(tagAttrs);
  const cls = /\bclass\s*=\s*"([^"]+)"/.exec(tagAttrs);
  return {
    id: id ? id[1] : null,
    classes: cls ? cls[1].trim().split(/\s+/) : [],
  };
}

function main() {
  assert(!/@media/.test(CSS), 'style.css grew an @media block — the flat rule parse in this test needs updating');

  // ---------------------------------------------------- elements to check
  const elements = new Map(); // id -> {id, classes}

  // 1. Everything index.html ships `hidden`.
  for (const m of HTML_SRC.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const attrs = m[2];
    if (!/(^|\s)hidden(\s|$|=)/.test(attrs)) continue;
    const { id, classes } = attrsOf(attrs);
    if (id) elements.set(id, { id, classes });
  }
  assert(elements.size > 0, 'found no hidden elements in index.html — the markup regex is stale');

  // 2. Everything app.js toggles through `els.X.hidden = …`.
  const idsBlock = APP_SRC.slice(APP_SRC.indexOf('const ELEMENT_IDS'), APP_SRC.indexOf('const els = {}'));
  const keyToId = new Map([...idsBlock.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
  const toggledKeys = [...APP_SRC.matchAll(/els\.(\w+)\.hidden\s*=/g)].map((m) => m[1]);
  assert(toggledKeys.length > 0, 'found no els.X.hidden toggles in app.js — the toggle regex is stale');

  for (const key of toggledKeys) {
    const id = keyToId.get(key);
    assert(id, `els.${key}.hidden is toggled but ${key} is not in ELEMENT_IDS — cannot resolve it to an element`);
    if (!id) continue;
    if (!elements.has(id)) {
      const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`, 'i').exec(HTML_SRC);
      elements.set(id, tag ? { id, ...attrsOf(tag[0].slice(1, -1)) } : { id, classes: [] });
    }
  }

  // ------------------------------------------------- the banner regression
  const bannerRules = RULES.filter((r) => selectorTargets(r.selector, { id: 'update-banner', classes: ['update-banner'] }));
  assert(
    bannerRules.some((r) => r.hiddenQualified && r.display === 'none'),
    '.update-banner has no `[hidden] { display: none }` override — the update banner cannot be dismissed ' +
      'and "Later" silently does nothing (the reported defect)',
  );

  // ------------------------------------------------- every toggled element
  let checked = 0;
  for (const el of elements.values()) {
    const conflicting = RULES.filter(
      (r) => !r.hiddenQualified && r.display && r.display !== 'none' && selectorTargets(r.selector, el),
    );
    if (conflicting.length === 0) continue; // UA [hidden] governs — nothing to fix
    checked += 1;
    const override = RULES.some(
      (r) => r.hiddenQualified && r.display === 'none' && selectorTargets(r.selector, el),
    );
    const where = conflicting.map((r) => `${r.selector} { display: ${r.display} }`).join('; ');
    assert(
      override,
      `#${el.id} is toggled with .hidden but ${where} is an author display rule that outranks the UA ` +
        '[hidden] { display: none } — add a `[hidden] { display: none }` override',
    );
  }

  assert(checked >= 2, `expected to audit several display-conflicting hidden elements, only saw ${checked}`);

  console.log(
    `Hidden-toggle test passed: audited ${elements.size} hidden/toggled elements, ` +
      `${checked} with author display rules; every one has a [hidden] override.`,
  );
}

try {
  main();
} catch (err) {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
if (failures > 0) {
  console.error(`\n${failures} hidden-toggle assertion(s) failed.`);
  process.exit(1);
}
