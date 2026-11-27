/**
 * Random arc-column generator for the badge builder (v2).
 *
 *   GET /column.png   -> transparent PNG
 *
 * Style: right-facing quarter-ring arcs (Top Right / Bottom Right only).
 * Tiles are stacked in pairs that form a half-ring ")", and each pair overlaps
 * the previous one by half a tile. Tiles are 70% opaque, so overlaps darken
 * and the background is fully transparent.
 *
 * A new combination is produced every second (the seed is the current Unix
 * second, so requests in the same second get the same image).
 *
 * Optional query parameters:
 *   count=18      number of tiles (default 18)
 *   w=200         tile width in px; image height = w * 14 for 18 tiles (max 1000)
 *   bg=ffffff     solid background hex colour (default transparent)
 *   seed=123      fixed seed (disables the per-second change)
 *   rotate=1      a fresh random image on every request
 *
 * Local:        node column.js            (PORT or 3000)
 * Vercel:       save as api/column.js
 */
const http = require('http');
const zlib = require('zlib');

// Colours and opacity taken from the original tile PNGs (alpha 179/255).
const COLORS = {
  hibiscus: [239, 63, 86],
  royalist: [32, 44, 93],
  sunday:   [249, 160, 57],
};
const COLOR_NAMES = Object.keys(COLORS);
const OPACITY = 179 / 255;

// ---------- seeded random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- tile masks (anti-aliased coverage, cached per size) ----------
// 'TR' = centre at bottom-left of the tile (ring bulges up and right)
// 'BR' = centre at top-left of the tile    (ring bulges down and right)
const maskCache = new Map();
function getMask(type, size) {
  const key = type + size;
  if (maskCache.has(key)) return maskCache.get(key);
  const m = new Float32Array(size * size);
  const SS = 4;
  const cy = type === 'TR' ? size : 0;
  const rOut2 = size * size, rIn2 = (size / 2) * (size / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = x + (sx + 0.5) / SS;
          const v = y + (sy + 0.5) / SS - cy;
          const d2 = u * u + v * v;
          if (d2 <= rOut2 && d2 >= rIn2) hit++;
        }
      }
      m[y * size + x] = hit / (SS * SS);
    }
  }
  maskCache.set(key, m);
  return m;
}

// ---------- layout + render ----------
function makeLayout(seed, count) {
  const rnd = mulberry32(seed);
  const tiles = [];
  for (let i = 0; i < count; i++) {
    tiles.push({
      c: COLOR_NAMES[Math.floor(rnd() * COLOR_NAMES.length)],
      type: i % 2 === 0 ? 'TR' : 'BR',
      top: (Math.floor(i / 2) * 1.5 + (i % 2)),   // in tile units
    });
  }
  return tiles;
}

function render(tiles, w, bg) {
  const hUnits = Math.max(...tiles.map(t => t.top)) + 1;
  const h = Math.round(hUnits * w);
  const R = new Float32Array(w * h), G = new Float32Array(w * h),
        B = new Float32Array(w * h), A = new Float32Array(w * h);

  for (const t of tiles) {
    const mask = getMask(t.type, w);
    const [cr, cg, cb] = COLORS[t.c];
    const y0 = Math.round(t.top * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const as = mask[y * w + x] * OPACITY;
        if (as === 0) continue;
        const i = (y0 + y) * w + x;
        const ab = A[i];
        const ar = as + ab * (1 - as);
        R[i] = (cr * as + R[i] * ab * (1 - as)) / ar;
        G[i] = (cg * as + G[i] * ab * (1 - as)) / ar;
        B[i] = (cb * as + B[i] * ab * (1 - as)) / ar;
        A[i] = ar;
      }
    }
  }

  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = row + 1 + x * 4;
      if (bg) {
        const a = A[i];
        raw[p]     = Math.round(R[i] * a + bg[0] * (1 - a));
        raw[p + 1] = Math.round(G[i] * a + bg[1] * (1 - a));
        raw[p + 2] = Math.round(B[i] * a + bg[2] * (1 - a));
        raw[p + 3] = 255;
      } else {
        raw[p] = Math.round(R[i]); raw[p + 1] = Math.round(G[i]);
        raw[p + 2] = Math.round(B[i]); raw[p + 3] = Math.round(A[i] * 255);
      }
    }
  }
  return { raw, w, h };
}

// ---------- PNG encoding ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG({ raw, w, h }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- HTTP handler ----------
function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  const count = Math.min(Math.max(parseInt(q.get('count')) || 18, 1), 100);
  const w = Math.min(Math.max(parseInt(q.get('w')) || 200, 20), 1000);
  const bgHex = /^[0-9a-f]{6}$/i.test(q.get('bg') || '') ? q.get('bg') : null;
  const bg = bgHex ? [0, 2, 4].map(i => parseInt(bgHex.substr(i, 2), 16)) : null;

  let seed;
  if (q.get('seed') !== null && q.get('seed') !== '') seed = parseInt(q.get('seed')) || 0;
  else if (q.get('rotate')) seed = Math.floor(Math.random() * 2 ** 31);
  else seed = Math.floor(Date.now() / 1000); // changes every second

  const png = encodePNG(render(makeLayout(seed, count), w, bg));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=1, must-revalidate');
  res.setHeader('Content-Type', 'image/png');
  res.end(png);
}

module.exports = handler;
module.exports.default = handler;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  http.createServer(handler).listen(port, () =>
    console.log(`Arc column generator: http://localhost:${port}/column.png`));
}
