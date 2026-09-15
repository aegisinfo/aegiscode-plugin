/**
 * The update notice. Checked on 2026-09-15: the CLI had none at all, so a
 * published fix reached only users who guessed to reinstall — which is why the
 * installed base sat months behind the registry.
 *
 * What is pinned here is mostly what it must NOT do: block, throw, or nag.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const u = require(join(root, 'cli', 'src', 'update.js'));

function assert(c, m) { if (!c) throw new Error(`ASSERT FAILED: ${m}`); }
const eq = (a, b, m) => assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ── version comparison ──────────────────────────────────────────────────────
eq(u.isNewer('6.5.2', '6.5.1'), true, 'patch bump is newer');
eq(u.isNewer('6.6.0', '6.5.9'), true, 'minor beats a higher patch');
eq(u.isNewer('7.0.0', '6.99.99'), true, 'major wins');
eq(u.isNewer('6.5.1', '6.5.1'), false, 'equal is not newer');
eq(u.isNewer('6.5.0', '6.5.1'), false, 'older is not newer');
eq(u.isNewer('6.5.10', '6.5.9'), true, 'numeric, not lexicographic — 10 > 9');
eq(u.isNewer('v6.5.2', '6.5.1'), true, 'a leading v is tolerated');
eq(u.isNewer('6.6.0-beta.1', '6.6.0'), false, 'a prerelease is not newer than its release');
eq(u.isNewer('', '6.5.1'), false, 'garbage never claims to be newer');
eq(u.isNewer(null, '6.5.1'), false, 'null never claims to be newer');

// ── the notice never blocks, and reports from cache ─────────────────────────
{
  let saved = null;
  const started = Date.now();
  const r = u.updateNotice({
    current: '6.5.1',
    cache: { checkedAt: 0, latest: '6.5.2' },     // stale → triggers a refresh
    save: (v) => { saved = v; },
    fetchImpl: () => new Promise(() => {}),        // a fetch that NEVER settles
  });
  assert(Date.now() - started < 100, 'updateNotice must return immediately');
  eq(r.behind, true, 'it reports from cache while the refresh is in flight');
  eq(r.latest, '6.5.2', 'and names the cached version');
  eq(saved, null, 'nothing is persisted until the fetch resolves');
}

// ── a fresh cache does not re-check ─────────────────────────────────────────
{
  let calls = 0;
  u.updateNotice({
    current: '6.5.1',
    cache: { checkedAt: Date.now(), latest: '6.5.1' },
    save: () => {},
    fetchImpl: () => { calls++; return Promise.resolve('6.5.2'); },
  });
  eq(calls, 0, 'one check a day — a CLI that pings on every launch is spyware');
}

// ── a failing fetch is silent, never thrown ─────────────────────────────────
{
  const r = u.updateNotice({
    current: '6.5.1',
    cache: null,
    save: () => {},
    fetchImpl: () => Promise.reject(new Error('offline')),
  });
  eq(r.behind, false, 'offline means no notice, not a crash');
  eq(r.latest, null, 'and nothing to report');
  await new Promise((res) => setTimeout(res, 20));   // let the rejection settle
}

// ── the refresh persists for the NEXT run ───────────────────────────────────
{
  let saved = null;
  u.updateNotice({
    current: '6.5.1', cache: null, save: (v) => { saved = v; },
    fetchImpl: () => Promise.resolve('6.5.2'), now: 1234,
  });
  await new Promise((res) => setTimeout(res, 20));
  eq(saved && saved.latest, '6.5.2', 'the answer lands for next time');
  eq(saved && saved.checkedAt, 1234, 'stamped so the interval can be honoured');
}

// ── the line itself ─────────────────────────────────────────────────────────
eq(u.updateLine({ current: '6.5.1', latest: '6.5.1', behind: false }), null,
   'nothing is printed when the user is current');
{
  const line = u.updateLine({ current: '6.5.1', latest: '6.5.2', behind: true });
  assert(line.includes('6.5.1') && line.includes('6.5.2'), 'shows both versions');
  assert(line.includes('npm i -g aegiscode@latest'), 'and the exact command to run');
}

console.log('cli update-check tests passed');
