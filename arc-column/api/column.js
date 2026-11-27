/**
 * Random arc-column generator for the badge builder.
 *
 *   GET /column.png   -> PNG image   (use this one in the badge builder)
 *   GET /column.svg   -> SVG image
 *
 * A new combination is produced every second: the random seed is the current
 * Unix second, so every request within the same second gets the same image.
 *
 * Optional query parameters:
 *   count=18        number of tiles in the column (default 18)
 *   w=200           width in pixels; height = w * count (default 200, max 1000)
 *   bg=ffffff       background hex colour (default transparent)
 *   seed=123        fixed seed (disables the per-second change)
 *   rotate=1        every request gets a fresh random image (cache-busting)
 *
 * Run locally:   node column-server.js        (listens on PORT or 3000)
 * Serverless:    export is `module.exports = handler` (e.g. Vercel /api/column.js)
 */
const http = require('http');
const zlib = require('zlib');

const COLORS = {
  pink:   [0xF4, 0x78, 0x8A],
  navy:   [0x63, 0x6B, 0x8D],
  orange: [0xFA, 0xB9, 0x73],
};
const COLOR_NAMES = Object.keys(COLORS);
// Arc centre (in unit-square coords) for each of the 4 orientations.
const CENTERS = [[1, 0], [0, 0], [1, 1], [0, 1]];

// ---------- seeded random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeLayout(seed, count) {
  const rnd = mulberry32(seed);
  const tiles = [];
  for (let i = 0; i < count; i++) {
    let t;
    do {
      t = { c: COLOR_NAMES[Math.floor(rnd() * 3)], o: Math.floor(rnd() * 4) };
    } while (i > 0 && t.c === tiles[i - 1].c && t.o === tiles[i - 1].o); // no exact repeats
    tiles.push(t);
  }
  return tiles;
}

// ---------- SVG ----------
function toSVG(tiles, w, bg) {
  const h = w * tiles.length;
  const ring = 'M0,0A1,1 0 0 0 1,1L1,.5A.5,.5 0 0 1 .5,0Z'; // arc centred top-right
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${tiles.length} ${tiles.length * tiles.length / tiles.length}" preserveAspectRatio="none">`;
  out = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1 ${tiles.length}" preserveAspectRatio="none">`;
  if (bg) out += `<rect width="1" height="${tiles.length}" fill="#${bg}"/>`;
  tiles.forEach((t, i) => {
    const [r, g, b] = COLORS[t.c];
    out += `<path d="${ring}" fill="rgb(${r},${g},${b})" transform="translate(0 ${i}) rotate(${t.o * 90} .5 .5)"/>`;
  });
  return out + '</svg>';
}

// ---------- PNG ----------
const tileCache = new Map();
function renderTile(color, orient, size, bg) {
  const key = `${color}|${orient}|${size}|${bg || ''}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const [cx, cy] = CENTERS[orient];
  const [r, g, b] = COLORS[color];
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size - cx;
          const v = (y + (sy + 0.5) / SS) / size - cy;
          const d = Math.sqrt(u * u + v * v);
          if (d <= 1 && d >= 0.5) hit++;
        }
      }
      const a = hit / (SS * SS);
      const p = (y * size + x) * 4;
      if (bg) {
        buf[p]     = Math.round(r * a + bg[0] * (1 - a));
        buf[p + 1] = Math.round(g * a + bg[1] * (1 - a));
        buf[p + 2] = Math.round(b * a + bg[2] * (1 - a));
        buf[p + 3] = 255;
      } else {
        buf[p] = r; buf[p + 1] = g; buf[p + 2] = b; buf[p + 3] = Math.round(a * 255);
      }
    }
  }
  tileCache.set(key, buf);
  return buf;
}

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

function toPNG(tiles, w, bg) {
  const h = w * tiles.length;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h); // each row: filter byte 0 + pixels
  tiles.forEach((t, i) => {
    const tile = renderTile(t.c, t.o, w, bg);
    for (let y = 0; y < w; y++) {
      const dst = (i * w + y) * (stride + 1);
      raw[dst] = 0;
      tile.copy(raw, dst + 1, y * stride, (y + 1) * stride);
    }
  });
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
  const path = url.pathname;
  const isPng = path.endsWith('.png') || path === '/' || path === '/api/column';
  const isSvg = path.endsWith('.svg');
  if (!isPng && !isSvg) { res.statusCode = 404; return res.end('Not found'); }

  const q = url.searchParams;
  const count = Math.min(Math.max(parseInt(q.get('count')) || 18, 1), 100);
  const w = Math.min(Math.max(parseInt(q.get('w')) || 200, 20), 1000);
  const bgHex = /^[0-9a-f]{6}$/i.test(q.get('bg') || '') ? q.get('bg') : null;
  const bg = bgHex ? [0, 2, 4].map(i => parseInt(bgHex.substr(i, 2), 16)) : null;

  let seed;
  if (q.get('seed') !== null && q.get('seed') !== '') seed = parseInt(q.get('seed')) || 0;
  else if (q.get('rotate')) seed = Math.floor(Math.random() * 2 ** 31);
  else seed = Math.floor(Date.now() / 1000); // changes every second

  const tiles = makeLayout(seed, count);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=1, must-revalidate');
  if (isSvg) {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end(toSVG(tiles, w, bgHex));
  }
  res.setHeader('Content-Type', 'image/png');
  res.end(toPNG(tiles, w, bg));
}

module.exports = handler;
module.exports.default = handler;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  http.createServer(handler).listen(port, () =>
    console.log(`Arc column generator: http://localhost:${port}/column.png`));
}
