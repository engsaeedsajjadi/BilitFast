// api/reserve.js — جریان چندمرحله‌ای رزرو (شروع / ارسال کپچا و اطلاعات / تصویر کپچا)
const {
  startReservation,
  submitReservation,
  refreshCaptcha,
  fetchCaptchaImage,
  solveCaptchaImage,
} = require('../lib/reserve');
const { guardApi } = require('../lib/guard');
const { readJsonBody } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'reserve', limit: 120, windowMs: 60000 })) return;

  const body = readJsonBody(req);
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
