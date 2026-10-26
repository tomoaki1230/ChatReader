// 未読監視（左側一覧）のテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { UnreadWatcher } = require('../src/content/unreadWatcher.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const active = [];
test.afterEach(() => { while (active.length) active.pop().stop(); });

const NAV = `<div role="navigation"><div role="tree">
  <div role="treeitem" aria-expanded="true"><span>スペース</span><div role="group">
    <div role="treeitem" id="s1"><span class="nm">開発チーム</span><span class="badge"></span></div>
    <div role="treeitem" id="s2"><span class="nm">営業</span><span class="badge"></span></div>
    <div role="treeitem" id="s3" aria-selected="true"><span class="nm">総務</span><span class="badge"></span></div>
    <div role="treeitem" id="s4"><span class="nm">田中 太郎</span><span class="badge">2</span></div>
  </div></div></div></div>
  <div role="main"><div role="treeitem"><span>メッセージ内の要素</span></div></div>`;

function setup(html, opts) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const doc = dom.window.document;
  const hits = [];
  const w = new UnreadWatcher(doc, { debounceMs: 10, warmupMs: 0, repeatGuardMs: 0, ...opts, onUnread: (u) => hits.push(u.name) });
  active.push(w);
  return { doc, w, hits, $: (s) => doc.querySelector(s) };
}

test('末端の項目だけを対象にし、メッセージ一覧内は除外する', () => {
  const t = setup(NAV);
  t.w.start();
  assert.equal(t.w.items.length, 4);
  assert.deepEqual(t.w.items.map((el) => t.w.nameOf(el)), ['開発チーム', '営業', '総務', '田中 太郎']);
});

test('未読数バッジが付いた・増えたスペースを通知する（起動時に既に未読のものは通知しない）', async () => {
  const t = setup(NAV);
  t.w.start();
  t.$('#s1 .badge').textContent = '1';
  await wait(40);
  t.$('#s4 .badge').textContent = '3';
  await wait(40);
  t.$('#s4 .badge').textContent = '3';
  await wait(40);
  assert.deepEqual(t.hits, ['開発チーム', '田中 太郎']);
});

test('開いているスペースは通知しない', async () => {
  const t = setup(NAV);
  t.w.start();
  t.$('#s3 .badge').textContent = '1';
  await wait(40);
  assert.deepEqual(t.hits, []);
});

test('aria-label の「未読」や太字でも検知する', async () => {
  const t = setup(NAV);
  t.w.start();
  t.$('#s2').setAttribute('aria-label', '営業、未読メッセージあり');
  await wait(40);
  t.$('#s1 .nm').style.fontWeight = '700';
  await wait(40);
  assert.deepEqual(t.hits, ['営業', '開発チーム']);
});

test('起動直後（warmup 中）の変化は通知しない', async () => {
  const t = setup(NAV, { warmupMs: 10000 });
  t.w.start();
  t.$('#s1 .badge').textContent = '1';
  await wait(40);
  assert.deepEqual(t.hits, []);
});

test('role 属性が無い一覧でも構造から項目を推定する', async () => {
  const item = (n) => `<div class="row"><span>${n}</span><span class="badge"></span></div>`;
  const t = setup(`<nav><div class="list">${item('チームA')}${item('チームB')}${item('チームC')}</div></nav><div role="main"></div>`);
  t.w.start();
  assert.equal(t.w.itemSource, 'learned');
  assert.equal(t.w.items.length, 3);
  t.doc.querySelectorAll('.badge')[1].textContent = '1';
  await wait(40);
  assert.deepEqual(t.hits, ['チームB']);
});

// 実機（2026-10）の Google Chat に合わせた構造: navigation 無し、Google バーのリンクあり
const REAL = `<header id="gb"><a aria-label="Google アカウント" href="https://accounts.google.com/x" role="button"></a>
    <a aria-label="ホーム" href="/home"></a></header>
  <div><span role="listitem" jsname="CmABtb" id="space/AAA/SCcFR" data-group-id="space/AAA" data-display-timestamp="1000">
      <span class="sr">未読</span><span>テスト2</span></span>
    <span role="listitem" jsname="CmABtb" id="space/BBB/SCcFR" data-group-id="space/BBB" data-display-timestamp="2000">
      <span class="sr">未読</span><span>開発</span></span></div>
  <div role="main" data-group-id="space/BBB"><div jsname="Ne3sFf">本文</div></div>`;

test('実機構造: スペース ID 付きの項目を対象にし、Google バーは除外する', () => {
  const t = setup(REAL);
  t.w.start();
  assert.equal(t.w.itemSource, 'group-id');
  assert.deepEqual(t.w.items.map((el) => t.w.nameOf(el)), ['テスト2', '開発']);
});

