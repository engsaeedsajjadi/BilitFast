// api/sync-cookies.js — همگام‌سازی کوکی‌ها از مرورگر (Firefox و Chrome)
// پارامتر اختیاری ?source=firefox|chrome|all (پیش‌فرض: all)
const { readFirefoxCookies } = require('../lib/cookies');
const { readChromeCookies } = require('../lib/chrome-cookies');

module.exports = async (req, res) => {
  const source = (req.query && req.query.source) || 'all';
  try {
    const all = [];
    if (source === 'all' || source === 'firefox') {
      all.push(...(await readFirefoxCookies()));
    }
    if (source === 'all' || source === 'chrome') {
      all.push(...(await readChromeCookies()));
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
        error: 'کوکی safirrail.ir یافت نشد. ابتدا در مرورگر (Firefox یا Chrome) وارد سایت صفیر ریل شوید و سپس دوباره همگام‌سازی کنید.',
      });
      return;
    }
    res.status(200).json({ ok: true, cookies, count: cookies.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
};
