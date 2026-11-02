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
 * آیا سوکت واقعاً از همین دستگاه (loopback) است؟
 * فقط آدرس سوکت بررسی می‌شود، نه هیچ هدری؛ پس با جعل X-Forwarded-For
 * قابل دورزدن نیست. برای تصمیم‌های «فقط محلی» همیشه از این تابع استفاده
 * کنید، نه از getClientIp.
 */
function isLoopbackSocket(req) {
  const ip = String((req && req.socket && req.socket.remoteAddress) || '');
  if (!/^(127\.|::1$|::ffff:127\.)/.test(ip)) return false;
  // پشت پروکسی معکوس، سوکت همیشه loopback/خصوصی است ولی کلاینت واقعی
  // راه دور است؛ وجود هدرهای پروکسی یعنی درخواست محلی نیست.
  const h = (req && req.headers) || {};
  if (h['x-forwarded-for'] || h['x-real-ip'] || h['forwarded']) return false;
  return true;
}

/** آیا هدرهای پروکسی معتبرند؟ فقط با تنظیم صریح BILITFAST_TRUST_PROXY=1. */
function trustProxy() {
  return /^(1|true|yes|on)$/i.test(String(process.env.BILITFAST_TRUST_PROXY || ''));
}

/**
 * استخراج آی‌پی کلاینت برای محدودسازی نرخ.
 *
 * نکته امنیتی (3.13.4): قبلاً XFF از هر سوکت خصوصی پذیرفته و «اولین» مقدار
 * آن برداشته می‌شد؛ پشت nginx با proxy_add_x_forwarded_for یا با پورت 3000
 * باز، کاربر می‌توانست 127.0.0.1 جعل کند. اکنون:
 *  - XFF فقط وقتی BILITFAST_TRUST_PROXY=1 باشد خوانده می‌شود؛
 *  - «آخرین» مقدار برداشته می‌شود (همان که پروکسی خودمان افزوده است).
 */
function getClientIp(req) {
  try {
    const headers = (req && req.headers) || {};
    const socketIp = (req && req.socket && req.socket.remoteAddress) || '';
    if (trustProxy()) {
      const xf = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
      if (xf) {
        const parts = String(xf).split(',').map((x) => x.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
      }
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

/* 3.13.4: قفل فقط بر اساس نام کاربری باعث می‌شد هر کسی با ۸ تلاش اشتباه،
 * مالک تنها را مدام بیرون نگه دارد. اکنون دو شمارنده داریم:
 *  - (نام کاربری + آی‌پی): آستانه LOCK_THRESHOLD — جلوی حدس از یک منبع؛
 *  - فقط نام کاربری: آستانه بسیار بالاتر GLOBAL_LOCK_THRESHOLD — جلوی botnet
 *    بدون اینکه چند تلاش اشتباه، مالک را قفل کند. */
const GLOBAL_LOCK_THRESHOLD = 100;
function loginKey(username, ip) {
  const u = String(username || '').trim().toLowerCase();
  return ip === undefined ? 'login:' + u : 'login:' + u + '|' + String(ip);
}

/** آیا این حساب هم‌اکنون قفل موقت است؟ */
function isLockedOut(username, now = Date.now(), ip) {
  if (typeof now !== 'number') { ip = now; now = Date.now(); }
  const keys = [loginKey(username)];
  if (ip !== undefined) keys.push(loginKey(username, ip));
  for (const k of keys) {
    const rec = failures.get(k);
    if (rec && rec.lockedUntil && now < rec.lockedUntil) {
      return { locked: true, retryInMs: rec.lockedUntil - now };
    }
  }
  return { locked: false };
}

/** ثبت یک تلاش ناموفق؛ در صورت عبور از حد، قفل موقت فعال می‌شود. */
function bump(key, threshold, now) {
  let rec = failures.get(key);
  if (!rec || now > rec.reset) {
    rec = { count: 0, reset: now + LOCK_WINDOW_MS, lockedUntil: 0 };
    failures.set(key, rec);
  }
  rec.count += 1;
  if (rec.count >= threshold) {
    rec.lockedUntil = now + LOCK_DURATION_MS;
    rec.count = 0;
  }
  return rec;
}

/**
 * ثبت یک تلاش ناموفق. با آی‌پی: قفل (کاربر+آی‌پی) در LOCK_THRESHOLD و قفل
 * سراسری کاربر در GLOBAL_LOCK_THRESHOLD. بدون آی‌پی (سازگاری قدیمی): قفل
 * سراسری در LOCK_THRESHOLD مثل قبل.
 */
function recordLoginFailure(username, now = Date.now(), ip) {
  if (typeof now !== 'number') { ip = now; now = Date.now(); }
  if (ip === undefined) return bump(loginKey(username), LOCK_THRESHOLD, now);
  bump(loginKey(username), GLOBAL_LOCK_THRESHOLD, now);
  return bump(loginKey(username, ip), LOCK_THRESHOLD, now);
}

/** ورود موفق، شمارنده را پاک می‌کند. */
function clearLoginFailures(username, ip) {
  if (ip !== undefined) failures.delete(loginKey(username, ip));
  else failures.delete(loginKey(username));
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
  guardApi, checkRate, getClientIp, isLoopbackSocket, trustProxy, sweepExpired,
  isLockedOut, recordLoginFailure, clearLoginFailures,
  LOCK_THRESHOLD, LOCK_DURATION_MS, GLOBAL_LOCK_THRESHOLD,
};
