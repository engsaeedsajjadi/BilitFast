// -*- coding: utf-8 -*-
/**
 * lib/cookie-trace.js — ثبت گام‌به‌گام هر تلاش انتقال کوکی.
 *
 * چرا لازم شد: کاربر می‌گفت دکمه‌های انتقال کوکی کار نمی‌کنند، ولی هیچ‌کدام
 * نمی‌گفتند «کجا» شکست خوردند. زنجیره چند حلقه دارد — پیدا کردن پروفایل
 * مرورگر، باز کردن فایل، رمزگشایی، فیلتر دامنه، وجود PHPSESSID، ذخیره در
 * مرورگر — و شکست هر حلقه از بیرون یک‌شکل دیده می‌شود.
 *
 * این ماژول یک دفترچه گردشی نگه می‌دارد که هر گام را با زمان، نتیجه و علت
 * ثبت می‌کند تا بشود دقیقاً دید زنجیره کجا پاره شده.
 *
 * حریم خصوصی: هرگز مقدار کوکی ثبت نمی‌شود — فقط نام کوکی، تعداد، و طول
 * مقدار. مسیرهای فایل هم کوتاه می‌شوند تا نام کاربری سیستم لو نرود.
 */

const MAX_ENTRIES = 300;
const entries = [];
let seq = 0;

/** کوتاه کردن مسیر تا نام کاربری و ساختار دیسک افشا نشود. */
function safePath(p) {
  if (!p) return '';
  const s = String(p);
  const parts = s.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return s;
  return '…/' + parts.slice(-3).join('/');
}

/** فقط نام کوکی‌ها (بدون مقدار) برای تشخیص اینکه چه چیزی پیدا شده. */
function cookieNames(list) {
  if (!Array.isArray(list)) return [];
  return list.map((c) => String(c).split('=')[0]).slice(0, 40);
}

/**
 * ثبت یک گام.
 * @param {string} scope کدام مسیر (firefox / chrome / connect / sync ...)
 * @param {string} step  چه اتفاقی افتاد
 * @param {object} data  جزئیات غیرحساس
 */
function log(scope, step, data) {
  entries.push({
    n: ++seq,
    at: Date.now(),
    scope: String(scope || '-'),
    step: String(step || '-'),
    ...(data && typeof data === 'object' ? data : {}),
  });
  while (entries.length > MAX_ENTRIES) entries.shift();
}

/** ثبت خطا به‌صورت خوانا (بدون stack trace طولانی). */
function logError(scope, step, err) {
  log(scope, step, {
    ok: false,
    error: (err && err.message) || String(err),
    code: (err && err.code) || undefined,
  });
}

/** خواندن دفترچه (تازه‌ترین در انتها). */
function getEntries() {
  return entries.slice();
}

/** پاک کردن دفترچه — برای شروع یک تشخیص تمیز. */
function clear() {
  entries.length = 0;
  seq = 0;
}

module.exports = { log, logError, getEntries, clear, safePath, cookieNames };
