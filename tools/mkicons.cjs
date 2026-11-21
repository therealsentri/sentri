// Generates the app-true icons without any image dependency: indigo tile,
// mint three-stripe mark (brand.dart's SentriLogoTile geometry), raw RGBA ->
// zlib deflate -> PNG chunks with CRCs.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, fn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = fn(x, y, size);
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const INDIGO = [14, 8, 163, 255]; // #0E08A3
const MINT = [19, 255, 71, 255]; // #13FF47
const CLEAR = [0, 0, 0, 0];

/** The three stripes of brand.dart's mark, in mark-space 0..100. */
function markBand(u, v) {
  if (v >= 0 && v <= 23 - u * 0.06) return true; // top band
  if (v >= 28 + u * 0.13 && v <= 53 + u * 0.16) return true; // middle band
  if (v >= 87 - u * 0.13 && v <= 100) return true; // bottom band
  return false;
}

function roundedIn(x, y, s, radius, inset) {
  const x0 = Math.min(x - inset, s - inset - x);
  const y0 = Math.min(y - inset, s - inset - y);
  if (x0 < 0 || y0 < 0) return false;
  return x0 >= radius || y0 >= radius || Math.hypot(radius - x0, radius - y0) <= radius;
}

// Home-screen icon: rounded indigo tile, mark inset 17% like SentriLogoTile.
function tileIcon(x, y, s) {
  if (!roundedIn(x, y, s, s * 0.3, 0)) return CLEAR;
  const i = s * 0.17;
  return markBand(((x - i) / (s - 2 * i)) * 100, ((y - i) / (s - 2 * i)) * 100) ? MINT : INDIGO;
}

// Maskable: full bleed indigo, mark pushed well inside the safe zone.
function maskIcon(x, y, s) {
  const i = s * 0.28;
  return markBand(((x - i) / (s - 2 * i)) * 100, ((y - i) / (s - 2 * i)) * 100) ? MINT : INDIGO;
}

const dir = 'C:/Users/USER/Documents/Default Project/website/icons';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon-192.png'), png(192, tileIcon));
fs.writeFileSync(path.join(dir, 'icon-512.png'), png(512, tileIcon));
fs.writeFileSync(path.join(dir, 'icon-maskable-512.png'), png(512, maskIcon));
console.log('icons written:', fs.readdirSync(dir).join(', '));
