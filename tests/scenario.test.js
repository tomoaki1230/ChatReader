// 実機に近い Google Chat の DOM での通しシナリオ試験
// コンテンツスクリプト（MAIN + ISOLATED）と background を本物のまま読み込み、「画面の変化 → 読み上げ」まで確認する
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const MAIN_SCRIPTS = MANIFEST.content_scripts.find((c) => c.world === 'MAIN').js;
const SCRIPTS = MANIFEST.content_scripts.find((c) => c.world !== 'MAIN').js;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 各シナリオは別々のページで動き互いに影響しないため、まとめて並列に実行する（起動待ち約 5 秒を重ねて時間を短縮）
const scenarios = [];
function scenario(name, fn) { scenarios.push([name, fn]); }

// ---- 実機の Google Chat の構造を再現する部品 ----
function message({ id, sender, text, ts }) {
  return `<div jsname="Ne3sFf" role="group" data-id="${id}">`
    + (sender ? `<span class="nzVtF"><span data-member-id="user/${sender}" data-name="${sender}">${sender}</span></span>` : '')
    + `<div data-cd="inline" aria-hidden="true"><span>,</span><span jsname="E53oB" data-absolute-timestamp="${ts}">2 分</span></div>`
    + `<div jsname="bgckF">${text}</div>`
    + `<div role="list"><div role="listitem"><div role="button" aria-label="リアクションを追加"></div></div></div></div>`;
}
function topic(m) {
  return `<c-wiz data-topic-id="${m.id}"><div jsname="oaLnEd">${message(m)}</div><div class="replies"></div></c-wiz>`;
}
// 左側一覧・ホーム画面の項目は実際の画面と同じ構造の部品を使う
const real = require('./fixtures/chatDom.js');
function navItem(gid, name, ts, presence, unread) {
  return real.navItem(gid, name, ts, { presence, bold: unread, type: gid.startsWith('dm/') ? 'ダイレクト メッセージ' : 'スペース' });
}

const T0 = Date.now() - 5 * 60 * 1000;
const SPACES = {
  'space/A': { name: 'テスト2', history: [{ id: 'a1', sender: '太郎', text: '既存1', ts: T0 }, { id: 'a2', sender: '花子', text: '既存2', ts: T0 + 1 }] },
  'space/B': { name: '開発', history: [{ id: 'b1', sender: '次郎', text: '開発の既存', ts: T0 }] },
  'dm/taro': { name: '太郎', history: [{ id: 'd1', sender: '太郎', text: 'DM既存', ts: T0 }] }
};

