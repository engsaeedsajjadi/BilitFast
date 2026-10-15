// -*- coding: utf-8 -*-
/**
 * lib/apiauth.js — نگهبان واحد احراز هویت و مجوز برای APIها.
 *
 * هدف: به‌جای تکرار منطق «کاربر را بگیر، نشست را چک کن، انقضا را چک کن، نقش
 * را چک کن» در ۲۲ فایل api/، همه از یک تابع استفاده کنند. هر جا این تابع
 * false برگرداند، پاسخ خطا هم نوشته شده و handler باید فوراً return کند —
 * دقیقاً مثل الگوی guardApi که از قبل در پروژه هست.
 *
 * یک تصمیم مهم درباره سازگاری عقب‌رو:
 * حالت تک‌کاربره محلی باید کار کند. اگر هیچ کاربری در دیتابیس ثبت نشده باشد
 * (نصب تازه روی لپ‌تاپ شخصی)، اجبار ورود، برنامه را برای کاربر فعلی خراب
 * می‌کند. پس requireUser در «حالت محلی تک‌کاربره» عبور می‌دهد. به محض اینکه
 * حتی یک حساب ساخته شود، یا BILITFAST_MULTIUSER=1 تنظیم شود، اجبار فعال
 * می‌شود. این رفتار در docs/AUTH.md مستند شده است.
 */

const { getSessionUser, verifySession } = require('./auth');
const accounts = require('./accounts');
const db = require('./db');

/**
 * آیا باید ورود را اجباری کنیم؟
 * - BILITFAST_MULTIUSER=1  → همیشه بله (حالت ابری/چندکاربره)
 * - BILITFAST_MULTIUSER=0  → همیشه خیر (تک‌کاربره صریح)
 * - تنظیم‌نشده             → اگر حداقل یک کاربر ثبت شده باشد، بله
 */
function isMultiUser() {
  const v = String(process.env.BILITFAST_MULTIUSER || '').trim();
  if (v === '1' || /^(true|yes|on)$/i.test(v)) return true;
  if (v === '0' || /^(false|no|off)$/i.test(v)) return false;
  try {
    return db.find('users', () => true).length > 0;
  } catch (e) {
    return false;
  }
}

/** توکن خام درخواست (برای بررسی iat در ابطال نشست). */
function rawSession(req, body) {
  let token = null;
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (h && /^Bearer\s+/i.test(h)) token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token && body && body.sessionToken) token = String(body.sessionToken);
  return verifySession(token);
}

/**
 * کاربر معتبرِ زنده را برمی‌گرداند یا null.
 * «زنده» یعنی: نشست امضای درست دارد، پس از آخرین logout صادر شده، حساب فعال
 * است و منقضی نشده.
 */
function resolveUser(req, body) {
  // Decode the signed token first to preserve useful disabled/expired
  // error reasons for the UI. getSessionUser() intentionally returns null
  // for those accounts and is therefore NOT used as the reason resolver.
  const sess = rawSession(req, body);
  if (!sess) return { user: null, reason: 'no_session' };
  const user = db.findById('users', sess.uid);
  if (!user) return { user: null, reason: 'no_session' };

  const st = accounts.accountStatus(user);
  if (!st.ok) return { user: null, reason: st.reason, error: st.error };
  if (!accounts.isSessionLive(user, sess)) {
    return { user: null, reason: 'revoked' };
  }
  return { user: st.user, reason: null };
}

/**
 * ورود الزامی. در صورت شکست، پاسخ 401/403 نوشته و false برمی‌گرداند.
 * در حالت تک‌کاربره محلی، با user=null عبور می‌دهد (سازگاری عقب‌رو).
 */
function requireUser(req, res, body, opts) {
  const { allowLocal = true } = opts || {};
  const r = resolveUser(req, body);
  if (r.user) return { ok: true, user: r.user };

  if (allowLocal && !isMultiUser()) {
    // حالت تک‌کاربره روی دستگاه شخصی: مثل گذشته بدون حساب کار می‌کند.
    return { ok: true, user: null, localMode: true };
  }

  if (r.reason === 'disabled' || r.reason === 'expired') {
    res.status(403).json({ ok: false, accountBlocked: true, reason: r.reason, error: r.error });
    return { ok: false };
  }
  res.status(401).json({
    ok: false,
    loginRequired: true,
    error: r.reason === 'revoked'
      ? 'نشست شما پایان یافته است. دوباره وارد شوید.'
      : 'برای استفاده از این بخش ابتدا وارد حساب کاربری شوید.',
  });
  return { ok: false };
}

/** دسترسی ادمین. همیشه ورود می‌خواهد، حتی در حالت محلی. */
function requireAdmin(req, res, body) {
  const r = resolveUser(req, body);
  if (!r.user) {
    res.status(401).json({ ok: false, loginRequired: true, error: 'برای دسترسی مدیریتی وارد شوید.' });
    return { ok: false };
  }
  if (r.user.role !== 'admin') {
    // عمداً همان پیام عمومی: به کاربر عادی نگوییم چه چیزی آنجا هست.
    res.status(403).json({ ok: false, error: 'شما به این بخش دسترسی ندارید.' });
    return { ok: false };
  }
  return { ok: true, user: r.user };
}

/**
 * کلید جداسازی داده‌های صفیر ریل برای هر کاربر.
 * در حالت محلی تک‌کاربره 'local' برمی‌گردد تا داده فعلی کاربر گم نشود.
 */
function scopeKey(user) {
  return user ? 'u:' + user.id : 'local';
}

module.exports = { isMultiUser, resolveUser, requireUser, requireAdmin, scopeKey, rawSession };
