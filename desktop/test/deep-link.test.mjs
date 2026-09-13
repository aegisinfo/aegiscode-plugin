#!/usr/bin/env node
/**
 * Unit tests for desktop/lib/deep-link.js — pure aegis:// URL/argv parsing,
 * no Electron binary needed (matches the ../test/*.test.mjs convention used
 * elsewhere in this repo for main.js's other pure modules).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PROTOCOL,
  isDeepLinkUrl,
  parseDeepLinkUrl,
  extractDeepLinkUrl,
  parseDeepLinkArgv,
} = require('../lib/deep-link.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

assert(PROTOCOL === 'aegis', 'protocol constant is "aegis"');

// isDeepLinkUrl
assert(isDeepLinkUrl('aegis://open?session=abc'), 'recognises the aegis:// scheme');
assert(isDeepLinkUrl('AEGIS://open?session=abc'), 'scheme match is case-insensitive');
assert(!isDeepLinkUrl('https://example.com'), 'rejects an unrelated scheme');
assert(!isDeepLinkUrl(''), 'rejects an empty string');
assert(!isDeepLinkUrl(null), 'rejects non-string input without throwing');
assert(!isDeepLinkUrl(42), 'rejects a number without throwing');

// parseDeepLinkUrl — open
{
  const parsed = parseDeepLinkUrl('aegis://open?session=sess-123');
  assert(parsed && parsed.action === 'open', 'open action recognised');
  assert(parsed.sessionId === 'sess-123', 'session id extracted');
}

// parseDeepLinkUrl — open with no session id is not a routable link
assert(parseDeepLinkUrl('aegis://open') === null, 'open without session -> null');
assert(parseDeepLinkUrl('aegis://open?session=') === null, 'open with empty session -> null');

// parseDeepLinkUrl — new, with a URL-encoded prompt
{
  const parsed = parseDeepLinkUrl('aegis://new?prompt=hello%20world');
  assert(parsed && parsed.action === 'new', 'new action recognised');
  assert(parsed.prompt === 'hello world', 'prompt is decoded');
}

// parseDeepLinkUrl — new with no prompt still resolves, with an empty string
{
  const parsed = parseDeepLinkUrl('aegis://new');
  assert(parsed && parsed.action === 'new' && parsed.prompt === '', 'new with no prompt -> empty string, not null');
}

// parseDeepLinkUrl — trailing slash before the query still resolves the host
{
  const parsed = parseDeepLinkUrl('aegis://open/?session=abc');
  assert(parsed && parsed.sessionId === 'abc', 'trailing slash before query is tolerated');
}

// parseDeepLinkUrl — rejects everything else
assert(parseDeepLinkUrl('aegis://unknown-action?x=1') === null, 'unrecognised action -> null');
assert(parseDeepLinkUrl('https://open?session=abc') === null, 'wrong scheme -> null even with a matching host');
assert(parseDeepLinkUrl('not a url at all') === null, 'unparseable string -> null, never throws');
assert(parseDeepLinkUrl('') === null, 'empty string -> null');
assert(parseDeepLinkUrl(null) === null, 'null -> null, never throws');
assert(parseDeepLinkUrl(undefined) === null, 'undefined -> null, never throws');

// extractDeepLinkUrl — the Linux argv quirk: the URL lands as a bare
// positional entry alongside the executable path and other flags, at no
// fixed index.
{
  const argv = ['/opt/AEGIS Desktop/aegis', '--flag', 'aegis://open?session=xyz'];
  assert(extractDeepLinkUrl(argv) === 'aegis://open?session=xyz', 'finds the url among other argv entries');
}
{
  const argv = ['aegis://new?prompt=hi', '/opt/AEGIS Desktop/aegis'];
  assert(extractDeepLinkUrl(argv) === 'aegis://new?prompt=hi', 'finds the url when it is the first entry');
}
assert(extractDeepLinkUrl(['/opt/AEGIS Desktop/aegis', '--flag']) === null, 'no url present -> null');
assert(extractDeepLinkUrl([]) === null, 'empty argv -> null');
assert(extractDeepLinkUrl(null) === null, 'non-array argv -> null, never throws');
assert(extractDeepLinkUrl(undefined) === null, 'undefined argv -> null, never throws');

// parseDeepLinkArgv — the combined convenience used by main.js at cold start
// and on 'second-instance'.
{
  const argv = ['/opt/AEGIS Desktop/aegis', 'aegis://open?session=cold-start'];
  const parsed = parseDeepLinkArgv(argv);
  assert(parsed && parsed.action === 'open' && parsed.sessionId === 'cold-start', 'argv -> parsed action in one call');
}
assert(parseDeepLinkArgv(['/opt/AEGIS Desktop/aegis']) === null, 'argv with no deep link -> null');

console.log('deep-link tests passed');
