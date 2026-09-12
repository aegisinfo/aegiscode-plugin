#!/usr/bin/env node
/** Unit tests for the DOM-free half of desktop/renderer/markdown.js — the
 *  pure helpers backing renderInto()'s link rewiring and code-block
 *  language detection. renderInto() itself needs a real DOM (marked +
 *  DOMPurify self-initialize against `window`) so it is exercised instead
 *  by the Electron-backed render-pipeline check the desktop-shell test
 *  documents, not here. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isExternalHref, langFromClassName } = require('../desktop/renderer/markdown.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// Only http(s) links are treated as externally-openable — this is what
// gates whether renderer/markdown.js wires a click handler onto an <a> at
// all (main.js isSafeExternalUrl is the actual security boundary before
// electron.shell.openExternal runs; this is the renderer-side mirror).
assert(isExternalHref('https://example.com') === true, 'https is external');
assert(isExternalHref('http://example.com') === true, 'http is external');
assert(isExternalHref('javascript:alert(1)') === false, 'javascript: is not external');
assert(isExternalHref('file:///etc/passwd') === false, 'file: is not external');
assert(isExternalHref('data:text/html,<script>1</script>') === false, 'data: is not external');
assert(isExternalHref('#section') === false, 'an in-page anchor is not external');
assert(isExternalHref('') === false, 'an empty href is not external');
assert(isExternalHref(null) === false, 'a null href is not external');
assert(isExternalHref('mailto:a@b.com') === false, 'mailto is not "external" (no browser to hand it to)');

// Fenced-code language extraction from marked's `language-xxx` class.
assert(langFromClassName('language-js') === 'js', 'extracts the language suffix');
assert(langFromClassName('language-python') === 'python', 'extracts a longer language name');
assert(langFromClassName('') === '', 'no class -> empty language');
assert(langFromClassName(undefined) === '', 'undefined class -> empty language');
assert(langFromClassName('some-other-class') === '', 'a non-language class -> empty language');

console.log('markdown helper tests passed');
