// api/search.js — یک تلاش جستجو (پورت از Worker.do_one_attempt)
const { searchOnce } = require('../lib/core');
const { filterAndRankTrains } = require('../lib/agent');
const { guardApi } = require('../lib/guard');
const { readJsonBody } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'search', limit: 240, windowMs: 60000 })) return;

  const body = readJsonBody(req);
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
