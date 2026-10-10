/*
 * ChatReader コンテンツスクリプト（Google Chat ページ上で動作）
 * トラッカーが検出した新着メッセージを設定に従って絞り込み、background に読み上げを依頼する。
 */
(async function () {
  'use strict';

  if (window.__chatReaderStarted) return;
  window.__chatReaderStarted = true;

  const { normalizeSettings } = globalThis.ChatReaderSettings;
  const { buildSpeechText, buildNotificationSpeech, parseNotificationTitle, prepareBody, isSystemMessage, formatSystemMessage, OwnMessageDetector, normalizeText } = globalThis.ChatReaderCore;
  const { ChatDomTracker } = globalThis.ChatReaderTracker;
  const { UnreadWatcher } = globalThis.ChatReaderUnreadWatcher;
  const { buildDomDump } = globalThis.ChatReaderDomDump;

  const LOG_PREFIX = '[ChatReader]';
  const log = (msg) => console.debug(LOG_PREFIX, msg);

  let settings = normalizeSettings(await chrome.storage.sync.get(null));
  const BAD_SELECTOR_TTL_MS = 7 * 24 * 60 * 60 * 1000; // Chat 側の変更で再び有効になり得るため期限付き
  const stored = await chrome.storage.local.get(['learnedProfile', 'badSelectors', 'selfNames']);
  // 自分の本名（自分の投稿は「自分」と表示されるが、要素の data-name に本名がある）。更新情報の「○○ さんが参加しました」の判定に使う
  const selfNames = new Set(Array.isArray(stored.selfNames) ? stored.selfNames : []);
  const learnedProfile = stored.learnedProfile;
  const badSelectors = (Array.isArray(stored.badSelectors) ? stored.badSelectors : [])
    .filter((b) => b && b.selector && Date.now() - b.at < BAD_SELECTOR_TTL_MS);
  const ownDetector = new OwnMessageDetector();
  let lastStatusJson = '';

  // 拡張機能の再読み込み後など、古いスクリプトが API を呼べなくなった時に停止する
  function isContextAlive() {
    try { return Boolean(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function isUserLooking() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  // 診断ログ（ポップアップの「診断ログ」に表示。background が保持する）
  function debug(text) {
    log(text);
    if (!isContextAlive()) return;
    const frame = window === window.top ? '' : '[iframe] ';
    const hidden = document.hidden ? '[非表示中] ' : '';
    chrome.runtime.sendMessage({ type: 'CR_LOG', text: frame + hidden + text }).catch(() => {});
  }

  function onMessage(message) {
    if (!isContextAlive()) { tracker.stop(); unreadWatcher.stop(); return; }
    if (isSystemMessage(message.text)) {
      onSystemMessage(message);
      return;
    }
    const own = ownDetector.isOwn(message, settings.ownName);
    if (own) learnSelfName(message.element);
    debug('DOM 検出: ' + (message.sender || '(送信者不明)') + ' / ' + message.text + (own ? '（自分）' : ''));
    if (!settings.enabled) { debug('→ 読み上げ OFF のため省略'); return; }
    if (own && !settings.readOwnMessages) {
      debug('→ 自分のメッセージのため省略（設定「自分が書いたメッセージも読み上げる」が OFF）');
      return;
    }
    if (!settings.readWhenFocused && isUserLooking()) { debug('→ Chat 表示中のため省略'); return; }
    const body = prepareBody(message.text, settings, knownNames());
    const space = currentSpaceName();
    const text = buildSpeechText({ ...message, text: body, space }, settings);
    if (!text) return;
    send({ type: 'CR_SPEAK', text, dedupeKey: message.text, sender: message.sender, space });
  }

  // 自分の投稿の送信者要素から本名を覚える（最大 5 件、保存して次回以降も使う）
  function learnSelfName(el) {
    const holder = el && el.querySelector && el.querySelector('[data-name]');
    const name = holder ? normalizeText(holder.getAttribute('data-name')) : '';
    if (!name || name === '自分' || selfNames.has(name)) return;
    selfNames.add(name);
    debug('自分の名前を記録: ' + name);
    if (isContextAlive()) chrome.storage.local.set({ selfNames: Array.from(selfNames).slice(-5) }).catch(() => {});
  }

  // スペースの更新情報（メンバーの招待・参加など）: 名前を文に戻し「スペース名、○○ さんが 太郎 を招待しました」と読む
  function onSystemMessage(message) {
    const text = formatSystemMessage(message.sender, message.text);
    const actor = normalizeText(message.sender);
    const ownAction = Boolean(actor) && (selfNames.has(actor) || actor === normalizeText(settings.ownName) || actor === '自分');
    debug('DOM 検出（スペースの更新情報）: ' + text + (ownAction ? '（自分の操作）' : ''));
    if (!settings.enabled) { debug('→ 読み上げ OFF のため省略'); return; }
    if (!settings.readSystemMessages) { debug('→ スペースの更新情報を読まない設定のため省略'); return; }
    if (ownAction && !settings.readOwnMessages) { debug('→ 自分の操作のため省略（設定「自分が書いたメッセージも読み上げる」が OFF）'); return; }
    if (!settings.readWhenFocused && isUserLooking()) { debug('→ Chat 表示中のため省略'); return; }
    const space = currentSpaceName();
    const speech = buildSpeechText({ text, sender: '', space }, settings);
    if (speech) send({ type: 'CR_SPEAK', text: speech, dedupeKey: text, sender: '', space });
  }

  // メンション除去用の既知の名前（メンバーの data-name、左側一覧の名前、自分の表示名）
  function knownNames() {
    const names = Array.from(document.querySelectorAll('[data-name]'), (el) => el.getAttribute('data-name'));
    for (const el of unreadWatcher.items) names.push(unreadWatcher.nameOf(el));
    if (settings.ownName) names.push(settings.ownName);
    return names;
  }

  // 開いているスペースの名前（左側一覧のうちメッセージ一覧と同じ data-group-id の項目 → role="main" の aria-label）
  function currentSpaceName() {
    const main = document.querySelector('[role="main"]');
    if (!main) return '';
    const gid = main.getAttribute('data-group-id');
    if (gid) {
      const item = Array.from(document.querySelectorAll('[role="listitem"][data-group-id]'))
        .find((el) => el.getAttribute('data-group-id') === gid && !main.contains(el));
      const name = item ? unreadWatcher.nameOf(item) : '';
      if (name) return name;
    }
    return normalizeText(main.getAttribute('aria-label'));
  }

  function send(payload) {
    if (!isContextAlive()) return;
    chrome.runtime.sendMessage(payload).catch(() => {});
  }

  function onStatus(status) {
    if (!isContextAlive()) return;
    // メッセージを持たないフレーム（Gmail 外枠など）の状態で上書きしない
    if (status.state !== 'tracking' && window !== window.top) return;
    const payload = { ...status, frameUrl: location.origin + location.pathname, updatedAt: Date.now() };
    const json = JSON.stringify({ ...payload, updatedAt: 0 });
    if (json === lastStatusJson) return;
    lastStatusJson = json;
    chrome.storage.local.set({ trackerStatus: payload }).catch(() => {});
  }

  function onProfileLearned(profile) {
    if (!isContextAlive()) return;
    chrome.storage.local.set({ learnedProfile: profile }).catch(() => {});
  }

  const tracker = new ChatDomTracker(document, {
    onMessage, onStatus, onProfileLearned,
    onProfileRejected: (p) => {
      // 不適切なセレクタを記録し、保存済みの学習結果なら破棄（次回起動時に再利用・再学習しない）
      if (!isContextAlive()) return;
      chrome.storage.local.get(['learnedProfile', 'badSelectors']).then((r) => {
        const list = (Array.isArray(r.badSelectors) ? r.badSelectors : []).filter((b) => b.selector !== p.message);
        list.push({ selector: p.message, at: Date.now() });
        const patch = { badSelectors: list.slice(-20) };
        if (r.learnedProfile && r.learnedProfile.message === p.message) patch.learnedProfile = null;
        return chrome.storage.local.set(patch);
      }).catch(() => {});
    },
    log: debug,
    onSkip: (reason, text) => debug('DOM 検出（読まない）: ' + reason + (text ? ' / ' + text : ''))
  });

  // ---- 開いていないスペースの新着 ----

  const otherStatus = { notifyCount: 0, lastNotifyAt: 0, nav: null };
  let lastOtherJson = '';

  function writeOtherStatus() {
    if (!isContextAlive()) return;
    const hooked = document.documentElement.hasAttribute('data-chatreader-hook');
    const nav = otherStatus.nav || { navItems: 0 };
    // 何も持たないフレームの状態で上書きしない
    if (!nav.navItems && !otherStatus.notifyCount && !(window === window.top && hooked)) return;
    const payload = {
      hooked,
      permission: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
      notifyCount: otherStatus.notifyCount,
      lastNotifyAt: otherStatus.lastNotifyAt,
      ...nav,
      frameUrl: location.origin + location.pathname
    };
    const json = JSON.stringify(payload);
    if (json === lastOtherJson) return;
    lastOtherJson = json;
    chrome.storage.local.set({ otherSpaceStatus: { ...payload, updatedAt: Date.now() } }).catch(() => {});
  }

  // A. デスクトップ通知（notifyHook.js が MAIN world から postMessage で渡す）
  window.addEventListener('message', (e) => {
    // 同じフレームの MAIN world からのメッセージのみ受け付ける（他フレーム・他オリジンは無視）
    if ((e.source !== null && e.source !== window) || (e.origin && e.origin !== location.origin)) return;
    if (!e.data || e.data.source !== 'chatreader-notify') return;
    const title = normalizeText(e.data.title);
    const body = normalizeText(e.data.body);
    otherStatus.notifyCount++;
    otherStatus.lastNotifyAt = Date.now();
    writeOtherStatus();
    debug('A 通知検出: ' + title + ' / ' + body);
    if (!settings.enabled || !settings.readNotifications) { debug('→ 読み上げ OFF、または「開いていないスペースの新着」が本文を読まない設定のため省略'); return; }
    if (!settings.readWhenFocused && isUserLooking()) { debug('→ Chat 表示中のため省略'); return; }
    if (!title && !body) return;
    // 通知タイトル「送信者 (スペース名)」→「スペース名、送信者、本文」
    const text = buildNotificationSpeech(title, prepareBody(body, settings, knownNames()), settings);
    const parsed = parseNotificationTitle(title);
    send({ type: 'CR_SPEAK', text, dedupeKey: body || title, sender: parsed.sender, space: parsed.space, source: 'notify' });
  });

  // B. 左側一覧の未読変化（本文は読めないためスペース名のみ）
  const unreadWatcher = new UnreadWatcher(document, {
    log: debug,
    onStatus: (s) => { otherStatus.nav = s; writeOtherStatus(); },
    onUnread: ({ name, count, reason }) => {
      debug('B 未読検出: ' + name + '（' + reason + (count ? '・' + count + ' 件' : '') + '）');
      if (!settings.enabled || !settings.announceUnread) { debug('→ 読み上げ OFF、または「開いていないスペースの新着」が「読まない」のため省略'); return; }
      if (!settings.readWhenFocused && isUserLooking()) { debug('→ Chat 表示中のため省略'); return; }
      send({ type: 'CR_UNREAD', name });
    }
  });

  // ---- 自分の送信内容の記録（自分のメッセージ判定用） ----

  function editableRoot(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) return el;
    return el.closest('[contenteditable="true"], [contenteditable=""], [role="textbox"]');
  }

  function editableText(el) {
    return normalizeText('value' in el && typeof el.value === 'string' ? el.value : el.textContent);
  }

  let lastComposeText = '';

  document.addEventListener('input', (e) => {
    const box = editableRoot(e.target);
    if (box) lastComposeText = editableText(box);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const box = editableRoot(e.target);
    if (!box) return;
    const text = editableText(box);
    if (text) ownDetector.recordSent(text);
  }, true);

  document.addEventListener('click', (e) => {
    const target = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!target) return;
    const button = target.closest('[aria-label*="送信"], [aria-label*="Send"], [data-tooltip*="送信"], [data-tooltip*="Send"]');
    if (button && lastComposeText) ownDetector.recordSent(lastComposeText);
  }, true);

  // ---- 設定変更・再学習要求の反映 ----

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!isContextAlive()) return;
    if (area === 'sync') {
      chrome.storage.sync.get(null).then((raw) => { settings = normalizeSettings(raw); });
    }
    if (area === 'local' && changes.dumpRequest && changes.dumpRequest.newValue) {
      // メッセージ一覧・左側一覧を持つフレームだけが応答する
      const hasContent = document.querySelector('[role="main"], [role="navigation"], nav') || tracker.getStatus().matchCount > 0;
      if (hasContent) {
        let text;
        try {
          text = buildDomDump(document, { messageSelector: tracker.profile ? tracker.profile.message : '', navItems: unreadWatcher.items });
        } catch (e) {
          text = '# ダンプ失敗: ' + (e && e.message) + ' (' + location.href + ')';
        }
        chrome.runtime.sendMessage({ type: 'CR_DUMP_RESULT', text }).catch(() => {});
      }
    }
    if (area === 'local' && changes.relearnRequest && changes.relearnRequest.newValue) {
      log('手動で再学習を実行します');
      tracker.heal('manual', true);
    }
  });

  // 最小化・タブ切替の記録（非表示中に Chat が DOM を更新しているかの切り分け用）
  if (window === window.top) {
    document.addEventListener('visibilitychange', () => {
      debug(document.hidden ? 'タブ状態: 非表示（最小化・別タブ）' : 'タブ状態: 表示に戻った');
    });
  }

  // 拡張機能の更新・再読み込み後に残った古いスクリプトは、監視を止めて CPU を使わないようにする
  const aliveTimer = setInterval(() => {
    if (isContextAlive()) return;
    tracker.stop();
    unreadWatcher.stop();
    clearInterval(aliveTimer);
    console.info(LOG_PREFIX, '拡張機能が更新されたため停止しました。ページを再読み込みしてください。');
  }, 10000);

  tracker.start(learnedProfile, badSelectors.map((b) => b.selector));
  unreadWatcher.start();
  writeOtherStatus();
  const st = tracker.getStatus();
  debug('監視開始: ' + location.origin + location.pathname + ' / ' + (st.state === 'tracking' ? 'セレクタ ' + st.messageSelector + '（' + st.matchCount + ' 件一致）' : 'メッセージ一覧を探索中')
    + ' / 通知フック ' + (document.documentElement.hasAttribute('data-chatreader-hook') ? '有効' : '無効')
    + ' / 一覧項目 ' + unreadWatcher.items.length + ' 件');
})();
