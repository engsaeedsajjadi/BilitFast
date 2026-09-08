// api/trial.js — وضعیت مجوز: فعال‌سازی دائمی یا دوره آزمایشی
// (بخش فروش اشتراک و درگاه پرداخت از برنامه حذف شده است.)
// اکشن‌ها:
//   status → وضعیت فعلی (ورودی: توکن‌های کلاینت + توکن نشست اختیاری)
//   start  → شروع دوره آزمایشی
const path = require('path');
const config = require(path.join(__dirname, '..', 'config.json'));
const { licenseStatus, makeTrialToken, isActivated } = require('../lib/license');
const { verifyInstallMarker } = require('../lib/install-marker');
const { getSessionUser } = require('../lib/auth');
const { guardApi } = require('../lib/guard');
const db = require('../lib/db');

const TRIAL_DAYS = Number.isFinite(config.trial_period_days) ? config.trial_period_days : 2;

/** وضعیت مجوز با اولویت: فعال‌سازی دائمی > دوره آزمایشی حساب > دوره آزمایشی مهمان. */
function resolveStatus({ req, body }) {
  // ۱) کاربر واردشده: دوره آزمایشی ذخیره‌شده در حساب (مستقل از مرورگر)
  const user = getSessionUser(req, body);
  if (user) {
    if (user.license_activated) {
      return { state: 'activated', message: 'فعال‌سازی دائمی', source: 'account' };
    }
    // خودترمیمی: اگر کاربر در این مرورگر فعال‌سازی کرده (توکن لایسنس معتبر دارد)
    // ولی حسابش هنوز علامت نخورده (مثلاً نسخه قبلی که توکن نشست را نمی‌فرستاد)،
    // همین‌جا فعال‌سازی را روی حساب ثبت می‌کنیم تا روی همه دستگاه‌ها فعال شود.
    const licenseToken = String(body.licenseToken || '');
    if (isActivated(licenseToken)) {
      db.update('users', user.id, {
        license_activated: true,
        license_activated_at: new Date().toISOString(),
      });
      return { state: 'activated', message: 'فعال‌سازی دائمی', source: 'account' };
    }
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
  // در نسخه دسکتاپ، تاریخ شروع به تاریخ واقعی نصب روی دستگاه گره می‌خورد
  // (توکن امضاشده که صفحه از رجیستری خوانده) تا با نصب مجدد تمدید نشود.
  const install = readValidInstall(body);
  if (install && st.state === 'not_started') {
    return { state: guestStateFromInstall(install), message: messageForInstall(install), source: 'guest-install' };
  }
  return { ...st, source: 'guest' };
}

function readValidInstall(body) {
  try {
    const info = body && body.install;
    if (!info || !info.signature) return null;
    const p = verifyInstallMarker(info.signature);
    if (!p) return null;
    if (p.deviceId !== String(info.deviceId || '')) return null;
    return p;
  } catch (e) { return null; }
}

function guestStateFromInstall(install) {
  const days = TRIAL_DAYS;
  const start = new Date(install.installDate).getTime();
  if (isNaN(start)) return 'not_started';
  return Date.now() > start + days * 86400000 ? 'expired' : 'active';
}
function messageForInstall(install) {
  return guestStateFromInstall(install) === 'active'
    ? 'دوره آزمایشی فعال (از تاریخ نصب)'
    : 'دوره آزمایشی به پایان رسیده';
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
      // در نسخه دسکتاپ: توکن آزمایشی به تاریخ نصب دستگاه گره می‌خورد تا با
      // نصب مجدد از نو شروع نشود.
      const install = readValidInstall(body);
      let token;
      if (install) {
        const days = TRIAL_DAYS;
        const start = new Date(install.installDate).getTime();
        const expired = !isNaN(start) && Date.now() > start + days * 86400000;
        token = makeTrialToken(null, install.installDate);
        return res.status(200).json({
          ok: true, trialToken: token,
          state: expired ? 'expired' : 'active',
          message: expired ? 'دوره آزمایشی به پایان رسیده' : 'دوره آزمایشی فعال (از تاریخ نصب)',
          source: 'guest-install',
        });
      }
      token = makeTrialToken(String(body.trialToken || '') || null);
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
