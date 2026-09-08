// lib/http.js — لایه شبکه بهینه برای ارتباط با صفیر ریل.
//
// چرا؟ پیش‌تر هر درخواست با fetch پیش‌فرض Node ساخته می‌شد؛ یعنی برای هر
// جستجو یک اتصال TCP تازه + دست‌دادن کامل TLS (۲ تا ۳ رفت‌وبرگشت) انجام
// می‌شد. روی اینترنت ایران هر رفت‌وبرگشت می‌تواند ۱۵۰ تا ۴۰۰ میلی‌ثانیه باشد،
// پس فقط برقراری اتصال ۰.۵ تا ۱.۵ ثانیه از هر تلاش را می‌خورد.
//
// این ماژول یک Agent مشترک با این ویژگی‌ها می‌سازد:
//   - keep-alive: اتصال TCP/TLS بین درخواست‌ها زنده می‌ماند (دست‌دادن فقط یک بار)
//   - pipelining: چند درخواست روی یک اتصال
//   - نشست TLS بازاستفاده می‌شود (TLS session resumption توسط undici)
//   - فشرده‌سازی gzip/deflate/br (صفحه نتایج صفیر بزرگ است؛ حجم چند برابر کم می‌شود)
//   - تایم‌اوت‌های جداگانه برای هدر و بدنه تا درخواست‌های گیرکرده زود رها شوند
//
// اگر undici در دسترس نباشد، بی‌صدا به fetch پیش‌فرض برمی‌گردیم (بدون شکست).

let dispatcher = null;
let undiciFetch = null;

function initDispatcher() {
  if (dispatcher !== null) return dispatcher;
  try {
    const { Agent, fetch: uFetch } = require('undici');
    dispatcher = new Agent({
      // اتصال‌ها را تا ۶۰ ثانیه زنده نگه دار (سرور معمولاً زودتر می‌بندد؛ undici رعایت می‌کند)
      keepAliveTimeout: 60000,
      keepAliveMaxTimeout: 120000,
      // چند اتصال موازی به همان میزبان (برای پایش چند مسیر همزمان)
      connections: 8,
      pipelining: 1,
      // زمان انتظار برای رسیدن هدرها و بدنه
      headersTimeout: 20000,
      bodyTimeout: 25000,
      connect: {
        // بازاستفاده از نشست TLS → دست‌دادن کوتاه‌تر در درخواست‌های بعدی
        maxCachedSessions: 100,
        timeout: 10000,
      },
    });
    undiciFetch = uFetch;
  } catch (e) {
    dispatcher = false; // undici نصب نیست → fetch پیش‌فرض
  }
  return dispatcher;
}

/** هدرهای پیش‌فرضی که سرعت را بالا می‌برند (فشرده‌سازی + اتصال پایدار). */
function perfHeaders(headers = {}) {
  const h = { ...headers };
  const has = (name) => Object.keys(h).some((k) => k.toLowerCase() === name);
  if (!has('accept-encoding')) h['Accept-Encoding'] = 'gzip, deflate, br';
  if (!has('connection')) h['Connection'] = 'keep-alive';
  return h;
}

/**
 * fetch بهینه‌شده برای صفیر ریل: keep-alive + فشرده‌سازی + تایم‌اوت.
 * امضای آن دقیقاً مثل fetch استاندارد است، پس جایگزینی بی‌خطر است.
 */
async function safirFetch(url, options = {}) {
  const agent = initDispatcher();
  const opts = { ...options, headers: perfHeaders(options.headers || {}) };
  if (agent && undiciFetch) {
    opts.dispatcher = agent;
    return undiciFetch(url, opts);
  }
  return fetch(url, opts);
}

/** بستن اتصال‌های باز (هنگام خاموش شدن برنامه). */
async function closeHttp() {
  if (dispatcher && typeof dispatcher.close === 'function') {
    try { await dispatcher.close(); } catch (e) { /* ignore */ }
  }
  dispatcher = null;
}

/**
 * گرم‌کردن اتصال: قبل از شروع جستجو یک درخواست سبک می‌فرستیم تا اتصال TCP/TLS
 * از قبل برقرار باشد و اولین جستجوی واقعی، تأخیر دست‌دادن را نداشته باشد.
 */
async function warmUp(baseUrl) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    await safirFetch(baseUrl + '/etrain/index.php', {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(t);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { safirFetch, perfHeaders, closeHttp, warmUp };
