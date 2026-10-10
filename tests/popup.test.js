// 設定画面（ポップアップ）のスモークテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const DIR = path.join(__dirname, '..', 'src', 'popup');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(local) {
  const html = fs.readFileSync(path.join(DIR, 'popup.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://x/popup/popup.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.chrome = {
    storage: {
      sync: { get: async () => ({}), set: async () => {} },
      local: { get: async () => ({ ...local }), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} }
    },
    tts: { getVoices: async () => [{ voiceName: 'Google 日本語', lang: 'ja-JP', remote: true }, { voiceName: 'Microsoft Haruka', lang: 'ja-JP', remote: false }] },
    runtime: { sendMessage: async () => {} }
  };
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'settings.js'), 'utf8'));
  // popup.js は非同期 IIFE のため、例外を捕捉できるよう Promise として評価する
  const p = w.eval(fs.readFileSync(path.join(DIR, 'popup.js'), 'utf8').replace(/^\(async function \(\) \{/m, 'window.__p = (async function () {'));
  await w.__p.catch((e) => errors.push(e.message));
  await wait(10);
  return { w, doc: w.document, errors };
}

test('エラーなく表示され、診断欄は既定で閉じている', async () => {
  const { doc, errors } = await open({ trackerStatus: { state: 'tracking', matchCount: 13, profileName: 'builtin-jsname', healCount: 0 } });
  assert.deepEqual(errors, []);
  for (const id of ['diagPanel', 'diagStatus', 'diagLog', 'diagDump']) assert.equal(doc.getElementById(id).open, false, id);
  assert.equal(doc.getElementById('diagSummary').textContent, '監視中（一致 13 件）');
});

test('声の一覧にオンライン音声を表示しない', async () => {
  const { doc } = await open({});
  const names = Array.from(doc.querySelectorAll('#voiceName option')).map((o) => o.value);
  assert.deepEqual(names, ['', 'Microsoft Haruka']);
});

test('通知が ON でないと本文が読まれない旨を表示し、未許可なら強調する', async () => {
  const ok = await open({ otherSpaceStatus: { permission: 'granted', hooked: true, notifyCount: 0 } });
  const note1 = ok.doc.getElementById('notifyNote');
  assert.match(note1.textContent, /デスクトップ通知を ON/);
  assert.equal(note1.classList.contains('warn'), false);
  const ng = await open({ otherSpaceStatus: { permission: 'denied', hooked: true, notifyCount: 0 } });
  const note2 = ng.doc.getElementById('notifyNote');
  assert.equal(note2.classList.contains('warn'), true);
  assert.match(note2.textContent, /^現在、Chat の通知が許可されていません（ブロック）。本文まで読むには/);
});

test('メンション設定の注意書きを表示する', async () => {
  const { doc } = await open({});
  assert.match(doc.getElementById('mentionNote').textContent, /最初の空白までしか除けず/);
});

test('声の一覧が空で取得された時は、保存済みの声を消さない', async () => {
  const html = fs.readFileSync(path.join(DIR, 'popup.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://x/popup/popup.html', runScripts: 'outside-only' });
  const w = dom.window;
  const saved = [];
  w.chrome = {
    storage: {
      sync: { get: async () => ({ voiceName: 'Microsoft Haruka' }), set: async (v) => { saved.push(v); } },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} }
    },
    tts: { getVoices: async () => [] },
    runtime: { sendMessage: async () => {} }
  };
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'settings.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(DIR, 'popup.js'), 'utf8').replace(/^\(async function \(\) \{/m, 'window.__p = (async function () {'));
  await w.__p;
  assert.deepEqual(saved, []);
});

test('「@全員」の設定は、メンションを読み上げない設定が OFF の時は操作できない', async () => {
  const html = fs.readFileSync(path.join(DIR, 'popup.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://x/popup/popup.html', runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = {
    storage: {
      sync: { get: async () => ({ skipMentions: false }), set: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} }
    },
    tts: { getVoices: async () => [] },
    runtime: { sendMessage: async () => {} }
  };
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'settings.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(DIR, 'popup.js'), 'utf8').replace(/^\(async function \(\) \{/m, 'window.__p = (async function () {'));
  await w.__p;
  const box = w.document.getElementById('announceMentionAll');
  assert.equal(box.disabled, true);
  const skip = w.document.getElementById('skipMentions');
  skip.checked = true;
  skip.dispatchEvent(new w.Event('change'));
  assert.equal(box.disabled, false);
});

test('開いていないスペースの新着は 1 つの選択肢で、「本文まで読む」以外では通知の注記を出さない', async () => {
  const { doc, w } = await open({ otherSpaceStatus: { permission: 'granted' } });
  const sel = doc.getElementById('otherSpaces');
  assert.deepEqual(Array.from(sel.options).map((o) => o.value), ['full', 'nameOnly', 'off']);
  assert.equal(sel.value, 'full');
  assert.equal(doc.getElementById('notifyNote').hidden, false);
  assert.equal(doc.getElementById('readNotifications'), null, '旧チェックボックスは無い');
  sel.value = 'nameOnly';
  sel.dispatchEvent(new w.Event('change'));
  assert.equal(doc.getElementById('notifyNote').hidden, true);
});

test('読み方の設定に合わせて読み上げ例を表示し、切り替えるとすぐ変わる', async () => {
  const { doc, w } = await open({});
  const ex = () => doc.getElementById('speechExample').textContent;
  assert.equal(ex(), '「営業チーム、佐藤、明日の件です」');
  const honor = doc.getElementById('addHonorific');
  honor.checked = true;
  honor.dispatchEvent(new w.Event('change'));
  assert.equal(ex(), '「営業チーム、佐藤さん、明日の件です」');
  const space = doc.getElementById('readSpaceName');
  space.checked = false;
  space.dispatchEvent(new w.Event('change'));
  assert.equal(ex(), '「佐藤さん、明日の件です」');
});
