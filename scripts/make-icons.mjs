#!/usr/bin/env node
// Generates the extension icons as PNGs. Kept as a script rather than binary
// blobs in the tree so the mark can be tweaked without a design tool.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BG = [59, 91, 219, 255];
const FG = [255, 255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A rounded square in the accent colour with a white "Q" ring and tail. */
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size;
  const radius = s * 0.22;
  const cx = s / 2;
  const cy = s / 2;
  const ringOuter = s * 0.30;
  const ringInner = s * 0.17;

  const put = (x, y, rgba, alpha = 1) => {
    const i = (y * s + x) * 4;
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] * (1 - alpha) + rgba[c] * alpha);
    px[i + 3] = Math.max(px[i + 3], Math.round(rgba[3] * alpha));
  };

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // Rounded-rect coverage.
      const dx = Math.max(radius - x, x - (s - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (s - 1 - radius), 0);
      const corner = Math.hypot(dx, dy);
      const bgAlpha = clamp(radius - corner + 0.5, 0, 1);
      if (bgAlpha <= 0) continue;
      put(x, y, BG, bgAlpha);

      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const ring = Math.min(clamp(ringOuter - d + 0.5, 0, 1), clamp(d - ringInner + 0.5, 0, 1));
      if (ring > 0) put(x, y, FG, ring * bgAlpha);

      // The tail: a short diagonal stroke off the lower right of the ring.
      const tail = strokeCoverage(x + 0.5, y + 0.5, cx + s * 0.08, cy + s * 0.08, cx + s * 0.30, cy + s * 0.30, s * 0.065);
      if (tail > 0) put(x, y, FG, tail * bgAlpha);
    }
  }
  return px;
}

/** Anti-aliased coverage of a round-capped line segment. */
function strokeCoverage(px, py, x1, y1, x2, y2, halfWidth) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq === 0 ? 0 : clamp(((px - x1) * vx + (py - y1) * vy) / lengthSq, 0, 1);
  const distance = Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy));
  return clamp(halfWidth - distance + 0.5, 0, 1);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

mkdirSync(resolve(root, 'icons'), { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(resolve(root, `icons/icon${size}.png`), encodePng(size, draw(size)));
  console.log(`icons/icon${size}.png`);
}
