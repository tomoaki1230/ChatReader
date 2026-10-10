/*
 * ChatReader 設定画面（ポップアップ / オプションページ共通）
 * 値を変更すると即座に chrome.storage.sync へ保存し、コンテンツスクリプトに反映される。
 */
(async function () {
  'use strict';

  const { normalizeSettings } = globalThis.ChatReaderSettings;
  const $ = (id) => document.getElementById(id);

  const RANGE_KEYS = ['volume', 'rate', 'pitch', 'maxLength'];
  const CHECK_KEYS = ['enabled', 'readSender', 'addHonorific', 'readSpaceName', 'skipMentions', 'announceMentionAll', 'readSystemMessages', 'readOwnMessages', 'readWhenFocused'];
  const TEXT_KEYS = ['voiceName', 'ownName', 'otherSpaces'];

  let settings = normalizeSettings(await chrome.storage.sync.get(null));

  function formatValue(key, value) {
    if (key === 'volume') return Math.round(value * 100) + '%';
    if (key === 'maxLength') return value + '文字';
    return Number(value).toFixed(1) + 'x';
  }

  // 声の一覧（日本語を先頭に）
  async function loadVoices() {
    // 外部送信が必要なオンライン音声（remote）は表示しない
    const voices = (await chrome.tts.getVoices()).filter((v) => !v.remote);
    voices.sort((a, b) => {
      const ja = (v) => (v.lang || '').toLowerCase().startsWith('ja') ? 0 : 1;
      return ja(a) - ja(b) || (a.voiceName || '').localeCompare(b.voiceName || '');
    });
    const select = $('voiceName');
    for (const v of voices) {
      if (!v.voiceName) continue;
      const opt = document.createElement('option');
      opt.value = v.voiceName;
      opt.textContent = v.voiceName + (v.lang ? '（' + v.lang + '）' : '');
      select.appendChild(opt);
    }
    // 保存済みの声が使えない（オンライン音声・環境に無い）場合は既定に戻す
    // （一覧の取得に失敗して空の時は、設定を消さない）
    const all = await chrome.tts.getVoices();
    if (all.length && settings.voiceName && !voices.some((v) => v.voiceName === settings.voiceName)) {
      await save({ voiceName: '' });
    }
    if (!voices.length) $('voiceHint').textContent = 'ローカル音声が見つかりません。OS に日本語の音声を追加してください。';
  }

  // 読み方の設定に合わせた読み上げ例（「営業チーム、佐藤、明日の件です」）
  function renderExample() {
    const parts = [];
    if ($('readSpaceName').checked) parts.push('営業チーム');
    if ($('readSender').checked) parts.push('佐藤' + ($('addHonorific').checked ? 'さん' : ''));
    parts.push('明日の件です');
    $('speechExample').textContent = '「' + parts.join('、') + '」';
  }

  function render() {
    for (const key of RANGE_KEYS) {
      $(key).value = settings[key];
      $(key + 'Value').textContent = formatValue(key, settings[key]);
    }
    for (const key of CHECK_KEYS) $(key).checked = settings[key];
    $('addHonorific').disabled = !settings.readSender;
    $('announceMentionAll').disabled = !settings.skipMentions;
    renderExample();
    for (const key of TEXT_KEYS) $(key).value = settings[key];
  }

  async function save(patch) {
    settings = normalizeSettings({ ...settings, ...patch });
    await chrome.storage.sync.set(settings);
  }

  for (const key of RANGE_KEYS) {
    $(key).addEventListener('input', () => {
      $(key + 'Value').textContent = formatValue(key, Number($(key).value));
    });
    $(key).addEventListener('change', () => save({ [key]: Number($(key).value) }));
  }
  for (const key of CHECK_KEYS) $(key).addEventListener('change', () => save({ [key]: $(key).checked }));
  $('readSender').addEventListener('change', () => { $('addHonorific').disabled = !$('readSender').checked; });
  $('skipMentions').addEventListener('change', () => { $('announceMentionAll').disabled = !$('skipMentions').checked; });
  for (const id of ['readSpaceName', 'readSender', 'addHonorific']) $(id).addEventListener('change', renderExample);
  $('voiceName').addEventListener('change', () => save({ voiceName: $('voiceName').value }));
  $('ownName').addEventListener('change', () => save({ ownName: $('ownName').value }));
  $('otherSpaces').addEventListener('change', () => { save({ otherSpaces: $('otherSpaces').value }); renderNotifyNote(lastOtherStatus); });

  $('testButton').addEventListener('click', () => {
    const overrides = {
      volume: Number($('volume').value),
      rate: Number($('rate').value),
      pitch: Number($('pitch').value),
      voiceName: $('voiceName').value
    };
    chrome.runtime.sendMessage({ type: 'CR_TEST', text: $('testText').value, overrides });
  });
  $('stopButton').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CR_STOP' }));

  $('relearnButton').addEventListener('click', () => chrome.storage.local.set({ relearnRequest: Date.now() }));
  $('resetButton').addEventListener('click', async () => {
    await chrome.storage.local.remove(['learnedProfile', 'badSelectors', 'trackerStatus']);
    renderStatus(null);
  });

  // ---- DOM 追従状態の表示 ----

  function formatTime(ms) {
    return ms ? new Date(ms).toLocaleString('ja-JP') : '-';
  }

  function renderRows(dl, rows) {
    dl.textContent = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
  }

  const PERMISSION_LABELS = { granted: '許可', denied: 'ブロック（本文は読めません）', default: '未設定（本文は読めません）', unsupported: '非対応' };

  // 通知が許可されていないと分かっている時は注記を強調
  let lastOtherStatus = null;

  function renderNotifyNote(s) {
    const note = $('notifyNote');
    // 本文を読まない設定では通知の注記は不要
    note.hidden = $('otherSpaces').value !== 'full';
    const blocked = s && s.permission && s.permission !== 'granted';
    note.classList.toggle('warn', Boolean(blocked));
    note.textContent = (blocked ? '現在、Chat の通知が許可されていません（' + ({ denied: 'ブロック', default: '未設定', unsupported: '非対応' }[s.permission] || s.permission) + '）。' : '')
      + '本文まで読むには、Google Chat のデスクトップ通知を ON にしてください。OFF の時や通知が出ない時は、スペース名だけを知らせます。';
  }

  function renderOtherStatus(s) {
    lastOtherStatus = s;
    renderNotifyNote(s);
    renderRows($('otherStatus'), s ? [
      ['通知フック', s.hooked ? '有効' : '無効'],
      ['通知の許可', PERMISSION_LABELS[s.permission] || s.permission],
      ['通知の検出', s.notifyCount + '件' + (s.lastNotifyAt ? '（最終 ' + formatTime(s.lastNotifyAt) + '）' : '')],
      ['一覧の項目', (s.navItems || 0) + '件' + (s.navSource ? '（' + ({ 'group-id': 'スペース ID', role: 'role 属性', learned: '構造推定', none: '休止中' }[s.navSource] || s.navSource) + '）' : '')],
      ['未読の項目', (s.unreadItems || 0) + '件'],
      ['未読お知らせ', (s.announceCount || 0) + '回' + (s.lastAnnounceAt ? '（最終 ' + formatTime(s.lastAnnounceAt) + '）' : '')]
    ] : [['状態', 'Google Chat を開くと表示されます']]);
  }

  function renderStatus(status) {
    // 折りたたみ時にも状態が分かるよう見出しに要約を表示
    $('diagSummary').textContent = status
      ? (status.state === 'tracking' ? '監視中（一致 ' + status.matchCount + ' 件）' : 'メッセージ一覧を探索中')
      : '';
    const dl = $('status');
    const rows = status ? [
      ['状態', status.state === 'tracking' ? '監視中' : 'メッセージ一覧を探索中'],
      ['方式', status.profileName === 'learned' ? '自動学習セレクタ' : (status.profileName || '-')],
      ['セレクタ', status.messageSelector || '-'],
      ['送信者', status.senderSelector || '-'],
      ['一致数', String(status.matchCount)],
      ['再学習', status.healCount + '回' + (status.lastHealAt ? '（最終 ' + formatTime(status.lastHealAt) + '）' : '')],
      ['最終読上', formatTime(status.lastMessageAt)]
    ] : [['状態', 'Google Chat を開くと表示されます']];
    renderRows(dl, rows);
  }

  // ---- 診断ログ ----

  let currentLog = [];

  function logLine(e) {
    return new Date(e.at).toLocaleTimeString('ja-JP') + ' ' + e.text;
  }

  function renderLog(entries) {
    currentLog = Array.isArray(entries) ? entries : [];
    const ol = $('debugLog');
    ol.textContent = '';
    if (!currentLog.length) {
      const li = document.createElement('li');
      li.textContent = 'まだ記録はありません';
      ol.append(li);
      return;
    }
    for (const e of currentLog.slice().reverse()) {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = new Date(e.at).toLocaleTimeString('ja-JP');
      li.append(time, document.createTextNode(e.text));
      ol.append(li);
    }
  }

  $('clearLogButton').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CR_CLEAR_LOG' }));
  $('copyLogButton').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentLog.map(logLine).join('\n'));
      $('copyResult').textContent = 'コピーしました';
    } catch (e) {
      $('copyResult').textContent = 'コピーできませんでした';
    }
    setTimeout(() => { $('copyResult').textContent = ''; }, 2000);
  });

  // ---- DOM 構造の診断 ----

  function renderDump(list) {
    const parts = Array.isArray(list) ? list : [];
    $('domDump').value = parts.join('\n\n======== 別フレーム ========\n\n');
    $('dumpResult').textContent = parts.length ? parts.length + ' フレーム分を取得' : '';
  }

  $('dumpButton').addEventListener('click', async () => {
    await chrome.storage.session.set({ domDump: [] });
    await chrome.storage.local.set({ dumpRequest: Date.now() });
    $('dumpResult').textContent = '取得中…';
    setTimeout(() => {
      if (!$('domDump').value) $('dumpResult').textContent = '応答なし（Google Chat のページを再読み込みしてください）';
    }, 3000);
  });
  $('copyDumpButton').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('domDump').value);
      $('dumpResult').textContent = 'コピーしました';
    } catch (e) {
      $('domDump').select();
      $('dumpResult').textContent = '選択しました。Ctrl+C でコピーしてください';
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.domDump) renderDump(changes.domDump.newValue);
    if (area === 'session' && changes.debugLog) renderLog(changes.debugLog.newValue);
    if (area === 'local' && changes.trackerStatus) renderStatus(changes.trackerStatus.newValue || null);
    if (area === 'local' && changes.otherSpaceStatus) renderOtherStatus(changes.otherSpaceStatus.newValue || null);
  });

  // 折りたたみの開閉状態を記憶（既定は閉）
  for (const id of ['diagPanel', 'diagStatus', 'diagLog', 'diagDump']) {
    const el = $(id);
    try { el.open = localStorage.getItem('open:' + id) === '1'; } catch (e) { /* 記憶できない環境 */ }
    el.addEventListener('toggle', () => {
      try { localStorage.setItem('open:' + id, el.open ? '1' : '0'); } catch (e) { /* 無視 */ }
    });
  }

  render();
  await loadVoices();
  $('voiceName').value = settings.voiceName;
  const { trackerStatus, otherSpaceStatus } = await chrome.storage.local.get(['trackerStatus', 'otherSpaceStatus']);
  const { debugLog } = await chrome.storage.session.get('debugLog');
  renderLog(debugLog);
  renderStatus(trackerStatus || null);
  renderOtherStatus(otherSpaceStatus || null);
})();
