// api/trial.js — وضعیت مجوز: اشتراک (اولویت اول)، فعال‌سازی دائمی، دوره آزمایشی
// اکشن‌ها:
//   status → وضعیت فعلی (ورودی: توکن‌های کلاینت + توکن نشست اختیاری)
//   start  → شروع دوره آزمایشی
const path = require('path');
const config = require(path.join(__dirname, '..', 'config.json'));
const { licenseStatus, makeTrialToken, isActivated } = require('../lib/license');
const { getSessionUser } = require('../lib/auth');
const subscription = require('../lib/subscription');
const { guardApi } = require('../lib/guard');
const db = require('../lib/db');

const TRIAL_DAYS = Number.isFinite(config.trial_period_days) ? config.trial_period_days : 2;

/** وضعیت مجوز با اولویت: اشتراک فعال > فعال‌سازی دائمی > دوره آزمایشی. */
function resolveStatus({ req, body }) {
  // ۱) کاربر واردشده با اشتراک فعال → بالاترین اولویت
  const user = getSessionUser(req, body);
  if (user) {
    const sub = subscription.subscriptionStatus(user);
    if (sub.active) {
      return { state: 'activated', message: sub.message, source: 'subscription', subscription: sub };
    }
    // دوره آزمایشی ذخیره‌شده در حساب (مستقل از مرورگر)
    if (user.trial && user.trial.startDate) {
      const start = new Date(user.trial.startDate).getTime();
      const expiry = start + TRIAL_DAYS * 86400000;
      if (Date.now() <= expiry) {
        return { state: 'active', message: 'دوره آزمایشی فعال', source: 'account' };
      }
      return { state: 'expired', message: 'دوره آزمایشی به پایان رسیده', source: 'account' };
    }
    return { state: 'not_started', message: 'دوره آزمایشی شروع نشده', source: 'account' };
  }

  // ۲) کاربر مهمان: همان مسیر توکن‌های امضاشده (سازگاری با نسخه قبل)
  const licenseToken = String(body.licenseToken || '');
  const trialToken = String(body.trialToken || '');
  const st = licenseStatus({ licenseToken, trialToken }, TRIAL_DAYS);
  return { ...st, source: 'guest' };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'trial', limit: 60, windowMs: 60000 })) return;

  const body = (typeof req.body === 'string') ? safeParse(req.body) : (req.body || {});
  const action = body.action || 'status';

  try {
    if (action === 'status') {
      const st = resolveStatus({ req, body });
      res.status(200).json({ ok: true, ...st });
      return;
    }

    if (action === 'start') {
      const user = getSessionUser(req, body);
      if (user) {
        if (user.trial && user.trial.startDate) {
          const st = resolveStatus({ req, body });
          return res.status(200).json({ ok: true, ...st });
        }
        db.update('users', user.id, { trial: { startDate: new Date().toISOString() } });
        const st = resolveStatus({ req, body });
        return res.status(200).json({ ok: true, ...st });
      }
      // مهمان: توکن امضاشده (مانند قبل)
      const licenseToken = String(body.licenseToken || '');
      if (isActivated(licenseToken)) {
        const st = licenseStatus({ licenseToken, trialToken: '' }, TRIAL_DAYS);
        return res.status(200).json({ ok: true, ...st, source: 'guest' });
      }
      const token = makeTrialToken(String(body.trialToken || '') || null);
      const st = licenseStatus({ licenseToken, trialToken: token }, TRIAL_DAYS);
      res.status(200).json({ ok: true, trialToken: token, ...st, source: 'guest' });
      return;
    }

    res.status(400).json({ ok: false, error: 'اکشن ناشناخته: ' + action });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}
