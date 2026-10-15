// -*- coding: utf-8 -*-
/**
 * lib/accounts.js — لایه «حساب سازمانی» روی سیستم کاربری موجود.
 *
 * چرا یک ماژول جدا و نه تغییر lib/auth.js؟
 * lib/auth.js امروز کار خودش (هش گذرواژه + توکن نشست) را درست انجام می‌دهد و
 * چند جای پروژه به آن وابسته است. چیزی که اضافه می‌شود مفاهیم *مجوز* است نه
 * *احراز هویت*: نقش، فعال/غیرفعال بودن، انقضا و سهمیه. این‌ها لایه دیگری
 * هستند، پس در فایل دیگری می‌مانند تا auth ساده و قابل‌اتکا بماند.
 *
 * سازگاری با داده قبلی (مهم):
 * کاربران فعلی در data/db.json هیچ‌کدام از فیلدهای role/is_active/expires_at
 * را ندارند. هیچ migration مخربی اجرا نمی‌شود؛ به‌جای آن normalizeUser() در
 * زمان خواندن مقادیر پیش‌فرضِ امن می‌گذارد: نقش user، فعال، بدون انقضا. پس
 * حساب‌های موجود دقیقاً مثل قبل کار می‌کنند.
 */

const crypto = require('crypto');
const db = require('./db');

const ROLES = ['admin', 'tester', 'user'];

/** سهمیه پیش‌فرض: null یعنی «بدون محدودیت» (رفتار امروزِ کاربران موجود). */
const DEFAULTS = {
  role: 'user',
  is_active: true,
  expires_at: null,
  max_searches: null,
  max_reservations: null,
};

function isRole(r) {
  return ROLES.indexOf(String(r)) !== -1;
}

/**
 * فیلدهای مجوز را با پیش‌فرض امن برمی‌گرداند بدون آنکه رکورد را بنویسد.
 * خواندنی محض است تا داده قدیمی دست‌نخورده بماند.
 */
function normalizeUser(user) {
  if (!user) return null;
  return {
    ...user,
    role: isRole(user.role) ? user.role : DEFAULTS.role,
    is_active: user.is_active === undefined ? DEFAULTS.is_active : !!user.is_active,
    expires_at: user.expires_at || DEFAULTS.expires_at,
    max_searches: (user.max_searches === undefined) ? DEFAULTS.max_searches : user.max_searches,
    max_reservations: (user.max_reservations === undefined) ? DEFAULTS.max_reservations : user.max_reservations,
    usage: user.usage || { searches: 0, reservations: 0 },
  };
}

function isExpired(user, now = Date.now()) {
  const u = normalizeUser(user);
  if (!u || !u.expires_at) return false;
  const t = Date.parse(u.expires_at);
  if (!Number.isFinite(t)) return false;
  return now > t;
}

/**
 * آیا این حساب حق استفاده از APIهای محافظت‌شده را دارد؟
 * دلیلِ رد همیشه مشخص برگردانده می‌شود تا رابط کاربری پیام دقیق بدهد.
 */
function accountStatus(user, now = Date.now()) {
  const u = normalizeUser(user);
  if (!u) return { ok: false, reason: 'no_user', error: 'ابتدا وارد حساب کاربری شوید.' };
  if (!u.is_active) {
    return { ok: false, reason: 'disabled', error: 'این حساب کاربری غیرفعال شده است. با پشتیبانی تماس بگیرید.' };
  }
  if (isExpired(u, now)) {
    return { ok: false, reason: 'expired', error: 'مهلت استفاده از این حساب به پایان رسیده است.' };
  }
  return { ok: true, user: u };
}

/* ---------------- سهمیه استفاده ---------------- */

/**
 * سهمیه را بدون افزایش شمارنده بررسی می‌کند.
 * kind: 'searches' | 'reservations'
 */
function quotaStatus(user, kind) {
  const u = normalizeUser(user);
  if (!u) return { ok: false, reason: 'no_user' };
  const limitField = kind === 'reservations' ? 'max_reservations' : 'max_searches';
  const limit = u[limitField];
  if (limit === null || limit === undefined) return { ok: true, unlimited: true };
  const used = Number(u.usage[kind] || 0);
  if (used >= Number(limit)) {
    return {
      ok: false,
      reason: 'quota',
      used,
      limit: Number(limit),
      error: kind === 'reservations'
        ? `سهمیه رزرو شما (${limit} مورد) تمام شده است.`
        : `سهمیه جستجوی شما (${limit} مورد) تمام شده است.`,
    };
  }
  return { ok: true, used, limit: Number(limit), remaining: Number(limit) - used };
}

/**
 * یک واحد از سهمیه مصرف می‌کند و شمارنده را در دیتابیس می‌نویسد.
 * اگر سهمیه تمام باشد چیزی نمی‌نویسد و ok:false برمی‌گرداند.
 */
function consumeQuota(userId, kind) {
  const fresh = db.findById('users', userId);
  if (!fresh) return { ok: false, reason: 'no_user' };
  const st = quotaStatus(fresh, kind);
  if (!st.ok) return st;
  const usage = { searches: 0, reservations: 0, ...(fresh.usage || {}) };
  usage[kind] = Number(usage[kind] || 0) + 1;
  db.update('users', userId, { usage });
  return { ok: true, used: usage[kind], limit: st.unlimited ? null : st.limit };
}

