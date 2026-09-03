// api/cookie-sync.js — همگام‌سازی کوکی صفیر ریل با «یک کلیک» از طریق افزونه مرورگر.
//
// چرا افزونه؟ کوکی نشست (PHPSESSID) از نوع HttpOnly است؛ نه جاوااسکریپتِ صفحه
// و نه هیچ روش مرورگری دیگری نمی‌تواند آن را بخواند — فقط افزونه (با مجوز
// cookies) می‌تواند. افزونه پوشه «extension» را ببینید.
//
// اکشن‌ها:
//   push → افزونه کوکی‌ها را می‌فرستد (ذخیره با برچسب زمانی)
//   poll → برنامه آخرین همگام‌سازی (حداکثر ۵ دقیقه قبل) را دریافت می‌کند

const db = require('../lib/db');
const { guardApi } = require('../lib/guard');

const TTL_MS = 5 * 60 * 1000;
const MAX_RECORDS = 20;

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
  }
  return req.body || {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'cookie-sync', limit: 120, windowMs: 60000 })) return;

  const body = readBody(req);
  const action = body.action || 'poll';

  try {
    if (action === 'push') {
      const cookies = Array.isArray(body.cookies)
        ? body.cookies.map((c) => String(c).slice(0, 2000)).filter(Boolean).slice(0, 30)
        : [];
      if (!cookies.length) {
        return res.status(400).json({ ok: false, error: 'کوکی‌ای ارسال نشده است.' });
      }
      const hasSession = cookies.some((c) => /^PHPSESSID=/i.test(c));
      db.insert('cookie_sync', {
        cookies,
        consumed: false,
        source: String(body.source || 'extension').slice(0, 40),
        has_session: hasSession,
      });
      // محدودنگه‌داشتن تعداد رکوردها
      const all = db.find('cookie_sync', () => true).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      for (const old of all.slice(MAX_RECORDS)) db.remove('cookie_sync', old.id);
      return res.status(200).json({ ok: true, count: cookies.length, has_session: hasSession });
    }

    if (action === 'poll') {
      const now = Date.now();
      const candidates = db
        .find('cookie_sync', (s) => !s.consumed && (now - (s.created_at || 0)) <= TTL_MS)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      if (!candidates.length) {
        return res.status(200).json({ ok: false, waiting: true });
      }
      const rec = candidates[0];
      db.update('cookie_sync', rec.id, { consumed: true });
      return res.status(200).json({
        ok: true,
        cookies: rec.cookies,
        count: rec.cookies.length,
        has_session: !!rec.has_session,
        received_at: rec.created_at,
      });
    }

    return res.status(400).json({ ok: false, error: 'اکشن ناشناخته: ' + action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