async function openChat(t, settings, opts = {}) {
  const startGid = opts.start || 'space/A';
  const nav = Object.entries(SPACES).map(([gid, s]) => navItem(gid, s.name, T0 + 10, gid.startsWith('dm/') ? 'オンライン' : '', gid === 'space/B')).join('');
  // ホーム画面（/app/home）: メッセージ一覧（role="main"）が無く、会話一覧にプレビューが出る
  const home = Object.entries(SPACES).map(([gid, s]) => real.homeCard(gid, s.name, T0 + 10, { sender: s.history[0].sender, body: s.history[0].text, unread: false })).join('');
  const center = opts.home
    ? `<div class="home">${home}</div><div id="list"></div>`
    : `<div role="main" data-group-id="${startGid}" aria-label="${SPACES[startGid].name}"><div id="list">${SPACES[startGid].history.map(topic).join('')}</div></div>`;
  const dom = new JSDOM(`<!doctype html><html><body>
    <header id="gb"><a href="/home" aria-label="ホーム"></a></header>
    <div class="nav">${opts.lateNav ? '' : nav}</div>
    ${center}
    <div id="box" contenteditable="true"></div></body></html>`,
  { url: 'https://chat.google.com/app/' + (opts.home ? 'home' : 'chat/' + startGid.split('/')[1]), runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  t.after(() => w.close());
  const spoken = [];
  const logs = [];
  const sync = { ...settings };
  const changeListeners = [];
  // background（Service Worker）を vm で読み込む
  let bgListener = null;
  const bgChrome = {
    tts: {
      speak: async (text) => { spoken.push(text); },
      stop: () => {},
      getVoices: async () => [{ voiceName: 'Microsoft Haruka', lang: 'ja-JP', remote: false }]
    },
    storage: {
      sync: { get: async () => ({ ...sync }), set: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {} }
    },
    runtime: { onMessage: { addListener: (fn) => { bgListener = fn; } }, onInstalled: { addListener: () => {} } }
  };
  const ctx = { chrome: bgChrome, console, setTimeout, clearTimeout, Date };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), ctx);
  // コンテンツスクリプト側の chrome
  w.chrome = {
    runtime: {
      id: 'x',
      sendMessage: (m) => {
        const msg = JSON.parse(JSON.stringify(m));
        if (msg.type === 'CR_LOG') logs.push(msg.text);
        else bgListener(msg, {}, () => {});
        return Promise.resolve();
      }
    },
    storage: {
      sync: { get: async () => ({ ...sync }) },
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: (fn) => changeListeners.push(fn) }
    }
  };
  w.document.hasFocus = () => false;
  w.console.debug = () => {};
  w.console.info = () => {};
  w.eval(`window.Notification = class Notification { constructor(t, o) { this.title = t; } static get permission() { return 'granted'; } };`);
  for (const f of MAIN_SCRIPTS) w.eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  for (const f of SCRIPTS) w.eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  const doc = w.document;
  const page = {
    w, doc, spoken, logs,
    list: () => doc.getElementById('list'),
    async startup() { await wait(5200); },
    addTopic(m) { page.list().insertAdjacentHTML('beforeend', topic({ ts: Date.now(), ...m })); },
    addReply(topicId, m) { doc.querySelector(`c-wiz[data-topic-id="${topicId}"] .replies`).insertAdjacentHTML('beforeend', message({ ts: Date.now(), ...m })); },
    // 設定画面での変更（chrome.storage.sync）を再現
    changeSettings(patch) { Object.assign(sync, patch); for (const fn of changeListeners) fn({}, 'sync'); },
    requestRelearn() { for (const fn of changeListeners) fn({ relearnRequest: { newValue: Date.now() } }, 'local'); },
    renderNav() { doc.querySelector('.nav').innerHTML = nav; },
    setNavTs(gid, ts) { doc.querySelector(`.nav [data-group-id="${gid}"]`).setAttribute('data-display-timestamp', String(ts)); },
    // ホーム画面の会話一覧で、新着によりプレビューが変わる（Chat は時刻・未読・プレビューを更新する）
    homeArrive(gid, ts, sender, body) {
      page.setNavTs(gid, ts);
      const card = doc.querySelector(`.home [data-group-id="${gid}"]`);
      card.setAttribute('data-display-timestamp', String(ts));
      card.setAttribute('data-is-unread', 'true');
      card.querySelector('[data-absolute-timestamp]').setAttribute('data-absolute-timestamp', String(ts));
      card.querySelector('[jsname="ok3btb"]').innerHTML = `<span jsname="rJxwpd">${sender}:</span>${body}`;
    },
    setPreviewSender(gid, sender) { doc.querySelector(`.home [data-group-id="${gid}"] [jsname="rJxwpd"]`).textContent = sender + ':'; },
    notify(title, body) { w.eval(`new Notification(${JSON.stringify(title)}, { body: ${JSON.stringify(body)} })`); },
    switchTo(gid) {
      w.history.pushState({}, '', '/app/chat/' + gid.split('/')[1]);
      const main = doc.querySelector('[role="main"]');
      main.setAttribute('data-group-id', gid);
      main.setAttribute('aria-label', SPACES[gid].name);
      page.list().innerHTML = SPACES[gid].history.map(topic).join('');
    }
  };
  return page;
}

scenario('シナリオ1: 開いているスペースの新着・返信は読み、編集・リアクション・時刻更新は読まない', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  p.addTopic({ id: 'n1', sender: '太郎', text: 'こんにちは' });
  await wait(400);
  p.addReply('n1', { id: 'r1', sender: '花子', text: '返信です' });
  await wait(400);
  p.doc.querySelector('[data-id="a1"] [jsname="bgckF"]').textContent = '既存1（編集）';
  p.doc.querySelector('[data-id="a2"] [role="list"]').insertAdjacentHTML('beforeend', '<div role="listitem"><img alt="👍"><span>1</span></div>');
  p.doc.querySelector('[data-id="a1"] [jsname="E53oB"]').textContent = '3 分';
  await wait(400);
  assert.deepEqual(p.spoken, ['テスト2、太郎、こんにちは', 'テスト2、花子、返信です']);
});

scenario('シナリオ2: スペースを切り替えると過去ログは読まず、切替後の新着は新しいスペース名で読む', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  p.switchTo('space/B');
  await wait(1500);
  p.addTopic({ id: 'n2', sender: '次郎', text: '開発の新着' });
  await wait(400);
  assert.deepEqual(p.spoken, ['開発、次郎、開発の新着']);
});

