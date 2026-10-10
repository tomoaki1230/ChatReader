// アイコン PNG を生成するスクリプト（外部依存なし）
// 使い方: node scripts/generate-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
mkdirSync(outDir, { recursive: true });

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

// 単位正方形 (0..1) 上の形状: 青い角丸背景 + 白い吹き出し + 青い音波
function shade(x, y) {
  const r = 0.22;
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  if (dx * dx + dy * dy > r * r) return null;
  const blue = [26, 115, 232];
  const white = [255, 255, 255];
  // 吹き出し（楕円 + しっぽ）
  const ex = (x - 0.5) / 0.34, ey = (y - 0.46) / 0.27;
  const inEllipse = ex * ex + ey * ey <= 1;
  const inTail = y >= 0.62 && y <= 0.82 && x >= 0.28 && x <= 0.28 + (0.82 - y) * 0.9;
  if (!inEllipse && !inTail) return blue;
  // 音波（3 本の弧）
  const d = Math.hypot(x - 0.36, y - 0.46);
  const ang = Math.atan2(y - 0.46, x - 0.36);
  if (Math.abs(ang) < 0.75) {
    for (const rr of [0.08, 0.15, 0.22]) if (Math.abs(d - rr) < 0.025) return blue;
  }
  if (d < 0.035) return blue;
  return white;
}

for (const size of [16, 32, 48, 128]) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
      const i = (py * size + px) * 4;
      if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; }
      buf[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  writeFileSync(join(outDir, `icon${size}.png`), encodePng(size, buf));
  console.log(`生成: icons/icon${size}.png`);
}
