#!/usr/bin/env node
/**
 * Zero-dependency static file server for the aegis-online SPA.
 *
 *   node scripts/serve.mjs            # http://localhost:8080
 *   PORT=9090 node scripts/serve.mjs  # http://localhost:9090
 *
 * Serves the online/ directory (index.html, app.js, style.css, vendor/).
 * No runtime deps — Node's built-in http + fs only.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const port = Number(process.env.PORT || 8080);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const file = normalize(join(root, pathname));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch (_) {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => {
  console.log(`aegis-online: http://localhost:${port}`);
});
