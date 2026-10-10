/*
 * ChatReader 重複読み上げ防止
 * 同じメッセージが「開いているスペースの DOM」と「デスクトップ通知」の両方から届く、
 * あるいは複数フレーム・複数タブから届く場合に、最初の 1 回だけを読み上げる。
 */
(function (root) {
  'use strict';

  // 比較用キー: 空白と記号を除去
  function toKey(s) {
    return String(s == null ? '' : s).replace(/[\s​、。,.:：!！?？「」"'()（）]+/g, '');
  }

  class RecentKeys {
    constructor(options) {
      const opts = options || {};
      this.windowMs = opts.windowMs || 15000;
      this.minContainLength = opts.minContainLength || 4;
      this.now = opts.now || (() => Date.now());
      this.items = [];
    }

    /**
     * 直近に同じメッセージがあれば true。無ければ記録して false。
     * 本文: 一致、または一方が他方を含む（通知本文が「名前: 本文」の形になることがあるため）。
     * 送信者・スペース: 両方分かっている時は一致が必要（別の人・別のスペースの同じ文面を省略しない）。
     */
    checkAndAdd(raw, sender, space) {
      const key = toKey(raw);
      if (!key) return false;
      const who = toKey(sender);
      const where = toKey(space);
      const now = this.now();
      this.items = this.items.filter((it) => now - it.at < this.windowMs);
      const dup = this.items.some((it) => {
        if (who && it.who && who !== it.who) return false;
        if (where && it.where && where !== it.where) return false;
        if (it.key === key) return true;
        const shorter = it.key.length < key.length ? it.key : key;
        const longer = shorter === key ? it.key : key;
        return shorter.length >= this.minContainLength && longer.includes(shorter);
      });
      if (!dup) this.items.push({ key, who, where, at: now });
      return dup;
    }
  }

  const api = { RecentKeys, toKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChatReaderDedupe = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
