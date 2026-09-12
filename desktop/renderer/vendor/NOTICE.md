# Vendored third-party files

These files are committed verbatim (no CDN, no network at runtime) and loaded
by `renderer/index.html` under the existing `script-src 'self'` CSP.

This directory (`renderer/vendor/`) is separate from `desktop/vendor/`, which
is a predist.mjs build-staging dir (copies of `client/aegis.js` +
`client/foreign-memory.js`) that the repo's `.githooks/pre-commit` guard
deliberately blocks from ever being committed — these files have no other
source of truth, so they live here instead.

- `marked.umd.js` — [marked](https://github.com/markedjs/marked) v18.0.12,
  MIT / MPL-2.0 dual-licensed. Markdown → HTML parser. Exposes global `marked`.
- `purify.min.js` — [DOMPurify](https://github.com/cure53/DOMPurify) v3.4.15,
  Apache-2.0 / MPL-2.0 dual-licensed. HTML sanitizer. Exposes global
  `DOMPurify`.
- `aegis-highlight.js` — first-party (not third-party), see the file header.

Do not edit `marked.umd.js` / `purify.min.js` by hand — replace with a fresh
build from the matching npm package version instead.
