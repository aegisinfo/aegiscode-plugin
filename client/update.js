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

/** Fetch the registry's `latest` dist-tag. Resolves null on any failure. */
function fetchLatest({ pkg = PKG, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      // The abbreviated metadata document: a few KB instead of the full
      // packument, which for a package with this many releases is megabytes.
      const req = https.get(
        `${REGISTRY}/${pkg}`,
        { headers: { accept: 'application/vnd.npm.install-v1+json' }, timeout: timeoutMs },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return done(null);
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            body += c;
            if (body.length > 2_000_000) {
              req.destroy();
              done(null);
            }
          });
          res.on('end', () => {
            try {
              const tags = JSON.parse(body)['dist-tags'];
              done((tags && tags.latest) || null);
            } catch {
              done(null);
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        done(null);
      });
      req.on('error', () => done(null));
    } catch {
      done(null);
    }
  });
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

module.exports = { isNewer, fetchLatest, updateNotice, updateLine, PKG, CHECK_INTERVAL_MS };
