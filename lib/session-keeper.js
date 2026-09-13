// -*- coding: utf-8 -*-
/**
 * lib/session-keeper.js — نگهدارنده خودکار نشست صفیر ریل.
 *
 * مسئله‌ای که حل می‌کند:
 * کوکی نشست صفیر ریل (PHPSESSID) بعد از مدتی بی‌اعتبار می‌شود. تا امروز کاربر
 * باید دستی دوباره کوکی را همگام می‌کرد و اگر یادش می‌رفت، رزرو با خطای
 * «نیاز به ورود» شکست می‌خورد — درست در لحظه‌ای که ظرفیت پیدا شده بود.
 *
 * راه‌حل:
 *   ۱) کاربر همان «شناسه و گذرواژه اصلی صفیر ریل خودش» را یک بار در برنامه
 *      وارد می‌کند. این اطلاعات با AES-256-GCM رمز می‌شود (lib/token.js) و
 *      روی رکورد حساب کاربر ذخیره می‌گردد — هرگز به‌صورت متن ساده نوشته
 *      نمی‌شود و هرگز به مرورگر برگردانده نمی‌شود.
 *   ۲) هر ۵ دقیقه (قابل تنظیم) برنامه خودکار با همان اطلاعات وارد صفیر ریل
 *      می‌شود و کوکی‌های تازه می‌گیرد.
 *   ۳) کوکی‌های تازه روی حساب ذخیره می‌شوند و مرورگر آن‌ها را می‌گیرد؛
 *      بنابراین نشست همیشه زنده است و کاربر سردرگم نمی‌شود.
 *
 * نکته امنیتی: اگر سایت صفیر برای ورود کپچا بخواهد، ورود خودکار ممکن نیست؛
 * در آن حالت وضعیت «captcha_required» گزارش می‌شود تا رابط کاربری به کاربر
 * بگوید کوکی را با افزونه/همگام‌سازی مرورگر منتقل کند.
 */

const { login } = require('./core');
const { encryptState, decryptState } = require('./token');
const db = require('./db');

// فاصله تازه‌سازی خودکار: پیش‌فرض ۵ دقیقه (خواسته کاربر)
const REFRESH_INTERVAL_MS = Number(process.env.BILITFAST_SESSION_REFRESH_MS) || 5 * 60 * 1000;
// اعتبار بسته رمزشده اعتبارنامه: عملاً بدون انقضا (۱۰ سال) چون باید بین
// راه‌اندازی‌های مجدد سرور باقی بماند.
const CRED_TTL_MS = 10 * 365 * 24 * 3600 * 1000;

/** وضعیت زنده هر کاربر (در حافظه): آخرین نتیجه تازه‌سازی. */
const state = new Map();
let timer = null;

/* ------------------------- ذخیره/خواندن اعتبارنامه ------------------------- */

/* ------------------- اعتبارنامه محلی (بدون حساب برنامه) -------------------
 * روی اجرای محلی، الزام به ساختن «حساب BilitFast» برای چیزی که فقط به خود
 * کاربر مربوط است، مانع بی‌دلیلی بود: بدون آن، اعتبارنامه ذخیره نمی‌شد و
 * وقتی نشست صفیر ریل منقضی می‌شد برنامه نمی‌توانست خودکار دوباره وارد شود.
 * چون ورود صفیر ریل کپچا نمی‌خواهد، ورود خودکار همیشه شدنی است؛ فقط باید
 * اعتبارنامه جایی امن ذخیره شود. اینجا همان رمزنگاری AES-256-GCM استفاده
 * می‌شود و فایل کنار داده‌های محلی برنامه می‌ماند (نه متن ساده).
 */
const LOCAL_ID = '__local__';

/** آیا اجرای محلی است؟ (روی ابر، اعتبارنامه باید به حساب کاربر بچسبد) */
function isLocalMode() {
  return !(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.FUNCTIONS_WORKER_RUNTIME || process.env.K_SERVICE);
}

/** رکورد اعتبارنامه محلی (مستقل از جدول users). */
function localRecord() {
  const rows = db.find('local_safir', () => true) || [];
  return rows.length ? rows[0] : null;
}

function saveLocalCredentials(username, password) {
  const blob = encryptState({ u: String(username), p: String(password) }, CRED_TTL_MS);
  const existing = localRecord();
  const patch = {
    safir_credentials: blob,
    safir_auto_refresh: true,
    safir_credentials_at: new Date().toISOString(),
  };
  if (existing) db.update('local_safir', existing.id, patch);
  else db.insert('local_safir', { id: LOCAL_ID, ...patch });
  return true;
}

/** ذخیره رمزشده شناسه و گذرواژه صفیر ریل روی حساب کاربر. */
function saveCredentials(userId, username, password) {
  if (!userId) throw new Error('برای ذخیره خودکار نشست باید وارد حساب برنامه شوید.');
  if (!username || !password) throw new Error('شناسه و گذرواژه صفیر ریل را وارد کنید.');
  const blob = encryptState({ u: String(username), p: String(password) }, CRED_TTL_MS);
  db.update('users', userId, {
    safir_credentials: blob,
    safir_auto_refresh: true,
    safir_credentials_at: new Date().toISOString(),
  });
  return true;
}

/** خواندن و رمزگشایی اعتبارنامه ذخیره‌شده؛ null اگر نبود/خراب بود. */
function readCredentials(user) {
  if (!user || !user.safir_credentials) return null;
  const obj = decryptState(user.safir_credentials);
  if (!obj || !obj.u || !obj.p) return null;
  return { username: obj.u, password: obj.p };
}

