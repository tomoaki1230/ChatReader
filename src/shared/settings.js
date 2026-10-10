/*
 * ChatReader 設定定義（background / popup / content / テストで共有）
 * クラシックスクリプトとしても CommonJS としても読み込めるようにしている。
 */
(function (root) {
  'use strict';

  // 設定の既定値
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,          // 読み上げ ON/OFF
    volume: 1.0,            // 音量 0.0〜1.0
    rate: 1.0,              // 読み上げ速度 0.1〜10（UI では 0.5〜3.0）
    pitch: 1.0,             // 声の高さ 0.0〜2.0
    voiceName: '',          // 声の種類（空 = ブラウザ既定の日本語音声）
    readSender: true,       // 送信者名を読み上げるか
    addHonorific: false,    // 送信者名に「さん」を付けるか
    readSpaceName: true,    // スペース名を読み上げるか（「スペース名、送信者、本文」）
    skipMentions: true,     // 本文中の「@名前」を読み上げない
    announceMentionAll: false, // 「@全員」等は除去せず「全員宛て」と伝える（skipMentions ON の時のみ）
    readSystemMessages: true, // スペースの更新情報（メンバーの招待・参加など）を読み上げる
    readOwnMessages: false, // 自分が書いたメッセージも読み上げるか
    ownName: '',            // 自分の表示名（自分のメッセージ判定に使用）
    readWhenFocused: true,  // タブを見ている時も読み上げるか
    // 開いていないスペースの新着: 'full' 本文まで読む（通知が出る時）/ 'nameOnly' スペース名だけ / 'off' 読まない
    otherSpaces: 'full',
    // 以下 2 つは otherSpaces から自動で決まる（内部用。A: 通知の本文を読む / B: 未読のスペース名を知らせる）
    readNotifications: true,
    announceUnread: true,
    maxLength: 200          // 読み上げる最大文字数
  });

  // 数値設定の範囲
  const LIMITS = Object.freeze({
    volume: [0, 1],
    rate: [0.1, 10],
    pitch: [0, 2],
    maxLength: [20, 2000]
  });

  function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  const OTHER_SPACES_MODES = ['full', 'nameOnly', 'off'];

  // 開いていないスペースの設定。旧版（readNotifications / announceUnread の 2 つ）からの移行を含む
  function resolveOtherSpaces(src) {
    if (OTHER_SPACES_MODES.includes(src.otherSpaces)) return src.otherSpaces;
    const a = typeof src.readNotifications === 'boolean' ? src.readNotifications : true;
    const b = typeof src.announceUnread === 'boolean' ? src.announceUnread : true;
    if (!a && !b) return 'off';
    if (!a && b) return 'nameOnly';
    return 'full'; // 旧「A: ON・B: OFF」は対応する選択肢が無いため「本文まで読む」に
  }

  // ストレージから読んだ値を検証し、欠損や範囲外を既定値で補う
  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(LIMITS)) {
      const [min, max] = LIMITS[key];
      out[key] = clamp(src[key], min, max, DEFAULT_SETTINGS[key]);
    }
    out.maxLength = Math.round(out.maxLength);
    for (const key of ['enabled', 'readSender', 'addHonorific', 'readSpaceName', 'skipMentions', 'announceMentionAll', 'readSystemMessages', 'readOwnMessages', 'readWhenFocused']) {
      if (typeof src[key] === 'boolean') out[key] = src[key];
    }
    for (const key of ['voiceName', 'ownName']) {
      if (typeof src[key] === 'string') out[key] = src[key].trim();
    }
    out.otherSpaces = resolveOtherSpaces(src);
    out.readNotifications = out.otherSpaces === 'full';
    out.announceUnread = out.otherSpaces !== 'off';
    return out;
  }

  const api = { DEFAULT_SETTINGS, LIMITS, OTHER_SPACES_MODES, normalizeSettings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChatReaderSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
