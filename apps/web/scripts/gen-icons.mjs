// Generates the PWA / apple-touch icons (public/icons/icon-{180,192,512}.png) without dependencies:
// a full-bleed stone background with the key mark of favicon.svg, rasterized with supersampling.
// Run: node apps/web/scripts/gen-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0x1c, 0x19, 0x17];
const FG = [0xf6, 0xf5, 0xf3];

// Mark in a 24-unit box (key: ring + shaft + two teeth), stroke width ~2 with round caps.
const STROKE = 1.9;
const ring = { cx: 15.5, cy: 8.5, r: 4.6 };
const segs = [
  [12.25, 11.75, 3.5, 20.5], // shaft
  [5.6, 18.4, 7.8, 20.6], // tooth 1
  [8.0, 16.0, 10.0, 18.0], // tooth 2
];
const dot = { cx: 16.6, cy: 7.4, r: 1.0 };

function segDist(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 1 when the point (mark units) lies on the mark, else 0. */
function inside(x, y) {
  if (Math.abs(Math.hypot(x - ring.cx, y - ring.cy) - ring.r) <= STROKE / 2) return 1;
  if (Math.hypot(x - dot.cx, y - dot.cy) <= dot.r) return 1;
  for (const s of segs) if (segDist(x, y, s) <= STROKE / 2) return 1;
  return 0;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const SS = 4; // supersampling per axis
  const markSize = size * 0.58; // mark stays inside the maskable safe zone
  const off = (size - markSize) / 2;
  const scale = 24 / markSize;
  const row = size * 3 + 1;
  const raw = Buffer.alloc(size * row);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let cov = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) cov += inside((x + (sx + 0.5) / SS - off) * scale, (y + (sy + 0.5) / SS - off) * scale);
      const a = cov / (SS * SS);
      const i = y * row + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[i + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = new URL('../public/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of [180, 192, 512]) writeFileSync(new URL(`icon-${size}.png`, dir), png(size));
