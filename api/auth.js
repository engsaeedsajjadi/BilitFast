// api/auth.js — حساب کاربری: ثبت‌نام / ورود / وضعیت / خروج / به‌روزرسانی پروفایل
const { registerUser, loginUser, publicUser, getSessionUser, verifyPassword, hashPassword } = require('../lib/auth');
const { guardApi } = require('../lib/guard');
const db = require('../lib/db');

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
  const body = readBody(req);
  const action = body.action || 'me';

  // ثبت‌نام/ورود محدودسازی سخت‌گیرانه دارد؛ بقیه اکشن‌ها ملایم‌تر
  if (action === 'register' || action === 'login') {
    if (!guardApi(req, res, { name: 'auth-' + action, limit: 10, windowMs: 60000 })) return;
  } else {
    if (!guardApi(req, res, { name: 'auth-other', limit: 120, windowMs: 60000 })) return;
  }

  try {
    if (action === 'register') {
      const r = registerUser(body.username, body.password);
      if (!r.ok) return res.status(200).json(r);
      return res.status(200).json({ ok: true, token: r.token, user: publicUser(r.user), storageOk: db.isPersistent() });
    }

    if (action === 'login') {
      const r = loginUser(body.username, body.password);
      if (!r.ok) return res.status(200).json(r);
      return res.status(200).json({ ok: true, token: r.token, user: publicUser(r.user), storageOk: db.isPersistent() });
    }

    if (action === 'me') {
      const user = getSessionUser(req, body);
      if (!user) return res.status(200).json({ ok: false, error: 'نشست معتبر نیست.', loggedIn: false });
      return res.status(200).json({ ok: true, loggedIn: true, user: publicUser(user) });
    }

    if (action === 'logout') {
      // نشست‌ها بدون حالت (توکن امضاشده) هستند؛ خروج فقط با حذف توکن سمت کلاینت است.
      return res.status(200).json({ ok: true });
    }

    if (action === 'change-password') {
      const user = getSessionUser(req, body);
      if (!user) return res.status(200).json({ ok: false, error: 'ابتدا وارد شوید.' });
      if (!verifyPassword(body.current_password || '', user.pass)) {
        return res.status(200).json({ ok: false, error: 'گذرواژه فعلی نادرست است.' });
      }
      if (String(body.new_password || '').length < 6) {
        return res.status(200).json({ ok: false, error: 'گذرواژه جدید باید حداقل ۶ کاراکتر باشد.' });
      }
      db.update('users', user.id, { pass: hashPassword(body.new_password) });
      return res.status(200).json({ ok: true, message: 'گذرواژه تغییر کرد.' });
    }

    if (action === 'update-profile') {
      const user = getSessionUser(req, body);
      if (!user) return res.status(200).json({ ok: false, error: 'ابتدا وارد شوید.' });
      const patch = {};
      if (body.phone !== undefined) {
        const p = String(body.phone || '').trim();
        if (p && !/^09\d{9}$/.test(p)) return res.status(200).json({ ok: false, error: 'شماره همراه معتبر نیست (مثال: 09123456789).' });
        patch.phone = p;
      }
      if (body.telegram_chat_id !== undefined) patch.telegram_chat_id = String(body.telegram_chat_id || '').trim();
      if (body.notify !== undefined && typeof body.notify === 'object') {
        patch.notify = {
          telegram: body.notify.telegram !== false,
          sms: body.notify.sms === true,
        };
      }
      db.update('users', user.id, patch);
      return res.status(200).json({ ok: true, user: publicUser(db.findById('users', user.id)) });
    }

    // انتقال داده‌های محلی مرورگر (مسیرها/کوکی‌ها) به حساب — یک‌بار بعد از ورود
    if (action === 'import-local') {
      const user = getSessionUser(req, body);
      if (!user) return res.status(200).json({ ok: false, error: 'ابتدا وارد شوید.' });
      const patch = {};
      if (Array.isArray(body.routes) && !user.imported_routes && body.routes.length) {
        patch.local_routes = body.routes.slice(0, 50);
        patch.imported_routes = true;
      }
      if (Array.isArray(body.cookies) && body.cookies.length) {
        patch.safir_cookies = body.cookies.slice(0, 30);
      }
      db.update('users', user.id, patch);
      return res.status(200).json({ ok: true });
    }

    if (action === 'export-local') {
      const user = getSessionUser(req, body);
      if (!user) return res.status(200).json({ ok: false, error: 'ابتدا وارد شوید.' });
      return res.status(200).json({
        ok: true,
        routes: user.local_routes || [],
        cookies: user.safir_cookies || [],
      });
    }

    return res.status(400).json({ ok: false, error: 'اکشن ناشناخته: ' + action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
