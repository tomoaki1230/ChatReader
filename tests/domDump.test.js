// DOM 構造ダンプ（診断）のテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { buildDomDump, mask } = require('../src/content/domDump.js');

test('伏せ字: 本文・名前は隠し、時刻・数字・キーワードは残す', () => {
  assert.equal(mask('明日の会議'), '○○○○○');
  assert.equal(mask('午後 3:21'), '午後 3:21');
  assert.equal(mask('開発チーム、未読 3 件'), '○○○○○、未読 3 件');
});

test('メッセージ一覧と左側一覧の構造を出力し、本文は含まない', () => {
  const dom = new JSDOM(`<body><div role="navigation"><div role="listitem" aria-label="開発チーム、未読"><span>開発チーム</span></div></div>
    <div role="main"><div role="list">${['秘密の本文A', '秘密の本文B', '秘密の本文C'].map((t, i) =>
      `<div data-message-id="m${i}" jsname="abc"><span data-member-id="u">田中</span><span>10:0${i}</span><div>${t}</div></div>`).join('')}</div></div></body>`,
    { url: 'https://chat.google.com/app/chat/x' });
  const doc = dom.window.document;
  const out = buildDomDump(doc, { messageSelector: 'div[data-message-id]', navItems: Array.from(doc.querySelectorAll('[role="listitem"]')) });
  assert.match(out, /セレクタ一致: 3 件/);
  assert.match(out, /div\[data-message-id="m2"\]\[jsname="abc"\]/);
  assert.match(out, /"10:02"/);
  assert.match(out, /aria-label="○○○○○、未読"/);
  assert.ok(!out.includes('秘密'), '本文が含まれない');
  assert.ok(!out.includes('田中'), '名前が含まれない');
  assert.ok(!out.includes('開発チーム'), 'スペース名が含まれない');
});
