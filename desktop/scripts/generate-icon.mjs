#!/usr/bin/env node
/**
 * Generates desktop/build/icon.png — a placeholder AEGIS mark (dark tile with
 * a violet ring + core) written as a dependency-free 1024x1024 PNG.
 * electron-builder derives .icns/.ico from this file automatically.
 *
 * Replace with the final brand artwork before the first tagged release:
 *   desktop/build/icon.png  (>= 512x512)
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'build');
const outFile = join(outDir, 'icon.png');
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------- geometry
const S = 1024;
const CX = S / 2;
const CY = S / 2;
const R_OUTER = S * 0.33; // ring outer radius
const R_INNER = S * 0.235; // ring inner radius
const R_CORE = S * 0.075; // core dot radius
const AA = 1.5; // anti-aliasing band (px)

// Placeholder palette — replace with real brand colors.
const BG_TOP = [13, 17, 23]; // #0d1117
const BG_BOT = [24, 29, 37]; // #181d25
const VIOLET = [154, 106, 242]; // brand accent

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a, b, t) => a + (b - a) * t;
const ringMid = (R_INNER + R_OUTER) / 2;
const ringHalf = (R_OUTER - R_INNER) / 2;

// Raw RGBA scanlines with filter byte 0 per row.
const raw = Buffer.alloc((S * 4 + 1) * S);
let o = 0;
for (let y = 0; y < S; y++) {
  raw[o++] = 0;
  const vy = y / (S - 1);
  const bgR = mix(BG_TOP[0], BG_BOT[0], vy);
  const bgG = mix(BG_TOP[1], BG_BOT[1], vy);
  const bgB = mix(BG_TOP[2], BG_BOT[2], vy);
  for (let x = 0; x < S; x++) {
    const d = Math.hypot(x - CX, y - CY);
    const ringCov = clamp01((ringHalf + AA - Math.abs(d - ringMid)) / (2 * AA));
    const coreCov = clamp01((R_CORE + AA - d) / (2 * AA));
    const cov = clamp01(ringCov + coreCov);
    raw[o++] = Math.round(mix(bgR, VIOLET[0], cov));
    raw[o++] = Math.round(mix(bgG, VIOLET[1], cov));
    raw[o++] = Math.round(mix(bgB, VIOLET[2], cov));
    raw[o++] = 255;
  }
}

// ------------------------------------------------------------- PNG writer
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(outFile, png);
console.log(`wrote ${outFile} (${S}x${S} PNG, ${png.length} bytes)`);
