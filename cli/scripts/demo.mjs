#!/usr/bin/env node
/**
 * Renders a canned session to stdout — banner, a prompt, a streamed answer with
 * markdown, the accounting line, and the status bar.
 *
 * No network and no key: this exists so the look can be reviewed (and pasted
 * into docs) without a live account, and so a regression in the layout is
 * visible to a human, not only to the width assertions in test/cli-render.
 *
 *   node cli/scripts/demo.mjs [--light] [--width 84] [--plain]
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, '..', 'src');

const render = require(path.join(src, 'render.js'));
const { stripAnsi } = require(path.join(src, 'screen.js'));
const art = require(path.join(src, 'art.js'));
// Read the version rather than hardcoding it — a demo that reports a stale
// version is the kind of drift nobody notices until it is in the docs.
const { version } = require(path.join(__dirname, '..', 'package.json'));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const width = Number(flag('--width', 0)) || Math.min(96, Math.max(48, process.stdout.columns || 84));
const ctx = { light: argv.includes('--light') };
const plain = argv.includes('--plain');

const out = [];
const push = (lines) => out.push(...(Array.isArray(lines) ? lines : [lines]));

push(
  render.renderBanner(ctx, {
    width,
    version,
    model: 'nexus-brain',
    base: 'https://aegiscloud.org',
    key: 'aegis_••••4f2a',
    stream: true,
  })
);
push('');
push(render.renderTurn(ctx, { role: 'user', text: 'summarise what changed in the token accounting' }, width));
push(
  render.renderTurn(
    ctx,
    {
      role: 'assistant',
      text: [
        'Three things changed, and one of them was costing you money:',
        '',
        '- the pool **merges** worker usage instead of overwriting it',
        '- cache reads and writes are billed, not ignored',
        '- a zero-token call no longer refunds its reservation',
        '',
        '```',
        'merge_usage({input_tokens: 1250}, {output_tokens: 312})',
        '=> 1562 total',
        '```',
        '',
        'Use `/balance` to see tokens beside € on every row.',
      ].join('\n'),
      meta: {
        model: 'nexus-brain',
        tokens: 1562,
        usage: { input: 1250, output: 312 },
        eur: 0.0007,
        ms: 4200,
        calls: 4,
      },
    },
    width
  )
);
push('');
push(render.renderWorking(ctx, { tick: 3, verb: 'Consulting', elapsedMs: 2100 }));
push(render.renderStatus(ctx, { model: 'nexus-brain', tokens: 1562, spend: 0.0007, mode: 'stream' }, width));

process.stdout.write((plain ? out.map(stripAnsi) : out).join('\n') + '\n\n');
if (!plain) {
  process.stdout.write(
    stripAnsi(`${art.WORDMARK} — ${out.length} lines rendered at ${width} cols${ctx.light ? ' (light)' : ''}\n`)
  );
}
