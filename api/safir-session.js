// api/safir-session.js — مدیریت نشست خودکار صفیر ریل.
//
// اقدام‌ها (action):
//   save    → ذخیره رمزشده شناسه/گذرواژه صفیر ریل + یک ورود فوری برای گرفتن کوکی
//   status  → وضعیت تازه‌سازی خودکار (فعال؟ آخرین نتیجه؟ چند کوکی؟)
//   refresh → تازه‌سازی فوری نشست (دکمه «همین حالا تازه کن»)
//   pull    → تحویل گرفتن آخرین کوکی‌های ذخیره‌شده روی حساب
//   clear   → خاموش‌کردن تازه‌سازی خودکار و حذف اعتبارنامه
//
// همه اقدام‌ها نیازمند ورود به حساب برنامه هستند، چون اعتبارنامه روی رکورد
// کاربر ذخیره می‌شود. گذرواژه صفیر هرگز به مرورگر بازگردانده نمی‌شود.

const keeper = require('../lib/session-keeper');
const { guardApi } = require('../lib/guard');
const { getSessionUser } = require('../lib/auth');
const db = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'safir-session', limit: 30, windowMs: 60000 })) return;

  const body = (typeof req.body === 'string') ? JSON.parse(req.body || '{}') : (req.body || {});
  const action = body.action || 'status';

  const user = getSessionUser(req, body);
  if (!user) {
    res.status(401).json({
      ok: false,
      loginRequired: true,
      error: 'برای تازه‌سازی خودکار نشست، ابتدا وارد حساب کاربری برنامه شوید.',
    });
    return;
  }

  try {
    if (action === 'status') {
      const fresh = db.findById('users', user.id) || user;
      res.status(200).json({ ok: true, ...keeper.getStatus(fresh) });
      return;
    }

    if (action === 'save') {
      const username = String(body.safir_username || '').trim();
      const password = String(body.safir_password || '');
      if (!username || !password) {
        res.status(400).json({ ok: false, error: 'شناسه و گذرواژه صفیر ریل را وارد کنید.' });
        return;
      }
      keeper.saveCredentials(user.id, username, password);
      // ورود فوری تا کاربر همان لحظه نتیجه را ببیند
      const r = await keeper.refreshUserSession(user.id);
      const fresh = db.findById('users', user.id) || user;
      res.status(200).json({
        ok: true,
        saved: true,
        refresh: { ok: r.ok, reason: r.reason || null, error: r.error || null, count: r.count || 0 },
        cookies: r.ok ? (r.cookies || []) : [],
        ...keeper.getStatus(fresh),
      });
      return;
    }

    if (action === 'refresh') {
      const r = await keeper.refreshUserSession(user.id);
      const fresh = db.findById('users', user.id) || user;
      res.status(200).json({
        ok: !!r.ok,
        reason: r.reason || null,
        error: r.error || null,
        cookies: r.ok ? (r.cookies || []) : [],
        count: r.count || 0,
        ...keeper.getStatus(fresh),
      });
      return;
    }

    if (action === 'pull') {
      const fresh = db.findById('users', user.id) || user;
      const cookies = Array.isArray(fresh.safir_cookies) ? fresh.safir_cookies : [];
      res.status(200).json({
        ok: cookies.length > 0,
        cookies,
        count: cookies.length,
        cookiesAt: fresh.safir_cookies_at || null,
        error: cookies.length ? null : 'هنوز کوکی تازه‌ای ذخیره نشده است.',
      });
      return;
    }

    if (action === 'clear') {
      keeper.clearCredentials(user.id);
      res.status(200).json({ ok: true, cleared: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'اقدام نامعتبر' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
