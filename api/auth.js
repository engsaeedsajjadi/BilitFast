// api/auth.js — حساب کاربری: ثبت‌نام / ورود / وضعیت / خروج / به‌روزرسانی پروفایل
const { registerUser, loginUser, publicUser, getSessionUser, verifyPassword, hashPassword } = require('../lib/auth');
const { guardApi, isLockedOut, recordLoginFailure, clearLoginFailures } = require('../lib/guard');
const db = require('../lib/db');
const accounts = require('../lib/accounts');
const activity = require('../lib/activity');

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
      // Commercial deployments provision users through the admin console.
      // Opt-in to public self-registration only when explicitly required.
      if (process.env.NODE_ENV === 'production' &&
          process.env.BILITFAST_ALLOW_PUBLIC_REGISTRATION !== '1') {
        return res.status(403).json({ ok: false, error: 'ثبت‌نام عمومی غیرفعال است؛ با مدیر مجموعه تماس بگیرید.' });
      }
      const r = registerUser(body.username, body.password);
      if (!r.ok) return res.status(200).json(r);
      return res.status(200).json({ ok: true, token: r.token, user: publicUser(r.user), storageOk: db.isPersistent() });
    }

    if (action === 'login') {
      /* قفل موقت پس از چند تلاش ناموفق روی همین نام کاربری — مکمل محدودیت
       * مبتنی بر آی‌پی، برای حالتی که مهاجم از چندین آی‌پی حمله می‌کند. */
      const lock = isLockedOut(body.username);
      if (lock.locked) {
        const mins = Math.ceil(lock.retryInMs / 60000);
        return res.status(429).json({
          ok: false,
          lockedOut: true,
          error: `به دلیل تلاش‌های ناموفق زیاد، ورود به این حساب موقتاً قفل شده است. حدود ${mins} دقیقه دیگر دوباره تلاش کنید.`,
        });
      }

      const r = loginUser(body.username, body.password);
      if (!r.ok) {
        if (r.accountBlocked) {
          activity.log({ type: 'LOGIN_BLOCKED', meta: { username: String(body.username || '').slice(0, 64) }, req });
          return res.status(200).json(r);
        }
        recordLoginFailure(body.username);
        activity.log({ type: 'LOGIN_FAILED', meta: { username: String(body.username || '').slice(0, 64) }, req });
        return res.status(200).json(r);
      }
      clearLoginFailures(body.username);
      /* حساب غیرفعال یا منقضی نباید اصلاً توکن بگیرد. بررسی اینجا (نه فقط در
       * APIهای بعدی) باعث می‌شود کاربر پیام روشن ببیند، نه خطای مبهم بعدی. */
      const st = accounts.accountStatus(r.user);
      if (!st.ok) {
        activity.log({ userId: r.user.id, type: 'LOGIN_BLOCKED', meta: { reason: st.reason }, req });
        return res.status(200).json({ ok: false, accountBlocked: true, reason: st.reason, error: st.error });
      }
      activity.log({ userId: r.user.id, type: 'LOGIN', req });
      return res.status(200).json({ ok: true, token: r.token, user: publicUser(r.user), storageOk: db.isPersistent() });
    }

    if (action === 'me') {
      const { resolveUser } = require('../lib/apiauth');
      const r = resolveUser(req, body);
      if (!r.user) {
        return res.status(200).json({
          ok: false,
          loggedIn: false,
          reason: r.reason || 'no_session',
          error: r.error || 'نشست معتبر نیست.',
        });
      }
      const u = accounts.normalizeUser(r.user);
      return res.status(200).json({
        ok: true,
        loggedIn: true,
        user: publicUser(r.user),
        // اطلاعات مجوز تا رابط کاربری بتواند سهمیه و دسترسی را درست نشان دهد
        account: {
          role: u.role,
          display_name: u.display_name || '',
          expires_at: u.expires_at,
          is_admin: u.role === 'admin',
          quota: {
            searches: accounts.quotaStatus(u, 'searches'),
            reservations: accounts.quotaStatus(u, 'reservations'),
          },
        },
      });
    }

    if (action === 'logout') {
      /* نشست‌ها بدون حالت‌اند، ولی «خروج» باید واقعاً توکن را بی‌اعتبار کند —
       * وگرنه توکن دزدیده‌شده تا ۷ روز معتبر می‌ماند. با ثبت لحظه خروج، هر
       * توکنی که پیش از آن صادر شده رد می‌شود.
       * توجه: کوکی‌های صفیر ریل عمداً پاک نمی‌شوند؛ خروج از حساب برنامه
       * ربطی به نشست صفیر ندارد و پاک کردنش کار کاربر را خراب می‌کند. */
      const user = getSessionUser(req, body);
      if (user) {
        accounts.revokeSessions(user.id);
        activity.log({ userId: user.id, type: 'LOGOUT', req });
      }
      return res.status(200).json({ ok: true, revoked: !!user });
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
      // Password changes must invalidate every existing bearer token.
      accounts.revokeSessions(user.id);
      activity.log({ userId: user.id, type: 'PASSWORD_CHANGED', req });
      return res.status(200).json({ ok: true, reauthRequired: true,
        message: 'گذرواژه تغییر کرد. برای امنیت حساب، دوباره وارد شوید.' });
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
      if (body.payment_notify !== undefined && typeof body.payment_notify === 'object') {
        const pn = body.payment_notify;
        patch.payment_notify = {
          enabled: pn.enabled === true,
          telegram: pn.telegram === true,
          bale: pn.bale === true,
          eitaa: pn.eitaa === true,
          bale_chat_id: String(pn.bale_chat_id || '').trim().slice(0, 120),
          eitaa_chat_id: String(pn.eitaa_chat_id || '').trim().slice(0, 120),
          template: String(pn.template || '').slice(0, 2000),
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
