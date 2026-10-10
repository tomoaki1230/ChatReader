// 設定正規化のテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSettings, DEFAULT_SETTINGS } = require('../src/shared/settings.js');

test('空の入力では既定値を返す', () => {
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS });
});

test('範囲外の数値は丸められる', () => {
  const s = normalizeSettings({ volume: 5, rate: 0, pitch: -1, maxLength: 99999 });
  assert.equal(s.volume, 1);
  assert.equal(s.rate, 0.1);
  assert.equal(s.pitch, 0);
  assert.equal(s.maxLength, 2000);
});

test('不正な型は既定値に戻る', () => {
  const s = normalizeSettings({ volume: 'abc', enabled: 'yes', voiceName: 3, readOwnMessages: 1 });
  assert.equal(s.volume, DEFAULT_SETTINGS.volume);
  assert.equal(s.enabled, true);
  assert.equal(s.voiceName, '');
  assert.equal(s.readOwnMessages, false);
});

test('「さん」付けは既定で OFF、指定値を保持する', () => {
  assert.equal(DEFAULT_SETTINGS.addHonorific, false);
  assert.equal(normalizeSettings({ addHonorific: true }).addHonorific, true);
});

test('自分のメッセージ読み上げ設定は既定で OFF、指定値を保持する', () => {
  assert.equal(DEFAULT_SETTINGS.readOwnMessages, false);
  assert.equal(normalizeSettings({ readOwnMessages: true }).readOwnMessages, true);
});

test('開いていないスペースの設定: 3 つの選択肢と、旧設定（A・B の 2 つ）からの移行', () => {
  assert.equal(DEFAULT_SETTINGS.otherSpaces, 'full');
  const cases = [
    [{ otherSpaces: 'full' }, 'full', true, true],
    [{ otherSpaces: 'nameOnly' }, 'nameOnly', false, true],
    [{ otherSpaces: 'off' }, 'off', false, false],
    [{ otherSpaces: 'xxx' }, 'full', true, true],
    // 旧設定からの移行
    [{ readNotifications: true, announceUnread: true }, 'full', true, true],
    [{ readNotifications: false, announceUnread: true }, 'nameOnly', false, true],
    [{ readNotifications: false, announceUnread: false }, 'off', false, false],
    [{ readNotifications: true, announceUnread: false }, 'full', true, true],
    // 新しい設定が優先（古い値が残っていても無視）
    [{ otherSpaces: 'off', readNotifications: true, announceUnread: true }, 'off', false, false]
  ];
  for (const [raw, mode, a, b] of cases) {
    const s = normalizeSettings(raw);
    assert.deepEqual([s.otherSpaces, s.readNotifications, s.announceUnread], [mode, a, b], JSON.stringify(raw));
  }
});
