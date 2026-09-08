// -*- coding: utf-8 -*-
/**
 * lib/secrets.js — مدیریت متمرکز کلیدهای رمزنگاری، با رفتار fail-closed.
 *
 * چرا این ماژول؟
 * پیش‌تر هر بخش برنامه کلید خودش را مستقیماً از متغیر محیطی می‌خواند و اگر
 * تنظیم نبود، به یک «کلید پیش‌فرض توسعه» برمی‌گشت. چون کد برنامه در دسترس
 * است، آن کلید پیش‌فرض عملاً عمومی است و در محیط تولید یعنی هر کسی می‌تواند
 * توکن نشست جعل کند و به حساب دیگران وارد شود.
 *
 * قواعد این ماژول:
 *   ۱) در محیط تولید (NODE_ENV=production یا BILITFAST_ENFORCE_SECURITY=1)
 *      نبودِ کلید یک خطای مرگبار است — سرویس بالا نمی‌آید (fail-closed).
 *   ۲) کلیدها از هم جدا هستند: کلید نشست، کلید لایسنس، کلید توکن وضعیت و
 *      کلید نشانه نصب هرکدام مستقل‌اند. لو رفتن یکی، بقیه را لو نمی‌دهد.
 *   ۳) اگر فقط یک کلید ریشه (BILITFAST_MASTER_KEY) داده شود، بقیه کلیدها با
 *      HKDF از آن مشتق می‌شوند — پس مدیر سیستم می‌تواند یک کلید تنظیم کند
 *      ولی همچنان کلیدهای واقعی از هم جدا بمانند.
 *   ۴) در توسعه محلی، کلید تصادفی «هر بار اجرا» ساخته می‌شود (نه یک ثابت
 *      قابل حدس). عارضه‌اش این است که با ری‌استارت، نشست‌ها باطل می‌شوند —
 *      که برای توسعه پذیرفتنی و از نظر امنیتی درست است.
 */

const crypto = require('crypto');

/** آیا در حالت سخت‌گیرانه (تولید) هستیم؟ */
function isProduction() {
  if (process.env.BILITFAST_ENFORCE_SECURITY === '1') return true;
  if (process.env.BILITFAST_ENFORCE_SECURITY === '0') return false;
  return process.env.NODE_ENV === 'production';
}

// کلیدهای تصادفیِ مخصوص همین اجرا (فقط برای توسعه محلی)
const ephemeral = new Map();
function ephemeralKey(purpose) {
  if (!ephemeral.has(purpose)) {
    ephemeral.set(purpose, crypto.randomBytes(32));
  }
  return ephemeral.get(purpose);
}

/** مشتق‌سازی کلید اختصاصی هر کاربرد از کلید ریشه (جداسازی دامنه). */
function derive(masterRaw, purpose) {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(masterRaw, 'utf8'), Buffer.alloc(0), 'bilitfast:' + purpose, 32),
  );
}

/**
 * گرفتن کلید یک کاربرد مشخص.
 * @param {string} purpose نام کاربرد: session | license | state | install
 * @param {string[]} envNames متغیرهای محیطی مخصوص همان کاربرد (به ترتیب اولویت)
 * @returns {Buffer} کلید ۳۲ بایتی
 */
function keyFor(purpose, envNames) {
  // ۱) کلید اختصاصی همان کاربرد
  for (const name of envNames) {
    const v = process.env[name];
    if (v && String(v).trim().length >= 16) {
      const t = String(v).trim();
      // اگر ۶۴ کاراکتر هگز بود، همان بایت‌ها؛ وگرنه هش می‌شود
      if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
      return crypto.createHash('sha256').update(t).digest();
    }
  }

  // ۲) کلید ریشه مشترک → مشتق‌سازی کلید جدا برای این کاربرد
  const master = process.env.BILITFAST_MASTER_KEY;
  if (master && String(master).trim().length >= 16) {
    return derive(String(master).trim(), purpose);
  }

  // ۳) در تولید: توقف کامل (fail-closed)
  if (isProduction()) {
    throw new Error(
      'کلید امنیتی «' + purpose + '» تنظیم نشده است. ' +
      'در محیط تولید باید یکی از متغیرهای ' + envNames.join(' یا ') +
      ' (یا BILITFAST_MASTER_KEY) تنظیم شود. ' +
      'ساخت کلید: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  // ۴) توسعه محلی: کلید تصادفی این اجرا — قابل حدس نیست
  return ephemeralKey(purpose);
}

/** کلید امضای توکن نشست کاربر (جدا از کلید لایسنس). */
function sessionKey() {
  return keyFor('session', ['BILITFAST_SESSION_KEY']);
}

/** کلید امضای توکن‌های مجوز/دوره آزمایشی. */
function licenseKey() {
  return keyFor('license', ['BILITFAST_LICENSE_KEY']);
}

/** کلید رمزنگاری توکن وضعیت رزرو (AES-256-GCM). */
function stateKey() {
  return keyFor('state', ['BILITFAST_TOKEN_KEY']);
}

/** کلید امضای نشانه نصب دسکتاپ. */
function installKey() {
  return keyFor('install', ['BILITFAST_INSTALL_KEY']);
}

/**
 * بررسی سلامت پیکربندی امنیتی هنگام بالا آمدن سرور.
 * در تولید، نبود هر کلید باعث پرتاب خطا (توقف سرویس) می‌شود.
 */
function assertSecureConfig() {
  const problems = [];
  const checks = [
    ['نشست کاربران', sessionKey],
    ['مجوز/لایسنس', licenseKey],
    ['توکن وضعیت رزرو', stateKey],
  ];
  for (const [label, fn] of checks) {
    try { fn(); } catch (e) { problems.push(label + ': ' + e.message); }
  }
  if (problems.length) {
    throw new Error('پیکربندی امنیتی ناقص است:\n - ' + problems.join('\n - '));
  }
  return true;
}

/** آیا کلیدها واقعی هستند (نه کلید موقت توسعه)؟ */
function usingEphemeralKeys() {
  return !isProduction() && ephemeral.size > 0;
}

module.exports = {
  isProduction, sessionKey, licenseKey, stateKey, installKey,
  assertSecureConfig, usingEphemeralKeys, keyFor,
};
