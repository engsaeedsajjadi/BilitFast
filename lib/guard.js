// -*- coding: utf-8 -*-
/**
 * lib/guard.js — محافظ ساده برای توابع API: محدودسازی نرخ (rate limit).
 *
 * پیاده‌سازی درون‌حافظه‌ای (بدون وابستگی خارجی). روی محیط‌های سرورلس چند
 * نمونه‌ای (مثل چند اینستنس هم‌زمان)، هر نمونه شمارنده خودش را دارد؛ برای
 * محصول تجاری با ترافیک بالا بهتر است از یک استور مشترک (مثل Upstash/Redis)
 * استفاده شود — اما حتی همین نسخه هم جلوی سوءاستفاده ساده از استقرار عمومی
 * را می‌گیرد (نسخه قبلی هیچ محافظی نداشت).
 */

const buckets = new Map();

/** استخراج آی‌پی کلاینت (سازگار با پروکسی‌های Vercel و سرور محلی). */
function getClientIp(req) {
  try {
    const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
    if (xf) return String(xf).split(',')[0].trim();
    if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  } catch (e) { /* ignore */ }
  return 'unknown';
}

/** شمارش درخواست در پنجره زمانی؛ آیا هنوز مجاز است؟ */
function checkRate(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit;
}

/**
 * اعمال محدودسازی روی یک درخواست. در صورت عبور از حد، پاسخ 429 می‌فرستد و
 * «false» برمی‌گرداند (هندلر باید فوراً برگردد).
 * @param {object} req درخواست
 * @param {object} res پاسخ
 * @param {{name:string, limit?:number, windowMs?:number}} opts نام/حد/پنجره
 */
function guardApi(req, res, opts) {
  const { name, limit = 120, windowMs = 60000 } = opts || {};
  const ip = getClientIp(req);
  if (!checkRate(name + ':' + ip, limit, windowMs)) {
    res.status(429).json({
      ok: false,
      error: 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً چند لحظه صبر کنید و دوباره تلاش کنید.',
    });
    return false;
  }
  return true;
}

/** نظافت دوره‌ای شمارنده‌های منقضی (جلوگیری از رشد حافظه). */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
function sweepExpired(now = Date.now()) {
  for (const [k, b] of buckets) {
    if (now > b.reset) buckets.delete(k);
  }
}
try {
  const t = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
  if (t && typeof t.unref === 'function') t.unref();
} catch (e) { /* ignore */ }

module.exports = { guardApi, checkRate, getClientIp, sweepExpired };
