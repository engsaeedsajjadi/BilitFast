// lib/rateplan.js — منطق خالص «نرخ تطبیقی جستجو» برای پایش همزمان مسیرها.
// نسخه کلاینت همین فرمول در public/app.js است؛ این ماژول برای تست و استفاده
// سمت سرور نگهداری می‌شود.

const MAX_CONCURRENT_MONITORS = 5;

/* کف مطلق فاصله بین دو *شروع* درخواست، برای یک مسیر.
 * مرجع: برنامه دسکتاپ اصلی (BilitFast.py) که روی سایت واقعی صفیر ریل کار
 * می‌کرد، در DynamicRateLimiter مقدار base_interval = 0.5 ثانیه داشت و
 * فاصله را «از شروع درخواست قبلی» می‌سنجید. ما محافظه‌کارانه‌تر عمل کرده و
 * کف را ۱ ثانیه گذاشته‌ایم. */
const MIN_GAP_MS = 1000;

/**
 * فاصله‌ای که پس از *پایان* یک درخواست باید صبر کنیم.
 *
 * نکته کلیدی (و باگی که قبلاً وجود داشت): فاصله باید از **شروع** درخواست
 * قبلی تا شروع درخواست بعدی سنجیده شود، نه از پایان آن. برنامه دسکتاپ اصلی
 * دقیقاً همین کار را می‌کرد (elapsed = now - last_request_time).
 *
 * قبلاً نسخه وب کل فاصله پایه را *بعد از* دریافت پاسخ صبر می‌کرد، پس وقتی
 * سامانه کند بود (مثلاً ۹.۵ ثانیه) فاصله واقعی بین دو جستجو به ۱۲.۵ ثانیه
 * می‌رسید — یعنی هرچه سایت شلوغ‌تر، جستجوی ما کندتر؛ دقیقاً برعکس چیزی که
 * لازم است. حالا زمان سپری‌شده کسر می‌شود.
 *
 * @param {number} baseMs فاصله هدف بین دو شروع درخواست، برای یک مسیر
 * @param {number} activeCount تعداد مسیرهای فعال (شامل خود مسیر)
 * @param {number} [rnd] عدد تصادفی ۰..۱ (برای تست، مقدار ثابت بدهید)
 * @param {number} [elapsedMs] مدت‌زمانی که درخواست قبلی طول کشیده است
 */
function monitorIntervalMs(baseMs, activeCount, rnd, elapsedMs) {
  const n = Math.min(Math.max(1, activeCount || 1), MAX_CONCURRENT_MONITORS);
  const r = (rnd === undefined) ? Math.random() : rnd;
  const target = (baseMs || 3000) * n;
  const jitter = Math.round(target * 0.3 * (r - 0.5));
  // زمانی که خود درخواست مصرف کرده، بخشی از فاصله محسوب می‌شود.
  const spent = Math.max(0, elapsedMs || 0);
  const wait = target + jitter - spent;
  return Math.max(MIN_GAP_MS * n, wait);
}

module.exports = { monitorIntervalMs, MAX_CONCURRENT_MONITORS, MIN_GAP_MS };
