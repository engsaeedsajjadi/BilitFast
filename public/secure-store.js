/* eslint-disable */
/**
 * secure-store.js — ذخیره‌سازی امن داده‌های حساس در مرورگر.
 *
 * مسئله: مسیرها و مسافران (کد ملی، تاریخ تولد، نام، موبایل) و کوکی نشست صفیر
 * به‌صورت متن ساده در localStorage می‌نشستند. این داده‌ها با پروفایل مشترک
 * مرورگر، افزونه مخرب، پشتیبان‌گیری دیسک یا دسترسی محلی قابل خواندن بودند.
 *
 * راهکار پیاده‌شده:
 *   ۱) کوکی نشست صفیر دیگر در localStorage نمی‌ماند. به sessionStorage منتقل
 *      شد که با بستن تب/مرورگر پاک می‌شود، و منبع اصلی آن حساب کاربر روی سرور
 *      است (نگهدارنده نشست هر ۵ دقیقه تازه‌اش می‌کند).
 *   ۲) داده‌های هویتی با AES-256-GCM رمز می‌شوند. کلید یک CryptoKey
 *      «غیرقابل‌استخراج» (non-extractable) است که در IndexedDB نگهداری می‌شود:
 *      حتی با دسترسی به دیسک یا خواندن IndexedDB، خودِ کلید قابل بیرون کشیدن
 *      نیست و داده بدون مرورگرِ همان پروفایل رمزگشایی نمی‌شود.
 *   ۳) کوچ خودکار: داده‌های متن‌سادهٔ قبلی خوانده، رمز و جایگزین می‌شوند.
 *
 * محدودیت صادقانه: در برابر XSS فعال، هیچ ذخیره‌سازی سمت مرورگر کاملاً امن
 * نیست (مهاجم می‌تواند از همان API استفاده کند). این لایه ریسک دسترسی آفلاین
 * /دیسک/پروفایل مشترک/پشتیبان را حذف می‌کند و برای PII الزامی است.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'bilitfast_secure';
  var STORE = 'keys';
  var KEY_ID = 'master-v1';
  var hasCrypto = !!(global.crypto && global.crypto.subtle && global.indexedDB);

  /* ---------------- کلید غیرقابل‌استخراج در IndexedDB ---------------- */

  function idb() {
    return new Promise(function (resolve, reject) {
      var req = global.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        tx.onsuccess = function () { resolve(tx.result); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbPut(key, val) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key);
        tx.onsuccess = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  var keyPromise = null;
  function masterKey() {
    if (keyPromise) return keyPromise;
    keyPromise = (function () {
      return idbGet(KEY_ID).then(function (existing) {
        if (existing) return existing;
        // extractable=false → کلید هرگز از مرورگر بیرون نمی‌آید
        return global.crypto.subtle
          .generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
          .then(function (k) { return idbPut(KEY_ID, k).then(function () { return k; }); });
      });
    })().catch(function () { return null; });
    return keyPromise;
  }

  /* ---------------- رمزنگاری/رمزگشایی ---------------- */

  function b64(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return global.btoa(s);
  }
  function unb64(str) {
    var s = global.atob(str), b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  function encrypt(plainText) {
    if (!hasCrypto) return Promise.resolve(null);
    return masterKey().then(function (key) {
      if (!key) return null;
      var iv = global.crypto.getRandomValues(new Uint8Array(12));
      var data = new TextEncoder().encode(plainText);
      return global.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data)
        .then(function (ct) { return 'enc1:' + b64(iv) + ':' + b64(ct); });
    }).catch(function () { return null; });
  }

  function decrypt(blob) {
    if (!hasCrypto || typeof blob !== 'string' || blob.indexOf('enc1:') !== 0) {
      return Promise.resolve(null);
    }
    var parts = blob.split(':');
    if (parts.length !== 3) return Promise.resolve(null);
    return masterKey().then(function (key) {
      if (!key) return null;
      return global.crypto.subtle
        .decrypt({ name: 'AES-GCM', iv: unb64(parts[1]) }, key, unb64(parts[2]))
        .then(function (pt) { return new TextDecoder().decode(pt); });
    }).catch(function () { return null; });
  }

  /* ---------------- کش همگام برای سازگاری با کد موجود ----------------
   * کد فعلی برنامه همگام (synchronous) داده را می‌خواند. برای اینکه رابط
   * تغییر نکند، نسخه رمزگشایی‌شده در حافظه (نه دیسک) کش می‌شود و نوشتن
   * به‌صورت غیرهمگام و رمزشده انجام می‌گیرد. */
  var cache = {};
  var ready = false;
  var readyWaiters = [];

  function markReady() {
    ready = true;
    readyWaiters.forEach(function (fn) { try { fn(); } catch (e) {} });
    readyWaiters = [];
  }

  /** بارگذاری اولیه: رمزگشایی همه کلیدهای حساس + کوچ داده متن ساده قبلی. */
  function init(keys) {
    var jobs = keys.map(function (k) {
      var raw = null;
      try { raw = global.localStorage.getItem(k); } catch (e) { raw = null; }
      if (raw === null || raw === undefined) { cache[k] = null; return Promise.resolve(); }

      if (typeof raw === 'string' && raw.indexOf('enc1:') === 0) {
        return decrypt(raw).then(function (plain) { cache[k] = plain; });
      }
      // داده قدیمی متن ساده → کش کن و بلافاصله رمزشده بنویس (کوچ یک‌باره)
      cache[k] = raw;
      return encrypt(raw).then(function (blob) {
        if (blob) { try { global.localStorage.setItem(k, blob); } catch (e) {} }
      });
    });
    return Promise.all(jobs).then(markReady, markReady);
  }

  function onReady(fn) {
    if (ready) fn(); else readyWaiters.push(fn);
  }

  /** خواندن همگام (از کش رمزگشایی‌شده). */
  function getItem(k) {
    return Object.prototype.hasOwnProperty.call(cache, k) ? cache[k] : null;
  }

  /** نوشتن: کش فوراً، دیسک به‌صورت رمزشده. */
  function setItem(k, v) {
    cache[k] = v;
    encrypt(v).then(function (blob) {
      try {
        if (blob) global.localStorage.setItem(k, blob);
        else global.localStorage.setItem(k, v); // بدون WebCrypto (HTTP قدیمی): همان رفتار قبلی
      } catch (e) {}
    });
  }

  function removeItem(k) {
    delete cache[k];
    try { global.localStorage.removeItem(k); } catch (e) {}
  }

  /** پاک‌کردن کامل داده‌های حساس این دستگاه. */
  function purge(keys) {
    keys.forEach(removeItem);
    try { global.sessionStorage.removeItem('bilitfast_cookies'); } catch (e) {}
  }

  global.BilitSecureStore = {
    available: hasCrypto,
    init: init,
    onReady: onReady,
    getItem: getItem,
    setItem: setItem,
    removeItem: removeItem,
    purge: purge,
    encrypt: encrypt,
    decrypt: decrypt,
  };
})(window);
