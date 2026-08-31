// api/reserve.js — جریان چندمرحله‌ای رزرو (شروع / ارسال کپچا و اطلاعات / تصویر کپچا)
const {
  startReservation,
  submitReservation,
  fetchCaptchaImage,
} = require('../lib/reserve');

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); }
    catch (e) { return {}; }
  }
  return req.body || {};
}

module.exports = async (req, res) => {
  const body = readBody(req);
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

    return respond(res, { ok: false, error: 'action ناشناخته: ' + action });
  } catch (e) {
    return respond(res, { ok: false, error: (e && e.message) ? e.message : String(e) }, 500);
  }
};

function respond(res, payload, status) {
  const code = status || (payload && payload.ok ? 200 : 400);
  res.status(code).json(payload);
}
