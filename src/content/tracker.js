/*
 * ChatReader 新着メッセージ監視（DOM 自動追従付き）
 *
 * 1. 既知のセレクタ（学習済み → 組み込み）から、現在の DOM に一致するものを採用
 * 2. MutationObserver で追加要素を監視し、未読のメッセージ要素を通知
 * 3. 以下のいずれかで「セレクタが古くなった」と判断し、learner で再学習する
 *    - 定期ヘルスチェックでセレクタが 1 件も一致しない状態が続く
 *    - リスト末尾にテキスト付き要素が追加されたのに、セレクタに一致しない（ドリフト）
 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const core = isNode ? require('./core.js') : root.ChatReaderCore;
  const learner = isNode ? require('./learner.js') : root.ChatReaderLearner;
  const { extractMessageText, collectSegments, isPendingSegment, textOf, safeQueryAll, safeMatches, elementSignature, signatureKey, messageIdOf, isNoiseSegment } = core;

  // 組み込みプロファイル（Google Chat の既知 DOM。変更されたら学習器が補う）
  const BUILTIN_PROFILES = Object.freeze([
    // 実機（2026-10）で確認済み: メッセージ div[jsname="Ne3sFf"][data-id]、本文 div[jsname="bgckF"]、送信者 span[data-member-id][data-name]
    {
      name: 'builtin-jsname',
      message: 'div[jsname="Ne3sFf"]',
      body: 'div[jsname="bgckF"]',
      sender: '[data-member-id], [data-hovercard-id], [data-name]'
    },
    {
      name: 'builtin-message-id',
      message: 'div[data-message-id]',
      body: 'div[jsname="bgckF"]',
      sender: '[data-member-id], [data-hovercard-id], [data-name]'
    }
  ]);

  const DEFAULT_OPTIONS = {
    debounceMs: 250,          // DOM 変更をまとめて処理する待ち時間
    healthIntervalMs: 15000,  // ヘルスチェック間隔
    healthMissLimit: 2,       // 連続で一致 0 件なら再学習
    warmupMs: 4000,           // 起動直後は既存メッセージとして扱う時間（画面切替時は最長時間）
    navQuietMs: 800,          // 画面切替後、メッセージの追加がこの時間途切れたら待機終了
    pendingRetryLimit: 20,    // 「送信しています...」の間、再評価する回数（retryDelayMs 間隔）
    burstThreshold: 5,        // 一度にこれ以上増えたら履歴読込とみなす
    driftThreshold: 2,        // 不一致追加がこの回数続いたら再学習
    maxAppendsPerMessage: 2,  // 1 回の変更でこれ以下の追加なら新着候補とみなす
    healCooldownMs: 10000,    // 再学習の最小間隔
    retryDelayMs: 500,        // 本文が未描画の時の再試行間隔
    retryLimit: 3,
    emptyLimit: 2,            // 本文の無い新着がこの回数続いたらセレクタを破棄して再学習
    minTextRatio: 0.5,        // 採用するプロファイルの「本文を持つ要素」の最低割合
    maxSeenIds: 3000,
    maxMessageAgeMs: 10 * 60 * 1000, // 投稿時刻がこれより古いメッセージは新着とみなさない（過去ログ・再描画）
    signatureTtlMs: 30 * 60 * 1000,  // 既読メッセージの内容の署名を覚えておく時間（再描画の判定用）
    maxSignatures: 3000
  };

  class ChatDomTracker {
    constructor(doc, options) {
      const opts = options || {};
      this.doc = doc;
      this.win = doc.defaultView;
      this.opts = { ...DEFAULT_OPTIONS, ...opts };
      this.onMessage = opts.onMessage || (() => {});
      this.onStatus = opts.onStatus || (() => {});
      this.onProfileLearned = opts.onProfileLearned || (() => {});
      this.log = opts.log || (() => {});
      this.onSkip = opts.onSkip || (() => {}); // 読み上げ対象外にした理由（診断用）
      this.onProfileRejected = opts.onProfileRejected || (() => {});
      this.now = opts.now || (() => Date.now());

      this.candidates = [];
      this.profile = null;
      this.badSelectors = new Set();
      this.emptyStreak = 0;
      this.seenEls = new WeakSet();
      this.seenIds = new Set();
      this.retries = new WeakMap();
      this.pending = [];
      this.flushTimer = null;
      this.healthTimer = null;
      this.observer = null;
      this.recentUnmatched = [];
      this.driftCount = 0;
      this.healthMisses = 0;
      this.lastHealAt = -Infinity;
      this.lastHealReason = '';
      this.healCount = 0;
      this.lastMessageAt = 0;
      this.warmupUntil = 0;
      this.navWarmupEnd = 0;
      this.pendingRetries = new WeakMap();
      this.seenSigs = new Map(); // 内容の署名 → 記録時刻（ID も時刻も無いメッセージが再描画された時に再度読まないため）
      this.healFailing = false;  // 学習の失敗が続いている間はログを繰り返さない
      this.retryScheduled = new WeakSet(); // 再試行タイマー予約済みの要素（DOM 変化のたびに回数を進めないため）
      this.lastUrl = '';
    }

    // ---- ライフサイクル ----

    /**
     * @param learnedProfile 前回保存した学習結果
     * @param badSelectors   過去に「本文の無い要素を指す」として破棄したセレクタ（再利用・再学習しない）
     */
    start(learnedProfile, badSelectors) {
      for (const sel of badSelectors || []) this.badSelectors.add(sel);
      // 実機で確認済みの組み込みを優先し、学習結果は組み込みが使えない時に使う
      this.candidates = [...BUILTIN_PROFILES, learnedProfile].filter((p) => p && p.message && !this.badSelectors.has(p.message));
      this.lastUrl = this.currentUrl();
      this.warmupUntil = this.now() + this.opts.warmupMs;
      this.selectProfile();
      this.baseline();
      const Observer = this.win.MutationObserver;
      this.observer = new Observer((muts) => this.onMutations(muts));
      this.observer.observe(this.doc.documentElement, { childList: true, subtree: true, characterData: true });
      this.healthTimer = this.win.setInterval(() => this.healthCheck(), this.opts.healthIntervalMs);
      this.emitStatus();
    }

    stop() {
      if (this.observer) this.observer.disconnect();
      if (this.healthTimer) this.win.clearInterval(this.healthTimer);
      if (this.flushTimer) this.win.clearTimeout(this.flushTimer);
      this.observer = null;
      this.healthTimer = null;
      this.flushTimer = null;
    }

    currentUrl() {
      try { return this.win.location.href; } catch (e) { return ''; }
    }

    // ---- プロファイル選択 ----

    selectProfile() {
      for (const p of this.candidates) {
        if (this.badSelectors.has(p.message)) continue;
        const q = this.profileQuality(p);
        if (!q.count) continue;
        // 一致はしても本文を持たない要素（装飾・区切り等）ばかりなら不採用
        if (q.withText / q.sampled < this.opts.minTextRatio) {
          this.log('プロファイル不採用（本文を持つ要素が ' + q.withText + '/' + q.sampled + ' 件）: ' + p.name + ' (' + p.message + ')');
          this.rejectProfile(p);
          continue;
        }
        if (this.profile !== p) this.log('プロファイル採用: ' + p.name + ' (' + p.message + ') 本文あり ' + q.withText + '/' + q.sampled + ' 件');
        this.profile = p;
        return true;
      }
      this.profile = null;
      return false;
    }

    // 直近の一致要素のうち本文を持つものの数
    profileQuality(p) {
      const sample = this.findMessages(this.doc, p).slice(-20);
      const withText = sample.filter((el) => extractMessageText(el, { bodySelector: p.body }).length > 0).length;
      return { count: sample.length, sampled: sample.length, withText };
    }

    // 不適切なプロファイルを候補から外す（学習結果なら保存分も破棄させる）
    rejectProfile(p) {
      this.badSelectors.add(p.message);
      this.candidates = this.candidates.filter((c) => c !== p);
      this.onProfileRejected(p);
    }

    // scope 内（scope 自身を含む）のメッセージ要素。入れ子は外側のみ。
    findMessages(scope, profile) {
      const p = profile || this.profile;
      if (!p || !scope) return [];
      const found = [];
      if (scope.nodeType === 1 && safeMatches(scope, p.message)) found.push(scope);
      for (const el of safeQueryAll(scope, p.message)) found.push(el);
      return found.filter((el) => !(el.parentElement && el.parentElement.closest && safeClosest(el.parentElement, p.message)));
    }

    closestMessage(node) {
      if (!this.profile) return null;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el) return null;
      let hit = safeClosest(el, this.profile.message);
      // 外側にも一致する要素があればそちらを採用
      while (hit && hit.parentElement) {
        const outer = safeClosest(hit.parentElement, this.profile.message);
        if (!outer) break;
        hit = outer;
      }
      return hit;
    }

    // ---- 既読管理 ----

    // メッセージ内容の署名（スペース・送信者・本文・投稿時刻）。本文が無ければ null
    signatureOf(el) {
      const p = this.profile;
      const text = extractMessageText(el, { bodySelector: p && p.body });
      if (!text) return null;
      const main = this.doc.querySelector('[role="main"]');
      const group = main ? (main.getAttribute('data-group-id') || '') : '';
      const sender = p && p.sender ? senderIn(el, p.sender) : '';
      return [group, sender, text, this.messageTimeOf(el)].join('|');
    }

    // 既に読んだ（または既存として扱った）メッセージと同じ内容の再描画か
    isRerender(el) {
      const sig = this.signatureOf(el);
      if (!sig) return false;
      const at = this.seenSigs.get(sig);
      return at !== undefined && this.now() - at < this.opts.signatureTtlMs;
    }

    rememberSignature(el) {
      const sig = this.signatureOf(el);
      if (!sig) return;
      this.seenSigs.delete(sig);
      this.seenSigs.set(sig, this.now());
      if (this.seenSigs.size > this.opts.maxSignatures) this.seenSigs.delete(this.seenSigs.keys().next().value);
    }

    markSeen(el) {
      this.seenEls.add(el);
      this.rememberSignature(el);
      const id = messageIdOf(el);
      if (id) {
        this.seenIds.add(id);
        if (this.seenIds.size > this.opts.maxSeenIds) {
          const first = this.seenIds.values().next().value;
          this.seenIds.delete(first);
        }
      }
    }

    isSeen(el) {
      if (this.seenEls.has(el)) return true;
      const id = messageIdOf(el);
      return Boolean(id && this.seenIds.has(id));
    }

    baseline(exclude) {
      const skip = exclude || new Set();
      for (const el of this.findMessages(this.doc)) if (!skip.has(el)) this.markSeen(el);
    }

    // ---- DOM 変更処理 ----

    onMutations(mutations) {
      for (const m of mutations) {
        if (m.type === 'characterData') {
          if (m.target.parentElement) this.pending.push(m.target.parentElement);
          continue;
        }
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) this.pending.push(n);
          else if (n.nodeType === 3 && n.parentElement) this.pending.push(n.parentElement);
        }
      }
      if (this.pending.length && !this.flushTimer) {
        this.flushTimer = this.win.setTimeout(() => {
          this.flushTimer = null;
          this.flush();
        }, this.opts.debounceMs);
      }
    }

    flush() {
      const added = Array.from(new Set(this.pending)).filter((n) => n.isConnected);
      this.pending = [];
      if (!added.length) return;

      const url = this.currentUrl();
      if (url !== this.lastUrl) {
        // 別のスペース・DM へ移動 → 表示される既存メッセージは読まない
        this.lastUrl = url;
        // 過去ログの描画が落ち着くまで（追加が navQuietMs 途切れるまで、最長 warmupMs）は既存扱い
        this.navWarmupEnd = this.now() + this.opts.warmupMs;
        this.warmupUntil = this.now() + this.opts.navQuietMs;
      }

      if (!this.profile) {
        if (this.selectProfile()) {
          this.baseline();
          this.emitStatus();
        } else {
          this.detectDrift(added);
        }
        return;
      }

      const found = new Set();
      for (const n of added) {
        const anc = this.closestMessage(n);
        if (anc) found.add(anc);
        for (const el of this.findMessages(n)) found.add(el);
      }
      if (!found.size) {
        this.detectDrift(added);
        return;
      }
      this.driftCount = 0;
      this.handleFresh(Array.from(found).filter((el) => !this.isSeen(el)));
    }

    handleFresh(fresh) {
      if (!fresh.length) return;
      const now = this.now();
      if (now < this.warmupUntil && now < this.navWarmupEnd) {
        this.warmupUntil = Math.min(this.navWarmupEnd, now + this.opts.navQuietMs);
      }
      if (now < this.warmupUntil || fresh.length >= this.opts.burstThreshold) {
        const reason = this.now() < this.warmupUntil ? '起動・画面切替直後のため既存扱い' : '一度に ' + fresh.length + ' 件追加（履歴読込扱い）';
        this.onSkip(reason, fresh.length === 1 ? extractMessageText(fresh[0]) : fresh.length + ' 件');
        fresh.forEach((el) => this.markSeen(el));
        return;
      }
      fresh.sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
      for (const el of fresh) {
        if (this.isSeen(el)) continue;
        if (this.isHistoryInsert(el)) {
          this.onSkip('既読メッセージより前に挿入（過去ログ扱い）', extractMessageText(el));
          this.markSeen(el);
          continue;
        }
        if (this.isPending(el)) {
          this.schedulePendingRetry(el);
          continue;
        }
        if (this.isRerender(el)) {
          this.onSkip('既に読んだメッセージと同じ内容の再描画', extractMessageText(el, { bodySelector: this.profile && this.profile.body }));
          this.markSeen(el);
          continue;
        }
        // 本文欄も投稿時刻も無いメッセージはスペースの更新情報（実画面: 「…さんから招待されましたが、まだ参加していません」等）。
        // 送信者は要素内からのみ取る（直前のメッセージの送信者を借りると「自分」と誤認する）
        const bodySel = this.profile && this.profile.body;
        const isEvent = Boolean(bodySel) && !el.querySelector(bodySel) && !this.messageTimeOf(el);
        const sender = isEvent ? (this.profile.sender ? senderIn(el, this.profile.sender) : '') : this.findSender(el);
        const text = extractMessageText(el, { sender, bodySelector: bodySel });
        if (!text) {
          this.scheduleRetry(el);
          continue;
        }
        this.markSeen(el);
        this.emptyStreak = 0;
        this.lastMessageAt = this.now();
        this.onMessage({ sender, text, element: el, system: isEvent, profileName: this.profile ? this.profile.name : '' });
      }
    }

    // 送信処理中（「送信しています...」表示）のメッセージか
    isPending(el) {
      return collectSegments(el).some(isPendingSegment);
    }

    // 送信が完了するまで待ってから読む（本文なしの判定・セレクタ破棄には数えない）
    schedulePendingRetry(el) {
      if (this.retryScheduled.has(el)) return;
      const n = (this.pendingRetries.get(el) || 0) + 1;
      this.pendingRetries.set(el, n);
      if (n > this.opts.pendingRetryLimit) {
        this.onSkip('送信中のまま完了しませんでした', extractMessageText(el));
        this.markSeen(el);
        return;
      }
      this.retryLater(el);
    }

    retryLater(el) {
      this.retryScheduled.add(el);
      this.win.setTimeout(() => {
        this.retryScheduled.delete(el);
        if (el.isConnected && !this.isSeen(el)) this.handleFresh([el]);
      }, this.opts.retryDelayMs);
    }

    // 本文が後から描画されるケースに備えて再評価する
    scheduleRetry(el) {
      if (this.retryScheduled.has(el)) return;
      const n = (this.retries.get(el) || 0) + 1;
      this.retries.set(el, n);
      if (n > this.opts.retryLimit) {
        this.onSkip('本文が空のまま（再試行 ' + this.opts.retryLimit + ' 回。画像・ファイルのみ等）', '');
        this.markSeen(el);
        // 学習したセレクタだけを疑う（組み込みは実機で確認済みのため、画像のみの投稿などで破棄しない）
        if (this.profile && this.profile.name === 'learned') {
          this.emptyStreak++;
          if (this.emptyStreak >= this.opts.emptyLimit) this.discardEmptyProfile();
        }
        return;
      }
      this.retryLater(el);
    }

    // 新着に一致するが本文が無い = メッセージ以外の要素を指している → 破棄して選び直す
    discardEmptyProfile() {
      const bad = this.profile;
      this.emptyStreak = 0;
      this.log('セレクタ ' + bad.message + ' は本文の無い要素に一致するため破棄します');
      this.rejectProfile(bad);
      this.profile = null;
      if (this.selectProfile()) {
        this.baseline();
        this.emitStatus();
      } else {
        this.heal('empty', true);
      }
    }

    // メッセージの投稿時刻（実機: span[data-absolute-timestamp]、ミリ秒）。不明なら 0
    messageTimeOf(el) {
      const holder = el.querySelector('[data-absolute-timestamp]');
      const n = holder ? Number(holder.getAttribute('data-absolute-timestamp')) : 0;
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    // 過去ログの読み込み・再描画か
    // 投稿時刻が分かれば古さで判定、分からなければ既読メッセージより前に挿入されたかで判定
    isHistoryInsert(el) {
      const ts = this.messageTimeOf(el);
      if (ts) return ts < this.now() - this.opts.maxMessageAgeMs;
      for (const base of [el, el.parentElement]) {
        if (!base) continue;
        let sib = base.nextElementSibling;
        for (let i = 0; sib && i < 50; i++, sib = sib.nextElementSibling) {
          if (this.isSeen(sib)) return true;
          if (this.findMessages(sib).some((m) => this.isSeen(m))) return true;
        }
      }
      return false;
    }

    // 送信者名: メッセージ内 → 直前のメッセージ（連続投稿は名前が省略されるため）
    findSender(el) {
      const sel = this.profile && this.profile.sender;
      if (!sel) return '';
      let cur = el;
      for (let i = 0; cur && i < 15; i++) {
        const name = senderIn(cur, sel);
        if (name) return name;
        cur = cur.previousElementSibling;
      }
      // メッセージごとに別の枠に入っている構造（実機）: 文書順で直前のメッセージをさかのぼる
      const all = this.findMessages(this.doc);
      const idx = all.indexOf(el);
      for (let i = idx - 1; i >= 0 && i >= idx - 15; i--) {
        const name = senderIn(all[i], sel);
        if (name) return name;
      }
      return '';
    }

    // ---- DOM 変更（セレクタ陳腐化）の検知 ----

    looksLikeListAppend(el) {
      if (el.nodeType !== 1) return false;
      const parent = el.parentElement;
      if (!parent) return false;
      const chatRoot = learner.findChatRoot(this.doc);
      if (!chatRoot || !chatRoot.contains(el)) return false;
      const kids = Array.from(parent.children);
      if (kids.indexOf(el) < kids.length - 3) return false;
      const key = signatureKey(elementSignature(el));
      const same = kids.filter((k) => k !== el && signatureKey(elementSignature(k)) === key).length;
      if (same < 2) return false;
      return extractMessageText(el).length > 0;
    }

    detectDrift(added) {
      const appends = added.filter((n) => this.looksLikeListAppend(n));
      if (!appends.length) return;
      const now = this.now();
      // 新着は通常 1 通ずつ追加される。まとめて追加された場合は一覧の再描画とみなし、新着候補にしない
      const fresh = appends.length <= this.opts.maxAppendsPerMessage ? appends : [];
      this.recentUnmatched = this.recentUnmatched
        .filter((r) => now - r.at < 30000)
        .concat(fresh.map((el) => ({ el, at: now })))
        .slice(-20);
      this.driftCount++;
      this.log('セレクタ不一致の追加要素を検出 (' + this.driftCount + '/' + this.opts.driftThreshold + ')');
      if (this.driftCount >= this.opts.driftThreshold) this.heal('drift');
    }

    healthCheck() {
      // メッセージ一覧の無い画面（招待のプレビュー・ホーム等）では学習しない
      if (!learner.findChatRoot(this.doc)) {
        this.healthMisses = 0;
        this.emitStatus();
        return;
      }
      const count = this.profile ? this.findMessages(this.doc).length : 0;
      if (count === 0) {
        this.healthMisses++;
        if (this.healthMisses >= this.opts.healthMissLimit) {
          // まず既知プロファイルで復帰を試み、駄目なら学習
          if (this.selectProfile()) {
            this.baseline();
            this.healthMisses = 0;
          } else {
            this.heal('missing');
          }
        }
      } else {
        this.healthMisses = 0;
      }
      this.emitStatus();
    }

    /**
     * セレクタを再学習する。
     * 学習直前に検知した「不一致の追加要素」は新着として読み上げ、それ以外は既読扱いにする。
     */
    heal(reason, force) {
      const now = this.now();
      if (!force && now - this.lastHealAt < this.opts.healCooldownMs) return false;
      this.lastHealAt = now;
      this.lastHealReason = reason;
      // 手動の再学習: まず候補（組み込み優先）を評価し直し、使えるものがあればそれを使う
      // （正常に動いている組み込みを、返信を拾えない学習結果で置き換えないため）
      if (reason === 'manual') {
        const before = this.profile;
        this.profile = null;
        if (this.selectProfile()) {
          if (this.profile !== before) this.baseline();
          this.log('再学習: 既知のセレクタ ' + this.profile.message + ' が使えるためそれを使います');
          this.emitStatus();
          return true;
        }
      }
      const learned = learner.learnProfile(this.doc, now, { exclude: this.badSelectors });
      if (!learned) {
        // 失敗が続く間は最初の 1 回だけ記録する（15 秒ごとに同じログが並ぶのを防ぐ）
        if (!this.healFailing) this.log('再学習に失敗しました（理由: ' + reason + '）。成功するまで再試行を続けます');
        this.healFailing = true;
        this.emitStatus();
        return false;
      }
      this.healFailing = false;
      const previous = this.profile;
      // 現在のセレクタがまだメッセージを拾えている時は、学習結果がそれらの過半を拾える場合のみ採用する
      // （入力中表示などメッセージ以外の並びを学習して、正しく動いているセレクタを置き換えないため）
      const currentMatches = previous ? this.findMessages(this.doc, previous) : [];
      if (reason !== 'manual' && currentMatches.length > 0) {
        const learnedSet = new Set(this.findMessages(this.doc, learned));
        const covered = currentMatches.filter((el) => learnedSet.has(el)).length;
        if (covered / currentMatches.length < 0.5) {
          this.driftCount = 0;
          this.recentUnmatched = [];
          this.log('学習結果 ' + learned.message + ' は現在のメッセージを拾えないため採用しません（' + previous.message + ' を継続）');
          this.emitStatus();
          return false;
        }
      }
      this.profile = learned;
      const recent = new Set();
      for (const r of this.recentUnmatched) {
        if (!r.el.isConnected || now - r.at > 30000) continue;
        const m = this.closestMessage(r.el) || this.findMessages(r.el)[0];
        if (m) recent.add(m);
      }
      this.recentUnmatched = [];
      // ドリフトが契機なのに、その追加要素を学習結果が拾えない = 追加要素はメッセージではなかった（入力中表示など）
      if (reason === 'drift' && previous && recent.size === 0) {
        this.profile = previous;
        this.driftCount = 0;
        this.log('学習結果 ' + learned.message + ' は不一致の追加要素を説明できないため採用しません（現在のセレクタを継続）');
        this.emitStatus();
        return false;
      }
      this.healCount++;
      this.candidates = [...BUILTIN_PROFILES.filter((b) => !this.badSelectors.has(b.message)), learned];
      this.log('セレクタを再学習しました: ' + learned.message + ' / 送信者: ' + (learned.sender || 'なし'));
      if (!learned.structural) this.onProfileLearned(learned);

      this.driftCount = 0;
      this.healthMisses = 0;
      this.baseline(recent);
      this.handleFresh(Array.from(recent).filter((el) => !this.isSeen(el)));
      this.emitStatus();
      return true;
    }

    getStatus() {
      return {
        state: this.profile ? 'tracking' : 'searching',
        profileName: this.profile ? this.profile.name : '',
        messageSelector: this.profile ? this.profile.message : '',
        senderSelector: this.profile ? (this.profile.sender || '') : '',
        matchCount: this.profile ? this.findMessages(this.doc).length : 0,
        healCount: this.healCount,
        lastHealAt: Number.isFinite(this.lastHealAt) ? this.lastHealAt : 0,
        lastHealReason: this.lastHealReason,
        lastMessageAt: this.lastMessageAt
      };
    }

    emitStatus() {
      this.onStatus(this.getStatus());
    }
  }

  function safeClosest(el, selector) {
    try { return el.closest(selector); } catch (e) { return null; }
  }

  function senderIn(el, selector) {
    for (const hit of safeQueryAll(el, selector)) {
      const t = textOf(hit);
      if (t && t.length <= 40 && !isNoiseSegment(t)) return t;
    }
    return '';
  }

  const api = { ChatDomTracker, BUILTIN_PROFILES, DEFAULT_OPTIONS };
  if (isNode) module.exports = api;
  root.ChatReaderTracker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
