/**
 * The desktop's update channel is npm, because the one it had never existed.
 *
 * electron-updater was configured against GitHub Releases
 * (desktop/electron-builder.yml `publish:`), and on 2026-09-15 there was no
 * published release at all — only a v0.2.0 DRAFT, which the updater cannot
 * see — because the release workflow has not run since the Actions billing
 * lock. Meanwhile aegis-desktop ships to npm on every release. The feed the
 * app depended on was empty; the one it actually publishes to was ignored.
 *
 * Worse, a non-packaged install resolved a flat 'disabled' — and `npm i -g
 * aegis-desktop` IS a non-packaged install, so exactly the users who could
 * update most easily were the ones never told to.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const u = require(join(root, 'client', 'update.js'));

function assert(c, m) { if (!c) throw new Error(`ASSERT FAILED: ${m}`); }
const eq = (a, b, m) => assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ── one checker, two packages ──────────────────────────────────────────────
{
  eq(u.updateLine({ current: '1.0.0', latest: '1.0.1', behind: true, pkg: 'aegis-desktop' }),
     'Update available: 1.0.0 → 1.0.1   run: npm i -g aegis-desktop@latest',
     'the desktop names its own package in the command');
  eq(u.updateLine({ current: '6.5.4', latest: '6.5.5', behind: true }),
     'Update available: 6.5.4 → 6.5.5   run: npm i -g aegiscode@latest',
     'and the CLI keeps its default');
}

// ── the CLI shim still resolves to the same implementation ─────────────────
{
  const viaCli = require(join(root, 'cli', 'src', 'update.js'));
  eq(viaCli.isNewer, u.isNewer, 'CLI and shared module must be the SAME code, not a copy');
}

// ── both published layouts carry it ────────────────────────────────────────
{
  const fs = require('node:fs');
  assert(fs.existsSync(join(root, 'cli', 'vendor', 'client', 'update.js')),
    'the CLI package must stage it, or the shim breaks once published');
  assert(fs.existsSync(join(root, 'desktop', 'vendor', 'update.js')),
    'the packaged desktop cannot reach outside its app dir — it needs the copy');
}

// ── a fetch failure never becomes a broken updater ─────────────────────────
{
  const r = u.updateNotice({
    current: '0.5.2', cache: null, save: () => {},
    fetchImpl: () => Promise.reject(new Error('registry down')),
  });
  eq(r.behind, false, 'offline means no notice');
  await new Promise((res) => setTimeout(res, 20));
}

console.log('npm update-channel tests passed');
