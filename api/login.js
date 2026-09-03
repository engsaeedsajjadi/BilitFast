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
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
