// -*- coding: utf-8 -*-
/**
 * lib/license.js — مجوز و دوره آزمایشی «سمت سرور».
 *
 * نسخه قبلی کد فعال‌سازی را داخل کد کلاینت داشت (در سورس قابل دیدن) و وضعیت
 * مجوز در localStorage بود (با پاک‌کردن مرورگر دور زده می‌شد). اکنون:
 *   - کد فعال‌سازی فقط در متغیر محیطی سرور است (BILITFAST_ACTIVATION_CODE).
 *   - سرور در ازای کد درست، یک «توکن امضاشده» (HMAC) می‌دهد که کلاینت ذخیره
 *     می‌کند؛ کلاینت نمی‌تواند آن را جعل کند چون کلید امضا را ندارد.
 *   - دوره آزمایشی هم با توکن امضاشده سرور مدیریت می‌شود (شروع فقط یک‌بار).
 *
 * متغیرهای محیطی:
 *   BILITFAST_ACTIVATION_CODE  — کد فعال‌سازی محصول (اجباری در تولید)
 *   BILITFAST_LICENSE_KEY      — کلید امضا (رشته تصادفی بلند)
 */

const crypto = require('crypto');
const secrets = require('./secrets');

function licenseKey() {
  // کلید مجوز، جدا از کلید نشست؛ در تولید fail-closed است.
  return secrets.licenseKey();
}

/** ساخت توکن امضاشده «بدنه.امضا» (هر دو base64url). */
function signPayload(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', licenseKey()).update(body).digest('base64url');
  return body + '.' + sig;
}

/** اعتبارسنجی توکن امضاشده؛ در صورت جعل/فساد «null» برمی‌گردد. */
function verifyPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', licenseKey()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * کد فعال‌سازی محصول.
 * کد ثابت برنامه است و همیشه معتبر است: وارد کردن آن در برنامه = فعال‌سازی
 * دائمی. در صورت تنظیم متغیر محیطی BILITFAST_ACTIVATION_CODE، آن مقدار نیز
 * علاوه بر کد ثابت پذیرفته می‌شود (برای نسخه‌های اختصاصی/پشتیبانی).
 */
const FIXED_ACTIVATION_CODE = 'Sa0946517835';

function activationCode() {
  return FIXED_ACTIVATION_CODE;
}

/** آیا کد واردشده با کد فعال‌سازی (ثابت یا متغیر محیطی) مطابق است؟ */
function isActivationCodeValid(code) {
  const c = String(code || '').trim();
  if (!c) return false;
  const candidates = [FIXED_ACTIVATION_CODE, String(process.env.BILITFAST_ACTIVATION_CODE || '').trim()].filter(Boolean);
  return candidates.some((expected) => {
    const a = Buffer.from(c);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

/** آیا توکن لایسنس معتبر و فعال است؟ */
function isActivated(licenseToken) {
  const o = verifyPayload(licenseToken);
  return !!(o && o.type === 'license' && o.activated);
}

/**
 * محاسبه وضعیت مجوز از روی توکن‌های کلاینت (بدون تغییر رفتار نسخه قبلی).
 * حالت‌ها: activated | active | expired | not_started
 */
function licenseStatus({ licenseToken = '', trialToken = '' } = {}, trialDays) {
  if (isActivated(licenseToken)) {
    return { state: 'activated', message: 'فعال‌سازی دائمی' };
  }
  const t = verifyPayload(trialToken);
  if (!t || t.type !== 'trial' || !t.startDate) {
    return { state: 'not_started', message: 'دوره آزمایشی شروع نشده' };
  }
  const days = Number.isFinite(trialDays) ? trialDays : 2;
  const start = new Date(t.startDate).getTime();
  if (isNaN(start)) return { state: 'not_started', message: 'دوره آزمایشی شروع نشده' };
  const expiry = start + days * 86400000;
  if (Date.now() > expiry) return { state: 'expired', message: 'دوره آزمایشی به پایان رسیده' };
  return { state: 'active', message: 'دوره آزمایشی فعال' };
}

/** ساخت توکن لایسنس دائم (بعد از تأیید کد فعال‌سازی). */
function makeLicenseToken() {
  return signPayload({ type: 'license', activated: true, iat: Date.now() });
}

/**
 * ساخت/بازیابی توکن دوره آزمایشی. اگر از قبل شروع شده باشد همان قبلی
 * برمی‌گردد (شروع مجدد با پاک‌کردن مرورگر ممکن نیست — توکن قبلاً صادر شده
 * و باید توسط کلاینت ارسال شود؛ اما تاریخ شروع هرگز جلو نمی‌افتد).
 */
function makeTrialToken(existingToken = null, anchorStartDate = null) {
  const existing = verifyPayload(existingToken);
  if (existing && existing.type === 'trial' && existing.startDate) {
    return existingToken;
  }
  // در نسخه دسکتاپ، تاریخ شروع آزمایشی به تاریخ واقعی نصب گره می‌خورد
  // (گذشته‌ی واقعیِ این دستگاه) تا با نصب مجدد، دوره تمدید نشود.
  const startDate = (anchorStartDate && !isNaN(new Date(anchorStartDate).getTime()))
    ? new Date(anchorStartDate).toISOString()
    : new Date().toISOString();
  return signPayload({ type: 'trial', startDate, iat: Date.now() });
}

/**
 * گیت مجوز سمت سرور برای اندپوینت‌های اصلی (جستجو/رزرو).
 * کاربر واردشده با license_activated → مجاز. کاربر واردشده بدون فعال‌سازی:
 * اگر کاربر فیلد trial معتبر دارد یا توکن مهمان فعال است، مجاز. در غیر این صورت
 * شیء {allowed:false,...} برمی‌گردد تا اندپوینت ۴۰۲/۴۰۳ برگرداند.
 */
function checkAccess({ user, licenseToken = '', trialToken = '', trialDays } = {}) {
  // گیت مجوز فقط وقتی فعال می‌شود که به‌صراحت درخواست شده باشد
  // (BILITFAST_ENFORCE_LICENSE=1)؛ در اجرای محلی/توسعه بدون این متغیر، آزاد است.
  if (!process.env.BILITFAST_ENFORCE_LICENSE) {
    return { allowed: true, reason: 'enforce-disabled' };
  }
  if (user && user.license_activated) return { allowed: true, reason: 'licensed-user' };
  if (isActivated(licenseToken)) return { allowed: true, reason: 'license-token' };
  const st = licenseStatus({ licenseToken: '', trialToken }, trialDays);
  if (user && user.trial && user.trial.startDate) {
    const days = Number.isFinite(trialDays) ? trialDays : 2;
    const start = new Date(user.trial.startDate).getTime();
    if (!isNaN(start) && Date.now() <= start + days * 86400000) {
      return { allowed: true, reason: 'user-trial' };
    }
  }
  if (st.state === 'active') return { allowed: true, reason: 'guest-trial' };
  return { allowed: false, state: st.state, message: st.message || 'دسترسی فعال نیست؛ لطفاً مجوز را فعال کنید.' };
}

module.exports = {
  signPayload,
  checkAccess,
  verifyPayload,
  activationCode,
  isActivationCodeValid,
  isActivated,
  licenseStatus,
  makeLicenseToken,
  makeTrialToken,
};
