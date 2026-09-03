// -*- coding: utf-8 -*-
/**
 * lib/token.js — توکن وضعیت رزرو: رمزنگاری + اصالت‌سنجی + انقضا.
 *
 * توکن وضعیت (stateToken) بین مراحل رزرو رفت‌وبرگشت می‌شود و شامل کوکی سشن
 * صفیر ریل و اطلاعات مسافران است. نسخه قبلی فقط base64 بود (قابل خواندن و
 * دستکاری). اکنون:
 *   - AES-256-GCM (رمزنگاری + اصالت‌سنجی یکپارچه)
 *   - انقضای زمانی (پیش‌فرض ۳۰ دقیقه)
 *
 * کلید از متغیر محیطی BILITFAST_TOKEN_KEY خوانده می‌شود (۶۴ کاراکتر هگز).
 * ساخت کلید:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * ⚠️ برای استقرار تجاری حتماً کلید واقعی تنظیم شود؛ کلید پیش‌فرض فقط برای
 * توسعه محلی است و در محیط تولید ناامن محسوب می‌شود.
 */

const crypto = require('crypto');

const DEFAULT_DEV_KEY = 'bilitfast-dev-only-key-DO-NOT-USE-IN-PRODUCTION';
const STATE_TTL_MS = 30 * 60 * 1000; // ۳۰ دقیقه اعتبار برای هر توکن وضعیت

function getKey() {
  const hex = process.env.BILITFAST_TOKEN_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    return Buffer.from(hex.trim(), 'hex');
  }
  // فقط برای توسعه محلی — در تولید باید متغیر محیطی تنظیم شود
  return crypto.createHash('sha256').update(DEFAULT_DEV_KEY).digest();
}

/**
 * رمزنگاری یک شیء وضعیت به توکن کوتاه (base64url).
 * @param {object} obj وضعیت رزرو
 * @param {number} ttlMs اعتبار توکن برحسب میلی‌ثانیه
 */
function encryptState(obj, ttlMs = STATE_TTL_MS) {
  const payload = JSON.stringify({ ...obj, _exp: Date.now() + ttlMs });
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

/**
 * بازکردن توکن وضعیت. در هر یک از این حالت‌ها «null» برمی‌گردد:
 * قالب نامعتبر، دستکاری/رمزنگاری اشتباه، یا منقضی‌بودن.
 */
function decryptState(token) {
  try {
    const raw = Buffer.from(String(token || ''), 'base64url');
    if (raw.length < 29) return null; // iv(12) + tag(16) + حداقل ۱ بایت داده
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    const payload = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    const obj = JSON.parse(payload);
    if (!obj || typeof obj !== 'object') return null;
    if (obj._exp && Date.now() > obj._exp) return null;
    const out = { ...obj };
    delete out._exp;
    return out;
  } catch (e) {
    return null;
  }
}

module.exports = { encryptState, decryptState, STATE_TTL_MS };
