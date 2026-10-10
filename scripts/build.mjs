// 配布用ビルド: src/ を検証して dist/ChatReader/ にコピーし、dist/ChatReader-<version>.zip を作成する
// 使い方: node scripts/build.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(rootDir, 'src');
const distDir = join(rootDir, 'dist');
const outDir = join(distDir, 'ChatReader');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// ---- 検証 ----
const manifest = JSON.parse(readFileSync(join(srcDir, 'manifest.json'), 'utf8'));
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap((c) => c.js)
];
const missing = referenced.filter((p) => { try { statSync(join(srcDir, p)); return false; } catch { return true; } });
if (missing.length) {
  console.error('manifest.json が参照するファイルが見つかりません:', missing);
  process.exit(1);
}
for (const file of walk(srcDir).filter((f) => f.endsWith('.js'))) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }); // 構文チェック
}

// ---- コピー ----
rmSync(distDir, { recursive: true, force: true });
const files = walk(srcDir).filter((f) => !f.includes('Zone.Identifier'));
for (const f of files) {
  const dest = join(outDir, relative(srcDir, f));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f, dest);
}

// ---- ZIP 作成（Chrome ウェブストア提出用）----
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
const locals = [];
const centrals = [];
let offset = 0;
const { time, date } = dosDateTime(new Date());
for (const f of files) {
  const name = Buffer.from(relative(srcDir, f).split(sep).join('/'), 'utf8');
  const data = readFileSync(f);
  const comp = deflateRawSync(data, { level: 9 });
  const crc = crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  locals.push(local, name, comp);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += 30 + name.length + comp.length;
}
const centralBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
const zipPath = join(distDir, `ChatReader-${manifest.version}.zip`);
writeFileSync(zipPath, Buffer.concat([...locals, centralBuf, end]));

console.log(`ビルド完了: ${relative(rootDir, outDir)}/ （${files.length} ファイル）`);
console.log(`ZIP 作成: ${relative(rootDir, zipPath)}`);
