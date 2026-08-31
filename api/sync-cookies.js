// api/sync-cookies.js — همگام‌سازی کوکی‌های Firefox (ورود از سایت اصلی به برنامه)
const { readFirefoxCookies } = require('../lib/cookies');

module.exports = async (req, res) => {
  try {
    const cookies = await readFirefoxCookies();
    if (!cookies.length) {
      res.status(200).json({
        ok: false,
        error: 'کوکی safirrail.ir یافت نشد. ابتدا در مرورگر Firefox وارد سایت صفیر ریل شوید و سپس دوباره همگام‌سازی کنید.',
      });
      return;
    }
    res.status(200).json({ ok: true, cookies, count: cookies.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
};