/** حذف اعتبارنامه (کاربر تازه‌سازی خودکار را خاموش می‌کند). */
function clearCredentials(userId) {
  if (!userId) return false;
  db.update('users', userId, {
    safir_credentials: null,
    safir_auto_refresh: false,
    safir_credentials_at: null,
  });
  state.delete(String(userId));
  return true;
}

/* ------------------------- تازه‌سازی نشست ------------------------- */

/**
 * یک بار ورود به صفیر ریل با اعتبارنامه ذخیره‌شده و به‌روزرسانی کوکی‌ها.
 * خروجی: { ok, cookies, count, reason }
 */
async function refreshUserSession(userId) {
  const user = db.findById('users', userId);
  if (!user) return { ok: false, reason: 'user_not_found' };
  const creds = readCredentials(user);
  if (!creds) return { ok: false, reason: 'no_credentials' };

  let result;
  try {
    result = await login(creds.username, creds.password);
  } catch (e) {
    const info = { ok: false, reason: 'network', error: e && e.message ? e.message : String(e), at: Date.now() };
    state.set(String(userId), info);
    return info;
  }

  if (!result || !result.ok) {
    const info = {
      ok: false,
      reason: result && result.captchaRequired ? 'captcha_required' : 'login_failed',
      error: (result && (result.error || result.message)) || 'ورود ناموفق بود',
      at: Date.now(),
    };
    state.set(String(userId), info);
    return info;
  }

  const cookies = Array.isArray(result.cookies) ? result.cookies.slice(0, 30) : [];
  db.update('users', userId, {
    safir_cookies: cookies,
    safir_cookies_at: new Date().toISOString(),
  });
  const info = { ok: true, count: cookies.length, cookies, at: Date.now() };
  state.set(String(userId), info);
  return info;
}

/**
 * تازه‌سازی نشست با اعتبارنامه محلی (وقتی کاربر حساب برنامه ندارد).
 * همان منطق refreshUserSession، ولی روی رکورد محلی.
 */
async function refreshLocalSession() {
  const rec = localRecord();
  if (!rec || !rec.safir_credentials) return { ok: false, reason: 'no_credentials' };
  const creds = decryptState(rec.safir_credentials);
  if (!creds || !creds.u || !creds.p) return { ok: false, reason: 'no_credentials' };

  let result;
  try {
    result = await login(creds.u, creds.p);
  } catch (e) {
    return { ok: false, reason: 'network', error: (e && e.message) || String(e) };
  }
  if (!result || !result.ok) {
    return {
      ok: false,
      reason: result && result.captchaRequired ? 'captcha_required' : 'login_failed',
      error: (result && (result.error || result.message)) || 'ورود ناموفق بود',
    };
  }
  const cookies = Array.isArray(result.cookies) ? result.cookies.slice(0, 30) : [];
  db.update('local_safir', rec.id, {
    safir_cookies: cookies,
    safir_cookies_at: new Date().toISOString(),
  });
  return { ok: true, count: cookies.length, cookies };
}

/** آیا اعتبارنامه محلی ذخیره شده است؟ */
function hasLocalCredentials() {
  const rec = localRecord();
  return !!(rec && rec.safir_credentials);
}

/** وضعیت آخرین تازه‌سازی این کاربر (برای نمایش در رابط کاربری). */
function getStatus(user) {
  if (!user) return { enabled: false };
  const last = state.get(String(user.id)) || null;
  const hasCreds = !!user.safir_credentials;
  return {
    enabled: !!(hasCreds && user.safir_auto_refresh !== false),
    hasCredentials: hasCreds,
    intervalMs: REFRESH_INTERVAL_MS,
    cookiesCount: Array.isArray(user.safir_cookies) ? user.safir_cookies.length : 0,
    cookiesAt: user.safir_cookies_at || null,
    last: last ? { ok: last.ok, reason: last.reason || null, error: last.error || null, at: last.at } : null,
    nextInMs: last && last.at ? Math.max(0, REFRESH_INTERVAL_MS - (Date.now() - last.at)) : 0,
  };
}

/* ------------------------- زمان‌بند دوره‌ای ------------------------- */

/** یک دور تازه‌سازی برای همه کاربرانی که این قابلیت را فعال کرده‌اند. */
async function tick() {
  let users = [];
  try {
    users = db.find('users', () => true) || [];
  } catch (e) {
    return 0;
  }
  let done = 0;
  for (const u of users) {
    if (!u || !u.safir_credentials || u.safir_auto_refresh === false) continue;
    // اگر ورود قبلی به‌خاطر کپچا شکست خورده، پشت سر هم تلاش نمی‌کنیم
    // (فقط هر ۶ دور یک بار) تا حساب کاربر روی صفیر قفل نشود.
    const last = state.get(String(u.id));
    if (last && !last.ok && last.reason === 'captcha_required') {
      const since = Date.now() - (last.at || 0);
      if (since < REFRESH_INTERVAL_MS * 6) continue;
    }
    try {
      await refreshUserSession(u.id);
      done++;
    } catch (e) { /* کاربر بعدی */ }
  }
  return done;
}

/** شروع زمان‌بند (در dev-server هنگام بالا آمدن صدا زده می‌شود). */
function start() {
  if (timer) return false;
  timer = setInterval(() => { tick().catch(() => {}); }, REFRESH_INTERVAL_MS);
  if (timer.unref) timer.unref();
  // یک دور اولیه با تأخیر کوتاه تا بالا آمدن سرور کند نشود
  setTimeout(() => { tick().catch(() => {}); }, 8000);
  return true;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  saveCredentials, readCredentials, clearCredentials,
  saveLocalCredentials, refreshLocalSession, hasLocalCredentials, isLocalMode,
  refreshUserSession, getStatus, tick, start, stop,
  REFRESH_INTERVAL_MS,
};
