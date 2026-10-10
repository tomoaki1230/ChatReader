/*
 * ChatReader コアロジック（DOM 構造の解析・テキスト抽出・セレクタ生成）
 * chrome.* API に依存しない純粋なロジックのみを置き、jsdom でテスト可能にしている。
 */
(function (root) {
  'use strict';

  // 読み上げ対象から除外する UI 文言
  const UI_WORDS = new Set([
    '返信', 'スレッドで返信', 'リアクションを追加', 'その他の操作', '編集済み', '(編集済み)', '（編集済み）',
    '今', '昨日', '既読', '送信中', '送信済み', 'メッセージを送信できませんでした',
    'reply', 'reply in thread', 'add reaction', 'more actions', 'edited', '(edited)', 'now', 'yesterday', 'sending', 'sent'
  ]);

  // 時刻表記（例: 15:21 / 午後 3:21 / 3:21 PM / 10月9日 15:21 / 月曜日 15:21）
  const TIMESTAMP_RE = new RegExp('^'
    + '((\\d{2,4}[/年.-])?\\d{1,2}[/月.-]\\d{1,2}日?\\s*(\\(?[月火水木金土日]\\)?\\s*)?)?'   // 日付
    + '(昨日\\s*|今日\\s*|yesterday,?\\s*|today,?\\s*)?'                                        // 昨日・今日
    + '([月火水木金土日]曜日?\\s*|(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s*)?'                  // 曜日
    + '(午前|午後|am|pm)?\\s*\\d{1,2}:\\d{2}\\s*(am|pm)?$', 'i');
  // 送信処理中の表示（実機: 自分の投稿の直後に「送信しています...」が付く）
  const PENDING_RE = /^(送信しています|送信中|sending)\s*(\.{2,3}|…)?$/i;
  // 相対時刻（実機の表示は「2 分」のように「前」が付かない）
  const RELATIVE_TIME_RE = /^(たった今|\d+\s*(秒|分|時間|日|週間?|か月|ヶ月|カ月|年)\s*前?|\d+\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wks?|weeks?|mo|months?|y|yrs?|years?)\s*(ago)?)$/i;

  // 子要素の走査で読み飛ばす要素
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT']);
  const SKIP_ROLES = new Set(['button', 'menu', 'menubar', 'toolbar', 'tooltip', 'dialog', 'progressbar']);

  // 送信者を示しやすい属性名
  const SENDER_ATTR_RE = /(member|hovercard|sender|author|user|name)/i;

  // 学習時に意味のない（値が毎回変わる）属性として扱うもの
  const VOLATILE_ATTRS = new Set(['data-message-id', 'data-id', 'data-topic-id', 'data-tooltip-id', 'data-ved']);

  function normalizeText(s) {
    return String(s == null ? '' : s).replace(/[\s​‎‏﻿]+/g, ' ').trim();
  }

  function isTimestampLike(s) {
    const t = normalizeText(s);
    if (!t) return false;
    return TIMESTAMP_RE.test(t) || RELATIVE_TIME_RE.test(t);
  }

  function isPendingSegment(s) {
    return PENDING_RE.test(normalizeText(s));
  }

  function isUiWord(s) {
    return UI_WORDS.has(normalizeText(s).toLowerCase());
  }

  // 読み上げ不要な断片（時刻・UI文言・数字のみ）か
  function isNoiseSegment(s) {
    const t = normalizeText(s);
    if (!t) return true;
    if (isTimestampLike(t) || isUiWord(t) || isPendingSegment(t)) return true;
    if (/^[\d\s,.:]+$/.test(t)) return true; // リアクション数など
    return false;
  }

  function shouldSkipElement(el) {
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
    if (el.hidden) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return true;
    const style = el.getAttribute('style');
    if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
    return false;
  }

  // 要素内のテキストを断片単位で収集する（innerText はレイアウトを伴い重く、jsdom でも未実装のため）
  function collectSegments(el, out) {
    const segments = out || [];
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const t = normalizeText(node.nodeValue);
        if (t) segments.push(t);
      } else if (node.nodeType === 1) {
        if (shouldSkipElement(node)) continue;
        if (node.tagName === 'IMG') {
          // 絵文字画像は alt を読む
          const alt = normalizeText(node.getAttribute('alt'));
          if (alt && alt.length <= 8) segments.push(alt);
          continue;
        }
        collectSegments(node, segments);
      }
    }
    return segments;
  }

  function textOf(el) {
    return el ? collectSegments(el).join(' ') : '';
  }

  // メッセージ本文を抽出（送信者名・時刻・UI 文言を除外）
  function extractMessageText(messageEl, opts) {
    const options = opts || {};
    const target = options.bodySelector ? safeQuery(messageEl, options.bodySelector) : null;
    if (target) {
      // 本文要素の中には時刻・UI 文言は無いため、送信中の表示以外はそのまま読む（「15:00」「3分」等の本文を消さない）
      return normalizeText(collectSegments(target).filter((seg) => !isPendingSegment(seg)).join(' '));
    }
    const segments = collectSegments(messageEl);
    const sender = normalizeText(options.sender);
    const kept = segments.filter((seg) => !isNoiseSegment(seg) && seg !== sender);
    return normalizeText(kept.join(' '));
  }

  function safeQuery(el, selector) {
    try { return el.querySelector(selector); } catch (e) { return null; }
  }

  function safeQueryAll(el, selector) {
    try { return Array.from(el.querySelectorAll(selector)); } catch (e) { return []; }
  }

  function safeMatches(el, selector) {
    try { return el.matches(selector); } catch (e) { return false; }
  }

  // 要素の安定した特徴（シグネチャ）
  function elementSignature(el) {
    const dataAttrs = [];
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-')) dataAttrs.push(attr.name);
    }
    dataAttrs.sort();
    const classes = Array.from(el.classList || []).filter(isSafeIdent).sort();
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      jsname: el.getAttribute('jsname') || '',
      dataAttrs,
      classes
    };
  }

  // 同種要素のグルーピング用キー（クラスは状態で変わりやすいので含めない）
  function signatureKey(sig) {
    return [sig.tag, sig.role, sig.jsname, sig.dataAttrs.join(',')].join('|');
  }

  function isSafeIdent(s) {
    return /^[A-Za-z_][\w-]*$/.test(s) && s.length <= 40;
  }

  function cssAttrValue(v) {
    return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function intersect(lists) {
    if (!lists.length) return [];
    return lists.reduce((acc, list) => acc.filter((x) => list.includes(x)));
  }

  // 同一グループの要素シグネチャ群から CSS セレクタ候補を生成（具体的なものから順に）
  function buildSelectorCandidates(sigs) {
    if (!sigs.length) return [];
    const tag = sigs[0].tag;
    const parts = [];
    const commonData = intersect(sigs.map((s) => s.dataAttrs));
    const commonClasses = intersect(sigs.map((s) => s.classes)).slice(0, 3);
    const jsname = sigs.every((s) => s.jsname && s.jsname === sigs[0].jsname) ? sigs[0].jsname : '';
    const role = sigs.every((s) => s.role && s.role === sigs[0].role) ? sigs[0].role : '';

    const stableData = commonData.filter((a) => !VOLATILE_ATTRS.has(a)).concat(commonData.filter((a) => VOLATILE_ATTRS.has(a)));
    const attrParts = [];
    if (jsname) attrParts.push('[jsname=' + cssAttrValue(jsname) + ']');
    for (const a of stableData) attrParts.push('[' + a + ']');
    if (role) attrParts.push('[role=' + cssAttrValue(role) + ']');

    for (const p of attrParts) parts.push(tag + p);
    if (attrParts.length >= 2) parts.push(tag + attrParts[0] + attrParts[1]);
    if (commonClasses.length) parts.push(tag + commonClasses.map((c) => '.' + c).join(''));
    if (commonClasses.length && attrParts.length) parts.push(tag + attrParts[0] + commonClasses.map((c) => '.' + c).join(''));
    return Array.from(new Set(parts));
  }

  // メッセージ要素に付いている一意 ID（あれば）
  function messageIdOf(el) {
    for (const name of ['data-message-id', 'data-id', 'data-topic-id']) {
      const v = el.getAttribute(name);
      if (v) return name + ':' + v;
    }
    return null;
  }

  // 「@名前」の除去。既知の名前（空白を含む「@山田 太郎」等）を長い順に除き、残りは「@」から区切りまでを除く
  // 「@」の直前が文頭・空白・句読点の時のみメンション（メールアドレス a@example.com は対象外）
  const MENTION_TOKEN_RE = /(^|[\s、。,，(（「『])[@＠][^\s@＠、。,，!?！？:：)）」』]+/g;

  function stripMentions(text, knownNames) {
    let t = String(text == null ? '' : text);
    if (!/[@＠]/.test(t)) return normalizeText(t);
    const names = Array.from(new Set((knownNames || []).map(normalizeText).filter(Boolean))).sort((a, b) => b.length - a.length);
    for (const n of names) {
      // 名前の直後が終端・空白・句読点の時のみ（「@A」で「@Alice」の先頭を削らない）
      const re = new RegExp('(^|[\\s、。,，(（「『])[@＠]' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\s、。,，!?！？:：)）」』])', 'g');
      t = t.replace(re, '$1 ');
    }
    return normalizeText(t.replace(MENTION_TOKEN_RE, '$1 ')).replace(/^[、。,，\s]+/, '');
  }

  const MENTION_ONLY = 'メンションのみ';
  const MENTION_ALL = '全員宛て';
  // 全員宛てのメンション（@全員 / @all / @everyone）
  const MENTION_ALL_RE = /(^|[\s、。,，(（「『])[@＠](全員|all|everyone)(?=$|[\s、。,，!?！？:：)）」』])/i;

  // 設定に応じて本文を整える
  // skipMentions ON: 「@名前」を除去し、メンションだけなら「メンションのみ」 / OFF: そのまま
  // announceMentionAll ON（skipMentions ON の時のみ）: 全員宛てのメンションがあれば先頭に「全員宛て」を付ける
  function prepareBody(text, settings, knownNames) {
    const t = normalizeText(text);
    if (!settings.skipMentions || !t) return t;
    const body = stripMentions(t, knownNames);
    if (settings.announceMentionAll && MENTION_ALL_RE.test(t)) return body ? MENTION_ALL + '、' + body : MENTION_ALL;
    return body || MENTION_ONLY;
  }

  // スペースの更新情報（メンバーの招待・参加など）
  // 実機: 「スペースの更新情報: [Tomoaki Bessho] さんが 太郎 を招待しました」の名前部分が送信者として切り離される
  const SYSTEM_PREFIX_RE = /^(スペースの更新情報|space updates?)\s*[:：]\s*/i;

  function isSystemMessage(text) {
    return SYSTEM_PREFIX_RE.test(normalizeText(text));
  }

  // 見出しを除き、切り離された名前を文に戻す（「Tomoaki Bessho さんが 太郎 を招待しました」）
  function formatSystemMessage(sender, text) {
    let t = normalizeText(text).replace(SYSTEM_PREFIX_RE, '');
    const who = normalizeText(sender);
    if (who && /^さん/.test(t)) t = who + ' ' + t;
    return normalizeText(t);
  }

  // 最大文字数で切る（文字単位。絵文字などのサロゲートペアを途中で切らない）
  function truncate(text, max) {
    const chars = Array.from(text);
    return chars.length > max ? chars.slice(0, max).join('') + '、以下省略' : text;
  }

  // 読み上げ文を組み立てる
  function buildSpeechText(message, settings) {
    const text = normalizeText(message.text);
    if (!text) return '';
    const body = truncate(text, settings.maxLength);
    const sender = normalizeText(message.sender);
    const space = normalizeText(message.space);
    const parts = [];
    // スペース名（DM はスペース名 = 相手の名前のため重ねて読まない）
    if (settings.readSpaceName && space && space !== sender) parts.push(space);
    if (settings.readSender && sender) parts.push(sender + (settings.addHonorific ? 'さん' : ''));
    parts.push(body);
    return parts.join('、');
  }

  // 通知タイトル「送信者 (スペース名)」を分解（DM はタイトル = 送信者のみ）
  function parseNotificationTitle(title) {
    const t = normalizeText(title);
    const m = t.match(/^(.+?)\s*[(（]([^()（）]+)[)）]$/);
    return m ? { sender: m[1].trim(), space: m[2].trim() } : { sender: t, space: '' };
  }

  // 通知の読み上げ文: 「スペース名、送信者、本文」（DM は「送信者、本文」）
  function buildNotificationSpeech(title, body, settings) {
    const { sender, space } = parseNotificationTitle(title);
    const text = normalizeText(body);
    const parts = [];
    if (space && settings.readSpaceName) parts.push(space);
    if (sender && settings.readSender) parts.push(sender + (settings.addHonorific ? 'さん' : ''));
    if (text) {
      parts.push(truncate(text, settings.maxLength));
    } else {
      if (!parts.length && sender) parts.push(sender);
      parts.push('新着メッセージ');
    }
    return parts.join('、');
  }

  function isOwnMessage(sender, ownName) {
    const a = normalizeText(sender);
    const b = normalizeText(ownName);
    if (!a) return false;
    if (a === 'あなた' || a === 'You' || a === '自分') return true;
    return Boolean(b && (a === b || a === b + ' (自分)' || a === b + ' (You)'));
  }

  // 比較用に空白を除去した文字列
  function compactText(s) {
    return normalizeText(s).replace(/\s+/g, '');
  }

  /**
   * 自分が送信したメッセージの判定。
   * 入力欄から送信した文章を一定時間記録しておき、直後に現れた同じ文章のメッセージを自分の投稿とみなす。
   * 加えて、設定された自分の表示名と送信者名が一致する場合も自分の投稿とみなす。
   */
  class OwnMessageDetector {
    constructor(options) {
      const opts = options || {};
      this.ttlMs = opts.ttlMs || 30000;
      this.now = opts.now || (() => Date.now());
      this.sent = [];
    }

    recordSent(text) {
      const t = compactText(text);
      if (!t) return;
      const now = this.now();
      this.sent = this.sent.filter((s) => now - s.at < this.ttlMs).concat([{ text: t, at: now }]).slice(-20);
    }

    isOwn(message, ownName) {
      if (isOwnMessage(message.sender, ownName)) return true;
      const t = compactText(message.text);
      if (!t) return false;
      const now = this.now();
      this.sent = this.sent.filter((s) => now - s.at < this.ttlMs);
      // 完全一致のみ（前方一致だと、他人の短い返信「了解」を自分の「了解です」と誤認する）
      const idx = this.sent.findIndex((s) => t === s.text);
      if (idx < 0) return false;
      this.sent.splice(idx, 1);
      return true;
    }
  }

  const api = {
    OwnMessageDetector,
    compactText,
    normalizeText,
    isTimestampLike,
    isUiWord,
    isPendingSegment,
    isNoiseSegment,
    collectSegments,
    textOf,
    extractMessageText,
    safeQuery,
    safeQueryAll,
    safeMatches,
    elementSignature,
    signatureKey,
    buildSelectorCandidates,
    messageIdOf,
    buildSpeechText,
    isSystemMessage,
    formatSystemMessage,
    truncate,
    stripMentions,
    prepareBody,
    parseNotificationTitle,
    buildNotificationSpeech,
    isOwnMessage,
    SENDER_ATTR_RE
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChatReaderCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
