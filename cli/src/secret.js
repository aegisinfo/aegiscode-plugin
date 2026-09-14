'use strict';

/**
 * Read a secret from the terminal without echoing it.
 *
 * Extracted from app.js so the non-interactive entry point can use the same
 * prompt as the in-session commands: `aegiscode login` asks for the account key
 * on the same terms `/key` does, and a second copy of this loop would be a
 * second place for a key to end up echoed to the screen or in a shell history.
 *
 * Raw mode when the stream supports it; a stream that cannot mask (no TTY, no
 * setRawMode) resolves to '' rather than silently reading an echoed secret —
 * every caller treats '' as "nothing given" and says so.
 */

const MASK = '\u2022'; // •

function readSecret(promptText, o = {}) {
  const stdin = o.stdin || process.stdin;
  const stdout = o.stdout || process.stdout;
  const canMask = !!stdin.isTTY && typeof stdin.setRawMode === 'function';
  if (!canMask) return Promise.resolve('');
  return new Promise((resolve) => {
    stdout.write(promptText);
    let buf = '';
    const done = (value) => {
      try {
        stdin.setRawMode(false);
      } catch {}
      stdin.removeListener('data', onData);
      stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      // Drop terminal escape sequences whole: skipping only the ESC leaves the
      // CSI tail ([A, [3~, …) to be appended to the key.
      const text = String(chunk).replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '').replace(/\x1b./g, '');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') return done(buf);
        if (ch === '\x03' || ch === '\x04') return done(''); // ctrl+c / ctrl+d
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          stdout.write('\b \b');
          continue;
        }
        buf += ch;
        stdout.write(MASK);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

module.exports = { readSecret, MASK };
