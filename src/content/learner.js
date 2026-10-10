/*
 * ChatReader セレクタ学習器
 * Google Chat の DOM 構造が変わって既知セレクタが使えなくなった時に、
 * 「同じ形の要素がテキストを持って繰り返し並んでいる場所 = メッセージ一覧」という
 * 構造的特徴からメッセージ要素・送信者要素のセレクタを推定する。
 */
(function (root) {
  'use strict';

  const core = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.ChatReaderCore;
  const {
    normalizeText, isNoiseSegment, extractMessageText, textOf, collectSegments, safeQueryAll,
    elementSignature, signatureKey, buildSelectorCandidates, SENDER_ATTR_RE
  } = core;

  const MAX_SCAN_ELEMENTS = 15000;
  const LIST_ROLES = new Set(['list', 'log', 'feed', 'grid', 'listbox']);

  // メッセージ一覧が含まれる領域（Google Chat では role="main"）
  // 無いフレーム（Chat 以外の部品・ポップアップ等）では学習しない（メニュー等の一覧を誤学習しないため）
  function findChatRoot(doc) {
    return doc.querySelector('[role="main"]');
  }

  function isListLike(el) {
    const role = el.getAttribute('role');
    return (role && LIST_ROLES.has(role)) || el.hasAttribute('aria-live');
  }

  // 同じシグネチャの子要素が 3 つ以上並ぶコンテナを候補として列挙・採点する
  function findListCandidates(chatRoot) {
    const candidates = [];
    const all = [chatRoot].concat(Array.from(chatRoot.querySelectorAll('*')).slice(0, MAX_SCAN_ELEMENTS));
    for (const container of all) {
      if (container.children.length < 3) continue;
      const groups = new Map();
      for (const child of container.children) {
        const sig = elementSignature(child);
        const key = signatureKey(sig);
        if (!groups.has(key)) groups.set(key, { key, items: [], sigs: [] });
        const g = groups.get(key);
        g.items.push(child);
        g.sigs.push(sig);
      }
      for (const g of groups.values()) {
        if (g.items.length < 3) continue;
        const lens = g.items.map((el) => extractMessageText(el).length);
        const withText = lens.filter((n) => n > 0).length;
        if (withText / g.items.length < 0.6) continue;
        const avgLen = lens.reduce((a, n) => a + Math.min(n, 300), 0) / g.items.length;
        if (avgLen < 2) continue;
        const bonus = isListLike(container) ? 1.5 : 1;
        candidates.push({
          container,
          key: g.key,
          items: g.items,
          sigs: g.sigs,
          score: withText * Math.log2(2 + avgLen) * bonus
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  // 候補要素がスレッド（複数メッセージのまとまり）の場合、内側のメッセージ単位へ絞り込む
  function refineToMessageUnits(candidate) {
    const items = candidate.items;
    const totalText = items.reduce((a, el) => a + textOf(el).length, 0);
    if (!totalText) return candidate;
    const stats = new Map();
    for (const item of items) {
      for (const el of Array.from(item.querySelectorAll('*')).slice(0, 2000)) {
        const key = signatureKey(elementSignature(el));
        if (!stats.has(key)) stats.set(key, { key, els: [], set: new Set(), itemsWith: new Set(), itemOf: new Map() });
        const s = stats.get(key);
        s.els.push(el);
        s.set.add(el);
        s.itemsWith.add(item);
        s.itemOf.set(el, item);
      }
    }
    let best = null;
    for (const s of stats.values()) {
      // 安い条件から先に判定（大きなページで重くならないように）
      if (s.els.length < items.length * 1.2) continue;
      if (s.itemsWith.size < items.length * 0.7) continue;
      // 入れ子になっている要素は外側だけを数える（祖先をたどって判定: 要素数に比例する計算量）
      const outer = s.els.filter((el) => {
        const item = s.itemOf.get(el);
        for (let p = el.parentElement; p && p !== item; p = p.parentElement) if (s.set.has(p)) return false;
        return true;
      });
      if (outer.length < items.length * 1.2) continue;
      const covered = outer.reduce((a, el) => a + textOf(el).length, 0);
      if (covered < totalText * 0.6) continue;
      const withText = outer.filter((el) => extractMessageText(el).length > 0).length;
      if (withText / outer.length < 0.6) continue;
      if (!best || outer.length > best.items.length || (outer.length === best.items.length && covered > best.covered)) {
        best = { key: s.key, items: outer, sigs: outer.map(elementSignature), covered };
      }
    }
    if (!best) return candidate;
    return { ...candidate, key: best.key, items: best.items, sigs: best.sigs, refined: true };
  }

  // セレクタの精度（候補要素をどれだけ正確に拾えるか）を評価
  function evaluateSelector(doc, selector, items) {
    const matched = safeQueryAll(doc, selector);
    if (!matched.length) return { selector, precision: 0, recall: 0, f1: 0 };
    const itemSet = new Set(items);
    const hit = matched.filter((el) => itemSet.has(el)).length;
    const precision = hit / matched.length;
    const recall = hit / items.length;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { selector, precision, recall, f1 };
  }

  // nth-of-type による構造パス（属性が使えない場合の最終手段）
  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'HTML') {
      const tag = cur.tagName.toLowerCase();
      if (tag === 'body') { parts.unshift('body'); break; }
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function chooseMessageSelector(doc, candidate, exclude) {
    const tried = [];
    for (const sel of buildSelectorCandidates(candidate.sigs)) {
      if (!exclude.has(sel)) tried.push(evaluateSelector(doc, sel, candidate.items));
    }
    let best = pickBest(tried);
    if (best) return { ...best, structural: false };

    // コンテナ基準のセレクタ（例: div[role="list"] > div）
    const containerSels = buildSelectorCandidates([elementSignature(candidate.container)])
      .filter((sel) => safeQueryAll(doc, sel).length === 1);
    if (!candidate.refined) {
      const childParts = buildSelectorCandidates(candidate.sigs).concat([candidate.sigs[0].tag]);
      const scoped = [];
      for (const c of containerSels) for (const p of childParts) {
        if (!exclude.has(c + ' > ' + p)) scoped.push(evaluateSelector(doc, c + ' > ' + p, candidate.items));
      }
      best = pickBest(scoped);
      if (best) return { ...best, structural: false };
      // 最終手段: 構造パス（ページ再読込までは有効）
      const pathSel = cssPath(candidate.container) + ' > ' + candidate.sigs[0].tag;
      best = pickBest([evaluateSelector(doc, pathSel, candidate.items)]);
      if (best) return { ...best, structural: true };
    }
    return null;
  }

  function pickBest(results) {
    const ok = results.filter((r) => r.recall >= 0.8 && r.precision >= 0.6);
    ok.sort((a, b) => (b.f1 - a.f1) || (a.selector.length - b.selector.length));
    return ok[0] || null;
  }

  // メッセージ要素内で送信者名を持つ要素のセレクタを推定
  function learnSenderSelector(items) {
    const stats = new Map();
    for (const item of items) {
      for (const el of Array.from(item.querySelectorAll('*')).slice(0, 300)) {
        if (el.children.length > 3) continue;
        // 時刻を表す要素（実機: span[data-absolute-timestamp]）は送信者にしない
        if (Array.from(el.attributes).some((a) => /time|date/i.test(a.name))) continue;
        // 名前は 1〜2 個のテキスト断片で構成され、時刻などを含まない
        const segments = collectSegments(el);
        if (!segments.length || segments.length > 2 || segments.some(isNoiseSegment)) continue;
        const t = segments.join(' ');
        if (t.length > 40) continue;
        const sig = elementSignature(el);
        const key = signatureKey(sig);
        if (!stats.has(key)) stats.set(key, { key, sigs: [], texts: [], itemsWith: new Set() });
        const s = stats.get(key);
        s.sigs.push(sig);
        s.texts.push(t);
        s.itemsWith.add(item);
      }
    }
    let best = null;
    for (const s of stats.values()) {
      const coverage = s.itemsWith.size / items.length;
      if (s.itemsWith.size < Math.max(2, items.length * 0.2)) continue;
      const distinctRatio = new Set(s.texts).size / s.texts.length;
      // 全要素にあり値がバラバラ → 本文の可能性が高い
      if (items.length >= 5 && coverage > 0.9 && distinctRatio > 0.8) continue;
      const attrBonus = s.sigs[0].dataAttrs.some((a) => SENDER_ATTR_RE.test(a)) ? 2 : 1;
      const score = s.itemsWith.size * attrBonus * (1.2 - distinctRatio);
      if (!best || score > best.score) best = { ...s, score };
    }
    if (!best) return null;
    for (const sel of buildSelectorCandidates(best.sigs)) {
      const ok = Array.from(best.itemsWith).filter((item) => {
        const hit = safeQueryAll(item, sel).map(textOf).find((t) => t && t.length <= 40 && !isNoiseSegment(t));
        return Boolean(hit);
      }).length;
      if (ok / best.itemsWith.size >= 0.8) return sel;
    }
    return null;
  }

  /**
   * 現在の DOM からプロファイル（メッセージ / 送信者セレクタ）を学習する。
   * 失敗時は null。
   */
  function learnProfile(doc, now, options) {
    const exclude = (options && options.exclude) || new Set();
    const chatRoot = findChatRoot(doc);
    if (!chatRoot) return null;
    const candidates = findListCandidates(chatRoot).slice(0, 5);
    for (const raw of candidates) {
      const candidate = refineToMessageUnits(raw);
      const chosen = chooseMessageSelector(doc, candidate, exclude);
      if (!chosen) continue;
      return {
        name: 'learned',
        message: chosen.selector,
        sender: learnSenderSelector(candidate.items),
        body: null,
        structural: chosen.structural,
        precision: Number(chosen.precision.toFixed(2)),
        recall: Number(chosen.recall.toFixed(2)),
        sampleCount: candidate.items.length,
        learnedAt: now || Date.now()
      };
    }
    return null;
  }

  const api = { learnProfile, findChatRoot, findListCandidates, refineToMessageUnits, learnSenderSelector, evaluateSelector, cssPath, normalizeText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChatReaderLearner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
