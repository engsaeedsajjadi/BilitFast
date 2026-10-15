// License activation. In production codes are single-use and user-bound.
'use strict';
const { isActivationCodeValid, makeLicenseToken } = require('../lib/license');
const { getSessionUser } = require('../lib/auth');
const { guardApi } = require('../lib/guard');
const { redeemCode } = require('../lib/entitlements');
const db = require('../lib/db');
const activity = require('../lib/activity');
const desktop = require('../lib/desktop-entitlement');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  if (!guardApi(req, res, { name: 'activate', limit: 5, windowMs: 60000 })) return;
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch (_) { return res.status(400).json({ ok: false, error: 'درخواست نامعتبر است.' }); }
  const code = String(body.code || '').trim();
  if (!code) return res.status(400).json({ ok: false, error: 'کد فعال‌سازی را وارد کنید.' });

  if (process.env.BILITFAST_SELF_HOSTED === '1') {
    // Redeeming the seller-signed deployment key requires the buyer's admin session.
    const admin = require('../lib/apiauth').requireAdmin(req,res,body);
    if (!admin.ok) return;
    const result = require('../lib/selfhost-license').redeem(code);
    if (result.ok) activity.log({userId:admin.user.id,type:'SELFHOST_LICENSE_ACTIVATED',req});
    return res.status(result.ok ? 200 : 400).json(result);
  }
  if (desktop.isDesktopMode()) {
    const result = desktop.redeem(code);
    if (result.ok) activity.log({ type: 'DESKTOP_LICENSE_ACTIVATED', req });
    return res.status(result.ok ? 200 : 400).json(result);
  }

  const user = getSessionUser(req, body);
  if (process.env.NODE_ENV === 'production') {
    if (!user) return res.status(401).json({ ok: false, error: 'برای فعال‌سازی ابتدا وارد حساب شوید.' });
    const result = redeemCode(user.id, code);
    if (!result.ok) return res.status(400).json(result);
    activity.log({ userId: user.id, type: 'LICENSE_ACTIVATED', req });
    return res.status(200).json({ ok: true, account_activated: true,
      message: 'مجوز اختصاصی حساب فعال شد.' });
  }

  // Backwards-compatible local development activation only.
  if (!isActivationCodeValid(code)) return res.status(200).json({ ok: false, error: 'کد فعال‌سازی نادرست است.' });
  if (user) db.update('users', user.id, { license_activated: true, license_activated_at: new Date().toISOString() });
  const token = makeLicenseToken();
  return res.status(200).json({ ok: true, token, account_activated: !!user,
    message: 'برنامه به صورت دائمی فعال شد.' });
};