scenario('シナリオ3: DM を開いている時は「太郎、本文」（在席状況やスペース名を重ねない）', async (t) => {
  const p = await openChat(t, {}, { start: 'dm/taro' });
  await p.startup();
  p.addTopic({ id: 'n3', sender: '太郎', text: '大丈夫です' });
  await wait(400);
  assert.deepEqual(p.spoken, ['太郎、大丈夫です']);
});

scenario('シナリオ4: 同じメッセージの通知が画面より先に届いても 1 回だけ読む', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  p.notify('太郎 (テスト2)', '先に通知');
  p.addTopic({ id: 'n4', sender: '太郎', text: '先に通知' });
  await wait(400);
  assert.deepEqual(p.spoken, ['テスト2、太郎、先に通知']);
});

scenario('シナリオ5: 別スペースの新着は通知で本文を読み、B のお知らせは重ねない', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  p.setNavTs('space/B', Date.now());
  p.notify('次郎 (開発)', 'ビルド完了');
  await wait(2800);
  assert.deepEqual(p.spoken, ['開発、次郎、ビルド完了']);
});

scenario('シナリオ6: 通知が出ない別スペースの新着は B でスペース名を知らせる（DM は相手の名前）', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  p.setNavTs('space/B', Date.now());
  await wait(1200);
  p.setNavTs('dm/taro', Date.now() + 1);
  await wait(2800);
  assert.deepEqual(p.spoken, ['開発 に新着メッセージ', '太郎 に新着メッセージ']);
});

scenario('シナリオ7: ページの読み込みが遅く左側一覧が後から表示されても、既存の未読は知らせない', async (t) => {
  const p = await openChat(t, {}, { lateNav: true });
  await p.startup();
  p.renderNav();
  await wait(2800);
  assert.deepEqual(p.spoken, []);
});

scenario('シナリオ8: 再接続などで通知が一度に大量に届いても、読み上げは数件に抑える', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  for (let i = 0; i < 8; i++) p.notify(`次郎 (開発)`, `まとめて届いた通知${i}`);
  await wait(3500);
  assert.ok(p.spoken.length <= 4, p.spoken.join(' / '));
  assert.ok(p.spoken.some((t) => /ほか \d+ 件/.test(t)), p.spoken.join(' / '));
});

scenario('シナリオ9: 長文は最大文字数で切り、絵文字を途中で壊さない', async (t) => {
  const p = await openChat(t, { maxLength: 21 });
  await p.startup();
  p.addTopic({ id: 'n9', sender: '太郎', text: '😀'.repeat(30) });
  await wait(400);
  assert.equal(p.spoken.length, 1);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(p.spoken[0]), '壊れたサロゲートペアがない');
  assert.ok(p.spoken[0].endsWith('、以下省略'));
});

scenario('シナリオ10: 自分の投稿は既定で読まず、設定 ON なら「自分」として読む', async (t) => {
  await Promise.all([[{}, []], [{ readOwnMessages: true }, ['テスト2、自分、送ります']]].map(async ([settings, expected]) => {
    const p = await openChat(t, settings);
    await p.startup();
    const box = p.doc.getElementById('box');
    box.textContent = '送ります';
    box.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    p.addTopic({ id: 'own1', sender: '自分', text: '送ります' });
    await wait(400);
    assert.deepEqual(p.spoken, expected);
    // 診断ログ: 監視開始（採用セレクタ）と、読まなかった理由が残る
    assert.ok(p.logs.some((l) => l.startsWith('監視開始: ') && l.includes('div[jsname="Ne3sFf"]')), p.logs.join('\n'));
    if (!settings.readOwnMessages) assert.ok(p.logs.some((l) => l.startsWith('→ 自分のメッセージのため省略')));
  }));
});

scenario('シナリオ11: 開いていない DM の通知は「太郎、本文」で読み、B のお知らせは重ねない', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  p.setNavTs('dm/taro', Date.now());
  p.notify('太郎', 'DMの本文');
  await wait(2800);
  assert.deepEqual(p.spoken, ['太郎、DMの本文']);
});

scenario('シナリオ12: 自分宛てのメンションは除いて読む（画面・通知とも）', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  p.addTopic({ id: 'm12', sender: '太郎', text: '<span data-name="Tomoaki Bessho" data-member-id="user/me">@Tomoaki Bessho</span> 確認お願いします' });
  await wait(400);
  p.notify('太郎 (開発)', '@Tomoaki Bessho 資料を送りました');
  await wait(100);
  assert.deepEqual(p.spoken, ['テスト2、太郎、確認お願いします', '開発、太郎、資料を送りました']);
});

