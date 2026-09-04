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
const { getRequiredEnv } = require('./http');

const DEFAULT_DEV_LICENSE_KEY = 'bilitfast-license-dev-only-key';

function licenseKey() {
  return getRequiredEnv('BILITFAST_LICENSE_KEY', { devFallback: DEFAULT_DEV_LICENSE_KEY });
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

/** کد فعال‌سازی محصول (فقط از متغیر محیطی). */
function activationCode() {
  return (process.env.BILITFAST_ACTIVATION_CODE || '').trim();
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
function makeTrialToken(existingToken = null) {
  const existing = verifyPayload(existingToken);
  if (existing && existing.type === 'trial' && existing.startDate) {
    return existingToken;
  }
  return signPayload({ type: 'trial', startDate: new Date().toISOString(), iat: Date.now() });
}

const CAPTCHA_LEARN_TTL_MS = 15 * 60 * 1000;

function makeCaptchaLearnToken({ workflow_id, captcha_text, image_hash, proof_id, ttlMs = CAPTCHA_LEARN_TTL_MS }) {
  return signPayload({
    type: 'captcha_learn',
    workflow_id: String(workflow_id || ''),
    captcha_text: String(captcha_text || '').trim(),
    image_hash: String(image_hash || '').trim(),
    proof_id: String(proof_id || '').trim(),
    iat: Date.now(),
    exp: Date.now() + ttlMs,
  });
}

function verifyCaptchaLearnToken(token) {
  const o = verifyPayload(token);
  if (!o || o.type !== 'captcha_learn' || !o.captcha_text || !o.image_hash || !o.proof_id) return null;
  if (o.exp && Date.now() > o.exp) return null;
  return o;
}

module.exports = {
  signPayload,
  verifyPayload,
  activationCode,
  isActivated,
  licenseStatus,
  makeLicenseToken,
  makeTrialToken,
  makeCaptchaLearnToken,
  verifyCaptchaLearnToken,
  CAPTCHA_LEARN_TTL_MS,
};
