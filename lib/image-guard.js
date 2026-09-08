// -*- coding: utf-8 -*-
/**
 * lib/image-guard.js — اعتبارسنجی تصویر پیش از تحویل به Jimp.
 *
 * پس‌زمینه امنیتی:
 * `npm audit` چهار مورد moderate روی زنجیره jimp → @jimp/core → file-type
 * گزارش می‌کند (GHSA-5v7r-6r5c-r473): پارسر ASF در file-type می‌تواند با
 * ورودی خراب (زیرهدر با اندازه صفر) وارد حلقه بی‌نهایت شود و پردازش را
 * قفل کند. ارتقا به jimp 1.6.1 یک تغییر عمده (breaking) در API است و کل
 * زنجیره OCR را می‌شکند، بنابراین به‌جای ارتقای عجولانه، جلوی *ورودی*
 * آسیب‌زا گرفته می‌شود:
 *
 *   ۱) فقط قالب‌های تصویری واقعیِ مورد نیاز کپچا پذیرفته می‌شوند
 *      (PNG, JPEG, GIF, BMP) — با بررسی «امضای بایتی» (magic bytes)، نه
 *      پسوند یا Content-Type که قابل جعل‌اند.
 *   ۲) ASF/WMV و هر قالب دیگری اصلاً به file-type نمی‌رسد، پس مسیر
 *      آسیب‌پذیر هرگز اجرا نمی‌شود.
 *   ۳) سقف اندازه: بافرهای بسیار بزرگ رد می‌شوند (منع مصرف حافظه).
 *   ۴) حداقل اندازه: بافرهای بریده/ناقص رد می‌شوند.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // ۸ مگابایت — کپچا همیشه بسیار کوچک‌تر است
const MIN_IMAGE_BYTES = 24;

/** امضاهای بایتی قالب‌های مجاز. */
const SIGNATURES = [
  { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { name: 'gif87a', bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { name: 'gif89a', bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { name: 'bmp', bytes: [0x42, 0x4d] },
];

function matches(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

/** تشخیص قالب از روی امضای بایتی؛ null یعنی قالب مجاز نیست. */
function detectFormat(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  for (const sig of SIGNATURES) {
    if (matches(buffer, sig.bytes)) return sig.name.replace(/8[79]a$/, '');
  }
  return null;
}

/**
 * بررسی امن بودن بافر تصویر.
 * @returns {{ok: boolean, format?: string, error?: string}}
 */
function inspectImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return { ok: false, error: 'داده تصویر معتبر نیست.' };
  }
  if (buffer.length < MIN_IMAGE_BYTES) {
    return { ok: false, error: 'تصویر ناقص یا خیلی کوچک است.' };
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'حجم تصویر بیش از حد مجاز است (بیشتر از ۸ مگابایت).' };
  }
  const format = detectFormat(buffer);
  if (!format) {
    return {
      ok: false,
      error: 'قالب تصویر پشتیبانی نمی‌شود. فقط PNG، JPEG، GIF و BMP پذیرفته می‌شوند.',
    };
  }
  return { ok: true, format };
}

/**
 * اعتبارسنجی و پرتاب خطا در صورت نامعتبر بودن (برای مسیرهایی که باید متوقف شوند).
 */
function assertSafeImage(buffer) {
  const r = inspectImageBuffer(buffer);
  if (!r.ok) throw new Error(r.error);
  return r.format;
}

module.exports = {
  inspectImageBuffer, assertSafeImage, detectFormat,
  MAX_IMAGE_BYTES, MIN_IMAGE_BYTES,
};
