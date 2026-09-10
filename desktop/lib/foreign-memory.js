'use strict';

/**
 * foreign-memory.js — desktop-side resolver for the shared foreign-memory
 * scanner (client/foreign-memory.js).
 *
 * Same resolution rule as main.js uses for the shared transport: in the repo
 * (dev / CI / smoke tests) the canonical file lives at ../client/; the
 * packaged app cannot reach outside its app dir, so scripts/predist.mjs stages
 * a copy into desktop/vendor/ and we fall back to that. Both are the same
 * file, never forked logic.
 */

let impl;
try {
  impl = require('../../client/foreign-memory.js');
} catch {
  impl = require('../vendor/foreign-memory.js');
}

module.exports = impl;
