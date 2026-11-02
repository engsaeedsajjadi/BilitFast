/* BilitFast direct, user-initiated browser-tab handoff.
 * No PIN, API upload, polling or background export of session credentials.
 * Credentials are written only to the explicitly matched BilitFast tab.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BilitDirectSession = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const VALID_PAGES = new Set(['/', '/login.html', '/route.html', '/index.html']);
  function official(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && u.hostname === 'safirrail.ir' &&
        (u.pathname === '/fa' || u.pathname.startsWith('/fa/') || u.pathname === '/etrain' || u.pathname.startsWith('/etrain/'));
    } catch (_) { return false; }
  }
  function appTab(tab, fromTab) {
    if (!tab || !Number.isSafeInteger(tab.id) || !tab.url) return null;
    try {
      const u = new URL(tab.url);
      if (!VALID_PAGES.has(u.pathname)) return null;
      return { tab, target: fromTab(tab) };
    } catch (_) { return null; }
  }
  function select(tabs, active, fromTab, trustedOrigin) {
    if (!active || !Number.isSafeInteger(active.id) || !official(active.url))
      throw new Error('افزونه را از تب رسمی safirrail.ir/etrain باز کنید؛ ورود به حساب باید در همان پروفایل Chrome باشد.');
    const matches = (tabs || []).filter(t => t?.windowId === active.windowId && t.id !== active.id)
      .map(t => appTab(t, fromTab)).filter(Boolean);
    if (!matches.length) throw new Error('تب BilitFast پیدا نشد. صفحه اتصال BilitFast را در همین پنجره باز نگه دارید.');
    const trusted = trustedOrigin ? matches.filter(x => x.target.origin === trustedOrigin) : [];
    if (trusted.length === 1) return trusted[0];
    if (trusted.length > 1) {
      const routes=trusted.filter(x=>new URL(x.tab.url).pathname==='/route.html');
      if (routes.length===1) return routes[0];
      throw new Error('چند تب BilitFast باز است؛ فقط یک تب مسیر را نگه دارید.');
    }
    const local = matches.filter(x => x.target.localPreview);
    if (local.length === 1) return local[0];
    if (local.length > 1) {
      const routes=local.filter(x=>new URL(x.tab.url).pathname==='/route.html');
      if (routes.length===1) return routes[0];
    }
    if (matches.length !== 1)
      throw new Error('چند تب احتمالی BilitFast پیدا شد؛ فقط یک تب BilitFast را در همین پنجره نگه دارید.');
    return matches[0];
  }
  return {official, appTab, select};
});
