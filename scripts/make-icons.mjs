// Draws the app icon as PNG without any dependency. Run: node scripts/make-icons.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]); };
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const cover = d => Math.max(0, Math.min(1, 0.5 - d)); // signed distance in pixels -> coverage
function png(size) {
  const s = size / 512, ink = [27, 26, 23], paper = [244, 241, 234], a = [224, 99, 61], b = [79, 107, 237];
  const box = (x, y, half, r) => { const qx = Math.abs(x - 256 * s) - (half - r) * s, qy = Math.abs(y - 256 * s) - (half - r) * s; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r * s; };
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x + 0.5, py = y + 0.5;
    let color = ink;
    color = mix(color, paper, cover(Math.abs(box(px, py, 106, 56)) - 13 * s));
    for (const [cx, fill] of [[112, a], [400, b]]) {
      const d = Math.hypot(px - cx * s, py - 256 * s);
      color = mix(color, ink, cover(d - 60 * s));
      color = mix(color, fill, cover(d - 40 * s));
    }
    const alpha = Math.round(255 * cover(box(px, py, 256, 112)));
    raw.set([...color, alpha], y * (size * 4 + 1) + 1 + x * 4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
for (const size of [192, 512]) fs.writeFileSync(new URL('../public/icon-' + size + '.png', import.meta.url), png(size));
console.log('icons written');
