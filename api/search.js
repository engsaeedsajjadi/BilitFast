// api/search.js — یک تلاش جستجو (پورت از Worker.do_one_attempt)
const { searchOnce } = require('../lib/core');
const { filterAndRankTrains } = require('../lib/agent');
const { guardApi } = require('../lib/guard');
const { getSessionUser } = require('../lib/auth');
const { requireUser } = require('../lib/apiauth');
const accounts = require('../lib/accounts');
const { checkAccess } = require('../lib/license');
const config = require('../config.json');
const { ensureCookies } = require('../lib/session-fallback');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'search', limit: 240, windowMs: 60000 })) return;

  const body = (typeof req.body === 'string') ? JSON.parse(req.body || '{}') : (req.body || {});

  /* احراز هویت: در نصب چندکاربره الزامی است. در نصب تک‌کاربره محلی، مثل قبل
   * بدون حساب هم کار می‌کند تا کاربران فعلی دچار اختلال نشوند. */
  const auth = requireUser(req, res, body);
  if (!auth.ok) return;
  const sessionUser = auth.user;

  // گیت مجوز سمت سرور (در حالت توسعه با کلید پیش‌فرض، آزاد است)
  try {
    const user = sessionUser || getSessionUser(req, body);
    const access = checkAccess({
      user,
      licenseToken: String(body.licenseToken || ''),
      trialToken: String(body.trialToken || ''),
      trialDays: config.trial_period_days,
    });
    if (!access.allowed) {
      res.status(402).json({ ok: false, licenseRequired: true, error: 'دوره آزمایشی پایان یافته یا مجوز فعال نیست. لطفاً برنامه را فعال کنید.' });
      return;
    }
  } catch (e) {
    // خطای غیرمنتظره در بررسی مجوز = دسترسی داده نشود (fail-closed)
    res.status(500).json({ ok: false, error: 'خطا در بررسی مجوز دسترسی.' });
    return;
  }
  try {
    /* اگر کوکی نشست به سرور نرسیده، یک بار خودمان جبران می‌کنیم — وگرنه
     * سایت به مهمانِ واردنشده «موجودی صفر» نشان می‌دهد و کاربر فکر می‌کند
     * قطار پر است. (زنجیرهٔ انتقال کوکی ممکن است سمت مرورگر قطع شده باشد.) */
    /* سهمیه جستجو پیش از تماس با سایت بررسی و مصرف می‌شود. اگر اینجا مصرف
     * نشود، کاربرِ به‌سهمیه‌رسیده می‌تواند با درخواست‌های موازی از حد بگذرد. */
    if (sessionUser) {
      const q = accounts.consumeQuota(sessionUser.id, 'searches');
      if (!q.ok && q.reason === 'quota') {
        res.status(429).json({ ok: false, quotaExceeded: true, error: q.error, used: q.used, limit: q.limit });
        return;
      }
    }

    const fb = await ensureCookies(body.cookies, sessionUser);
    if (fb.recovered) body.cookies = fb.cookies;

    const result = await searchOnce(body);
    if (fb.recovered && result && typeof result === 'object') {
      result.sessionRecovered = true;
      result.cookies = fb.cookies; // تا کلاینت بتواند نشست تازه را نگه دارد
    }
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    // اختیاری: اعمال ترجیحات کاربر (فیلتر سخت + رتبه‌بندی نرم) از موتور عامل.
    // اگر پرامتر prefs ارسال نشود، رفتار دقیقاً مثل قبل است (بدون تغییر).
    if (body.prefs && typeof body.prefs === 'object' && Array.isArray(result.trains)) {
      const r = filterAndRankTrains(result.trains, body.prefs);
      result.trains = r.ranked;
      result.ranking = { keptCount: r.keptCount, droppedCount: r.droppedCount };
    }
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
