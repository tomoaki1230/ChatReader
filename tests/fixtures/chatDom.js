// 実際の Google Chat の画面（2026-10 に保存したページ）と同じ構造を再現する部品
// 構造だけを写し、名前・本文・画像などは架空のもの

// 左側一覧の項目（スペース / DM）
// 名前は <bdi>、その前に「未読」や在席状況、後ろに種別（「スペース」等）の文字列が入る
function navItem(gid, name, ts, opts = {}) {
  const weight = opts.bold ? 700 : 400;
  return `<span role="listitem" jsname="CmABtb" tabindex="-1" id="${gid}/SCcFR" data-group-id="${gid}" data-starred="false" data-display-timestamp="${ts}">`
    + `<div jsname="v5GXOc"><div role="link"><div jsname="ZlM1Wd"><div>`
    + `<div data-hovercard-id="${gid}"><img src="x.png" alt=""></div>`
    + `<div><div><span>未読</span>${opts.presence ? `<span>${opts.presence}</span>` : ''}`
    + `<span jsname="dfY7oc" role="presentation"><span role="presentation"><bdi style="font-weight:${weight}">${name}</bdi></span>`
    + `<span role="presentation">${opts.type || 'スペース'}</span></span></div><div></div></div></div></div>`
    + `<div><div jsname="WdGLhc"><div role="presentation"></div><div aria-label="Tab キーを押すと、その他のオプションが表示されます。">`
    + `<button aria-label="ポップアップで開く"><span aria-hidden="true">open</span></button>`
    + `<button aria-label="オプション" aria-haspopup="menu"></button></div></div></div></div></div></span>`;
}

// ホーム画面（/app/home）の会話一覧の項目
// 未読状態は data-is-unread、最新メッセージのプレビューは送信者 span[jsname="rJxwpd"]（「太郎:」）と本文 span[jsname="ok3btb"]
// 送信者名は読み込み中「名前を読み込み中...:」と表示されることがある
function homeCard(gid, name, ts, opts = {}) {
  const sender = opts.sender === undefined ? '' : `<span jsname="rJxwpd">${opts.sender}:</span>`;
  return `<span role="listitem" jsname="CmABtb" tabindex="-1" id="${gid}/SCcFR" data-group-id="${gid}" data-display-timestamp="${ts}" data-is-unread="${opts.unread === false ? 'false' : 'true'}" data-group-type="4">`
    + `<div jsname="LNl4xb"><div><div>`
    + `<div jsname="aXLJRd" aria-hidden="true" data-hovercard-id="${gid}"><div><div><img src="x.png" alt=""></div></div></div>`
    + `<div><div><div jsname="zW8KYb"><div jsname="VYJYmb">${name}</div>`
    + `<div jsname="exilE"><span data-absolute-timestamp="${opts.previewTs || ts}" role="presentation">10月10日</span></div></div>`
    + `<div><div jsname="JzStRd"><span jsname="ok3btb">${sender}${opts.body || ''}</span></div></div>`
    + `<span>Tab キーを押すと、その他のオプションが表示されます。</span></div>`
    + `<div><div><span data-is-tooltip-wrapper="true"><button aria-label="未読にする" data-item="mark-as-unread"><i aria-hidden="true">mark_chat_unread</i></button>`
    + `<div role="tooltip" aria-hidden="true">未読にする</div></span></div>`
    + `<div><button aria-label="オプション" aria-haspopup="menu"></button></div></div></div></div></div></span>`;
}

module.exports = { navItem, homeCard };
