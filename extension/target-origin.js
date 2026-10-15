/* Identify the installation from the tab the customer deliberately opened.
 * HTTPS is mandatory except local development preview on port 3000.
 * Never infer the target from the SafirRail tab or a stored URL. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BilitTargetOrigin = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function fromTab(tab) {
    if (!tab || typeof tab.url !== 'string') {
      throw new Error('تب BilitFast قابل شناسایی نیست. ابتدا صفحه BilitFast را باز کنید و همان‌جا افزونه را بزنید.');
    }
    let u;
    try { u = new URL(tab.url); }
    catch (_) { throw new Error('آدرس تب معتبر نیست. افزونه را از تب BilitFast باز کنید.'); }
    const host = u.hostname.toLowerCase();
    const dev = u.protocol === 'http:' &&
      (host === 'localhost' || host === '127.0.0.1') && u.port === '3000';
    const secure = u.protocol === 'https:' &&
      host !== 'localhost' && host !== '127.0.0.1' &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(host) &&
      host !== 'safirrail.ir' && !host.endsWith('.safirrail.ir');
    if (!dev && !secure) {
      throw new Error('افزونه را در تب BilitFast باز کنید. برای مشتری دامنه HTTPS لازم است؛ برای آزمایش محلی فقط http://127.0.0.1:3000 پذیرفته می‌شود.');
    }
    if (u.username || u.password) throw new Error('آدرس دارای نام کاربری یا رمز در نشانی پذیرفته نیست.');
    return { origin: u.origin, localPreview: dev };
  }
  // Chrome permission match patterns cannot contain TCP ports.
  function permissionPattern(origin) {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Invalid protocol');
    return u.protocol + '//' + u.hostname + '/*';
  }
  return { fromTab, permissionPattern };
});
