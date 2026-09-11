#!/usr/bin/env node
'use strict';

/**
 * `aegis` CLI entry point for the `aegis-desktop` npm package: launches the
 * same Electron app as `npm start` in this repo, but from a global install
 * where there is no sibling `client/` dir — main.js's require('../client/
 * aegis.js') fails there and it falls back to the vendored copy staged by
 * predist at publish time (prepublishOnly), which is the intended path.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const appDir = path.join(__dirname, '..');

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(require(path.join(appDir, 'package.json')).version);
  process.exit(0);
}

const electronPath = require('electron');
const child = spawn(electronPath, [appDir, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('error', (err) => {
  console.error('Failed to launch AEGIS Desktop:', err.message);
  process.exit(1);
});
child.on('close', (code) => process.exit(code == null ? 0 : code));
