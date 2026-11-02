// api/login.js — ورود به سامانه صفیر ریل و بازگرداندن کوکی‌ها
const { login } = require('../lib/core');
const { guardApi, isLoopbackSocket } = require('../lib/guard');
const { requireUser } = require('../lib/apiauth');

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (e) { return null; }
  }
  return req.body || {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  // ورود به سامانه بالادستی حساس است؛ حد سخت‌گیرانه برای جلوگیری از سوءاستفاده
  if (!guardApi(req, res, { name: 'login', limit: 5, windowMs: 60000 })) return;
  const body = readBody(req);
  if (!body) {
    res.status(400).json({ ok: false, error: 'بدنه درخواست نامعتبر است.' });
    return;
  }
  /* 3.13.4 (security): previously anonymous. Anyone could use this server as
   * a SafirRail login proxy and overwrite the stored local credentials,
   * which /api/connect then replayed to anonymous callers. */
  const auth = requireUser(req, res, body);
  if (!auth.ok) return;

  const username = body.username || '';
  const password = body.password || '';
  if (!username || !password) {
    res.status(400).json({ ok: false, error: 'شناسه و گذرواژه را وارد کنید.' });
    return;
  }
  try {
    const result = await login(username, password);

    /* اگر ورود موفق بود و اجرای محلی شخصی (بدون حساب برنامه، از همین دستگاه)
     * است، اعتبارنامه را رمزشده ذخیره کن تا ورود مجدد خودکار ممکن باشد.
     * روی نصب self-hosted یا درخواست از راه دور هرگز ذخیره نمی‌شود. */
    if (result && result.ok && !auth.user && isLoopbackSocket(req)) {
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
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ ok: false, error: isProd ? 'خطای داخلی سرور.' : (e && e.message ? e.message : String(e)) });
  }
};
