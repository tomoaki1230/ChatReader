// マニフェストの安全性チェック（Chat 以外のページ・通知を扱わないこと）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'manifest.json'), 'utf8'));

test('コンテンツスクリプト（通知フックを含む）は chat.google.com でのみ動く', () => {
  for (const cs of manifest.content_scripts) {
    assert.deepEqual(cs.matches, ['https://chat.google.com/*'], cs.js.join(','));
  }
});

test('不要な権限を要求しない（通知の読み取り・全サイトアクセス等）', () => {
  assert.deepEqual(manifest.permissions.slice().sort(), ['storage', 'tts']);
  assert.equal(manifest.host_permissions, undefined);
});
