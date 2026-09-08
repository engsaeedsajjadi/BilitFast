// api/search.js — یک تلاش جستجو (پورت از Worker.do_one_attempt)
const { searchOnce } = require('../lib/core');
const { filterAndRankTrains } = require('../lib/agent');
const { guardApi } = require('../lib/guard');
const { getSessionUser } = require('../lib/auth');
const { checkAccess } = require('../lib/license');
const config = require('../config.json');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'search', limit: 240, windowMs: 60000 })) return;

  const body = (typeof req.body === 'string') ? JSON.parse(req.body || '{}') : (req.body || {});
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
    // خطای غیرمنتظره در بررسی مجوز = دسترسی داده نشود (fail-closed)
    res.status(500).json({ ok: false, error: 'خطا در بررسی مجوز دسترسی.' });
    return;
  }
  try {
    const result = await searchOnce(body);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    // اختیاری: اعمال ترجیحات کاربر (فیلتر سخت + رتبه‌بندی نرم) از موتور عامل.
    // اگر پرامتر prefs ارسال نشود، رفتار دقیقاً مثل قبل است (بدون تغییر).
    if (body.prefs && typeof body.prefs === 'object' && Array.isArray(result.trains)) {
      const r = filterAndRankTrains(result.trains, body.prefs);
      result.trains = r.ranked;
      result.ranking = { keptCount: r.keptCount, droppedCount: r.droppedCount };
    }
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
