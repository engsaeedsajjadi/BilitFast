// -*- coding: utf-8 -*-
/**
 * api/connect.js — «اتصال هوشمند» به صفیر ریل با یک دکمه.
 *
 * مسئله‌ای که حل می‌کند:
 * تا امروز کاربر با چهار روشِ موازی روبه‌رو بود (ورود مستقیم، افزونه مرورگر،
 * خواندن از پروفایل فایرفاکس/کروم، چسباندن دستی کوکی) و باید خودش تشخیص
 * می‌داد کدام‌یک به دردش می‌خورد. این یعنی بار تصمیم‌گیری فنی روی دوش کسی که
 * فقط می‌خواهد بلیت بخرد.
 *
 * راه‌حل: کاربر هیچ روشی انتخاب نمی‌کند. این endpoint همه راه‌ها را به ترتیبِ
 * «کمترین زحمت برای کاربر» خودش امتحان می‌کند و اولین روشی که به یک نشستِ
 * واقعاً معتبر برسد برنده است:
 *
 *   ۱) کوکی‌های فعلی مرورگر کاربر  → اگر هنوز معتبرند، اصلاً کاری لازم نیست.
 *   ۲) کوکی ذخیره‌شده روی حساب     → دستگاه دیگر قبلاً وصل شده بوده.
 *   ۳) ورود مستقیم با شناسه/گذرواژه → اگر کاربر آن را ذخیره کرده باشد.
 *   ۴) خواندن از پروفایل مرورگر     → فقط اجرای محلی (فایرفاکس/کروم).
 *
 * نکته کلیدی: «معتبر بودن» با core.verifySession سنجیده می‌شود، نه با صرفِ
 * وجود PHPSESSID. وجود آن کوکی هیچ چیز را ثابت نمی‌کند چون سایت به مهمانِ
 * وارد نشده هم PHPSESSID می‌دهد.
 *
 * اگر هیچ روشی جواب ندهد، به‌جای پیام خطای کلی، «قدم بعدیِ مشخص» برگردانده
 * می‌شود تا رابط کاربری دقیقاً بگوید کاربر چه کار کند.
 */

const { guardApi } = require('../lib/guard');
const { getSessionUser } = require('../lib/auth');
const core = require('../lib/core');
const db = require('../lib/db');
const keeper = require('../lib/session-keeper');

/** آیا روی محیط ابری اجرا می‌شویم؟ (خواندن پروفایل مرورگر فقط محلی ممکن است) */
function isLocalRun() {
  return typeof core.isCloudEnv === 'function' ? !core.isCloudEnv() : true;
}

/**
 * بررسی اعتبار نشست، با سازگاری عقب‌رو.
 *
 * چرا این محافظ لازم است: اگر سرور با نسخه قدیمی‌تر lib/core.js در حافظه
 * اجرا شده باشد (مثلاً کاربر بعد از به‌روزرسانی، پروسه node را ری‌استارت
 * نکرده باشد)، core.verifySession وجود ندارد و کل endpoint با خطای
 * «core.verifySession is not a function» می‌افتاد. به‌جای کرش، به بررسی
 * سادهٔ وجود کوکی برمی‌گردیم و به کاربر می‌گوییم سرور را ری‌استارت کند.
 */
async function checkSession(cookies) {
  if (typeof core.verifySession === 'function') {
    return core.verifySession(cookies);
  }
  const hasCookie = typeof core.hasSessionCookie === 'function'
    ? core.hasSessionCookie(cookies)
    : (Array.isArray(cookies) && cookies.some((c) => /^PHPSESSID=/i.test(String(c))));
  return {
    valid: hasCookie,
    degraded: true,
    reason: hasCookie ? undefined : 'no_session_cookie',
  };
}

