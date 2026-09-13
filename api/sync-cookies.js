// api/sync-cookies.js — همگام‌سازی کوکی‌ها از مرورگر (Firefox و Chrome)
// پارامتر اختیاری ?source=firefox|chrome|all (پیش‌فرض: all)
// توجه: این قابلیت فقط در اجرای محلی (دسترسی به فایل‌سیستم کاربر) کار می‌کند.
const { readFirefoxCookies } = require('../lib/cookies');
const { readChromeCookies } = require('../lib/chrome-cookies');
const { guardApi } = require('../lib/guard');

module.exports = async (req, res) => {
  if (!guardApi(req, res, { name: 'sync-cookies', limit: 10, windowMs: 60000 })) return;
  const source = (req.query && req.query.source) || 'all';
  try {
    const all = [];
    const notes = [];

    if (source === 'all' || source === 'firefox') {
      all.push(...(await readFirefoxCookies()));
    }
    if (source === 'all' || source === 'chrome') {
      try {
        all.push(...(await readChromeCookies()));
      } catch (e) {
        // اگر Chrome در دسترس نبود (مثلاً کلید ویندوز)، فقط یادداشت ثبت می‌کنیم
        // تا Firefox (در صورت وجود) همچنان برگردانده شود.
        notes.push(e && e.message ? e.message : String(e));
      }
    }

    // حذف تکراری‌ها (بر اساس نام کوکی)
    const seen = new Map();
    for (const c of all) {
      const name = c.split('=')[0];
      if (!seen.has(name)) seen.set(name, c);
    }
    const cookies = Array.from(seen.values());

    if (!cookies.length) {
      res.status(200).json({
        ok: false,
        error: 'کوکی safirrail.ir یافت نشد. ابتدا در مرورگر (Firefox یا Chrome) وارد سایت صفیر ریل شوید و سپس دوباره همگام‌سازی کنید.' +
          (notes.length ? ' نکته: ' + notes.join(' ') : ''),
      });
      return;
    }

    /* مهم: «چند کوکی پیدا شد» با «نشست منتقل شد» یکی نیست.
     *
     * باگی که رفع شد: اگر کاربر در مرورگر وارد صفیر ریل نشده بود، باز هم
     * کوکی‌های عمومی سایت (مثل _ga یا cookieconsent) پیدا می‌شد و این
     * endpoint با ok:true برمی‌گشت. رابط کاربری پیام «✅ N کوکی همگام‌سازی
     * و ذخیره شد» نشان می‌داد، ولی هیچ نشست فعالی منتقل نشده بود و جستجو
     * همچنان «موجودی صفر» می‌داد. یعنی پیام موفقیت، دروغ بود.
     *
     * حالا بدون PHPSESSID شکست صریح گزارش می‌شود. */
    const hasSession = cookies.some((c) => /^PHPSESSID=/i.test(String(c)));
    if (!hasSession) {
      res.status(200).json({
        ok: false,
        noSession: true,
        found: cookies.length,
        error: cookies.length + ' کوکی از مرورگر خوانده شد، اما کوکی نشست (ورود) بین آن‌ها نبود. ' +
          'یعنی در همان مرورگر وارد حساب safirrail.ir نشده‌اید یا نشست‌تان منقضی شده است. ' +
          'ابتدا در مرورگر وارد سایت شوید، سپس دوباره این دکمه را بزنید.' +
          (notes.length ? ' نکته: ' + notes.join(' ') : ''),
      });
      return;
    }

    res.status(200).json({
      ok: true, cookies, count: cookies.length,
      hasSession: true,
      notes: notes.length ? notes : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
};