test('実機構造: 最新メッセージ時刻が更新されたスペースを通知し、開いているスペースは除外する', async () => {
  const t = setup(REAL);
  t.w.start();
  t.$('[data-group-id="space/BBB"]').setAttribute('data-display-timestamp', '3000');
  await wait(40);
  assert.deepEqual(t.hits, [], '開いているスペース');
  t.$('[data-group-id="space/AAA"]').setAttribute('data-display-timestamp', '4000');
  await wait(40);
  assert.deepEqual(t.hits, ['テスト2']);
});

test('実機構造: DM の項目に入る在席状況（オンライン等）は名前として扱わない', () => {
  const t = setup(`<div>
    <span role="listitem" data-group-id="dm/1" data-display-timestamp="1"><span>未読</span><span>オンライン</span><span>太郎</span></span>
    <span role="listitem" data-group-id="dm/2" data-display-timestamp="1"><span>未読メッセージ 2 件</span><span>退席中</span><span>花子</span></span>
    <span role="listitem" data-group-id="space/3" data-display-timestamp="1"><span>未読対応チーム</span></span></div>
    <div role="main" data-group-id="space/X"></div>`);
  t.w.start();
  assert.deepEqual(t.w.items.map((el) => t.w.nameOf(el)), ['太郎', '花子', '未読対応チーム']);
});

test('監視開始後に一覧へ新しく現れた項目（初めての DM など）も、最新時刻が新しければ通知する', async () => {
  const t = setup(REAL);
  t.w.start();
  const list = t.$('[data-group-id="space/AAA"]').parentElement;
  list.insertAdjacentHTML('afterbegin', `<span role="listitem" data-group-id="dm/NEW" data-display-timestamp="${Date.now() + 1000}"><span>次郎</span></span>`
    + `<span role="listitem" data-group-id="dm/OLD" data-display-timestamp="5"><span>古い相手</span></span>`);
  await wait(40);
  assert.deepEqual(t.hits, ['次郎']);
});

test('スペースが 1 つだけでも監視する', async () => {
  const t = setup(`<div><span role="listitem" data-group-id="space/ONLY" data-display-timestamp="1"><span>唯一</span></span></div>
    <div role="main" data-group-id="dm/X"></div>`);
  t.w.start();
  assert.equal(t.w.items.length, 1);
  t.$('[data-group-id="space/ONLY"]').setAttribute('data-display-timestamp', String(Date.now() + 1000));
  await wait(40);
  assert.deepEqual(t.hits, ['唯一']);
});

test('メッセージ一覧の無いフレームの（スペース ID の無い）一覧や、左側一覧の外の一覧は監視しない（誤ったお知らせを出さない）', () => {
  const noMain = setup(`<nav>${'<span role="listitem"><span>メニュー</span></span>'.repeat(4)}</nav>`);
  noMain.w.start();
  assert.equal(noMain.w.items.length, 0);
  const menu = setup(`<ul>${'<li role="listitem"><span>メニュー</span></li>'.repeat(4)}</ul><div role="main"></div>`);
  menu.w.start();
  assert.equal(menu.w.items.length, 0);
});

// 実機で発生: 読み上げ済みのスペースを、新着が無いのに後から「新着メッセージ」と知らせた
test('実機構造: 太字の数が変わっただけ（新着なし）では知らせない', async () => {
  const item = (gid, name, ts, bold) => `<span role="listitem" data-group-id="${gid}" data-display-timestamp="${ts}">`
    + `<span>未読</span><span class="nm" style="font-weight:${bold ? 700 : 400}">${name}</span></span>`;
  const t = setup(`<div>${item('space/T', 'テスト', 100, false)}${item('space/T2', 'テスト2', 100, false)}${item('dm/taro', '太郎', 100, false)}</div>
    <div role="main" data-group-id="space/T2"></div>`);
  t.w.start();
  const bold = (gid, on) => { t.$(`[data-group-id="${gid}"] .nm`).style.fontWeight = on ? '700' : '400'; };
  // 新着（最新時刻の更新）→ 知らせる
  t.$('[data-group-id="space/T"]').setAttribute('data-display-timestamp', '200'); bold('space/T', true);
  await wait(40);
  t.$('[data-group-id="dm/taro"]').setAttribute('data-display-timestamp', '200'); bold('dm/taro', true);
  await wait(40);
  assert.deepEqual(t.hits, ['テスト', '太郎']);
  // 新着なしで太字の数だけ変わる（3 件中 3 件 → 2 件）
  bold('space/T2', true);
  await wait(40);
  bold('space/T2', false);
  await wait(40);
  assert.deepEqual(t.hits, ['テスト', '太郎'], '新着が無いのに知らせない');
});

