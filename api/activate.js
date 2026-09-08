// api/activate.js — فعال‌سازی دائمی محصول
// کد فعال‌سازی ثابت برنامه (Sa0946517835) است؛ وارد کردن آن، برنامه را
// به‌صورت دائمی فعال می‌کند. اگر کاربر وارد حساب باشد، فعال‌سازی روی حساب
// هم ثبت می‌شود تا روی همه دستگاه‌هایش فعال بماند.
const { isActivationCodeValid, makeLicenseToken } = require('../lib/license');
const { getSessionUser } = require('../lib/auth');
const { guardApi } = require('../lib/guard');
const db = require('../lib/db');

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

  if (!isActivationCodeValid(code)) {
    res.status(200).json({ ok: false, error: 'کد فعال‌سازی نادرست است.' });
    return;
  }

  // اگر کاربر وارد حساب است، فعال‌سازی دائمی روی حساب ثبت می‌شود تا مستقل
  // از مرورگر/دستگاه باشد.
  let accountActivated = false;
  try {
    const user = getSessionUser(req, body);
    if (user) {
      db.update('users', user.id, {
        license_activated: true,
        license_activated_at: new Date().toISOString(),
      });
      accountActivated = true;
    }
  } catch (e) { /* فعال‌سازی مهمان هم معتبر است؛ خطای حساب، پاسخ را خراب نمی‌کند */ }

  const token = makeLicenseToken();
  res.status(200).json({
    ok: true,
    token,
    account_activated: accountActivated,
    message: 'برنامه به صورت دائمی فعال شد.',
  });
};

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}
