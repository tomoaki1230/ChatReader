// バックグラウンド（読み上げ・重複防止・未読お知らせの省略）のテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const VOICES = [
  { voiceName: 'Google 日本語', lang: 'ja-JP', remote: true },
  { voiceName: 'Microsoft Haruka', lang: 'ja-JP', remote: false },
  { voiceName: 'Microsoft Ayumi', lang: 'ja-JP', remote: false },
  { voiceName: 'Microsoft Zira', lang: 'en-US', remote: false }
];

function load(settings, voices) {
  const spoken = [];
  const voiceUsed = [];
  const localWrites = [];
  const sessionWrites = [];
  let onMessage = null;
  const chrome = {
    tts: {
      speak: async (text, options) => { spoken.push(text); voiceUsed.push(options.voiceName); },
      stop: () => {},
      getVoices: async () => voices || VOICES
    },
    storage: {
      sync: { get: async () => ({ ...settings }), set: async () => {} },
      local: { get: async () => ({}), set: async (v) => { localWrites.push(v); }, remove: async () => {} },
      session: { get: async () => ({}), set: async (v) => { sessionWrites.push(v); } }
    },
    runtime: {
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      onInstalled: { addListener: () => {} }
    }
  };
  const ctx = { chrome, console, setTimeout, clearTimeout, Date };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), ctx);
  const send = (msg) => onMessage(msg, {}, () => {});
  return { spoken, voiceUsed, send, localWrites, sessionWrites };
}

test('同じメッセージが DOM と通知から届いても 1 回だけ読む', async () => {
  const b = load({});
  b.send({ type: 'CR_SPEAK', text: '田中、明日の会議の件です', dedupeKey: '明日の会議の件です' });
  b.send({ type: 'CR_SPEAK', text: '開発チーム、田中: 明日の会議の件です', dedupeKey: '田中: 明日の会議の件です' });
  await wait(30);
  assert.deepEqual(b.spoken, ['田中、明日の会議の件です']);
});

test('通知で本文を読んだスペースの未読お知らせは省略し、それ以外は知らせる', { timeout: 5000 }, async () => {
  const b = load({});
  b.send({ type: 'CR_SPEAK', text: '開発チーム、リリースしました', dedupeKey: 'リリースしました', sender: '佐藤', space: '開発チーム' });
  b.send({ type: 'CR_UNREAD', name: '開発チーム' });
  b.send({ type: 'CR_UNREAD', name: '営業' });
  b.send({ type: 'CR_UNREAD', name: '営業' });
  await wait(1700);
  assert.deepEqual(b.spoken, ['開発チーム、リリースしました', '営業 に新着メッセージ']);
});

test('設定で未読お知らせを OFF にできる', { timeout: 5000 }, async () => {
  const b = load({ otherSpaces: 'off' });
  b.send({ type: 'CR_UNREAD', name: '営業' });
  await wait(1700);
  assert.deepEqual(b.spoken, []);
});

test('外部送信が必要なオンライン音声は使わず、日本語のローカル音声を明示して読み上げる', async () => {
  const b = load({});
  b.send({ type: 'CR_SPEAK', text: 'こんにちは' });
  await wait(30);
  assert.deepEqual(b.voiceUsed, ['Microsoft Haruka']);
});

test('オンライン音声が設定に残っていても使わない', async () => {
  const b = load({ voiceName: 'Google 日本語' });
  b.send({ type: 'CR_TEST', text: '試聴' });
  await wait(30);
  assert.deepEqual(b.voiceUsed, ['Microsoft Haruka']);
});

test('指定したローカル音声で読み上げる', async () => {
  const b = load({ voiceName: 'Microsoft Ayumi' });
  b.send({ type: 'CR_SPEAK', text: 'こんにちは' });
  await wait(30);
  assert.deepEqual(b.voiceUsed, ['Microsoft Ayumi']);
});

test('ローカル音声が無ければ読み上げない（オンライン音声に切り替えない）', async () => {
  const b = load({}, [{ voiceName: 'Google 日本語', lang: 'ja-JP', remote: true }]);
  b.send({ type: 'CR_SPEAK', text: 'こんにちは' });
  await wait(30);
  assert.deepEqual(b.spoken, []);
});

test('本文にスペース名が含まれるだけでは未読お知らせを省略しない／DM は送信者名で省略する', { timeout: 5000 }, async () => {
  const b = load({});
  b.send({ type: 'CR_SPEAK', text: 'テスト2、太郎、開発の件です', dedupeKey: '開発の件です', sender: '太郎', space: 'テスト2' });
  b.send({ type: 'CR_SPEAK', text: '花子、大丈夫です', dedupeKey: '大丈夫です', sender: '花子', space: '' });
  b.send({ type: 'CR_UNREAD', name: '開発' });
  b.send({ type: 'CR_UNREAD', name: '花子' });
  await wait(1700);
  assert.deepEqual(b.spoken, ['テスト2、太郎、開発の件です', '花子、大丈夫です', '開発 に新着メッセージ']);
});

test('診断ログ（本文を含む）はディスクに残らない storage.session に保存する', async () => {
  const b = load({});
  b.send({ type: 'CR_LOG', text: '本文を含むログ' });
  await wait(400);
  assert.ok(b.sessionWrites.some((v) => Array.isArray(v.debugLog) && v.debugLog.some((e) => e.text === '本文を含むログ')));
  assert.ok(!b.localWrites.some((v) => 'debugLog' in v));
});
