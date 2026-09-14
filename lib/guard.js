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

/**
 * استخراج آی‌پی کلاینت. نکته امنیتی: هدر X-Forwarded-For را کاربر می‌تواند
 * جعل کند و با آن محدودسازی نرخ را دور بزند. بنابراین:
 *  - آی‌پی واقعی سوکت مبناست؛
 *  - XFF فقط وقتی معتبر است که اتصال از یک پروکسی محلی/خصوصی برقرار شده باشد
 *    (یعنی واقعاً پشت reverse proxy خودمان هستیم).
 */
function getClientIp(req) {
  try {
    const headers = req.headers || {};
    /* نکته امنیتی: هدر x-vercel-forwarded-for حذف شد. وقتی برنامه پشت لبه
     * Vercel اجرا می‌شد، آن هدر را خود Vercel می‌گذاشت و قابل اعتماد بود.
     * حالا که روی سرور خودمان اجرا می‌شود چنین لبه‌ای وجود ندارد، پس هر
     * کسی می‌توانست آن را جعل کند و با آی‌پی ساختگی محدودیت نرخ را دور
     * بزند. حالا فقط آی‌پی واقعی سوکت و XFF پشت پروکسی محلی معتبرند. */
    const socketIp = (req.socket && req.socket.remoteAddress) || '';
    if (socketIp && !/^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(socketIp)) {
      return socketIp; // اتصال مستقیم از کلاینت عمومی
    }
    // پشت پروکسی محلی مطمئن → اولین آی‌پی لیست XFF کلاینت واقعی است
    const xf = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
    if (xf) {
      const first = String(xf).split(',')[0].trim();
      if (first) return first;
    }
    if (socketIp) return socketIp;
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

/* ---------------- قفل موقت پس از تلاش‌های ناموفق ورود ---------------- */

/**
 * محدودسازی نرخ بر اساس آی‌پی به‌تنهایی جلوی حمله جستجوی فراگیر گذرواژه را
 * نمی‌گیرد: مهاجم با botnet از صدها آی‌پی همان یک حساب را هدف می‌گیرد. پس
 * علاوه بر آی‌پی، روی خودِ «نام کاربری» هم می‌شماریم.
 *
 * تعمداً فقط قفل موقت می‌گذاریم و حساب را دائمی نمی‌بندیم — وگرنه مهاجم
 * می‌تواند با تلاش عمدی ناموفق، کاربر واقعی را از سیستم بیرون نگه دارد
 * (حمله محرومیت از سرویس روی حساب).
 */
const failures = new Map();
const LOCK_THRESHOLD = 8;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_DURATION_MS = 10 * 60 * 1000;

function loginKey(username) {
  return 'login:' + String(username || '').trim().toLowerCase();
}

/** آیا این حساب هم‌اکنون قفل موقت است؟ */
function isLockedOut(username, now = Date.now()) {
  const rec = failures.get(loginKey(username));
  if (!rec) return { locked: false };
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { locked: true, retryInMs: rec.lockedUntil - now };
  }
  return { locked: false };
}

/** ثبت یک تلاش ناموفق؛ در صورت عبور از حد، قفل موقت فعال می‌شود. */
function recordLoginFailure(username, now = Date.now()) {
  const key = loginKey(username);
  let rec = failures.get(key);
  if (!rec || now > rec.reset) {
    rec = { count: 0, reset: now + LOCK_WINDOW_MS, lockedUntil: 0 };
    failures.set(key, rec);
  }
  rec.count += 1;
  if (rec.count >= LOCK_THRESHOLD) {
    rec.lockedUntil = now + LOCK_DURATION_MS;
    rec.count = 0;
  }
  return rec;
}

/** ورود موفق، شمارنده را پاک می‌کند. */
function clearLoginFailures(username) {
  failures.delete(loginKey(username));
}

/** نظافت دوره‌ای شمارنده‌های منقضی (جلوگیری از رشد حافظه). */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
function sweepExpired(now = Date.now()) {
  for (const [k, b] of buckets) {
    if (now > b.reset) buckets.delete(k);
  }
  for (const [k, r] of failures) {
    if (now > r.reset && now > (r.lockedUntil || 0)) failures.delete(k);
  }
}
try {
  const t = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
  if (t && typeof t.unref === 'function') t.unref();
} catch (e) { /* ignore */ }

module.exports = {
  guardApi, checkRate, getClientIp, sweepExpired,
  isLockedOut, recordLoginFailure, clearLoginFailures,
  LOCK_THRESHOLD, LOCK_DURATION_MS,
};
