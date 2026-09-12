#!/usr/bin/env node
/** Unit tests for desktop/renderer/vendor/aegis-highlight.js (fenced-code syntax
 *  highlighting for the markdown rendering pipeline — see
 *  desktop/renderer/markdown.js). No DOM required: the highlighter is a
 *  pure string -> string tokenizer. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { highlight, resolve, escapeHtml } = require('../desktop/renderer/vendor/aegis-highlight.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// Language aliasing.
assert(resolve('js') === 'js', 'js resolves to the js grammar');
assert(resolve('JavaScript') === 'js', 'aliases are case-insensitive');
assert(resolve('ts') === 'js', 'TypeScript shares the js grammar');
assert(resolve('py') === 'python', 'py alias resolves to python');
assert(resolve('yaml') === null, 'an unsupported language resolves to null');
assert(resolve('') === null, 'an empty language resolves to null');
assert(resolve(null) === null, 'a null language resolves to null');

// escapeHtml never lets markup through.
assert(escapeHtml('<b>&"</b>') === '&lt;b&gt;&amp;"&lt;/b&gt;', 'escapeHtml escapes < > &');

// JS tokenization: keywords, strings (all three quote styles), comments,
// numbers, and a called identifier as "function".
{
  const out = highlight("const x = 1; // note\nfoo('a', `b${x}`);", 'js');
  assert(out.includes('<span class="tok-keyword">const</span>'), 'const is tokenized as a keyword');
  assert(out.includes('<span class="tok-number">1</span>'), '1 is tokenized as a number');
  assert(out.includes('<span class="tok-comment">// note</span>'), 'line comment is tokenized');
  assert(out.includes('<span class="tok-function">foo</span>'), 'a called identifier is tokenized as a function');
  assert(out.includes('<span class="tok-string">\'a\'</span>'), 'single-quoted string is tokenized');
  assert(out.includes('<span class="tok-string">`b${x}`</span>'), 'template-literal string is tokenized whole');
}

// Python tokenization.
{
  const out = highlight('def foo(x):\n    # hi\n    return x', 'python');
  assert(out.includes('<span class="tok-keyword">def</span>'), 'def is a keyword');
  assert(out.includes('<span class="tok-comment"># hi</span>'), '# comment is tokenized');
  assert(out.includes('<span class="tok-function">foo</span>'), 'foo is tokenized as a function');
}

// JSON tokenization.
{
  const out = highlight('{"a": 1, "b": true}', 'json');
  assert(out.includes('<span class="tok-string">"a"</span>'), 'JSON key is tokenized as a string');
  assert(out.includes('<span class="tok-keyword">true</span>'), 'true is tokenized as a keyword');
}

// Unknown/unsupported language: plain escaped text, no spans at all.
{
  const out = highlight('<script>alert(1)</script>', 'brainfuck');
  assert(!out.includes('<span'), 'unsupported languages get no highlight spans');
  assert(out === '&lt;script&gt;alert(1)&lt;/script&gt;', 'unsupported languages are still HTML-escaped');
}

// Code containing markup must never produce unescaped HTML, even inside a
// supported grammar (the highlighter must escape gaps AND matched tokens).
{
  const out = highlight('const s = "<img src=x onerror=alert(1)>";', 'js');
  assert(!/<img/.test(out), 'raw <img> markup never survives highlighting');
  assert(out.includes('&lt;img'), 'the angle bracket is escaped');
}

console.log('aegis-highlight tests passed');
