/*
 * ChatReader DOM 構造ダンプ（実機の DOM に合わせてセレクタを調整するための診断機能）
 * メッセージ本文・名前などの文字は「○」で伏せ字にし、文字数・時刻表記・未読などのキーワードのみ残す。
 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const core = isNode ? require('./core.js') : root.ChatReaderCore;
  const learner = isNode ? require('./learner.js') : root.ChatReaderLearner;
  const { normalizeText, isTimestampLike, safeQueryAll } = core;

  const KEEP_WORDS_RE = /(未読|既読|件|返信|スレッド|編集済み|メッセージ|新着|unread|reply|thread|edited|message|\d+|[\s、,.:：()（）\-/]+)/gi;
  const MAX_LINES = 600;

  // 文字を伏せ字にする（時刻表記・キーワード・数字・記号は残す）
  function mask(text, max) {
    const t = normalizeText(text);
    if (!t) return '';
    if (isTimestampLike(t)) return t;
    const masked = t.split(KEEP_WORDS_RE).map((part, i) => (i % 2 === 1 ? part : part.replace(/./gu, '○'))).join('');
    const limit = max || 40;
    return masked.length > limit ? masked.slice(0, limit) + '…(' + t.length + '文字)' : masked;
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      if (name === 'class' || name === 'style') continue;
      if (name === 'aria-label' || name === 'title' || name === 'alt' || name === 'data-tooltip' || name === 'placeholder') {
        s += '[' + name + '="' + mask(attr.value, 30) + '"]';
      } else if (name.startsWith('data-') || name === 'jsname' || name === 'role' || name.startsWith('aria-') || name === 'id' || name === 'jscontroller' || name === 'jsaction' || name === 'hidden' || name === 'contenteditable' || name === 'href') {
        const v = attr.value.length > 30 ? attr.value.slice(0, 30) + '…' : attr.value;
        s += v ? '[' + name + '="' + v + '"]' : '[' + name + ']';
      }
    }
    const classes = Array.from(el.classList || []).slice(0, 4);
    if (classes.length) s += '.' + classes.join('.');
    const style = el.getAttribute('style');
    if (style && /font-weight|display\s*:\s*none/i.test(style)) s += ' {' + style.slice(0, 40) + '}';
    return s;
  }

  function dumpTree(el, depth, maxDepth, lines) {
    if (lines.length >= MAX_LINES) return;
    const pad = '  '.repeat(depth);
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3 && normalizeText(n.nodeValue)) own += ' ' + normalizeText(n.nodeValue);
    lines.push(pad + describe(el) + (own ? '  "' + mask(own) + '"' : ''));
    if (depth >= maxDepth) {
      if (el.children.length) lines.push(pad + '  …(子要素 ' + el.children.length + ' 個省略)');
      return;
    }
    for (const child of el.children) {
      const tag = child.tagName.toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'PATH') continue;
      dumpTree(child, depth + 1, maxDepth, lines);
    }
  }

  function ancestors(el, n) {
    const chain = [];
    for (let p = el.parentElement; p && chain.length < n; p = p.parentElement) chain.unshift(describe(p));
    return chain;
  }

  /**
   * @param {Document} doc
   * @param {{messageSelector?: string, navItems?: Element[]}} info
   */
  function buildDomDump(doc, info) {
    const lines = [];
    const opts = info || {};
    const main = doc.querySelector('[role="main"]');
    lines.push('# URL: ' + doc.location.origin + doc.location.pathname);
    lines.push('# role="main": ' + (main ? 'あり' : 'なし') + ' / 採用セレクタ: ' + (opts.messageSelector || 'なし'));

    // メッセージ一覧
    let container = null;
    if (opts.messageSelector) {
      const matched = safeQueryAll(doc, opts.messageSelector);
      lines.push('# セレクタ一致: ' + matched.length + ' 件');
      const last = matched[matched.length - 1];
      if (last) container = last.parentElement;
    }
    if (main) {
      const cand = learner.findListCandidates(main)[0];
      if (cand) {
        lines.push('# 学習器の推定（メッセージ一覧候補）: 要素 ' + cand.items.length + ' 件 / ' + describe(cand.items[0]));
        if (!container) container = cand.container;
      }
    }
    if (container) {
      lines.push('', '## メッセージ一覧コンテナの祖先');
      ancestors(container, 8).forEach((s, i) => lines.push('  '.repeat(i) + s));
      lines.push('', '## メッセージ一覧の末尾 4 要素（子要素 ' + container.children.length + ' 個中）');
      const kids = Array.from(container.children).slice(-4);
      lines.push(describe(container));
      for (const k of kids) dumpTree(k, 1, 14, lines);
    } else if (main) {
      lines.push('', '## role="main" の構造（一覧を特定できず）');
      dumpTree(main, 0, 9, lines);
    }

    // 左側一覧
    const navs = safeQueryAll(doc, '[role="navigation"], nav').filter((n) => !(main && main.contains(n)));
    lines.push('', '## 左側一覧: [role="navigation"]/nav ' + navs.length + ' 個 / 未読監視の対象項目 ' + (opts.navItems ? opts.navItems.length : 0) + ' 件');
    (opts.navItems || []).slice(0, 8).forEach((el, i) => lines.push('  項目' + (i + 1) + ': ' + describe(el) + '  "' + mask(el.textContent) + '"'));
    for (const nav of navs.slice(0, 3)) {
      lines.push('', '### ' + describe(nav));
      dumpTree(nav, 0, 10, lines);
    }
    if (lines.length >= MAX_LINES) lines.push('…(' + MAX_LINES + ' 行で打ち切り)');
    return lines.join('\n');
  }

  const api = { buildDomDump, mask, describe };
  if (isNode) module.exports = api;
  root.ChatReaderDomDump = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
