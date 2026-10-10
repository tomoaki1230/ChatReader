/*
 * ChatReader バックグラウンド（Service Worker）
 * chrome.tts で読み上げる。タブが裏にあっても確実に再生できるよう、読み上げはここで一括処理する。
 */
importScripts('shared/settings.js', 'shared/dedupe.js');

const { normalizeSettings } = self.ChatReaderSettings;
const { RecentKeys, toKey } = self.ChatReaderDedupe;

// 同じメッセージを二重に読まないための記録
// （開いているスペースの DOM と通知の両方、複数フレーム・複数タブから届く場合）
const recentKeys = new RecentKeys({ windowMs: 15000 });

// 直近に本文を読み上げたスペース・送信者（未読のお知らせを省略するかの判定用）
const UNREAD_DELAY_MS = 1500;
const SPOKEN_LOG_MS = 10000;
const UNREAD_REPEAT_MS = 15000;
let spokenLog = [];
const lastUnreadAt = new Map();

function logSpoken(space, sender) {
  const now = Date.now();
  spokenLog = spokenLog.filter((s) => now - s.at < SPOKEN_LOG_MS).concat([{ space: toKey(space), sender: toKey(sender), at: now }]);
}

// B のスペース名（DM は相手の名前）と、直近に読んだメッセージのスペース名・送信者が一致するか
function recentlySpokenAbout(name) {
  const key = toKey(name);
  const now = Date.now();
  return Boolean(key) && spokenLog.some((s) => now - s.at < SPOKEN_LOG_MS && (s.space === key || s.sender === key));
}

// ---- 一度に大量に届いた時の抑制（再接続・スリープ復帰などで通知や未読がまとめて届く）----
// 開いていないスペースの読み上げ（通知 A・未読 B）は 5 秒間に 3 件まで。超えた分は静かになってから件数だけ知らせる
const BURST_WINDOW_MS = 5000;
const BURST_MAX = 3;
const BURST_SUMMARY_DELAY_MS = 2000;
let burstTimes = [];
let burstSuppressed = 0;
let burstTimer = null;

function allowBurst() {
  const now = Date.now();
  burstTimes = burstTimes.filter((t) => now - t < BURST_WINDOW_MS);
  if (burstTimes.length < BURST_MAX) {
    burstTimes.push(now);
    return true;
  }
  burstSuppressed++;
  clearTimeout(burstTimer);
  burstTimer = setTimeout(() => {
    const n = burstSuppressed;
    burstSuppressed = 0;
    addDebug('読み上げ: ほか ' + n + ' 件（一度に届いたため省略）');
    speak('ほか ' + n + ' 件の新着があります');
  }, BURST_SUMMARY_DELAY_MS);
  return false;
}

// ---- 診断ログ（ポップアップに表示）----
// メッセージ本文を含むため、ディスクに残らない storage.session（ブラウザ終了で消える）に保存する
const DEBUG_LOG_MAX = 80;
let debugLog = [];
let debugSaveTimer = null;

function addDebug(text) {
  debugLog.push({ at: Date.now(), text: String(text).slice(0, 300) });
  if (debugLog.length > DEBUG_LOG_MAX) debugLog = debugLog.slice(-DEBUG_LOG_MAX);
  if (!debugSaveTimer) {
    debugSaveTimer = setTimeout(() => {
      debugSaveTimer = null;
      chrome.storage.session.set({ debugLog }).catch(() => {});
    }, 300);
  }
}

// Service Worker 再起動後も続きから記録する
const debugLoaded = chrome.storage.session.get('debugLog').then((r) => {
  if (Array.isArray(r.debugLog)) debugLog = r.debugLog.concat(debugLog).slice(-DEBUG_LOG_MAX);
}).catch(() => {});

async function loadSettings() {
  return normalizeSettings(await chrome.storage.sync.get(null));
}

/**
 * 使用する声を決める。外部送信が必要な声（remote: true のオンライン音声）は使わない。
 * 指定の声がローカルに無ければ日本語のローカル音声 → 任意のローカル音声の順で選ぶ。
 * lang だけを指定すると Chrome がオンライン音声を選ぶことがあるため、必ず voiceName を明示する。
 */
async function pickLocalVoice(preferredName, excludeName) {
  const voices = (await chrome.tts.getVoices()).filter((v) => v.voiceName && !v.remote && v.voiceName !== excludeName);
  const preferred = preferredName && voices.find((v) => v.voiceName === preferredName);
  if (preferred) return preferred.voiceName;
  const ja = voices.find((v) => (v.lang || '').toLowerCase().startsWith('ja'));
  return (ja || voices[0] || {}).voiceName || '';
}