scenario('シナリオ13: 同じ文面を別の人が同時に投稿したら両方読む', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  p.addTopic({ id: 's1', sender: '太郎', text: 'おはようございます' });
  p.addTopic({ id: 's2', sender: '花子', text: 'おはようございます' });
  await wait(400);
  assert.deepEqual(p.spoken, ['テスト2、太郎、おはようございます', 'テスト2、花子、おはようございます']);
});

scenario('シナリオ14: スペース切替後に過去ログが遅れて届いても読まない', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  p.switchTo('space/B');
  await wait(1500);
  p.list().insertAdjacentHTML('afterbegin', topic({ id: 'old1', sender: '次郎', text: '遅れて届いた過去ログ', ts: T0 - 3600000 }));
  await wait(400);
  assert.deepEqual(p.spoken, []);
});

scenario('シナリオ15: 使用中に設定を変えるとすぐ反映される（OFF → ON、スペース名なし）', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  p.changeSettings({ enabled: false });
  await wait(50);
  p.addTopic({ id: 'c1', sender: '太郎', text: 'OFF中' });
  await wait(400);
  p.changeSettings({ enabled: true, readSpaceName: false });
  await wait(50);
  p.addTopic({ id: 'c2', sender: '太郎', text: 'ON後' });
  await wait(400);
  assert.deepEqual(p.spoken, ['太郎、ON後']);
});

scenario('シナリオ16: 正常に動いている時に「セレクタを再学習」を押しても、新着・返信を正しく読み続ける', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  for (const [i, who] of ['太郎', '花子', '次郎', '太郎'].entries()) p.addTopic({ id: 'h' + i, sender: who, text: '既存の追加' + i, ts: T0 + 100 + i });
  await wait(400);
  p.spoken.length = 0;
  p.requestRelearn();
  await wait(100);
  p.addTopic({ id: 'h9', sender: '花子', text: '再学習後の新着' });
  await wait(400);
  p.addReply('h9', { id: 'h9r', sender: '太郎', text: '再学習後の返信' });
  await wait(400);
  assert.deepEqual(p.spoken, ['テスト2、花子、再学習後の新着', 'テスト2、太郎、再学習後の返信']);
});

// 実機で確認: メンバーの招待・参加は本文要素（bgckF）を持たず、名前が送信者として切り離される
function systemMessage(id, parts) {
  return `<c-wiz data-topic-id="${id}"><div jsname="oaLnEd"><div jsname="Ne3sFf" role="group" data-id="${id}">`
    + `<span>スペースの更新情報:</span>${parts}<span jsname="E53oB" data-absolute-timestamp="${Date.now()}">今</span></div></div></c-wiz>`;
}

scenario('シナリオ17: スペースの更新情報（招待・参加）を自然な文で読む／設定 OFF なら読まない', async (t) => {
  await Promise.all([
    [{}, ['テスト2、Tomoaki Bessho さんが 太郎 を招待しました', 'テスト2、太郎 さんが参加しました']],
    [{ readSystemMessages: false }, []]
  ].map(async ([settings, expected]) => {
    const p = await openChat(t, settings);
    await p.startup();
    p.list().insertAdjacentHTML('beforeend', systemMessage('sys1',
      '<span data-member-id="user/me" data-name="Tomoaki Bessho">Tomoaki Bessho</span><span>さんが</span><span data-name="太郎">太郎</span><span>を招待しました</span>'));
    await wait(400);
    p.list().insertAdjacentHTML('beforeend', systemMessage('sys2', '<span data-member-id="user/taro" data-name="太郎">太郎</span><span>さんが参加しました</span>'));
    await wait(400);
    assert.deepEqual(p.spoken, expected);
  }));
});

scenario('シナリオ18: 自分の参加（更新情報）は、自分のメッセージを読まない設定なら読まない', async (t) => {
  await Promise.all([
    [{}, ['テスト2、太郎 さんが参加しました']],
    [{ readOwnMessages: true }, ['テスト2、自分、送ります', 'テスト2、Tomoaki Bessho さんが参加しました', 'テスト2、太郎 さんが参加しました']]
  ].map(async ([settings, expected]) => {
    const p = await openChat(t, settings);
    await p.startup();
    // 自分の投稿（表示は「自分」、data-name に本名）から本名を覚える
    p.list().insertAdjacentHTML('beforeend', topic({ id: 'me1', sender: '自分', text: '送ります', ts: Date.now() }).replace('data-name="自分"', 'data-name="Tomoaki Bessho"'));
    await wait(400);
    p.list().insertAdjacentHTML('beforeend', systemMessage('j1', '<span data-member-id="user/me" data-name="Tomoaki Bessho">Tomoaki Bessho</span><span>さんが参加しました</span>'));
    await wait(400);
    p.list().insertAdjacentHTML('beforeend', systemMessage('j2', '<span data-member-id="user/taro" data-name="太郎">太郎</span><span>さんが参加しました</span>'));
    await wait(400);
    assert.deepEqual(p.spoken, expected);
  }));
});

