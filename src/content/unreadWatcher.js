/*
 * ChatReader 未読監視（左側のスペース / チャット一覧）
 *
 * 開いていないスペースに新着が届くと、一覧の項目の最新メッセージ時刻（data-display-timestamp）が進む。
 * その変化を検知して知らせる。ホーム画面では最新メッセージのプレビュー（送信者・本文）も取得できる。
 * 項目の特定は role 属性ベースで行い、見つからなければ learner の構造推定で補う。
 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const core = isNode ? require('./core.js') : root.ChatReaderCore;
  const learner = isNode ? require('./learner.js') : root.ChatReaderLearner;
  const { collectSegments, isNoiseSegment, normalizeText, safeQueryAll, textOf } = core;

  const NAV_ROOT_SELECTOR = '[role="navigation"], nav';
  // 実機（2026-10）の Google Chat: span[role="listitem"][data-group-id="space/…"][data-display-timestamp="…"]
  const GROUP_ITEM_SELECTOR = '[data-group-id][role="listitem"], [data-group-id][data-display-timestamp]';
  // Google アカウントバー等（スペース一覧ではない）
  const EXCLUDE_AREA_SELECTOR = 'header, [role="banner"], #gb';
  const ITEM_SELECTOR = '[role="treeitem"], [role="listitem"], [role="option"], [role="link"], a[href]';
  const UNREAD_LABEL_RE = /未読|unread/i;
  // 未読の表示ではない「未読」を含むラベル（実画面: 「未読にする」ボタン、「未読フィルタを切り替え」スイッチ）
  const NOT_UNREAD_LABEL_RE = /未読にする|未読フィルタ|mark as unread|unread filter/i;
  // 実画面の目印: ホーム画面の名前欄・プレビュー（送信者・本文）
  const HOME_NAME_SELECTOR = '[jsname="VYJYmb"]';
  const PREVIEW_BOX_SELECTOR = '[jsname="JzStRd"]';
  const PREVIEW_BODY_SELECTOR = '[jsname="ok3btb"]';
  const PREVIEW_SENDER_SELECTOR = '[jsname="rJxwpd"]';
  const SENDER_LOADING_RE = /読み込み中|loading/i;
  // 項目名ではない断片（未読表示、DM 相手の在席状況など）。実機では DM の項目に「オンライン」が名前より前に入る
  const NON_NAME_SEGMENT_RE = /^((未読|unread)(\s*(メッセージ|messages?)?\s*(あり|\d+\s*件?)?)?|既読|オンライン|オフライン|退席中|離席中|不在|応答不可|取り込み中|通話中|会議中|発表中|プレゼンテーション中|ミュート|ミュート中|ピン留め|ピン留め済み|online|offline|away|busy|do not disturb|in a call|in a meeting|presenting|active|inactive|muted|pinned)$/i;
  const COUNT_IN_LABEL_RE = /(\d{1,4})\s*件?\s*(の)?\s*未読|未読\s*(メッセージ)?\s*(\d{1,4})|(\d{1,4})\s*unread|unread[^0-9]{0,20}(\d{1,4})/i;

  const DEFAULT_OPTIONS = {
    debounceMs: 800,
    warmupMs: 5000,
    rescanIntervalMs: 30000,   // 一覧の項目セレクタを取り直す間隔（DOM 変更への追従）
    repeatGuardMs: 10000       // 同じ項目を連続で通知しない時間
  };

  class UnreadWatcher {
    constructor(doc, options) {
      const opts = options || {};
      this.doc = doc;
      this.win = doc.defaultView;
      this.opts = { ...DEFAULT_OPTIONS, ...opts };
      this.onUnread = opts.onUnread || (() => {});
      this.onStatus = opts.onStatus || (() => {});
      this.log = opts.log || (() => {});
      this.now = opts.now || (() => Date.now());
      this.states = new Map();
      this.lastAnnounced = new Map();
      this.items = [];
      this.itemSource = '';
      this.warmupUntil = 0;
      this.timer = null;
      this.rescanTimer = null;
      this.observer = null;
      this.announceCount = 0;
      this.lastAnnounceAt = 0;
      this.scanned = false;
      this.knownTs = new Map(); // 項目ごとに見た最新メッセージ時刻（一覧から一時的に消えても保持）
      this.startedAt = 0;
      this.groupCount = 0;
    }

    start() {
      this.startedAt = this.now();
      this.warmupUntil = this.now() + this.opts.warmupMs;
      this.refreshItems();
      this.scan();
      const Observer = this.win.MutationObserver;
      this.observer = new Observer((muts) => this.onMutations(muts));
      this.observer.observe(this.doc.documentElement, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['aria-label', 'class', 'style', 'aria-selected', 'aria-current', 'data-display-timestamp']
      });
      this.rescanTimer = this.win.setInterval(() => { this.refreshItems(); this.scan(); }, this.opts.rescanIntervalMs);
    }

    stop() {
      if (this.observer) this.observer.disconnect();
      if (this.timer) this.win.clearTimeout(this.timer);
      if (this.rescanTimer) this.win.clearInterval(this.rescanTimer);
      this.observer = null;
      this.timer = null;
      this.rescanTimer = null;
    }

    chatMain() {
      return this.doc.querySelector('[role="main"]');
    }

    onMutations(mutations) {
      const main = this.chatMain();
      // メッセージ一覧内の変更は無視（負荷軽減）
      const relevant = mutations.some((m) => {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        return t && !(main && main.contains(t));
      });
      if (!relevant || this.timer) return;
      this.timer = this.win.setTimeout(() => {
        this.timer = null;
        // スペース ID 方式は軽いので毎回取り直す（新しい DM 等の項目追加に追従）
        if (this.itemSource === 'group-id' || !this.items.length || this.items.some((el) => !el.isConnected)) this.refreshItems();
        this.scan();
      }, this.opts.debounceMs);
    }

    // ---- 一覧項目の特定 ----

    refreshItems() {
      const main = this.chatMain();
      const outsideMain = (el) => !(main && main.contains(el));
      const usable = (el) => outsideMain(el) && !el.closest(EXCLUDE_AREA_SELECTOR);
      const roots = safeQueryAll(this.doc, NAV_ROOT_SELECTOR).filter(usable);
      // 代替の探し方は左側一覧（navigation）の中だけ。ページ全体から探すとメニュー等の一覧を誤認する
      const scopes = main ? roots : [];

      // 1. スペース ID 付きの項目（最も確実。Chat 固有の構造のため、ホーム画面のようにメッセージ一覧が無くても使う）
      let items = outermost(safeQueryAll(this.doc, GROUP_ITEM_SELECTOR).filter(usable)).filter((el) => this.nameOf(el));
      let source = 'group-id';
      // スペース ID 付きの項目が無く、メッセージ一覧（role="main"）も無いフレームは Chat の画面ではないため監視しない
      if (!items.length && !main) {
        if (this.itemSource !== 'none') this.log('スペースの一覧もメッセージ一覧も無い画面のため未読監視を休止');
        this.items = [];
        this.itemSource = 'none';
        return;
      }

      // 2. role 属性ベース
      if (!items.length) {
        source = 'role';
        for (const scope of scopes) items = items.concat(safeQueryAll(scope, ITEM_SELECTOR));
        items = pickItems(Array.from(new Set(items)).filter(usable)).filter((el) => this.nameOf(el));
      }

      // スペース ID で見つかった項目は 1 件でも採用する（スペースが 1 つだけの利用者もいる）
      if (source !== 'group-id' && items.length < 2) {
        // role が付いていない構造: 同じ形の要素が並ぶ場所を一覧とみなす
        source = 'learned';
        items = [];
        for (const scope of scopes) {
          const cands = learner.findListCandidates(scope).filter((c) => outsideMain(c.container));
          const best = cands.find((c) => c.items.every((el) => this.nameOf(el).length <= 80));
          if (best) { items = best.items; break; }
        }
      }
      if (this.itemSource !== source || this.items.length !== items.length) {
        this.log('未読監視の対象項目: ' + items.length + ' 件 (' + source + ')');
      }
      this.items = items;
      this.itemSource = source;
      this.groupCount = new Set(items.map((el) => this.groupIdOf(el) || this.nameOf(el))).size;
    }

    // ---- 項目の状態 ----

    nameOf(el) {
      // 実画面の目印: ホーム画面の名前欄、左側一覧の <bdi>（プレビュー内の <bdi> は送信者なので除く）
      const homeName = el.querySelector(HOME_NAME_SELECTOR);
      if (homeName && textOf(homeName)) return textOf(homeName).slice(0, 80);
      const bdis = safeQueryAll(el, 'bdi').filter((b) => !b.closest(PREVIEW_BOX_SELECTOR)).map(textOf).filter(Boolean);
      if (bdis.length) return Array.from(new Set(bdis)).join('、').slice(0, 80);
      // 目印が無い場合の予備: 先頭から意味のある断片を推測
      const label = normalizeText(el.getAttribute('aria-label'));
      const seg = collectSegments(el).find((s) => !isNoiseSegment(s) && !NON_NAME_SEGMENT_RE.test(s));
      if (seg) return seg.slice(0, 80);
      if (label) return label.split(/[、,，]/)[0].trim().slice(0, 80);
      return '';
    }

    countOf(el) {
      let count = 0;
      const label = el.getAttribute('aria-label') || '';
      const m = label.match(COUNT_IN_LABEL_RE);
      if (m) count = Number(m[1] || m[4] || m[5] || m[6]) || 0;
      // バッジ（数字のみの断片、または aria-label に未読を含む子要素）
      for (const seg of collectSegments(el)) {
        if (/^\d{1,3}\+?$/.test(seg)) count = Math.max(count, parseInt(seg, 10));
      }
      for (const child of safeQueryAll(el, '[aria-label]')) {
        const cm = (child.getAttribute('aria-label') || '').match(COUNT_IN_LABEL_RE);
        if (cm) count = Math.max(count, Number(cm[1] || cm[4] || cm[5] || cm[6]) || 0);
      }
      return count;
    }

    hasUnreadLabel(el) {
      const isUnreadLabel = (x) => {
        const label = x.getAttribute('aria-label') || '';
        if (!UNREAD_LABEL_RE.test(label) || NOT_UNREAD_LABEL_RE.test(label)) return false;
        // ボタン・スイッチ（操作）のラベルは状態の表示ではない
        return !x.closest('button, [role="button"], [role="switch"], [role="menuitem"]');
      };
      return isUnreadLabel(el) || safeQueryAll(el, '[aria-label]').some(isUnreadLabel);
    }

    // ホーム画面の未読状態（data-is-unread）。属性が無ければ null
    unreadAttrOf(el) {
      const v = el.getAttribute('data-is-unread');
      return v === null ? null : v === 'true';
    }

    /**
     * ホーム画面の最新メッセージのプレビュー。{ sender, text, senderPending } または null
     * ts を渡した場合、プレビューの時刻が一致しなければ（古いプレビュー）null
     */
    previewOf(el, ts) {
      const body = el.querySelector(PREVIEW_BODY_SELECTOR);
      if (!body) return null;
      const tsEl = el.querySelector('[data-absolute-timestamp]');
      const previewTs = tsEl ? Number(tsEl.getAttribute('data-absolute-timestamp')) : 0;
      if (ts && previewTs && previewTs !== ts) return null;
      const senderEl = body.querySelector(PREVIEW_SENDER_SELECTOR);
      const senderRaw = senderEl ? textOf(senderEl) : '';
      const all = textOf(body);
      const text = normalizeText(senderRaw && all.startsWith(senderRaw) ? all.slice(senderRaw.length) : all.replace(senderRaw, ''));
      if (!text) return null;
      let sender = normalizeText(senderRaw.replace(/\s*[:：]\s*$/, ''));
      const senderPending = SENDER_LOADING_RE.test(sender);
      if (senderPending) sender = '';
      return { sender, text, senderPending };
    }

    // スペース ID のプレビュー（呼び出し時点の DOM から取得。名前の読み込みを待つ時に繰り返し呼ばれる）
    previewFor(key) {
      const ts = this.knownTs.get(key) || 0;
      for (const el of safeQueryAll(this.doc, '[data-group-id]')) {
        if (el.getAttribute('data-group-id') !== key) continue;
        const p = this.previewOf(el, ts);
        if (p) return p;
      }
      return null;
    }

    // 名前部分の文字の太さ（未読は太字で表示される）
    weightOf(el, name) {
      const walker = this.doc.createTreeWalker(el, 4);
      let node;
      while ((node = walker.nextNode())) {
        if (normalizeText(node.nodeValue) === name && node.parentElement) {
          const w = this.win.getComputedStyle(node.parentElement).fontWeight;
          const n = w === 'bold' ? 700 : parseInt(w, 10);
          return Number.isFinite(n) ? n : 400;
        }
      }
      return 400;
    }

    // そのスペースの最新メッセージ時刻（data-display-timestamp）
    timestampOf(el) {
      const holder = el.hasAttribute('data-display-timestamp') ? el : el.querySelector('[data-display-timestamp]');
      const n = holder ? Number(holder.getAttribute('data-display-timestamp')) : 0;
      return Number.isFinite(n) ? n : 0;
    }

    groupIdOf(el) {
      const holder = el.hasAttribute('data-group-id') ? el : el.querySelector('[data-group-id]');
      return holder ? holder.getAttribute('data-group-id') : '';
    }

    isActive(el) {
      // 開いているスペース（メッセージ一覧の data-group-id と一致）
      const main = this.chatMain();
      const openGroup = main && main.getAttribute('data-group-id');
      if (openGroup && this.groupIdOf(el) === openGroup) return true;
      const on = (x) => x.getAttribute('aria-selected') === 'true'
        || (x.hasAttribute('aria-current') && x.getAttribute('aria-current') !== 'false');
      return on(el) || safeQueryAll(el, '[aria-selected="true"], [aria-current]:not([aria-current="false"])').length > 0;
    }

    scan() {
      const perElement = this.items.filter((el) => el.isConnected).map((el) => {
        const name = this.nameOf(el);
        return {
          el, name, key: this.groupIdOf(el) || name, ts: this.timestampOf(el), unreadAttr: this.unreadAttrOf(el),
          count: this.countOf(el), label: this.hasUnreadLabel(el), weight: this.weightOf(el, name), active: this.isActive(el)
        };
      }).filter((s) => s.name);
      // 同じスペースが左側一覧とホーム画面の両方にある場合は 1 件にまとめる（名前は左側一覧を優先）
      const byKey = new Map();
      for (const s of perElement) {
        const g = byKey.get(s.key);
        if (!g) { byKey.set(s.key, { ...s }); continue; }
        g.ts = Math.max(g.ts, s.ts);
        g.count = Math.max(g.count, s.count);
        g.label = g.label || s.label;
        g.weight = Math.max(g.weight, s.weight);
        g.active = g.active || s.active;
        if (s.unreadAttr !== null) g.unreadAttr = g.unreadAttr === null ? s.unreadAttr : (g.unreadAttr || s.unreadAttr);
      }
      const snapshot = Array.from(byKey.values());

      // ほぼ全項目が太字なら太字は未読の目印として使わない
      const boldCount = snapshot.filter((s) => s.weight >= 600).length;
      const useBold = snapshot.length >= 2 && boldCount / snapshot.length < 0.8;

      const now = this.now();
      // 初回の走査は現状把握のみ（起動時点の未読は通知しない）
      const inWarmup = now < this.warmupUntil || !this.scanned;
      this.scanned = true;
      const next = new Map();
      for (const s of snapshot) {
        const unread = s.count > 0 || s.label || (useBold && s.weight >= 600);
        const state = { count: s.count, unread, ts: s.ts };
        next.set(s.key, state);
        if (inWarmup) {
          this.knownTs.set(s.key, Math.max(this.knownTs.get(s.key) || 0, s.ts));
          continue;
        }
        const prev = this.states.get(s.key);
        // 最新メッセージ時刻の更新（初めて現れた項目は監視開始より新しいか）・未読数の増加・未読化のいずれか
        const knownTs = this.knownTs.get(s.key);
        const tsIncreased = s.ts > 0 && (knownTs !== undefined ? s.ts > knownTs : s.ts > this.startedAt);
        // 初めて現れた項目は最新時刻だけで判定する（読み込みの遅い一覧で、起動前からの未読を新着と誤認しないため）
        // スペース ID 方式（実機）は最新時刻の更新だけで判定する。太字・未読数・ラベルは、読んだ時の表示変化や
        // 「8 割以上が太字なら太字を使わない」判定の切り替わりで誤検知する（実機で、読み上げ済みのスペースを後から再通知した）
        const flagIncreased = this.itemSource !== 'group-id' && Boolean(prev && (s.count > prev.count || (unread && !prev.unread)));
        const increased = tsIncreased || flagIncreased;
        // ホーム画面で既読と表示されている（別端末からの自分の投稿・既に読んだ等）。
        // 既読表示の更新が時刻より遅れて来ることがあるため、時刻は記録せず、未読になった時点で改めて判定する
        if (increased && s.unreadAttr === false) continue;
        if (s.ts > (knownTs || 0)) this.knownTs.set(s.key, s.ts);
        if (!increased || s.active) continue;
        const last = this.lastAnnounced.get(s.key) || 0;
        if (now - last < this.opts.repeatGuardMs) continue;
        this.lastAnnounced.set(s.key, now);
        this.announceCount++;
        this.lastAnnounceAt = now;
        const reason = tsIncreased ? '最新時刻の更新' : (s.count > (prev ? prev.count : 0) ? '未読数の増加' : '未読表示');
        const key = s.key;
        this.onUnread({ name: s.name, count: s.count, reason, key, getPreview: () => this.previewFor(key) });
      }
      this.states = next;
      this.onStatus(this.getStatus());
    }

    getStatus() {
      let unread = 0;
      for (const s of this.states.values()) if (s.unread) unread++;
      return {
        navItems: this.groupCount,
        navSource: this.itemSource,
        unreadItems: unread,
        announceCount: this.announceCount,
        lastAnnounceAt: this.lastAnnounceAt
      };
    }
  }

  /**
   * 一覧項目の選別。
   * - role 付き項目（treeitem 等）は、他の項目を含むもの（セクション見出し等）を除いた末端を採用
   * - リンクは role 付き項目の内側にあるものを除外（バッジがリンクの外にあることがあるため）
   */
  function pickItems(els) {
    const isRoleItem = (el) => /^(treeitem|listitem|option)$/.test(el.getAttribute('role') || '');
    const roleItems = els.filter(isRoleItem);
    const leaves = roleItems.filter((el) => !roleItems.some((o) => o !== el && el.contains(o)));
    const leafSet = new Set(leaves);
    const links = els.filter((el) => !isRoleItem(el) && !roleItems.some((r) => r.contains(el) && leafSet.has(r)) && !roleItems.some((r) => el.contains(r)));
    return leaves.concat(outermost(links));
  }

  function outermost(els) {
    const set = new Set(els);
    return els.filter((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
  }

  const api = { UnreadWatcher };
  if (isNode) module.exports = api;
  root.ChatReaderUnreadWatcher = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
