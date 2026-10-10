// 重複読み上げ防止のテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const { RecentKeys } = require('../src/shared/dedupe.js');

test('同じ本文は時間内に 1 回だけ', () => {
  let now = 0;
  const r = new RecentKeys({ windowMs: 1000, now: () => now });
  assert.equal(r.checkAndAdd('こんにちは 世界'), false);
  assert.equal(r.checkAndAdd('こんにちは、世界'), true, '空白・句読点の違いは無視');
  now = 2000;
  assert.equal(r.checkAndAdd('こんにちは 世界'), false, '期限切れ後は再度読む');
});

test('通知本文「名前: 本文」と DOM の本文は同じメッセージとみなす', () => {
  const r = new RecentKeys();
  assert.equal(r.checkAndAdd('明日の会議の件です'), false);
  assert.equal(r.checkAndAdd('田中: 明日の会議の件です'), true);
});

test('短い本文は包含では重複扱いしない', () => {
  const r = new RecentKeys();
  assert.equal(r.checkAndAdd('はい'), false);
  assert.equal(r.checkAndAdd('はい、了解です'), false);
});

test('別の人・別のスペースの同じ文面は重複扱いしない（どちらか不明なら本文で判定）', () => {
  const r = new RecentKeys();
  assert.equal(r.checkAndAdd('おはようございます', '太郎', 'テスト2'), false);
  assert.equal(r.checkAndAdd('おはようございます', '花子', 'テスト2'), false, '別の人');
  assert.equal(r.checkAndAdd('おはようございます', '太郎', '開発'), false, '別のスペース');
  assert.equal(r.checkAndAdd('おはようございます', '太郎', ''), true, 'DM の通知などスペース不明');
  assert.equal(r.checkAndAdd('おはようございます', '', ''), true, '送信者不明');
});
