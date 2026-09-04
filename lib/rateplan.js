// lib/rateplan.js — منطق خالص «نرخ تطبیقی جستجو» برای پایش همزمان مسیرها.
// نسخه کلاینت همین فرمول در public/app.js است؛ این ماژول برای تست و استفاده
// سمت سرور نگهداری می‌شود.

const MAX_CONCURRENT_MONITORS = 5;

/**
 * فاصله بین درخواست‌های جستجو بر اساس تعداد مسیرهای فعال.
 * فرمول: فاصله پایه × تعداد مسیرها (سقف ۵) + جیتر ±۱۵٪ — یعنی نرخ مجموع
 * درخواست‌ها به سایت تقریباً ثابت می‌ماند و با اضافه‌شدن هر مسیر، فاصلهٔ
 * درخواست‌های هر مسیر به همان نسبت زیاد می‌شود.
 *
 * @param {number} baseMs فاصله پایه (میلی‌ثانیه) برای یک مسیر
 * @param {number} activeCount تعداد مسیرهای فعال (شامل خود مسیر)
 * @param {number} [rnd] عدد تصادفی ۰..۱ (برای تست، مقدار ثابت بدهید)
 */
function monitorIntervalMs(baseMs, activeCount, rnd) {
  const n = Math.min(Math.max(1, activeCount || 1), MAX_CONCURRENT_MONITORS);
  const r = (rnd === undefined) ? Math.random() : rnd;
  const interval = (baseMs || 3000) * n;
  const jitter = Math.round(interval * 0.3 * (r - 0.5));
  return Math.max(1500, interval + jitter);
}

module.exports = { monitorIntervalMs, MAX_CONCURRENT_MONITORS };
