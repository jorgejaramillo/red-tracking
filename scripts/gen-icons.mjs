#!/usr/bin/env node
/** Generates simple PNG icons (eye glyph) without any image library. */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'extension', 'public', 'icons');
mkdirSync(out, { recursive: true });

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function eye(size) {
  const c = size / 2;
  const r = size * 0.46;
  return (x, y) => {
    const dx = x + 0.5 - c, dy = y + 0.5 - c;
    const d = Math.hypot(dx, dy);
    if (d > r) return [0, 0, 0, 0];
    // eye white: ellipse
    const ex = dx / (size * 0.36), ey = dy / (size * 0.2);
    const inEye = ex * ex + ey * ey <= 1;
    const iris = Math.hypot(dx, dy) <= size * 0.15;
    const pupil = Math.hypot(dx, dy) <= size * 0.07;
    const glint = Math.hypot(dx - size * 0.05, dy - size * 0.05) <= size * 0.03;
    if (glint && inEye) return [255, 255, 255, 255];
    if (pupil) return [20, 20, 30, 255];
    if (iris) return [230, 60, 50, 255];
    if (inEye) return [245, 245, 245, 255];
    return [30, 34, 46, 255];
  };
}

for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(out, `icon-${s}.png`), png(s, eye(s)));
}
console.log('[gen-icons] wrote icons to', out);
