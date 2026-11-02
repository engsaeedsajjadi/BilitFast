// -*- coding: utf-8 -*-
/**
 * lib/departure.js — تشخیص قطارهایی که ساعت حرکتشان گذشته است.
 *
 * مسئله (3.13.5): در جستجوی «امروز»، سایت گاهی برای قطاری که ساعت حرکتش
 * گذشته هنوز ظرفیت نشان می‌دهد. برنامه آن را «پیدا شد» حساب می‌کرد و جستجو
 * را متوقف می‌کرد، در حالی که آن قطار دیگر قابل رزرو نیست.
 *
 * قاعده:
 *  - فقط وقتی تاریخ حرکت قطار «امروز» (به وقت ایران) است، قطارهایی که ساعت
 *    حرکتشان گذشته کنار گذاشته می‌شوند.
 *  - برای تاریخ‌های بعد از امروز، ساعت فعلی هیچ نقشی ندارد و همه قطارها
 *    مثل قبل بررسی می‌شوند.
 *  - اگر ساعت یا تاریخ ردیف قابل خواندن نباشد، قطار کنار گذاشته نمی‌شود
 *    (هیچ قطار واقعی به‌خاطر داده ناخوانا حذف نمی‌شود).
 *
 * ساعت و تاریخ همیشه به وقت تهران حساب می‌شوند، مستقل از منطقه زمانی سرور.
 */

const jalaali = require('jalaali-js');

const TEHRAN_TZ = 'Asia/Tehran';

function toLatinDigits(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/** تاریخ جلالی و دقیقه‌های گذشته از نیمه‌شب، به وقت تهران. */
function tehranNow(now = new Date()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: TEHRAN_TZ, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(now)) parts[p.type] = p.value;
  const gy = Number(parts.year), gm = Number(parts.month), gd = Number(parts.day);
  const j = jalaali.toJalaali(gy, gm, gd);
  return { jy: j.jy, jm: j.jm, jd: j.jd, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** خواندن تاریخ جلالی «۱۴۰۵/۸/۱۱» یا «1405-08-11» از متن؛ نامعتبر → null. */
function parseJalaliDate(text) {
  const m = toLatinDigits(text).match(/(1[34]\d{2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})/);
  if (!m) return null;
  const jy = Number(m[1]), jm = Number(m[2]), jd = Number(m[3]);
  return jalaali.isValidJalaaliDate(jy, jm, jd) ? { jy, jm, jd } : null;
}

/** خواندن ساعت «۱۴:۳۰» یا «8:05» به دقیقه؛ نامعتبر → null. */
function parseTimeMinutes(text) {
  const m = toLatinDigits(text).match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function sameDay(a, b) {
  return !!a && !!b && a.jy === b.jy && a.jm === b.jm && a.jd === b.jd;
}

/**
 * آیا این قطار امروز است و ساعت حرکتش گذشته؟
 * @param {object} p
 * @param {string} p.timeText    ساعت حرکت از ردیف نتیجه
 * @param {string} [p.rowDate]   تاریخ حرکت از ردیف نتیجه (در صورت وجود اولویت دارد)
 * @param {string} [p.searchDate] تاریخ جستجو (جایگزین وقتی تاریخ ردیف خوانا نیست)
 * @param {Date}   [p.now]
 * @param {number} [p.bufferMinutes] قطارهایی که کمتر از این مقدار تا حرکتشان
 *                                   مانده هم «گذشته» حساب می‌شوند (پیش‌فرض ۰)
 */
function hasDeparted({ timeText, rowDate, searchDate, now = new Date(), bufferMinutes = 0 }) {
  const trainDay = parseJalaliDate(rowDate) || parseJalaliDate(searchDate);
  if (!trainDay) return false;
  const t = tehranNow(now);
  if (!sameDay(trainDay, t)) return false; // future (or past) dates: never filtered by clock
  const dep = parseTimeMinutes(timeText);
  if (dep === null) return false;
  const buffer = Math.max(0, Number(bufferMinutes) || 0);
  return dep <= t.minutes + buffer;
}

module.exports = { tehranNow, parseJalaliDate, parseTimeMinutes, hasDeparted, TEHRAN_TZ };
