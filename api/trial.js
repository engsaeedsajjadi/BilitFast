// api/trial.js — وضعیت مجوز و شروع دوره آزمایشی (توکن‌های امضاشده سمت سرور)
// اکشن‌ها:
//   status → بررسی وضعیت فعلی (ورودی: توکن‌های ذخیره‌شده کلاینت)
//   start  → شروع دوره آزمایشی (فقط اگر قبلاً شروع نشده باشد)
const path = require('path');
const config = require(path.join(__dirname, '..', 'config.json'));
const { licenseStatus, makeTrialToken, isActivated } = require('../lib/license');
const { guardApi } = require('../lib/guard');

const TRIAL_DAYS = Number.isFinite(config.trial_period_days) ? config.trial_period_days : 2;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'trial', limit: 60, windowMs: 60000 })) return;

  const body = (typeof req.body === 'string') ? safeParse(req.body) : (req.body || {});
  const action = body.action || 'status';
  const licenseToken = String(body.licenseToken || '');
  const trialToken = String(body.trialToken || '');

  if (action === 'status') {
    const st = licenseStatus({ licenseToken, trialToken }, TRIAL_DAYS);
    res.status(200).json({ ok: true, ...st });
    return;
  }

  if (action === 'start') {
    if (isActivated(licenseToken)) {
      const st = licenseStatus({ licenseToken, trialToken }, TRIAL_DAYS);
      res.status(200).json({ ok: true, ...st });
      return;
    }
    const token = makeTrialToken(trialToken || null);
    const st = licenseStatus({ licenseToken, trialToken: token }, TRIAL_DAYS);
    res.status(200).json({ ok: true, trialToken: token, ...st });
    return;
  }

  res.status(400).json({ ok: false, error: 'اکشن ناشناخته: ' + action });
};

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}
