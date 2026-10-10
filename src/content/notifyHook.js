/*
 * ChatReader 通知フック（ページの MAIN world で document_start に実行）
 *
 * Google Chat が表示するデスクトップ通知（new Notification / registration.showNotification）を
 * 横取りし、タイトルと本文を window.postMessage でコンテンツスクリプトへ渡す。
 * 通知そのものは通常どおり表示する（ページの動作は変えない）。
 * ※ MAIN world では chrome.* API は使えない。
 */
(function () {
  'use strict';

  if (window.__chatReaderNotifyHooked) return;
  Object.defineProperty(window, '__chatReaderNotifyHooked', { value: true });

  const SOURCE = 'chatreader-notify';

  function post(title, options) {
    try {
      const opts = options && typeof options === 'object' ? options : {};
      window.postMessage({
        source: SOURCE,
        title: String(title == null ? '' : title),
        body: String(opts.body == null ? '' : opts.body),
        tag: String(opts.tag == null ? '' : opts.tag)
      }, location.origin);
    } catch (e) {
      // 通知の表示自体は妨げない
    }
  }

  let hooked = false;

  // new Notification(title, options)
  const OrigNotification = window.Notification;
  if (typeof OrigNotification === 'function') {
    const HookedNotification = function Notification(title, options) {
      if (!new.target) return OrigNotification(title, options); // 本来どおり TypeError にする
      post(title, options);
      return Reflect.construct(OrigNotification, [title, options], new.target);
    };
    HookedNotification.prototype = OrigNotification.prototype;
    Object.setPrototypeOf(HookedNotification, OrigNotification);
    Object.defineProperty(HookedNotification, 'permission', { get: () => OrigNotification.permission, configurable: true });
    if (typeof OrigNotification.requestPermission === 'function') {
      HookedNotification.requestPermission = function (...args) { return OrigNotification.requestPermission(...args); };
    }
    try {
      window.Notification = HookedNotification;
      hooked = true;
    } catch (e) { /* 書き換え不可の環境 */ }
  }

  // ServiceWorkerRegistration.prototype.showNotification(title, options)
  const SWR = window.ServiceWorkerRegistration;
  if (SWR && SWR.prototype && typeof SWR.prototype.showNotification === 'function') {
    const origShow = SWR.prototype.showNotification;
    SWR.prototype.showNotification = function showNotification(title, options) {
      post(title, options);
      return origShow.call(this, title, options);
    };
    hooked = true;
  }

  // フックの有無をコンテンツスクリプト（ISOLATED world）へ伝える（DOM は両 world で共有される）
  if (hooked && document.documentElement) document.documentElement.setAttribute('data-chatreader-hook', '1');
})();
