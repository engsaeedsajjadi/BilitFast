/* app.js — منطق مشترک سمت کلاینت (پورت از هسته پایتون به مرورگر)
 *
 * تغییر مهم نسبت به نسخه قبل: مدیریت مجوز/دوره آزمایشی دیگر در مرورگر جعل
 * نمی‌شود. کد فعال‌سازی از کد کلاینت حذف شده و وضعیت مجوز با «توکن امضاشده
 * سمت سرور» بررسی می‌شود (از طریق /api/trial و /api/activate). برای مقاومت
 * در برابر قطعی موقت سرور، آخرین وضعیت معتبر به‌صورت کش نگهداری می‌شود.
 */

const BilitFast = (function () {
  const TRIAL_KEY = 'bilitfast_trial_token';   // توکن امضاشده دوره آزمایشی (از سرور)
  const LICENSE_KEY = 'bilitfast_license_token'; // توکن امضاشده فعال‌سازی دائمی (از سرور)
  const CACHE_KEY = 'bilitfast_license_cache'; // کش آخرین وضعیت (برای آفلاین/کندی)
  const CACHE_TTL_MS = 15000;                  // اعتبار کش قبل از پرسش دوباره از سرور

  /* ---------------- مجوز و دوره آزمایشی (سمت سرور) ---------------- */

  function getLicenseToken() { return localStorage.getItem(LICENSE_KEY) || ''; }
  function getTrialToken() { return localStorage.getItem(TRIAL_KEY) || ''; }

  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return (c && typeof c === 'object' && c.state) ? c : null;
    } catch (e) { return null; }
  }
  function writeCache(st) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...st, ts: Date.now() })); } catch (e) { /* ignore */ }
  }

  /**
   * دریافت وضعیت مجوز از سرور (مرجع اصلی). خروجی:
   *   { state: 'activated'|'active'|'expired'|'not_started'|'unknown', message }
   * اگر سرور در دسترس نبود، از کش استفاده می‌شود؛ اگر کشی نبود 'not_started'.
   */
  async function fetchLicenseState(force = false) {
    const cache = readCache();
    if (!force && cache && (Date.now() - (cache.ts || 0) < CACHE_TTL_MS)) {
      return { state: cache.state, message: cache.message };
    }
    try {
      const res = await fetch('/api/trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', trialToken: getTrialToken(), licenseToken: getLicenseToken() }),
      });
      const data = await res.json();
      if (data && data.ok && data.state) {
        const st = { state: data.state, message: data.message || '' };
        writeCache(st);
        return st;
      }
      throw new Error('bad response');
    } catch (e) {
      // سرور در دسترس نیست → کش قدیمی (هرچقدر قدیمی) بهتر از قفل‌کردن کاربر است
      if (cache) return { state: cache.state, message: cache.message + ' (آفلاین)' };
      return { state: 'not_started', message: 'دوره آزمایشی شروع نشده' };
    }
  }

  /** شروع دوره آزمایشی (فقط یک‌بار — سرور توکن امضاشده می‌دهد). */
  async function startTrial() {
    const res = await fetch('/api/trial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', trialToken: getTrialToken(), licenseToken: getLicenseToken() }),
    });
    const data = await res.json();
    if (data && data.ok) {
      if (data.trialToken) localStorage.setItem(TRIAL_KEY, data.trialToken);
      writeCache({ state: data.state, message: data.message });
      return { state: data.state, message: data.message };
    }
    return { state: 'unknown', message: (data && data.error) || 'خطا در شروع دوره آزمایشی' };
  }

  /** فعال‌سازی دائمی با کد (اعتبارسنجی فقط سمت سرور). */
  async function activate(code) {
    const res = await fetch('/api/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (data && data.ok && data.token) {
      localStorage.setItem(LICENSE_KEY, data.token);
      writeCache({ state: 'activated', message: 'فعال‌سازی دائمی' });
      return { ok: true, message: data.message || 'برنامه فعال شد.' };
    }
    return { ok: false, message: (data && data.error) || 'خطا در فعال‌سازی' };
  }

  /* ---------------- مسیرها (معادل route_search_data / route_windows) ---------------- */
  const ROUTES_KEY = 'bilitfast_routes';

  function loadRoutes() {
    try {
      const raw = localStorage.getItem(ROUTES_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveRoutes(routes) {
    localStorage.setItem(ROUTES_KEY, JSON.stringify(routes));
  }
  function getRoute(id) {
    return loadRoutes().find((r) => r.id === id) || null;
  }
  function upsertRoute(route) {
    const routes = loadRoutes();
    const idx = routes.findIndex((r) => r.id === route.id);
    if (idx >= 0) routes[idx] = route;
    else routes.push(route);
    saveRoutes(routes);
    return route;
  }
  function removeRoute(id) {
    saveRoutes(loadRoutes().filter((r) => r.id !== id));
  }
  function nextRouteId() {
    const routes = loadRoutes();
    const maxId = routes.reduce((m, r) => Math.max(m, r.id), 0);
    return maxId + 1;
  }

  /* ---------------- کوکی‌ها (نشست صفیر ریل) ---------------- */
  const COOKIES_KEY = 'bilitfast_cookies';

  function getCookies() {
    try { return JSON.parse(localStorage.getItem(COOKIES_KEY)) || []; }
    catch (e) { return []; }
  }
  function setCookies(c) {
    localStorage.setItem(COOKIES_KEY, JSON.stringify(c || []));
  }

  /* ---------------- تاریخ شمسی (با jalaali) ---------------- */
  function jalali() {
    if (!window.jalaali) {
      throw new Error('کتابخانه jalaali.min.js بارگذاری نشده است. (خطای اسکریپت)');
    }
    return window.jalaali;
  }
  function todayJalali() {
    const j = jalali();
    const now = new Date();
    const t = j.toJalaali(now.getFullYear(), now.getMonth() + 1, now.getDate());
    return t.jy + '/' + String(t.jm).padStart(2, '0') + '/' + String(t.jd).padStart(2, '0');
  }
  function isValidJalaliDate(s) {
    const m = (s || '').trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) return false;
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    return jalali().isValidJalaaliDate(y, mo, d);
  }
  function shiftJalaliDate(s, days) {
    const m = (s || '').trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) return s;
    const j = jalali();
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    const g = j.toGregorian(y, mo, d);
    const dt = new Date(g.gy, g.gm - 1, g.gd + days);
    const t = j.toJalaali(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
    return t.jy + '/' + String(t.jm).padStart(2, '0') + '/' + String(t.jd).padStart(2, '0');
  }

  /* ---------------- اعتبارسنجی‌های کاربردی ---------------- */
  /** اعتبارسنجی کد ملی ایران (الگوریتم چک‌دیجیت) — هم‌نام نسخه سروری. */
  function isValidNationalCode(code) {
    const s = String(code == null ? '' : code).trim();
    if (!/^\d{10}$/.test(s)) return false;
    if (/^(\d)\1{9}$/.test(s)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(s[i], 10) * (10 - i);
    const r = sum % 11;
    const check = r < 2 ? r : 11 - r;
    return parseInt(s[9], 10) === check;
  }

  /* ---------------- تنظیمات مشترک (از /api/config) ---------------- */
  let sharedConfig = null;

  async function loadSharedConfig() {
    if (sharedConfig) return sharedConfig;
    try {
      const res = await fetch('/api/config');
      sharedConfig = await res.json();
    } catch (e) { sharedConfig = {}; }
    return sharedConfig;
  }
  /** فاصله جستجو (میلی‌ثانیه) — از config.json؛ پیش‌فرض ۳۰۰۰ */
  function getPollIntervalMs() {
    const n = parseInt(sharedConfig && sharedConfig.refresh_interval, 10);
    return (n > 0 ? n * 1000 : 3000);
  }
  /** حداکثر تلاش خودکار حل کپچا — از config.json؛ پیش‌فرض ۵ */
  function getCaptchaMaxAttempts() {
    const c = (sharedConfig && sharedConfig.captcha) || {};
    const n = parseInt(c.max_attempts, 10);
    return (n > 0 ? n : 5);
  }

  /* ---------------- حالت توسعه (نمایش تشخیص‌ها) ---------------- */
  function isDebugMode() {
    try {
      if (new URLSearchParams(window.location.search).has('debug')) return true;
      return localStorage.getItem('bilitfast_debug') === '1';
    } catch (e) { return false; }
  }
  function setDebugMode(on) {
    try { localStorage.setItem('bilitfast_debug', on ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  /* ---------------- API ---------------- */
  async function apiSearch(payload) {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }
  async function apiReserve(payload) {
    const res = await fetch('/api/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }
  async function apiLogin(username, password) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return res.json();
  }

  return {
    fetchLicenseState, startTrial, activate,
    loadRoutes, saveRoutes, getRoute, upsertRoute, removeRoute, nextRouteId,
    getCookies, setCookies,
    todayJalali, isValidJalaliDate, shiftJalaliDate,
    isValidNationalCode,
    loadSharedConfig, getPollIntervalMs, getCaptchaMaxAttempts,
    isDebugMode, setDebugMode,
    apiSearch, apiReserve, apiLogin,
  };
})();
