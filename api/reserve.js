// api/reserve.js — جریان چندمرحله‌ای رزرو (شروع / ارسال کپچا و اطلاعات / تصویر کپچا)
const {
  startReservation,
  submitReservation,
  refreshCaptcha,
  fetchCaptchaImage,
} = require('../lib/reserve');
const { guardApi } = require('../lib/guard');
const { getSessionUser } = require('../lib/auth');
const { requireUser } = require('../lib/apiauth');
const accounts = require('../lib/accounts');
const { checkAccess } = require('../lib/license');
const config = require('../config.json');
const { ensureCookies } = require('../lib/session-fallback');
const { buildReserveForm } = require('../lib/core');
const { buildReserveInitBody } = require('../lib/reserve');

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); }
    catch (e) { return {}; }
  }
  return req.body || {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'reserve', limit: 120, windowMs: 60000 })) return;

  const body = readBody(req);

  /* رزرو همیشه باید به یک کاربر مشخص نسبت داده شود. در نصب تک‌کاربره محلی،
   * مثل قبل بدون حساب هم کار می‌کند. */
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
    res.status(500).json({ ok: false, error: 'خطا در بررسی مجوز دسترسی.' });
    return;
  }
  const action = body.action || (req.query && req.query.action) || 'start';

  try {
    // First-party browser reservation: prepare the official form WITHOUT
    // contacting SafirRail from the customer's hosting server. The actual
    // POST is made only in the official browser tab, using that tab's session.
    // This also prevents a slow/failed server-side login probe from blocking
    // the user's selected-train click.
    if (action === 'prepare-official-handoff') {
      const prepared = buildReserveForm({
        fields: body.fields, passengers: body.passengers, train: body.train,
      });
      if (!prepared.ok) return respond(res, prepared);
      const officialUrl = new URL(config.reserve_init_url || '/etrain/TresV-auth.php', config.base_url);
      if (officialUrl.protocol !== 'https:' || officialUrl.hostname !== 'safirrail.ir' ||
          officialUrl.pathname !== '/etrain/TresV-auth.php')
        return respond(res, { ok: false, error: 'مقصد رسمی شروع رزرو معتبر نیست.' });
      return respond(res, {
        ok: true, step: 'arcaptcha_required',
        message: 'فرم قطار آماده شد؛ مرحله انسانی فقط در صفحه رسمی سفیر ریل انجام می‌شود.',
        browserHandoff: {
          url: officialUrl.toString(), method: 'POST',
          fields: buildReserveInitBody(prepared.reserveData),
        },
      });
    }
    if (action === 'start') {
      /* همان تور ایمنی جستجو: رزرو بدون نشست معتبر قطعاً به «نیاز به ورود»
       * می‌خورد. اگر کوکی به سرور نرسیده، پیش از شروع یک بار جبران می‌کنیم
       * تا کاربر در لحظهٔ پیدا شدن ظرفیت معطل نشود. */
      /* سهمیه رزرو فقط در گام start مصرف می‌شود، نه در submit — وگرنه یک رزرو
       * که چند بار تلاش کپچا دارد، چند واحد از سهمیه کاربر را می‌خورد. */
      if (sessionUser) {
        const q = accounts.consumeQuota(sessionUser.id, 'reservations');
        if (!q.ok && q.reason === 'quota') {
          res.status(429).json({ ok: false, quotaExceeded: true, error: q.error, used: q.used, limit: q.limit });
          return;
        }
      }

      const fb = await ensureCookies(body.cookies, sessionUser);
      if (fb.recovered) body.cookies = fb.cookies;
      const result = await startReservation(body);
      if (fb.recovered && result && typeof result === 'object') {
        result.sessionRecovered = true;
      }
      return respond(res, result);
    }

    if (action === 'submit') {
      const result = await submitReservation({
        stateToken: body.stateToken,
        captcha: body.captcha,
        passengers: body.passengers,
        phone: body.phone,
      });
      return respond(res, result);
    }

    if (action === 'captcha-image') {
      const result = await fetchCaptchaImage(body.captchaImageUrl, body.stateToken);
      return respond(res, result);
    }

    if (action === 'refresh-captcha') {
      const result = await refreshCaptcha({ stateToken: body.stateToken });
      return respond(res, result);
    }

    // Automatic CAPTCHA solving was removed in 3.13.4. CAPTCHA codes must be
    // entered by the human user; never re-add an OCR/ML solver here.
    if (action === 'solve-captcha') {
      return respond(res, { ok: false, error: 'حل خودکار کپچا پشتیبانی نمی‌شود؛ کد را خودتان وارد کنید.' }, 410);
    }

    return respond(res, { ok: false, error: 'action ناشناخته: ' + action });
  } catch (e) {
    return respond(res, { ok: false, error: (e && e.message) ? e.message : String(e) }, 500);
  }
};

function respond(res, payload, status) {
  const code = status || (payload && payload.ok ? 200 : 400);
  res.status(code).json(payload);
}