/* ---------------- ابطال نشست (Logout واقعی) ---------------- */

/**
 * توکن‌های نشست بدون‌حالت و امضاشده‌اند، پس «باطل کردن» یعنی بی‌اعتبار کردن
 * هر توکنی که پیش از لحظه خروج صادر شده است. برای این کار یک مُهر زمانی روی
 * رکورد کاربر نگه می‌داریم و در بررسی نشست با iat توکن مقایسه می‌کنیم.
 * مزیت: بدون جدول نشست و بدون Redis کار می‌کند.
 */
function revokeSessions(userId) {
  db.update('users', userId, { sessions_revoked_at: Date.now() });
  return true;
}

/**
 * آیا این توکن پس از آخرین خروج صادر شده است؟
 *
 * مقایسه عمداً «اکیداً بزرگ‌تر» است، نه «بزرگ‌تر یا مساوی». چون iat توکن و
 * لحظه خروج هر دو با دقت میلی‌ثانیه ثبت می‌شوند، توکنی که در همان میلی‌ثانیهٔ
 * خروج صادر شده مبهم است. در امنیت، حالت مبهم باید رد شود (fail-closed):
 * بدترین پیامد این سخت‌گیری، یک بار ورود دوباره است؛ بدترین پیامد سهل‌گیری،
 * زنده ماندن توکنی است که کاربر فکر می‌کند باطل شده.
 */
function isSessionLive(user, session) {
  if (!user || !session) return false;
  const cut = Number(user.sessions_revoked_at || 0);
  if (!cut) return true;
  return Number(session.iat || 0) > cut;
}

/* ---------------- مدیریت کاربران (Admin) ---------------- */

function listUsers() {
  return db.find('users', () => true).map((u) => adminView(u));
}

/** نمای کاربر برای پنل مدیریت — هرگز شامل هش گذرواژه یا اعتبارنامه صفیر نیست. */
function adminView(user) {
  const u = normalizeUser(user);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name || '',
    role: u.role,
    license_activated: !!u.license_activated,
    is_active: u.is_active,
    expires_at: u.expires_at,
    max_searches: u.max_searches,
    max_reservations: u.max_reservations,
    usage: { searches: Number(u.usage.searches || 0), reservations: Number(u.usage.reservations || 0) },
    has_safir_credentials: !!u.safir_credentials,
    created_at: u.created_at,
    updated_at: u.updated_at || null,
  };
}

/** فیلدهایی که ادمین حق تغییرشان را دارد. بقیه نادیده گرفته می‌شوند. */
function applyAdminPatch(userId, patch) {
  const user = db.findById('users', userId);
  if (!user) return { ok: false, error: 'کاربر پیدا نشد.' };
  const out = {};
  if (patch.display_name !== undefined) out.display_name = String(patch.display_name).slice(0, 120);
  if (patch.role !== undefined) {
    if (!isRole(patch.role)) return { ok: false, error: 'نقش نامعتبر است.' };
    out.role = patch.role;
  }
  if (patch.is_active !== undefined) out.is_active = !!patch.is_active;
  if (patch.expires_at !== undefined) {
    if (patch.expires_at === null || patch.expires_at === '') out.expires_at = null;
    else {
      const t = Date.parse(patch.expires_at);
      if (!Number.isFinite(t)) return { ok: false, error: 'تاریخ انقضا نامعتبر است.' };
      out.expires_at = new Date(t).toISOString();
    }
  }
  for (const [k, field] of [['max_searches', 'max_searches'], ['max_reservations', 'max_reservations']]) {
    if (patch[k] !== undefined) {
      if (patch[k] === null || patch[k] === '') out[field] = null;
      else {
        const n = Number(patch[k]);
        if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'محدودیت باید عدد نامنفی باشد.' };
        out[field] = Math.floor(n);
      }
    }
  }
  if (patch.reset_usage) out.usage = { searches: 0, reservations: 0 };
  out.updated_at = new Date().toISOString();
  db.update('users', userId, out);
  // غیرفعال کردن حساب باید نشست‌های باز را هم ببندد، وگرنه کاربرِ غیرفعال تا
  // انقضای توکن به کار ادامه می‌دهد.
  if (out.is_active === false) revokeSessions(userId);
  return { ok: true, user: adminView(db.findById('users', userId)) };
}

/** آیا اصلاً ادمینی وجود دارد؟ برای راه‌اندازی اولیه لازم است. */
function hasAdmin() {
  return !!db.findOne('users', (u) => u.role === 'admin');
}

function countAdmins() {
  return db.find('users', (u) => u.role === 'admin' && u.is_active !== false).length;
}

/** گذرواژه تصادفی خوانا برای کاربران تستی. */
function generatePassword(len = 14) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = {
  ROLES, DEFAULTS,
  normalizeUser, isRole, isExpired, accountStatus,
  quotaStatus, consumeQuota,
  revokeSessions, isSessionLive,
  listUsers, adminView, applyAdminPatch,
  hasAdmin, countAdmins, generatePassword,
};