// 実機で発生: Chat のホーム画面（/app/home）には role="main" が無く、B が休止していた
test('実機構造: メッセージ一覧の無いホーム画面でも、スペース ID 付きの一覧があれば監視する', async () => {
  const t = setup(`<div><span role="listitem" data-group-id="space/A" data-display-timestamp="1"><span>テスト</span></span>
    <span role="listitem" data-group-id="dm/taro" data-display-timestamp="1"><span>オンライン</span><span>太郎</span></span></div>
    <div class="home"><span>ホーム</span></div>`);
  t.w.start();
  assert.equal(t.w.itemSource, 'group-id');
  t.$('[data-group-id="space/A"]').setAttribute('data-display-timestamp', String(Date.now() + 1000));
  await wait(40);
  assert.deepEqual(t.hits, ['テスト']);
});

// ---- 実際の画面（ホーム画面の保存ページ）の構造での確認 ----
const real = require('./fixtures/chatDom.js');

test('実画面: 名前は <bdi>（左側一覧）・名前欄（ホーム画面）から取り、未読・在席状況・種別・ボタン名を混ぜない', () => {
  const t = setup(`<div>${real.navItem('space/A', '定例会', 1)}${real.navItem('dm/x', '佐藤 一郎', 1, { presence: '会議中（予定あり）', type: 'ダイレクト メッセージ' })}</div>`
    + `<div class="home">${real.homeCard('space/B', '営業チーム', 1, { sender: '鈴木', body: 'お疲れ様です' })}</div>`);
  t.w.start();
  assert.deepEqual(t.w.items.map((el) => t.w.nameOf(el)), ['定例会', '佐藤 一郎', '営業チーム']);
});

test('実画面: 同じスペースが左側一覧とホーム画面の両方にあっても 1 件として扱い、知らせるのは 1 回', async () => {
  const t = setup(`<div>${real.navItem('space/A', '定例会', 1)}</div><div class="home">${real.homeCard('space/A', '定例会', 1, { sender: '鈴木', body: '前の話' })}</div>`);
  const payloads = [];
  t.w.onUnread = (u) => payloads.push(u);
  t.w.start();
  assert.equal(t.w.getStatus().navItems, 1, 'スペース単位の件数');
  const ts = String(Date.now() + 1000);
  t.$('.nav, div').querySelector('[data-group-id="space/A"]').setAttribute('data-display-timestamp', ts);
  const card = t.$('.home [data-group-id="space/A"]');
  card.setAttribute('data-display-timestamp', ts);
  card.querySelector('[data-absolute-timestamp]').setAttribute('data-absolute-timestamp', ts);
  card.querySelector('[jsname="ok3btb"]').innerHTML = '<span jsname="rJxwpd">鈴木:</span>新着です';
  await wait(40);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].name, '定例会');
  assert.deepEqual(payloads[0].getPreview(), { sender: '鈴木', text: '新着です', senderPending: false });
});

test('実画面: プレビューの送信者が「名前を読み込み中...」の間は送信者未確定として返す', async () => {
  const t = setup(`<div class="home">${real.homeCard('space/A', '定例会', 1, { sender: '名前を読み込み中...', body: 'あれあれ' })}</div>`);
  t.w.start();
  const el = t.$('[data-group-id="space/A"]');
  assert.deepEqual(t.w.previewOf(el, 1), { sender: '', text: 'あれあれ', senderPending: true });
});

test('実画面: プレビューの時刻が最新時刻と違う（古いプレビュー）なら本文を使わない', () => {
  const t = setup(`<div class="home">${real.homeCard('space/A', '定例会', 200, { sender: '鈴木', body: '古い話', previewTs: 100 })}</div>`);
  t.w.start();
  assert.equal(t.w.previewOf(t.$('[data-group-id="space/A"]'), 200), null);
});

test('実画面: ホーム画面で既読（data-is-unread="false"）のまま時刻だけ進んだ場合（別端末からの自分の投稿など）は知らせない', async () => {
  const t = setup(`<div class="home">${real.homeCard('space/A', '定例会', 1, { unread: false, sender: '自分', body: 'a' })}</div>`);
  t.w.start();
  t.$('[data-group-id="space/A"]').setAttribute('data-display-timestamp', String(Date.now() + 1000));
  await wait(40);
  assert.deepEqual(t.hits, []);
});

test('実画面: 「未読にする」ボタンや「未読フィルタを切り替え」は未読の表示とみなさない', () => {
  const t = setup(`<div class="home">${real.homeCard('space/A', '定例会', 1, { unread: false })}</div>`);
  assert.equal(t.w.hasUnreadLabel(t.$('[data-group-id="space/A"]')), false);
});
