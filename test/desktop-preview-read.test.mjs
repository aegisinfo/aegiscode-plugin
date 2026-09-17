#!/usr/bin/env node
/**
 * Tests for the desktop diff-preview read bridge — the one filesystem
 * capability the sandboxed renderer has (`preload.js` readTextFile ->
 * `main.js` readTextFileForPreview, over a synchronous IPC round trip).
 *
 * This is a security boundary: the renderer is untrusted relative to main, so
 * every containment refusal is asserted here, not just the happy path. No
 * Electron binary is booted; readTextFileForPreview is pure apart from fs.
 */
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { readTextFileForPreview, PREVIEW_READ_MAX_BYTES, MODEL_PREFIX } = require('../desktop/main.js');

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  passed++;
}

// A workspace and a sibling whose name shares the workspace's prefix — the
// classic `startsWith('/root')` false-friend that `path.relative` must reject.
const base = mkdtempSync(join(tmpdir(), 'aegis-preview-'));
const root = join(base, 'work');
const sibling = join(base, 'work-evil');
mkdirSync(root, { recursive: true });
mkdirSync(sibling, { recursive: true });
mkdirSync(join(root, 'sub'), { recursive: true });

const inner = join(root, 'sub', 'a.js');
writeFileSync(inner, 'const a = 1;\nconst b = 2;\n');
writeFileSync(join(sibling, 'secret.txt'), 'do not read me\n');
writeFileSync(join(root, 'big.txt'), `${'x'.repeat(79)}\n`.repeat(7000));

// --- happy path -----------------------------------------------------------
{
  const got = readTextFileForPreview({ file: 'sub/a.js', cwd: root });
  assert(got && got.text === 'const a = 1;\nconst b = 2;\n', 'relative path inside cwd reads');
  assert(got.truncated === false, 'a small read is not flagged truncated');
}
{
  const got = readTextFileForPreview({ file: inner, cwd: root });
  assert(got && got.text.includes('const b = 2;'), 'absolute path inside cwd reads');
}

// --- containment refusals -------------------------------------------------
{
  const got = readTextFileForPreview({ file: join(sibling, 'secret.txt'), cwd: root });
  assert(got === null, 'a prefix-sibling directory is refused (not just startsWith)');
}
{
  const got = readTextFileForPreview({ file: '../work-evil/secret.txt', cwd: root });
  assert(got === null, 'a ../ escape is refused');
}
{
  const got = readTextFileForPreview({ file: '../../etc/passwd', cwd: root });
  assert(got === null, 'a climb to /etc is refused');
}
{
  // A symlink planted inside the workspace that points out of it. Containment
  // must be judged on the realpath, or this is a read-anything primitive.
  const link = join(root, 'link.txt');
  symlinkSync(join(sibling, 'secret.txt'), link);
  const got = readTextFileForPreview({ file: 'link.txt', cwd: root });
  assert(got === null, 'a symlink escaping the workspace is refused');
}
{
  assert(readTextFileForPreview({ file: 'sub', cwd: root }) === null, 'a directory is refused');
  assert(readTextFileForPreview({ file: 'nope.txt', cwd: root }) === null, 'a missing file is refused');
  assert(readTextFileForPreview({ file: 'a.js', cwd: 'relative/dir' }) === null, 'a relative cwd is refused');
  assert(readTextFileForPreview({ file: '', cwd: root }) === null, 'an empty file is refused');
  assert(readTextFileForPreview({ file: 'a.js', cwd: '' }) === null, 'an empty cwd is refused');
  assert(readTextFileForPreview({}) === null, 'an empty payload is refused');
  assert(readTextFileForPreview(null) === null, 'a null payload is refused');
  assert(readTextFileForPreview('sub/a.js') === null, 'a non-object payload is refused');
}

// --- oversized reads ------------------------------------------------------
{
  const got = readTextFileForPreview({ file: 'big.txt', cwd: root });
  assert(got && got.truncated === true, 'an oversized file is flagged truncated');
  assert(got.text.length <= PREVIEW_READ_MAX_BYTES, 'the oversized read is capped');
  assert(got.text.endsWith('\n'), 'the capped read cuts back to a line boundary');
  assert(!got.text.includes('\uFFFD'), 'the capped read leaves no half-decoded multi-byte tail');
}

// --- the cap is a real ceiling, not decorative ----------------------------
{
  const n = PREVIEW_READ_MAX_BYTES;
  assert(typeof n === 'number' && n > 0, 'PREVIEW_READ_MAX_BYTES is exported as a positive number');
}

// --- wiring: preload and main agree on the channel ------------------------
{
  const preload = readFileSync(new URL('../desktop/preload.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
  // preload composes the channel from MODEL_PREFIX, so match that expression
  // rather than a literal 'model:readTextFile'.
  assert(
    preload.includes("MODEL_PREFIX + 'readTextFile'"),
    'preload sends the model:readTextFile channel',
  );
  // sendSync is answered only by ipcMain.on — an `handle` registration would
  // silently never reply, and the diff would degrade with no error anywhere.
  const onIdx = main.indexOf('ipcMain.on(`${MODEL_PREFIX}readTextFile`');
  assert(onIdx !== -1, 'main registers model:readTextFile with ipcMain.on (sendSync requires it)');
  assert(
    !main.includes('ipcMain.handle(`${MODEL_PREFIX}readTextFile`'),
    'main does not register model:readTextFile with ipcMain.handle',
  );
}
{
  // The renderer must forward the session cwd, or main has nothing to contain
  // against and refuses every read while still "working".
  const app = readFileSync(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
  assert(
    app.includes('bridge.readTextFile(file, cwd)'),
    'the renderer passes cwd to the bridge (without it every read is refused)',
  );
}

console.log(`desktop-preview-read: ${passed} assertions passed`);
