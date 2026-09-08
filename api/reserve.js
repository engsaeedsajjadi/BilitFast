// api/reserve.js — جریان چندمرحله‌ای رزرو (شروع / ارسال کپچا و اطلاعات / تصویر کپچا)
const {
  startReservation,
  submitReservation,
  refreshCaptcha,
  fetchCaptchaImage,
  solveCaptchaImage,
} = require('../lib/reserve');
const { guardApi } = require('../lib/guard');
const { getSessionUser } = require('../lib/auth');
const { checkAccess } = require('../lib/license');
const config = require('../config.json');

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
  // گیت مجوز سمت سرور (در حالت توسعه با کلید پیش‌فرض، آزاد است)
  try {
    const user = getSessionUser(req, body);
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
    if (action === 'start') {
      const result = await startReservation(body);
      return respond(res, result);
    }

    if (action === 'submit') {
      const result = await submitReservation({
        stateToken: body.stateToken,
        captcha: body.captcha,
        passengers: body.passengers,
        phone: body.phone,
      });
      // حلقه یادگیری: آیا کپچای ارسال‌شده از سد صفیر ریل عبور کرد یا نه؟
      // پذیرفته‌شده → نمونه آموزشی تأییدشده؛ ردشده → در صف برچسب‌گذاری دستی.
      // «بهترین تلاش» — هیچ خطایی نباید پاسخ رزرو را تغییر دهد.
      try {
        const { markOutcomeBySubmit } = require('../lib/captures');
        await markOutcomeBySubmit({
          captureId: body.captchaCaptureId || null,
          text: body.captcha || '',
          result,
        });
      } catch (e) { /* نادیده بگیر */ }
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

    if (action === 'solve-captcha') {
      const result = await solveCaptchaImage({
        captchaImageUrl: body.captchaImageUrl,
        stateToken: body.stateToken,
      });
      return respond(res, result);
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
