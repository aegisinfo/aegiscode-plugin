/**
 * "There is a newer version" — the notice this CLI never had.
 *
 * Checked on 2026-09-15: there was no update check anywhere in the client, so
 * a user learned about a release only by guessing to run
 * `npm i -g aegiscode@latest`. Publishing therefore reached almost nobody, and
 * the installed base drifted months behind the registry.
 *
 * Three rules, because an update check is a background nicety that must never
 * become a liability:
 *   · it never blocks — the caller gets a cached answer immediately and the
 *     network call settles whenever it settles;
 *   · it never throws — offline, proxied, rate-limited or garbage JSON all
 *     mean "no notice", not a broken CLI;
 *   · it never nags — one check a day, cached, and nothing printed when the
 *     user is already current.
 */

const https = require('node:https');

const REGISTRY = 'https://registry.npmjs.org';
//: Default package. Both hosts ship from npm — the CLI as `aegiscode`, the
//: desktop as `aegis-desktop` — so one checker serves both; the caller names
//: which one it is.
const PKG = 'aegiscode';
/** One check a day. A CLI that pings the registry every launch is spyware. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The registry is not on the critical path; give up quickly and silently. */
const TIMEOUT_MS = 2500;

/** Compare two semver-ish strings. Returns true when `latest` is newer. */
function isNewer(latest, current) {
  const parse = (v) =>
    String(v || '')
      .trim()
      .replace(/^v/, '')
      .split('-')[0] // a prerelease never counts as newer than its release
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Why a check produced no version. Every one of these used to collapse into a
 * bare `null`, which is enough for the CLI ("no notice") but NOT enough for a
 * host that shows the user a sentence about it: the desktop rendered all six
 * as "registry unreachable", so a 2.5s timeout on a slow VPN was reported as
 * fact about the registry — a false accusation, and unactionable.
 */
const REASONS = Object.freeze({
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  NOT_FOUND: 'not-found',
  FORBIDDEN: 'forbidden',
  HTTP: 'http',
  MALFORMED: 'malformed',
  TOO_LARGE: 'too-large',
});

/**
 * Does this failure mean "the network let us down" (worth retrying silently, and
 * NOT worth telling the user about) rather than "the registry answered, and the
 * answer was no" (a real condition the user may need to act on)?
 *
 * `status` is the HTTP status when there was one, so 5xx/429 count as transient
 * while 404/403 do not.
 */
function isTransientReason(reason, status = null) {
  if (reason === REASONS.TIMEOUT || reason === REASONS.NETWORK) return true;
  if (reason === REASONS.HTTP) return !status || status >= 500 || status === 429;
  return false;
}

/**
 * Fetch the registry's `latest` dist-tag, saying WHY when it fails.
 *
 * Resolves `{ ok, latest, reason, status }` and never rejects: `ok` is the
 * version question, `reason` (one of REASONS) is the diagnosis. Use this when
 * you intend to tell someone what happened; use `fetchLatest` when you only
 * care whether there is a notice.
 */
function fetchLatestDetailed({ pkg = PKG, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const fail = (reason, status = null) =>
      done({ ok: false, latest: null, reason, status });
    const succeed = (latest) => done({ ok: true, latest, reason: null, status: 200 });
    try {
      // The abbreviated metadata document: a few KB instead of the full
      // packument, which for a package with this many releases is megabytes.
      const req = https.get(
        `${REGISTRY}/${pkg}`,
        { headers: { accept: 'application/vnd.npm.install-v1+json' }, timeout: timeoutMs },
        (res) => {
          const status = res.statusCode;
          if (status !== 200) {
            res.resume();
            if (status === 404) return fail(REASONS.NOT_FOUND, status);
            if (status === 401 || status === 403) return fail(REASONS.FORBIDDEN, status);
            return fail(REASONS.HTTP, status);
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            body += c;
            if (body.length > 2_000_000) {
              req.destroy();
              fail(REASONS.TOO_LARGE, status);
            }
          });
          res.on('end', () => {
            try {
              const tags = JSON.parse(body)['dist-tags'];
              const latest = (tags && tags.latest) || null;
              // A 200 that parses but names no `latest` is a malformed
              // document, not a slow network — do not invite a retry for it.
              if (!latest) return fail(REASONS.MALFORMED, status);
              succeed(latest);
            } catch {
              fail(REASONS.MALFORMED, status);
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        fail(REASONS.TIMEOUT);
      });
      // Every socket-level failure — DNS (ENOTFOUND), refused (ECONNREFUSED),
      // TLS, proxy, reset mid-body — is the same story to a user: the network.
      req.on('error', () => fail(REASONS.NETWORK));
    } catch {
      fail(REASONS.NETWORK);
    }
  });
}

/** Fetch the registry's `latest` dist-tag. Resolves null on any failure. */
function fetchLatest(opts = {}) {
  return fetchLatestDetailed(opts).then((r) => (r.ok ? r.latest : null));
}

/**
 * The notice to show, from cache. Never waits on the network.
 *
 * `cache` is the persisted `{ checkedAt, latest }` blob; `save` persists a new
 * one. Returns `{ latest, behind }`, and kicks off a refresh in the background
 * when the cache is stale.
 */
function updateNotice({
  current,
  cache,
  save,
  now = Date.now(),
  fetchImpl = fetchLatest,
  intervalMs = CHECK_INTERVAL_MS,
} = {}) {
  const c = cache || {};
  const fresh = typeof c.checkedAt === 'number' && now - c.checkedAt < intervalMs;

  if (!fresh) {
    // Fire and forget: this run reports on what was already known, and the
    // answer lands for the next one. A first run therefore never shows a
    // notice, which is correct — it has nothing to compare against yet.
    Promise.resolve(fetchImpl())
      .then((latest) => {
        if (latest && typeof save === 'function') save({ checkedAt: now, latest });
      })
      .catch(() => {});
  }

  const latest = c.latest || null;
  return { latest, behind: !!(latest && isNewer(latest, current)) };
}

/** One line for the welcome box, or null when there is nothing to say. */
function updateLine({ current, latest, behind, pkg = PKG }) {
  if (!behind) return null;
  return `Update available: ${current} → ${latest}   run: npm i -g ${pkg}@latest`;
}

module.exports = {
  isNewer,
  fetchLatest,
  fetchLatestDetailed,
  isTransientReason,
  updateNotice,
  updateLine,
  PKG,
  CHECK_INTERVAL_MS,
  REASONS,
};
