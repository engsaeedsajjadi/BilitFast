// api/activate.js — فعال‌سازی دائمی محصول (کد فعال‌سازی فقط سمت سرور است)
const { activationCode, makeLicenseToken } = require('../lib/license');
const { guardApi } = require('../lib/guard');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'activate', limit: 5, windowMs: 60000 })) return;

  const body = (typeof req.body === 'string') ? safeParse(req.body) : (req.body || {});
  const code = String(body.code || '').trim();
  if (!code) {
    res.status(400).json({ ok: false, error: 'کد فعال‌سازی را وارد کنید.' });
    return;
  }

  const expected = activationCode();
  if (!expected) {
    res.status(503).json({
      ok: false,
      error: 'فعال‌سازی روی این استقرار پیکربندی نشده است (متغیر محیطی کد فعال‌سازی تنظیم نشده). با پشتیبانی تماس بگیرید.',
    });
    return;
  }

  // مقایسه زمان‌ثابت (جلوگیری از زمان‌سنجی)
  const a = Buffer.from(code);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && require('crypto').timingSafeEqual(a, b);

  if (!ok) {
    res.status(200).json({ ok: false, error: 'کد فعال‌سازی نادرست است.' });
    return;
  }

  const token = makeLicenseToken();
  res.status(200).json({ ok: true, token, message: 'برنامه به صورت دائمی فعال شد.' });
};

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}
