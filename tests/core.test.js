// コアロジック（テキスト抽出・セレクタ生成・自分判定）のテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const core = require('../src/content/core.js');

function el(html) {
  const dom = new JSDOM('<body>' + html + '</body>');
  return dom.window.document.body.firstElementChild;
}

test('時刻表記を判定できる', () => {
  for (const t of ['15:21', '午後 3:21', '3:21 PM', '10月9日 15:21', '月曜日 9:00', '5分前']) {
    assert.ok(core.isTimestampLike(t), t);
  }
  assert.ok(!core.isTimestampLike('会議は15:00からです'));
});

test('本文抽出で送信者・時刻・UI 文言・非表示要素を除外する', () => {
  const m = el('<div><span>田中</span><span>午後 3:21</span><div>明日の 会議は 15:00 から</div>'
    + '<button>返信</button><span aria-hidden="true">隠し</span><span>編集済み</span><img alt="😀"></div>');
  assert.equal(core.extractMessageText(m, { sender: '田中' }), '明日の 会議は 15:00 から 😀');
});

test('bodySelector 指定時はその要素のみを読む', () => {
  const m = el('<div><span>田中</span><div class="b">本文</div><div>フッター</div></div>');
  assert.equal(core.extractMessageText(m, { bodySelector: '.b' }), '本文');
});

test('セレクタ候補は共通属性から生成される', () => {
  const a = core.elementSignature(el('<div jsname="abc" data-x="1" class="m k1"></div>'));
  const b = core.elementSignature(el('<div jsname="abc" data-x="2" class="m k2"></div>'));
  const sels = core.buildSelectorCandidates([a, b]);
  assert.ok(sels.includes('div[jsname="abc"]'));
  assert.ok(sels.includes('div[data-x]'));
  assert.ok(sels.includes('div.m'));
  assert.ok(!sels.some((s) => s.includes('k1')));
});

test('読み上げ文の組み立てと長文の省略', () => {
  const s = { readSender: true, maxLength: 5 };
  assert.equal(core.buildSpeechText({ sender: '田中', text: 'こんにちは世界' }, s), '田中、こんにちは、以下省略');
  assert.equal(core.buildSpeechText({ sender: '田中', text: 'はい' }, { readSender: false, maxLength: 100 }), 'はい');
});

test('「さん」付けは設定で切り替えられる', () => {
  const msg = { sender: '田中', text: 'はい' };
  assert.equal(core.buildSpeechText(msg, { readSender: true, addHonorific: true, maxLength: 100 }), '田中さん、はい');
  assert.equal(core.buildSpeechText(msg, { readSender: true, addHonorific: false, maxLength: 100 }), '田中、はい');
  assert.equal(core.buildSpeechText(msg, { readSender: false, addHonorific: true, maxLength: 100 }), 'はい');
});

test('自分のメッセージ判定: 表示名一致', () => {
  const d = new core.OwnMessageDetector();
  assert.ok(d.isOwn({ sender: '山田 太郎', text: 'x' }, '山田 太郎'));
  assert.ok(d.isOwn({ sender: 'あなた', text: 'x' }, ''));
  assert.ok(!d.isOwn({ sender: '田中', text: 'x' }, '山田 太郎'));
});

test('自分のメッセージ判定: 送信した文章との一致（1 回だけ・期限付き）', () => {
  let now = 0;
  const d = new core.OwnMessageDetector({ ttlMs: 1000, now: () => now });
  d.recordSent('了解です  よろしく');
  assert.ok(d.isOwn({ sender: '', text: '了解です よろしく' }, ''));
  assert.ok(!d.isOwn({ sender: '', text: '了解です よろしく' }, ''), '同じ記録は 1 回で消費される');
  d.recordSent('期限切れ');
  now = 2000;
  assert.ok(!d.isOwn({ sender: '', text: '期限切れ' }, ''));
});

test('通知タイトル「送信者 (スペース名)」の分解', () => {
  assert.deepEqual(core.parseNotificationTitle('太郎 (テスト2)'), { sender: '太郎', space: 'テスト2' });
  assert.deepEqual(core.parseNotificationTitle('山田 花子（開発チーム）'), { sender: '山田 花子', space: '開発チーム' });
  assert.deepEqual(core.parseNotificationTitle('太郎'), { sender: '太郎', space: '' });
});

test('通知の読み上げ文はスペース名を先に読む', () => {
  const s = { readSender: true, addHonorific: false, readSpaceName: true, maxLength: 200 };
  assert.equal(core.buildNotificationSpeech('太郎 (テスト2)', 'あいうえお', s), 'テスト2、太郎、あいうえお');
  assert.equal(core.buildNotificationSpeech('太郎', 'こんにちは', s), '太郎、こんにちは', 'DM');
  assert.equal(core.buildNotificationSpeech('太郎 (テスト2)', 'あいうえお', { ...s, addHonorific: true }), 'テスト2、太郎さん、あいうえお');
  assert.equal(core.buildNotificationSpeech('太郎 (テスト2)', 'あいうえお', { ...s, readSender: false }), 'テスト2、あいうえお');
  assert.equal(core.buildNotificationSpeech('太郎 (テスト2)', '', s), 'テスト2、太郎、新着メッセージ');
});

test('通知: スペース名を読まない設定', () => {
  const s = { readSender: true, addHonorific: false, readSpaceName: false, maxLength: 200 };
  assert.equal(core.buildNotificationSpeech('太郎 (テスト2)', 'あいうえお', s), '太郎、あいうえお');
});