/** تلاش برای خواندن کوکی از پروفایل مرورگرهای نصب‌شده روی همین سیستم. */
async function readBrowserProfiles() {
  const out = [];
  const notes = [];
  try {
    const { readFirefoxCookies } = require('../lib/cookies');
    out.push(...(await readFirefoxCookies()));
  } catch (e) {
    notes.push('Firefox: ' + ((e && e.message) || e));
  }
  try {
    const { readChromeCookies } = require('../lib/chrome-cookies');
    out.push(...(await readChromeCookies()));
  } catch (e) {
    notes.push('Chrome: ' + ((e && e.message) || e));
  }
  // حذف تکراری بر اساس نام کوکی
  const seen = new Map();
  for (const c of out) {
    const name = String(c).split('=')[0];
    if (!seen.has(name)) seen.set(name, c);
  }
  return { cookies: Array.from(seen.values()), notes };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'connect', limit: 20, windowMs: 60000 })) return;

  const body = (typeof req.body === 'string') ? safeParse(req.body) : (req.body || {});
  const browserCookies = Array.isArray(body.cookies) ? body.cookies : [];
  const user = getSessionUser(req, body);

  // گزارش مرحله‌به‌مرحله تا رابط کاربری بتواند صادقانه نشان دهد چه شد.
  const tried = [];
  const record = (method, ok, detail) => tried.push({ method, ok, detail });

  /* ---- ۱) کوکی‌هایی که همین حالا در مرورگر کاربر است ---- */
  if (browserCookies.length) {
    const v = await checkSession(browserCookies);
    if (v.valid) {
      record('existing', true, 'نشست فعلی معتبر است');
      res.status(200).json({
        ok: true, method: 'existing', cookies: browserCookies, tried,
        degraded: v.degraded || undefined,
        message: v.degraded
          ? 'کوکی نشست موجود است. (سرور نسخه قدیمی را در حافظه دارد؛ برای بررسی دقیق، برنامه را ری‌استارت کنید.)'
          : 'اتصال شما به صفیر ریل برقرار است.',
      });
      return;
    }
    record('existing', false, v.reason === 'network' ? 'سامانه در دسترس نبود' : 'نشست منقضی شده');
    if (v.reason === 'network') {
      res.status(200).json({
        ok: false, reason: 'network', tried,
        error: 'دسترسی به سامانه صفیر ریل برقرار نشد. ' + core.networkHint(),
      });
      return;
    }
  }

  /* ---- ۲) کوکی ذخیره‌شده روی حساب (از دستگاه دیگر) ---- */
  if (user) {
    let saved = [];
    try {
      const fresh = db.findById('users', user.id) || user;
      if (Array.isArray(fresh.safir_cookies) && fresh.safir_cookies.length) {
        saved = fresh.safir_cookies;
      }
    } catch (e) { /* ignore */ }

    if (saved.length) {
      const v = await checkSession(saved);
      if (v.valid) {
        record('account', true, 'کوکی ذخیره‌شده روی حساب معتبر بود');
        res.status(200).json({
          ok: true, method: 'account', cookies: saved, tried,
          message: 'اتصال با استفاده از نشست ذخیره‌شده در حساب شما برقرار شد.',
        });
        return;
      }
      record('account', false, 'کوکی ذخیره‌شده منقضی شده بود');
    } else {
      record('account', false, 'کوکی ذخیره‌شده‌ای در حساب نبود');
    }
  } else {
    record('account', false, 'وارد حساب BilitFast نشده‌اید');
  }

  /* ---- ۳) ورود مستقیم با اطلاعات ذخیره‌شده صفیر ریل ---- */
  if (user) {
    try {
      const r = await keeper.refreshUserSession(user.id);
      if (r && r.ok && Array.isArray(r.cookies) && r.cookies.length) {
        record('login', true, 'ورود خودکار انجام شد');
        res.status(200).json({
          ok: true, method: 'login', cookies: r.cookies, tried,
          message: 'با شناسه و گذرواژه ذخیره‌شده، خودکار وارد صفیر ریل شدیم.',
        });
        return;
      }
      if (r && r.reason === 'captcha_required') {
        record('login', false, 'سایت کد امنیتی خواست');
        res.status(200).json({
          ok: false, reason: 'captcha_required', tried,
          error: 'سامانه صفیر ریل هنگام ورود کد امنیتی (کپچا) می‌خواهد، پس ورود خودکار ممکن نیست.',
          nextStep: isLocalRun() ? 'browser_login' : 'extension',
        });
        return;
      }
      record('login', false, (r && r.error) || 'اطلاعات ورود ذخیره نشده است');
    } catch (e) {
      record('login', false, (e && e.message) || String(e));
    }
  }

  /* ---- ۳.۵) ورود خودکار با اعتبارنامه محلی (بدون نیاز به حساب برنامه) ----
   * چون ورود صفیر ریل کپچا نمی‌خواهد، اگر کاربر یک‌بار در همین برنامه وارد
   * شده باشد، اعتبارنامه‌اش رمزشده ذخیره شده و می‌توانیم بی‌صدا دوباره
   * وارد شویم — حتی اگر حساب BilitFast نداشته باشد. */
  if (!user && keeper.hasLocalCredentials && keeper.hasLocalCredentials()) {
    try {
      const r = await keeper.refreshLocalSession();
      if (r && r.ok && Array.isArray(r.cookies) && r.cookies.length) {
        record('login', true, 'ورود خودکار با اطلاعات ذخیره‌شده روی این دستگاه');
        res.status(200).json({
          ok: true, method: 'login', cookies: r.cookies, tried,
          message: 'به‌صورت خودکار دوباره وارد صفیر ریل شدیم.',
        });
        return;
      }
      if (r && r.reason === 'captcha_required') {
        record('login', false, 'سایت کد امنیتی خواست');
      } else {
        record('login', false, (r && (r.error || r.reason)) || 'ورود خودکار ناموفق بود');
      }
    } catch (e) {
      record('login', false, (e && e.message) || String(e));
    }
  } else if (!user) {
    record('login', false, 'هنوز یک‌بار با شناسه و گذرواژه وارد نشده‌اید');
  }

  /* ---- ۴) خواندن از پروفایل مرورگر (فقط اجرای محلی) ---- */
  if (isLocalRun()) {
    const { cookies, notes } = await readBrowserProfiles();
    if (cookies.length) {
      const v = await checkSession(cookies);
      if (v.valid) {
        record('profile', true, 'از مرورگر نصب‌شده روی همین سیستم خوانده شد');
        res.status(200).json({
          ok: true, method: 'profile', cookies, tried,
          message: 'نشست شما از مرورگر همین سیستم خوانده و متصل شد.',
        });
        return;
      }
      record('profile', false, 'کوکی مرورگر مربوط به نشست واردشده نبود');
    } else {
      record('profile', false, notes.length ? notes.join(' | ') : 'کوکی صفیر ریل در مرورگرها یافت نشد');
    }
  } else {
    record('profile', false, 'روی سرور ابری امکان خواندن مرورگر نیست');
  }

  /* ---- هیچ روشی جواب نداد: قدم بعدیِ مشخص را بگو ---- */
  res.status(200).json({
    ok: false,
    reason: 'no_session',
    tried,
    nextStep: isLocalRun() ? 'browser_login' : 'extension',
    error: 'هنوز به صفیر ریل متصل نیستید.',
  });
};

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}
