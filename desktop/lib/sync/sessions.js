'use strict';

/**
 * sessions.js — the desktop's session store, now a thin binding over the
 * SHARED store in `client/session-store.js`.
 *
 * This file used to be the implementation. It was the desktop's private
 * `sessions.json`, while the terminal host kept `~/.aegiscode/history.jsonl`
 * and the MCP plugin could see neither — three hosts, one account, three
 * disjoint views of the conversation. The implementation now lives in
 * `client/session-store.js`, which is the tree every host already bundles,
 * and every call here forwards to it.
 *
 * Two things that matter are deliberately unchanged:
 *
 *   * the public API and its argument order (`(dir, …)` first) — `main.js`, the
 *     sync dispatch and `test/sync-sessions.test.mjs` call it by those names;
 *   * the record shape — `pending`, `seq`, `updatedAt`, `remoteId`,
 *     `lastSyncedAt`, `__seq` all keep their meaning, because cloud sync and
 *     the renderer's session list read them.
 *
 * The only real change is *where* `dir` points: main.js now passes the shared
 * data dir (see `resolveStoreDir`), so a session typed in the terminal appears
 * in the desktop's list without a network round trip.
 *
 * Resolution mirrors main.js's own pattern for the shared client: `client/` in
 * a source checkout, `vendor/` in the packaged app (electron-builder cannot
 * reach outside the app dir, so predist.mjs stages the file).
 */

const shared = (() => {
  try {
    return require('../../../client/session-store.js');
  } catch {
    return require('../../vendor/session-store.js');
  }
})();

const credentials = (() => {
  try {
    return require('../../../client/credentials.js');
  } catch {
    return require('../../vendor/credentials.js');
  }
})();

/**
 * The directory the shared store lives in: `$AEGISCODE_HOME` or `~/.aegiscode`.
 * `legacyDir` (Electron's userData) is only used to adopt a pre-unification
 * store, never to read sessions from afterwards.
 */
function resolveStoreDir(legacyDir) {
  const dir = credentials.aegisHome();
  if (legacyDir && legacyDir !== dir) adopt(dir, legacyDir);
  return dir;
}

const {
  storeFile,
  load,
  save,
  upsertSession,
  appendMessage,
  recordExchange,
  listSessions,
  getSession,
  deleteSession,
  markSynced,
  markPending,
  listPending,
  mergeRemoteSessions,
  listSummaries,
  readTranscript,
  adopt,
  toMarkdown,
  toJson,
} = shared;

/** Kept under its old name — main.js and the tests call `sessionsFile`. */
const sessionsFile = storeFile;

module.exports = {
  sessionsFile,
  storeFile,
  resolveStoreDir,
  load,
  save,
  upsertSession,
  appendMessage,
  recordExchange,
  listSessions,
  getSession,
  deleteSession,
  markSynced,
  markPending,
  listPending,
  mergeRemoteSessions,
  listSummaries,
  readTranscript,
  adopt,
  toMarkdown,
  toJson,
};