async function speak(text, overrides, interrupt) {
  const s = { ...(await loadSettings()), ...(overrides || {}) };
  const options = { enqueue: !interrupt, volume: s.volume, rate: s.rate, pitch: s.pitch };
  options.voiceName = await pickLocalVoice(s.voiceName);
  if (!options.voiceName) {
    addDebug('音声エラー: 外部送信の無いローカル音声が見つからないため読み上げできません');
    return;
  }
  if (s.voiceName && s.voiceName !== options.voiceName) addDebug('指定の声「' + s.voiceName + '」は使えないため「' + options.voiceName + '」で読み上げます');
  try {
    await chrome.tts.speak(text, options);
  } catch (e) {
    // 声が使えなくなった（OS 変更など）場合は別のローカル音声で再試行
    addDebug('音声エラー（別のローカル音声で再試行）: ' + (e && e.message));
    options.voiceName = await pickLocalVoice('', options.voiceName);
    if (!options.voiceName) return;
    await chrome.tts.speak(text, options).catch((err) => addDebug('音声エラー: ' + (err && err.message)));
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'CR_SPEAK':
      // msg.dedupeKey: 重複判定に使う本文（省略時は読み上げ文全体） / msg.sender, msg.space: 送信者・スペース名
      loadSettings().then((s) => {
        if (!s.enabled || !msg.text) return;
        if (recentKeys.checkAndAdd(msg.dedupeKey || msg.text, msg.sender, msg.space)) {
          addDebug('読み上げ省略（15 秒以内に同じ内容を読み上げ済み）: ' + msg.text);
          return;
        }
        logSpoken(msg.space, msg.sender);
        if (msg.source === 'notify' && !allowBurst()) {
          addDebug('読み上げ省略（通知が一度に大量に届いたため）: ' + msg.text);
          return;
        }
        addDebug('読み上げ: ' + msg.text);
        speak(msg.text);
      });
      sendResponse({ ok: true });
      return false;
    case 'CR_UNREAD':
      // 未読になったスペースのお知らせ。通知で同じスペースの本文を読んでいれば省略するため少し待つ
      setTimeout(async () => {
        const s = await loadSettings();
        if (!s.enabled || !s.announceUnread || !msg.name) return;
        if (recentlySpokenAbout(msg.name)) {
          addDebug('未読お知らせ省略（通知で本文を読み上げ済み）: ' + msg.name);
          return;
        }
        const now = Date.now();
        if (now - (lastUnreadAt.get(msg.name) || 0) < UNREAD_REPEAT_MS) return;
        lastUnreadAt.set(msg.name, now);
        if (!allowBurst()) {
          addDebug('未読お知らせ省略（一度に大量に届いたため）: ' + msg.name);
          return;
        }
        addDebug('読み上げ: ' + msg.name + ' に新着メッセージ');
        speak(msg.name + ' に新着メッセージ');
      }, UNREAD_DELAY_MS);
      sendResponse({ ok: true });
      return false;
    case 'CR_LOG':
      debugLoaded.then(() => addDebug(msg.text));
      sendResponse({ ok: true });
      return false;
    case 'CR_DUMP_RESULT':
      // 複数フレームからの結果を順に追記
      chrome.storage.session.get('domDump').then((r) => {
        const list = Array.isArray(r.domDump) ? r.domDump : [];
        list.push(String(msg.text || '').slice(0, 200000));
        return chrome.storage.session.set({ domDump: list });
      }).catch(() => {});
      sendResponse({ ok: true });
      return false;
    case 'CR_CLEAR_LOG':
      debugLog = [];
      chrome.storage.session.set({ debugLog }).catch(() => {});
      sendResponse({ ok: true });
      return false;
    case 'CR_TEST':
      // ポップアップからの試聴（未保存の値も反映できるよう overrides を受け取る）
      speak(msg.text || '読み上げのテストです。', msg.overrides, true);
      sendResponse({ ok: true });
      return false;
    case 'CR_STOP':
      chrome.tts.stop();
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  // 旧版がディスクに保存していた診断ログ・ダンプを削除
  await chrome.storage.local.remove(['debugLog', 'domDump']).catch(() => {});
  // 欠けている設定項目を既定値で補完
  const current = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set(normalizeSettings(current));
});
