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
    res.status(200).json({ ok: true, cookies, count: cookies.length, notes: notes.length ? notes : undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
};