test('開いているスペースのメッセージもスペース名を先に読む（DM では重ねない）', () => {
  const s = { readSender: true, addHonorific: false, readSpaceName: true, maxLength: 200 };
  assert.equal(core.buildSpeechText({ space: 'テスト2', sender: '太郎', text: '石狩川' }, s), 'テスト2、太郎、石狩川');
  assert.equal(core.buildSpeechText({ space: '太郎', sender: '太郎', text: '石狩川' }, s), '太郎、石狩川', 'DM');
  assert.equal(core.buildSpeechText({ space: '', sender: '太郎', text: '石狩川' }, s), '太郎、石狩川');
  assert.equal(core.buildSpeechText({ space: 'テスト2', sender: '太郎', text: '石狩川' }, { ...s, readSpaceName: false }), '太郎、石狩川');
  assert.equal(core.buildSpeechText({ space: 'テスト2', sender: '太郎', text: '石狩川' }, { ...s, readSender: false }), 'テスト2、石狩川');
});

test('メンション除去: 既知の名前（空白入り）・不明な名前・全角＠', () => {
  assert.equal(core.stripMentions('@山田 太郎 明日の件です', ['山田 太郎']), '明日の件です');
  assert.equal(core.stripMentions('明日は @太郎 と ＠花子 が担当', []), '明日は と が担当');
  assert.equal(core.stripMentions('@all 全員確認してください', []), '全員確認してください');
  assert.equal(core.stripMentions('メールは a@example.com まで', []), 'メールは a@example.com まで');
  assert.equal(core.stripMentions('（@太郎）確認', []), '（ ）確認');
  assert.equal(core.stripMentions('メンションなし', []), 'メンションなし');
});

test('メンションだけのメッセージ: 設定 ON なら「メンションのみ」、OFF ならそのまま', () => {
  assert.equal(core.prepareBody('@山田 太郎', { skipMentions: true }, ['山田 太郎']), 'メンションのみ');
  assert.equal(core.prepareBody('@山田 太郎', { skipMentions: false }, ['山田 太郎']), '@山田 太郎');
  assert.equal(core.prepareBody('@太郎 了解', { skipMentions: false }, []), '@太郎 了解');
});

test('自分の判定は完全一致のみ（他人の短い返信を自分の投稿と誤認しない）', () => {
  const d = new core.OwnMessageDetector();
  d.recordSent('了解です');
  assert.equal(d.isOwn({ sender: '太郎', text: '了解' }, ''), false);
  d.recordSent('はい');
  assert.equal(d.isOwn({ sender: '花子', text: 'はい、わかりました' }, ''), false);
  assert.equal(d.isOwn({ sender: '', text: '了解です' }, ''), true);
});

test('メンション除去: 既知の短い名前が長い名前の先頭を削らない・先頭の読点を残さない', () => {
  assert.equal(core.stripMentions('@A @Alice こんにちは', ['A']), 'こんにちは');
  assert.equal(core.stripMentions('@山田 太郎、明日の件', ['山田 太郎']), '明日の件');
});

// ---- 2 回目の厳密チェックで見つかった不具合の再発防止 ----

test('実機の相対時刻「2 分」等を時刻として扱う', () => {
  for (const t of ['2 分', '1 分', 'たった今', '3 時間', '昨日 15:21', 'Yesterday 3:21 PM', '5 min', '2 hr']) {
    assert.ok(core.isNoiseSegment(t), t);
  }
  for (const t of ['2分で行きます', '3時間後', '今日は晴れ']) assert.ok(!core.isNoiseSegment(t), t);
});

test('本文要素がある場合は「15:00」「3分」のような本文もそのまま読む', () => {
  const m = el('<div><span>太郎</span><span>2 分</span><div class="b">15:00</div></div>');
  assert.equal(core.extractMessageText(m, { bodySelector: '.b' }), '15:00');
  const m2 = el('<div><div class="b">3分</div><span>送信しています...</span></div>');
  assert.equal(core.extractMessageText(m2, { bodySelector: '.b' }), '3分');
});

test('スペースの更新情報: 見出しを除き、切り離された名前を文に戻す', () => {
  assert.equal(core.isSystemMessage('スペースの更新情報: さんが参加しました'), true);
  assert.equal(core.isSystemMessage('スペースの更新情報について相談'), false);
  assert.equal(core.formatSystemMessage('Tomoaki Bessho', 'スペースの更新情報: さんが 太郎 を招待しました'), 'Tomoaki Bessho さんが 太郎 を招待しました');
  assert.equal(core.formatSystemMessage('太郎', 'スペースの更新情報: さんが参加しました'), '太郎 さんが参加しました');
  assert.equal(core.formatSystemMessage('', 'スペースの更新情報: 履歴がオンになっています'), '履歴がオンになっています');
});

test('全員宛てのメンション: 設定 ON なら「全員宛て」と伝え、OFF なら他のメンションと同じく除く', () => {
  const on = { skipMentions: true, announceMentionAll: true };
  assert.equal(core.prepareBody('@全員 zen zen', on, []), '全員宛て、zen zen');
  assert.equal(core.prepareBody('@all 確認お願いします', on, []), '全員宛て、確認お願いします');
  assert.equal(core.prepareBody('＠everyone', on, []), '全員宛て');
  assert.equal(core.prepareBody('@山田 太郎 明日', on, ['山田 太郎']), '明日', '個人宛ては従来どおり');
  assert.equal(core.prepareBody('メールは a@all.com', on, []), 'メールは a@all.com');
  assert.equal(core.prepareBody('@全員 zen zen', { skipMentions: true, announceMentionAll: false }, []), 'zen zen');
  assert.equal(core.prepareBody('@全員 zen zen', { skipMentions: false, announceMentionAll: true }, []), '@全員 zen zen', 'メンションを読む設定ならそのまま');
});
