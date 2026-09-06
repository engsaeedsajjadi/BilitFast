// -*- coding: utf-8 -*-
/**
 * lib/validation.js — اعتبارسنجی‌های مشترک.
 *
 * نکته: نسخه کلاینت این توابع در public/app.js هم وجود دارد (برای نمایش خطا
 * قبل از ارسال به سرور). این ماژول برای استفاده سمت سرور و تست است.
 */

/**
 * اعتبارسنجی کد ملی ایران (الگوریتم رسمی چک‌دیجیت).
 * - باید ۱۰ رقم باشد
 * - رقم‌های تکراری کامل (مثل 0000000000) نامعتبرند
 * - رقم دهم باید با باقیمانده وزن‌دار رقم‌های اول تا نهم سازگار باشد
 */
function isValidNationalCode(code) {
  const s = String(code == null ? '' : code).trim();
  if (!/^\d{10}$/.test(s)) return false;
  if (/^(\d)\1{9}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(s[i], 10) * (10 - i);
  const r = sum % 11;
  const check = r < 2 ? r : 11 - r;
  return parseInt(s[9], 10) === check;
}

/** اعتبارسنجی شماره همراه ایران (09 شروع شود و ۱۱ رقم باشد). */
function isValidIranMobile(phone) {
  const s = String(phone == null ? '' : phone).trim();
  return /^09\d{9}$/.test(s);
}

module.exports = { isValidNationalCode, isValidIranMobile };
