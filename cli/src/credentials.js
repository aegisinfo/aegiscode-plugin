'use strict';

/**
 * The AEGIS account credential store for the terminal host.
 *
 * The implementation moved to `client/credentials.js` — the tree every host in
 * this repo already bundles — because the desktop app and the MCP plugin read
 * the same file now. Before that move the MCP host took its key from the
 * environment only (it ships as `mcp/` + `client/`, so it could not require this
 * directory), which meant `aegiscode login` made the CLI work and left the
 * plugin saying "No AEGIS_API_KEY is set".
 *
 * This module stays as the CLI's name for that store, so the resolution order,
 * the 0600 write and the legacy-adoption behaviour are unchanged for every
 * existing caller and test:
 *
 *   1. `AEGIS_API_KEY` — the environment, so CI and an explicit export keep
 *      working and nothing written here can shadow them.
 *   2. `credentials.json` in the data dir, mode 0600. The writable store.
 *   3. `config.json`'s `aegiscloud.api_key` / `memory.token` — the shape an
 *      earlier AEGIS CLI left in the same data dir. Read, never written or
 *      deleted; adopted into the 0600 store once so the next run reads that.
 *
 * A re-export, not a copy: two implementations is how the CLI and the plugin
 * would come to disagree about which key is configured.
 */

const shared = require('./shared.js');

module.exports = shared.credentials;
