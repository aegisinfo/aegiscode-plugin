'use strict';

/**
 * The CLI's view of the shared npm update checker (client/update.js).
 *
 * It lives at the repo root rather than here because the desktop host needs
 * the same thing for `aegis-desktop`: two hosts, two package names, one
 * checker. Resolved through deps.js so the in-repo and published-vendor
 * layouts both work.
 */

const { resolveShared } = require('./deps.js');
module.exports = require(resolveShared('client/update.js'));
