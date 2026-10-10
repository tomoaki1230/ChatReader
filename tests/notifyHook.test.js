// 通知フック（MAIN world スクリプト）のテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HOOK = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'notifyHook.js'), 'utf8');

function setup() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://chat.google.com/', runScripts: 'outside-only' });
  const w = dom.window;
  const shown = [];
  // ブラウザの Notification / ServiceWorkerRegistration の代用
  w.eval(`
    window.__shown = [];
    window.Notification = class Notification {
      constructor(title, options) { this.title = title; this.body = (options || {}).body; window.__shown.push(['page', title]); }
      static get permission() { return 'granted'; }
      static requestPermission() { return Promise.resolve('granted'); }
    };
    window.ServiceWorkerRegistration = class ServiceWorkerRegistration {
      showNotification(title, options) { window.__shown.push(['sw', title]); return Promise.resolve(); }
    };
  `);
  const received = [];
  w.addEventListener('message', (e) => { if (e.data && e.data.source === 'chatreader-notify') received.push({ ...e.data }); });
  w.eval(HOOK);
  return { w, received, shown };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('new Notification の内容を受け取り、通知自体も通常どおり作られる', async () => {
  const { w, received } = setup();
  const n = w.eval(`new Notification('田中', { body: 'こんにちは', tag: 't1' })`);
  await wait(20);
  assert.deepEqual(received, [{ source: 'chatreader-notify', title: '田中', body: 'こんにちは', tag: 't1' }]);
  assert.equal(n.body, 'こんにちは');
  assert.ok(w.eval('n => n instanceof Notification')(n));
  assert.deepEqual(JSON.parse(JSON.stringify(w.__shown)), [['page', '田中']]);
  assert.equal(w.Notification.permission, 'granted');
  assert.equal(w.document.documentElement.getAttribute('data-chatreader-hook'), '1');
  w.close();
});

test('ServiceWorkerRegistration.showNotification も受け取る', async () => {
  const { w, received } = setup();
  await w.eval(`new ServiceWorkerRegistration().showNotification('開発チーム', { body: '佐藤: リリースしました' })`);
  await wait(20);
  assert.equal(received.length, 1);
  assert.equal(received[0].title, '開発チーム');
  assert.equal(received[0].body, '佐藤: リリースしました');
  assert.deepEqual(JSON.parse(JSON.stringify(w.__shown)), [['sw', '開発チーム']]);
  w.close();
});
