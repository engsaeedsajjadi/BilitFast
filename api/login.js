// api/login.js — ورود به سامانه صفیر ریل و بازگرداندن کوکی‌ها
const { login } = require('../lib/core');
const { guardApi } = require('../lib/guard');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  // ورود به سامانه بالادستی حساس است؛ حد سخت‌گیرانه برای جلوگیری از سوءاستفاده
  if (!guardApi(req, res, { name: 'login', limit: 5, windowMs: 60000 })) return;
  const body = (typeof req.body === 'string') ? JSON.parse(req.body || '{}') : (req.body || {});
  const username = body.username || '';
  const password = body.password || '';
  if (!username || !password) {
    res.status(400).json({ ok: false, error: 'شناسه و گذرواژه را وارد کنید.' });
    return;
  }
  try {
    const result = await login(username, password);

    /* اگر ورود موفق بود و اجرای محلی است، اعتبارنامه را رمزشده ذخیره کن.
     * چرا: ورود صفیر ریل کپچا نمی‌خواهد، پس هر وقت نشست منقضی شود برنامه
     * می‌تواند خودش دوباره وارد شود — به شرطی که اعتبارنامه را داشته باشد.
     * قبلاً این فقط با «حساب BilitFast» ممکن بود و کاربرِ محلی هنگام
     * انقضای نشست وسط رزرو گیر می‌کرد. ذخیره‌سازی با AES-256-GCM است. */
    if (result && result.ok) {
      try {
        const keeper = require('../lib/session-keeper');
        if (keeper.isLocalMode()) {
          keeper.saveLocalCredentials(username, password);
          result.autoRelogin = true;
        }
      } catch (e) { /* ذخیره اختیاری است؛ ورود نباید به‌خاطر آن شکست بخورد */ }
    }

    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
