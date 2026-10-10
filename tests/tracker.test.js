// 新着検出と DOM 自動追従（自己修復）のテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { ChatDomTracker } = require('../src/content/tracker.js');
const { learnProfile } = require('../src/content/learner.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 失敗時もタイマーが残らないよう、各テスト後に必ず停止する
const active = [];
test.afterEach(() => { while (active.length) active.pop().stop(); });

// 現行想定の Google Chat 風 DOM
function oldMsg(id, sender, text) {
  return `<div data-message-id="${id}" class="msg">`
    + (sender ? `<span data-member-id="u-${sender}">${sender}</span>` : '')
    + `<span>午後 3:2${id.length % 10}</span><div jsname="bgckF">${text}</div><button>返信</button></div>`;
}

// 仕様変更後を想定した DOM（data-message-id も jsname も無くなる）
function newMsg(sender, text) {
  return `<div class="zX9 row" data-kind="m">`
    + `<div class="hdr"><span class="nm" data-uid="1">${sender}</span><span class="tm">10:0${text.length % 10}</span></div>`
    + `<p class="tx">${text}</p></div>`;
}

function setup(listHtml, options) {
  const dom = new JSDOM(`<!doctype html><body><div role="main"><div role="list" id="list">${listHtml}</div></div></body>`, { url: 'https://chat.google.com/app/chat/space1' });
  const doc = dom.window.document;
  const spoken = [];
  const learned = [];
  const tracker = new ChatDomTracker(doc, {
    debounceMs: 10, healthIntervalMs: 100000, warmupMs: 0, healCooldownMs: 0, retryDelayMs: 20,
    ...options,
    onMessage: (m) => spoken.push((m.sender ? m.sender + ':' : '') + m.text),
    onProfileLearned: (p) => learned.push(p)
  });
  active.push(tracker);
  return { dom, doc, tracker, spoken, learned, list: () => doc.getElementById('list') };
}

function append(container, html) {
  container.insertAdjacentHTML('beforeend', html);
}

const OLD_LIST = oldMsg('m1', '田中', 'おはよう') + oldMsg('m2', '', '今日もよろしく') + oldMsg('m3', '佐藤', 'はい');

test('組み込みセレクタで新着のみを読み上げ、既存メッセージは読まない', async () => {
  const t = setup(OLD_LIST);
  t.tracker.start(null);
  assert.equal(t.tracker.getStatus().profileName, 'builtin-message-id');
  append(t.list(), oldMsg('m4', '鈴木', '会議を始めます'));
  await wait(50);
  assert.deepEqual(t.spoken, ['鈴木:会議を始めます']);
  t.tracker.stop();
});

test('連続投稿で名前が省略されたメッセージは直前の送信者を使う', async () => {
  const t = setup(OLD_LIST);
  t.tracker.start(null);
  append(t.list(), oldMsg('m4', '', '追加の連絡です'));
  await wait(50);
  assert.deepEqual(t.spoken, ['佐藤:追加の連絡です']);
  t.tracker.stop();
});

test('一度に大量追加（履歴読込）や先頭への挿入は読まない', async () => {
  const t = setup(OLD_LIST);
  t.tracker.start(null);
  append(t.list(), ['a', 'b', 'c', 'd', 'e'].map((x) => oldMsg('h' + x, '過去', x + 'の話')).join(''));
  await wait(50);
  t.list().insertAdjacentHTML('afterbegin', oldMsg('h0', '過去', '昔の話'));
  await wait(50);
  assert.deepEqual(t.spoken, []);
  t.tracker.stop();
});

test('本文が後から描画されるメッセージも読み上げる', async () => {
  const t = setup(OLD_LIST);
  t.tracker.start(null);
  append(t.list(), '<div data-message-id="m9"><span data-member-id="x">高橋</span><div jsname="bgckF"></div></div>');
  await wait(15);
  t.doc.querySelector('[data-message-id="m9"] [jsname="bgckF"]').textContent = '遅れて表示';
  await wait(80);
  assert.deepEqual(t.spoken, ['高橋:遅れて表示']);
  t.tracker.stop();
});

test('DOM 構造が変わってもドリフト検知で再学習し、新着を読み上げる', async () => {
  const t = setup(OLD_LIST);
  t.tracker.start(null);
  // Google Chat の仕様変更: 一覧の中身が新しい構造に置き換わる
  t.list().innerHTML = newMsg('田中', 'おはよう') + newMsg('佐藤', '了解') + newMsg('田中', '資料を送ります');
  await wait(50);
  append(t.list(), newMsg('鈴木', '新しい構造の1通目'));
  await wait(50);
  append(t.list(), newMsg('佐藤', '新しい構造の2通目'));
  await wait(50);
  const st = t.tracker.getStatus();
  assert.equal(st.profileName, 'learned');
  assert.equal(st.healCount, 1);
  assert.equal(t.learned.length, 1);
  assert.deepEqual(t.spoken, ['鈴木:新しい構造の1通目', '佐藤:新しい構造の2通目']);
  // 学習後は通常通り検出できる
  append(t.list(), newMsg('高橋', '3通目'));
  await wait(50);
  assert.equal(t.spoken.at(-1), '高橋:3通目');
  t.tracker.stop();
});

test('ヘルスチェックでセレクタ不一致が続くと再学習する', async () => {
  const t = setup(OLD_LIST, { healthIntervalMs: 30 });
  t.tracker.start(null);
  t.list().innerHTML = newMsg('田中', 'おはよう') + newMsg('佐藤', '了解') + newMsg('田中', '資料です');
  await wait(150);
  assert.equal(t.tracker.getStatus().profileName, 'learned');
  assert.deepEqual(t.spoken, [], '既存メッセージは読まない');
  append(t.list(), newMsg('鈴木', 'こんにちは'));
  await wait(50);
  assert.deepEqual(t.spoken, ['鈴木:こんにちは']);
  t.tracker.stop();
});

test('組み込みセレクタが一致しない時は、保存された学習結果を次回起動時に使う', async () => {
  const html = newMsg('田中', 'おはよう') + newMsg('佐藤', '了解') + newMsg('田中', '資料です');
  const first = setup(html);
  const profile = learnProfile(first.doc);
  assert.ok(profile && profile.message);
  const t = setup(html);
  t.tracker.start(profile);
  assert.equal(t.tracker.getStatus().profileName, 'learned');
  append(t.list(), newMsg('鈴木', '再起動後'));
  await wait(50);
  assert.deepEqual(t.spoken, ['鈴木:再起動後']);
  t.tracker.stop();
});

test('学習器: スレッド単位のまとまりからメッセージ単位を選び、送信者セレクタも推定する', () => {
  const topic = (msgs) => `<section class="topic">${msgs.map(([s, x]) =>
    `<div class="m" data-r="1"><span class="who" data-hovercard-id="h">${s}</span><span>9:0${x.length % 10}</span><div class="body">${x}</div></div>`).join('')}</section>`;
  const html = topic([['田中', '議題1'], ['佐藤', '返信1'], ['鈴木', '返信2']])
    + topic([['佐藤', '議題2'], ['田中', '返信3']])
    + topic([['鈴木', '議題3'], ['佐藤', '返信4'], ['田中', '返信5']]);
  const dom = new JSDOM(`<body><div role="main"><div role="list">${html}</div></div></body>`);
  const p = learnProfile(dom.window.document);
  assert.ok(p, '学習できること');
  const matched = dom.window.document.querySelectorAll(p.message);
  assert.equal(matched.length, 8, 'メッセージ単位で一致: ' + p.message);
  assert.ok(p.sender, '送信者セレクタを推定');
  assert.equal(matched[0].querySelector(p.sender).textContent, '田中');
});

test('メッセージが無いページでは学習しない（誤検出しない）', () => {
  const dom = new JSDOM('<body><div role="main"><div><span>ようこそ</span></div></div></body>');
  assert.equal(learnProfile(dom.window.document), null);
});

// 実機で発生: 学習済みセレクタが本文の無い要素（装飾など）を指していた
function withDeco(id, sender, text) {
  return oldMsg(id, sender, text) + `<div data-cd="x"><span aria-hidden="true">·</span></div>`;
}

test('保存された学習結果より、実機で確認済みの組み込みセレクタを優先する', async () => {
  const t = setup(withDeco('m1', '田中', 'おはよう') + withDeco('m2', '佐藤', 'はい') + withDeco('m3', '鈴木', '了解'));
  t.tracker.start({ name: 'learned', message: 'div[data-cd]', sender: null, body: null });
  assert.equal(t.tracker.getStatus().profileName, 'builtin-message-id');
  append(t.list(), withDeco('m4', '高橋', '読めること'));
  await wait(50);
  assert.deepEqual(t.spoken, ['高橋:読めること']);
});

test('学習したセレクタが本文の無い要素にばかり一致する場合は、捨てて学習し直す', async () => {
  // 組み込みが一致しない構造で、既存分は本文を持つため起動時は学習結果が採用されてしまうケース
  const deco = (txt) => `<div data-cd="x">${txt}</div>`;
  const t = setup(newMsg('田中', 'おはよう') + deco('古い') + newMsg('佐藤', '了解') + deco('古い') + newMsg('田中', '資料です'),
    { retryDelayMs: 10 });
  const rejected = [];
  t.tracker.onProfileRejected = (p) => rejected.push(p.message);
  t.tracker.start({ name: 'learned', message: 'div[data-cd]', sender: null, body: null });
  assert.equal(t.tracker.getStatus().messageSelector, 'div[data-cd]');
  append(t.list(), newMsg('佐藤', '1通目') + deco(''));
  await wait(100);
  append(t.list(), newMsg('佐藤', '2通目') + deco(''));
  await wait(100);
  assert.deepEqual(rejected, ['div[data-cd]']);
  const st = t.tracker.getStatus();
  assert.equal(st.profileName, 'learned');
  assert.notEqual(st.messageSelector, 'div[data-cd]');
  append(t.list(), newMsg('鈴木', '3通目'));
  await wait(50);
  assert.equal(t.spoken.at(-1), '鈴木:3通目');
});

// 実機で発生: DM を開いた直後の最初の送信が「既存扱い」になり、送信中表示のまま既読化された
test('「送信しています...」の間は読まず、送信完了後に 1 回だけ読む', async () => {
  const t = setup(OLD_LIST);
  t.tracker.start(null);
  append(t.list(), `<div data-message-id="p1"><span data-member-id="me">自分</span><div jsname="bgckF">あああ</div><span class="st">送信しています...</span></div>`);
  await wait(60);
  assert.deepEqual(t.spoken, [], '送信中は読まない');
  t.doc.querySelector('[data-message-id="p1"] .st').remove();
  await wait(80);
  assert.deepEqual(t.spoken, ['自分:あああ']);
});

test('画面切替後は過去ログの描画が落ち着いたら待機を終え、すぐ後の新着を読む', async () => {
  const t = setup(OLD_LIST, { warmupMs: 3000, navQuietMs: 100 });
  t.tracker.start(null);
  t.tracker.warmupUntil = 0; // 起動時の待機は省略
  t.dom.window.history.pushState({}, '', '/app/chat/dm2');
  append(t.list(), oldMsg('d1', '太郎', '過去1') + oldMsg('d2', '', '過去2'));
  await wait(40);
  append(t.list(), oldMsg('d3', '', '過去3'));
  await wait(250);
  append(t.list(), oldMsg('d4', '自分', '最初の送信'));
  await wait(50);
  assert.deepEqual(t.spoken, ['自分:最初の送信']);
});

// ---- 厳密チェックで見つかった不具合の再発防止 ----

test('本文の描画中に DOM 変化が続いても再試行回数を消費せず、本文が出たら読む（セレクタも破棄しない）', async () => {
  const t = setup(OLD_LIST, { retryDelayMs: 100, retryLimit: 3 });
  t.tracker.start(null);
  for (const id of ['e1', 'e2']) {
    append(t.list(), `<div data-message-id="${id}"><span data-member-id="u">太郎</span><div jsname="bgckF"></div></div>`);
    const body = t.doc.querySelector(`[data-message-id="${id}"] [jsname="bgckF"]`);
    for (let i = 0; i < 6; i++) { body.appendChild(t.doc.createElement('i')); await wait(25); }
    body.textContent = '遅い本文' + id;
    await wait(150);
  }
  assert.deepEqual(t.spoken, ['太郎:遅い本文e1', '太郎:遅い本文e2']);
  assert.equal(t.tracker.getStatus().profileName, 'builtin-message-id');
});

// 実機の構造: メッセージごとに別の枠（c-wiz）に入り、時刻 span[data-absolute-timestamp] を持つ
function realMsg(id, sender, text, ts) {
  return `<c-wiz data-topic-id="${id}"><div class="w"><div jsname="Ne3sFf" data-id="${id}">`
    + (sender ? `<span data-member-id="u" data-name="${sender}">${sender}</span>` : '')
    + `<span jsname="E53oB" data-absolute-timestamp="${ts}">1 分</span><div jsname="bgckF">${text}</div></div></div></c-wiz>`;
}

test('実機構造: 投稿時刻が古いメッセージ（少量の過去ログ読込）は読まず、新しいものは読む', async () => {
  const now = Date.now();
  const t = setup(realMsg('a', '太郎', '既存', now - 60000));
  t.tracker.start(null);
  t.list().insertAdjacentHTML('afterbegin', realMsg('h1', '花子', '昔の話1', now - 3600000) + realMsg('h2', '花子', '昔の話2', now - 3500000));
  await wait(50);
  append(t.list(), realMsg('n1', '次郎', '新着です', Date.now()));
  await wait(50);
  assert.deepEqual(t.spoken, ['次郎:新着です']);
});

test('実機構造: 名前が省略された連続投稿は、別の枠にある直前のメッセージの送信者を使う', async () => {
  const t = setup(realMsg('a', '太郎', '一通目', Date.now()));
  t.tracker.start(null);
  append(t.list(), realMsg('b', '', '二通目', Date.now()));
  await wait(50);
  assert.deepEqual(t.spoken, ['太郎:二通目']);
});

// ---- 2 回目の厳密チェックで見つかった不具合の再発防止 ----

test('組み込みセレクタは、画像だけ（本文なし）の投稿が続いても破棄しない', async () => {
  const t = setup(OLD_LIST, { retryDelayMs: 10 });
  t.tracker.start(null);
  for (const id of ['i1', 'i2', 'i3']) {
    append(t.list(), `<div data-message-id="${id}"><span data-member-id="u">太郎</span><div jsname="bgckF"><img src="x.png"></div></div>`);
    await wait(80);
  }
  assert.equal(t.tracker.getStatus().profileName, 'builtin-message-id');
  append(t.list(), oldMsg('t1', '太郎', '3分'));
  await wait(50);
  assert.deepEqual(t.spoken, ['太郎:3分'], '時刻のような本文も読む');
});

test('ドリフト（メッセージ以外の追加）で学習した結果が追加要素を説明できなければ採用しない', async () => {
  const sys = (txt) => `<div class="sys" data-kind="notice">${txt}</div>`;
  const t = setup(OLD_LIST + sys('入力中') + sys('入力中'));
  t.tracker.start(null);
  append(t.list(), sys('入力中'));
  await wait(40);
  append(t.list(), sys('入力中'));
  await wait(40);
  assert.equal(t.tracker.getStatus().profileName, 'builtin-message-id');
  assert.equal(t.tracker.getStatus().healCount, 0);
  append(t.list(), oldMsg('m9', '太郎', '通常どおり'));
  await wait(40);
  assert.deepEqual(t.spoken, ['太郎:通常どおり']);
});

test('学習器: 大きなページでも短時間で終わる（入れ子判定の計算量）', () => {
  const topic = (i) => `<c-wiz data-topic-id="t${i}"><div>` + [0, 1, 2].map((k) =>
    `<div jsname="Ne3sFf" data-id="m${i}_${k}"><span data-name="太郎">太郎</span>` + '<span class="x"><span class="y">あ</span></span>'.repeat(30)
    + `<div jsname="bgckF">本文${i}</div></div>`).join('') + '</div></c-wiz>';
  const dom = new JSDOM(`<body><div role="main"><div>${Array.from({ length: 120 }, (_, i) => topic(i)).join('')}</div></div></body>`);
  const t0 = Date.now();
  const p = learnProfile(dom.window.document);
  assert.ok(p);
  assert.ok(Date.now() - t0 < 5000, (Date.now() - t0) + 'ms');
});

test('学習器: メッセージ一覧（role="main"）の無いフレームでは学習しない', () => {
  const dom = new JSDOM(`<body><ul>${'<li><span>メニュー項目</span></li>'.repeat(5)}</ul></body>`);
  assert.equal(learnProfile(dom.window.document), null);
});

test('学習器: 時刻の要素（「2 分」）を送信者として学習しない', () => {
  const row = (who, txt) => `<div class="r" data-k="1"><span class="who">${who}</span><span data-absolute-timestamp="1">2 分</span><p>${txt}</p></div>`;
  const dom = new JSDOM(`<body><div role="main"><div>${row('太郎', 'あ')}${row('花子', 'い')}${row('太郎', 'う')}${row('次郎', 'え')}</div></div></body>`);
  const p = learnProfile(dom.window.document);
  assert.ok(p && p.sender && !/timestamp/.test(p.sender), p && p.sender);
});

// ---- 実機（招待されたスペースへの参加）で見つかった不具合の再発防止 ----

test('ID も投稿時刻も無いメッセージが再描画されても、同じ内容は再度読まない（時刻が違えば読む）', async () => {
  const sys = (txt, ts) => `<div class="m" data-kind="msg">${txt}${ts ? `<span data-absolute-timestamp="${ts}">今</span>` : ''}</div>`;
  const t = setup(OLD_LIST);
  t.tracker.start(null);
  const prof = { name: 'learned', message: 'div[data-kind="msg"]', sender: null, body: null };
  t.tracker.candidates = [prof];
  t.tracker.profile = prof;
  append(t.list(), sys('履歴がオンになっています'));
  await wait(50);
  // 画面の描き直し（同じ内容の新しい要素）
  t.list().querySelectorAll('[data-kind="msg"]').forEach((el) => el.remove());
  append(t.list(), sys('履歴がオンになっています'));
  await wait(50);
  const now = Date.now();
  append(t.list(), sys('了解', now));
  await wait(50);
  append(t.list(), sys('了解', now + 5000));
  await wait(50);
  assert.deepEqual(t.spoken, ['履歴がオンになっています', '了解', '了解']);
});

test('メッセージ一覧の無い画面では再学習を繰り返さず、失敗のログも繰り返さない', async () => {
  const dom = new JSDOM('<!doctype html><body><div class="invite-preview"><span>招待されています</span></div></body>');
  const logs = [];
  const tr = new ChatDomTracker(dom.window.document, { healthIntervalMs: 20, warmupMs: 0, log: (m) => logs.push(m) });
  active.push(tr);
  tr.start(null);
  await wait(200);
  assert.deepEqual(logs.filter((m) => m.includes('再学習')), []);
});
