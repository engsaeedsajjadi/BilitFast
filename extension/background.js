// background.js — سرویس‌ورکر افزونه: با کلیک روی آیکون، کوکی‌های صفیر ریل
// (شامل PHPSESSID که از صفحه وب قابل خواندن نیست) خوانده و به برنامه ارسال می‌شود.

const DEFAULT_APP_URL = 'http://localhost:3000';

function setBadge(text, color, title) {
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
    if (title) chrome.action.setTitle({ title });
  } catch (e) { /* ignore */ }
}

chrome.action.onClicked.addListener(async () => {
  try {
    const cfg = await chrome.storage.local.get({ appUrl: DEFAULT_APP_URL });
    const appUrl = String(cfg.appUrl || DEFAULT_APP_URL).replace(/\/+$/, '');
    const appBase = new URL(appUrl);
    const pairCookie = await chrome.cookies.get({ url: appBase.origin + '/', name: 'bf_cookie_sync_pair' });
    const pairToken = pairCookie && pairCookie.value;
    if (!pairToken) {
      setBadge('✗', '#c0392b', 'ابتدا در صفحه ورود بیلیت فست روی «دریافت کوکی از افزونه» بزنید، سپس دوباره آیکون افزونه را کلیک کنید.');
      return;
    }

    // خواندن همه کوکی‌های دامنه صفیر ریل (شامل کوکی‌های HttpOnly)
    const cookies = await chrome.cookies.getAll({ domain: 'safirrail.ir' });
    if (!cookies.length) {
      setBadge('✗', '#c0392b', 'کوکی‌ای یافت نشد. ابتدا در مرورگر وارد safirrail.ir شوید.');
      return;
    }

    const list = cookies.map((c) => c.name + '=' + c.value);
    const hasSession = list.some((c) => /^PHPSESSID=/i.test(c));

    const resp = await fetch(appUrl + '/api/cookie-sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BilitFast-Pair': pairToken,
      },
      body: JSON.stringify({ action: 'push', cookies: list, source: 'extension' }),
    });
    const data = await resp.json();

    if (data && data.ok) {
      setBadge('✓', '#27ae60',
        data.count + ' کوکی به برنامه ارسال شد' +
        (hasSession ? ' (کوکی نشست ✓)' : ' (⚠ کوکی نشست یافت نشد — ابتدا در سایت وارد شوید)'));
    } else {
      setBadge('✗', '#c0392b', (data && data.error) || 'خطا در ارسال کوکی‌ها');
    }
  } catch (e) {
    setBadge('✗', '#c0392b',
      'برنامه در دسترس نیست. مطمئن شوید برنامه اجراست (npm start) و آدرس در تنظیمات افزونه درست است.');
  }
});