scenario('シナリオ19: 参加などで画面が描き直されても、読んだ更新情報を再度読まない', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  const html = '<c-wiz data-topic-id="h"><div jsname="Ne3sFf" role="group"><span>スペースの更新情報:</span><span>履歴がオンになっています</span></div></c-wiz>';
  p.list().insertAdjacentHTML('beforeend', html);
  await wait(400);
  p.list().querySelector('c-wiz[data-topic-id="h"]').remove();
  p.list().insertAdjacentHTML('beforeend', html);
  await wait(400);
  assert.deepEqual(p.spoken, ['テスト2、履歴がオンになっています']);
  // 重複防止（15 秒）頼みではなく、描き直しとして検出段階で除外していること（実機では 2 回目が 20 秒後だった）
  assert.equal(p.logs.filter((t) => t.startsWith('DOM 検出（スペースの更新情報）')).length, 1, p.logs.join('\n'));
  assert.ok(p.logs.some((t) => t.includes('既に読んだメッセージと同じ内容の再描画')));
});

scenario('シナリオ20: 自分の表示名を設定するとその名前の投稿は読まない／「スペース名だけ」なら通知の本文は読まない', async (t) => {
  const p = await openChat(t, { ownName: '山田', otherSpaces: 'nameOnly' });
  await p.startup();
  p.addTopic({ id: 'y1', sender: '山田', text: '別端末から送信' });
  p.notify('次郎 (開発)', '通知の本文');
  await wait(400);
  p.addTopic({ id: 'y2', sender: '太郎', text: '他人の投稿' });
  await wait(400);
  assert.deepEqual(p.spoken, ['テスト2、太郎、他人の投稿']);
});

scenario('シナリオ21: ホーム画面では通知が出なくてもプレビューから送信者と本文を読む（名前の読み込みを待つ）', async (t) => {
  const p = await openChat(t, {}, { home: true });
  await p.startup();
  p.homeArrive('space/B', Date.now(), '名前を読み込み中...', 'ビルドが完了しました');
  await wait(1400);
  p.setPreviewSender('space/B', '次郎');
  await wait(2500);
  p.homeArrive('dm/taro', Date.now() + 1, '太郎', 'DMの本文');
  await wait(2800);
  assert.deepEqual(p.spoken, ['開発、次郎、ビルドが完了しました', '太郎、DMの本文']);
});

scenario('シナリオ22: ホーム画面で通知とプレビューの両方が届いても 1 回だけ読む／「スペース名だけ」なら本文は読まない', async (t) => {
  const [a, b] = await Promise.all([openChat(t, {}, { home: true }), openChat(t, { otherSpaces: 'nameOnly' }, { home: true })]);
  await Promise.all([a.startup(), b.startup()]);
  for (const p of [a, b]) {
    p.notify('次郎 (開発)', '同じ内容です');
    p.homeArrive('space/B', Date.now(), '次郎', '同じ内容です');
  }
  await wait(2800);
  assert.deepEqual(a.spoken, ['開発、次郎、同じ内容です']);
  assert.deepEqual(b.spoken, ['開発 に新着メッセージ']);
});

scenario('シナリオ23: 本文欄の無い更新情報は直前の送信者を借りず、メールアドレスの名前は「@」より前だけ読む', async (t) => {
  const p = await openChat(t, {});
  await p.startup();
  p.list().insertAdjacentHTML('beforeend', '<c-wiz data-topic-id="ev1"><div jsname="Ne3sFf" role="group">'
    + '<span>sato@example.com さんは 太郎 さんから </span><a href="#">招待</a><span> されましたが、まだ参加していません</span></div></c-wiz>');
  await wait(400);
  p.addTopic({ id: 'em1', sender: 'sato@example.com', text: 'よろしくお願いします' });
  await wait(400);
  assert.deepEqual(p.spoken, ['テスト2、sato さんは 太郎 さんから 招待 されましたが、まだ参加していません', 'テスト2、sato、よろしくお願いします']);
});

describe('通しシナリオ', { concurrency: true, timeout: 120000 }, () => {
  for (const [name, fn] of scenarios) it(name, { timeout: 60000 }, fn);
});
