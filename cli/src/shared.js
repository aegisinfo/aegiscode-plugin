'use strict';

/**
 * Where the CLI finds the modules it shares with the other hosts.
 *
 * `src/deps.js` does this for the transport/engine/registry trio, but it pulls
 * the whole agent loop in at require time — far too heavy for `config.js` and
 * `history.js`, which every command and every launch touches. This module
 * resolves the two *pure* shared modules those files need, with the same
 * two-layout rule and the same by-existence lookup:
 *
 *   in-repo   <repo>/cli/src/shared.js  -> <repo>/client/*.js
 *   npm       <pkg>/src/shared.js       -> <pkg>/vendor/client/*.js
 *
 * A missing module is a loud error rather than a silent fallback to a second
 * copy: a duplicate credential store or session store is exactly the drift this
 * whole arrangement exists to prevent.
 */

const fs = require('node:fs');
const path = require('node:path');

function candidates(name) {
  return [
    path.join(__dirname, '..', '..', 'client', name), // repo checkout
    path.join(__dirname, '..', 'vendor', 'client', name), // staged package
  ];
}

function resolveClientModule(name) {
  const tried = candidates(name);
  for (const candidate of tried) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `aegiscode: cannot find client/${name}. Expected it beside cli/ (in the repo) ` +
      'or under cli/vendor/client/ (installed package). Reinstall the package, or ' +
      'run `node scripts/predist.mjs` from cli/ if this is a source checkout.'
  );
}

const credentials = require(resolveClientModule('credentials.js'));
const sessionStore = require(resolveClientModule('session-store.js'));

module.exports = { credentials, sessionStore, resolveClientModule };
