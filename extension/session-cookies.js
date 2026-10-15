/* global chrome */
// Extract the browser cookie header for the exact SafirRail request path.
// No values are logged, persisted, or sent to a third party by this module.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BilitCookieReader = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  const CANONICAL = 'https://safirrail.ir';
  const SITE_PATTERNS = [CANONICAL + '/*'];
  function isSafirHost(host) {
    // The reservation backend uses the apex host, NOT agency.safirrail.ir.
    return typeof host === 'string' && host.toLowerCase() === 'safirrail.ir';
  }
  function tabSite(tab) {
    if (!tab || !tab.url) throw new Error('تب سامانه رزرو سفیر ریل در این پروفایل مرورگر یافت نشد.');
    let url;
    try { url = new URL(tab.url); } catch (_) { throw new Error('آدرس تب سفیر ریل نامعتبر است.'); }
    if (url.protocol !== 'https:' || !isSafirHost(url.hostname)) {
      throw new Error('از سامانه رزرو https://safirrail.ir وارد شوید؛ تب سامانه مالی یا سایت دیگر قابل انتقال نیست.');
    }
    return url;
  }
  async function discoverTab(chromeApi) {
    const active = await chromeApi.tabs.query({ active: true, currentWindow: true });
    const activeTab = active && active[0];
    if (activeTab) {
      try { tabSite(activeTab); return activeTab; } catch (_) { /* search safely */ }
    }
    // Opening BilitFast's instructions or chrome://extensions may make a different
    // tab active. The SafirRail tab still exists; do not require switching tabs.
    const sameWindow = await chromeApi.tabs.query({ currentWindow: true, url: SITE_PATTERNS });
    const valid = (sameWindow || []).filter(t => { try { tabSite(t); return true; } catch (_) { return false; } });
    if (valid.length === 1) return valid[0];
    if (valid.length > 1) {
      // In one browser window, tabs share a cookie store. The freshest tab is
      // preferred, but never silently choose a tab from another browser window.
      return [...valid].sort((a,b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    }
    // If the website was opened in a *different window of the same profile*,
    // permit it only if the choice is unambiguous.
    const all = await chromeApi.tabs.query({ url: SITE_PATTERNS });
    const elsewhere = (all || []).filter(t => { try { tabSite(t); return true; } catch (_) { return false; } });
    if (elsewhere.length === 1) return elsewhere[0];
    if (elsewhere.length > 1) throw new Error('چند پنجره سفیر ریل باز است. افزونه را در همان پنجره حساب موردنظر باز کنید.');
    throw new Error('تب https://safirrail.ir پیدا نشد. سایت را در همین پروفایل Chrome/Edge باز کنید و وارد حساب شوید.');
  }
  function toHeaders(raw) {
    const selected = [];
    for (const [index, cookie] of (raw || []).entries()) {
      if (!cookie || typeof cookie.name !== 'string') continue;
      if (cookie.expirationDate && cookie.expirationDate < Date.now() / 1000) continue;
      if (!/^[!#$%&'*+.^_`|~\w-]{1,128}$/.test(cookie.name)) continue;
      if (typeof cookie.value !== 'string' || cookie.value.length > 2000 || /[\r\n;]/.test(cookie.value)) continue;
      // Duplicate names with different paths MUST be retained. A real
      // browser sends both (longer path first); previously dropping the
      // shorter-path PHPSESSID could discard the logged-in root session.
      selected.push({ index, pathLen: (cookie.path || '/').length,
        line: cookie.name + '=' + cookie.value });
    }
    selected.sort((a,b) => b.pathLen - a.pathLen || a.index - b.index);
    return selected.map(x => x.line);
  }
  function hasSession(list) { return list.some(c => /^PHPSESSID=[^\s;]+/i.test(c)); }
  async function collect(chromeApi) {
    const tab = await discoverTab(chromeApi);
    const site = tabSite(tab);
    const stores = await chromeApi.cookies.getAllCookieStores();
    const store = stores.find(s => Array.isArray(s.tabIds) && s.tabIds.includes(tab.id));
    if (!store) throw new Error('پروفایل کوکی همان تب پیدا نشد. افزونه را در پروفایلی باز کنید که وارد سایت شده‌اید.');
    const reservationUrl = CANONICAL + '/etrain/TresV-auth.php';
    const verificationUrl = CANONICAL + '/fa/UserAut.php';
    const [forBooking, forVerification] = await Promise.all([
      chromeApi.cookies.getAll({ url: reservationUrl, storeId: store.id }),
      chromeApi.cookies.getAll({ url: verificationUrl, storeId: store.id }),
    ]);
    const cookies = toHeaders(forBooking);
    const verificationCookies = toHeaders(forVerification);
    if (!hasSession(cookies)) {
      throw new Error('نشست سامانه رزرو در مرورگر پیدا نشد. پس از ورود به حساب، صفحه رزرو سفیر ریل را باز کنید.');
    }
    // PHP sessions may have different Path=/etrain and Path=/fa cookies.
    // Keep the two sets separate so verifying /fa NEVER uses an /etrain cookie.
    return { cookies, verificationCookies, host: site.hostname, storeId: store.id };
  }
  return { collect, discoverTab, isSafirHost, tabSite, toHeaders };
});
