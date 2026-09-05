/* app.js — منطق مشترک سمت کلاینت
 *
 * نسخه تجاری: مجوز سروری + حساب کاربری + اشتراک + تاریخچه + اطلاع‌رسانی.
 * مهمان‌ها (بدون ورود) همچنان با توکن‌های امضاشده دوره آزمایشی کار می‌کنند؛
 * کاربران واردشده اولویت با «اشتراک فعال» دارند و تاریخچه/اطلاعیه دارند.
 */

const BilitFast = (function () {
  const TRIAL_KEY = 'bilitfast_trial_token';
  const LICENSE_KEY = 'bilitfast_license_token';
  const SESSION_KEY = 'bilitfast_session_token';
  const CACHE_KEY = 'bilitfast_license_cache';
  const CACHE_TTL_MS = 15000;

  /* ---------------- نشست کاربر ---------------- */
  function getSessionToken() { return localStorage.getItem(SESSION_KEY) || ''; }
  function setSessionToken(t) { if (t) localStorage.setItem(SESSION_KEY, t); else localStorage.removeItem(SESSION_KEY); }
  function isLoggedIn() { return !!getSessionToken(); }

  /** فراخوانی API با توکن نشست (هدر + بدنه برای سازگاری). */
  async function authFetch(path, payload) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getSessionToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const body = { ...(payload || {}) };
    if (token) body.sessionToken = token;
    const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    return res.json();
  }

  /* ---------------- مجوز، دوره آزمایشی و اشتراک ---------------- */

  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return (c && typeof c === 'object' && c.state) ? c : null;
    } catch (e) { return null; }
  }
  function writeCache(st) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...st, ts: Date.now() })); } catch (e) { /* ignore */ }
  }

  /** وضعیت مجوز از سرور: اشتراک فعال > فعال‌سازی دائمی > دوره آزمایشی. */
  async function fetchLicenseState(force = false) {
    const cache = readCache();
    if (!force && cache && (Date.now() - (cache.ts || 0) < CACHE_TTL_MS) && (cache.session === isLoggedIn())) {
      return { state: cache.state, message: cache.message };
    }
    try {
      const data = await authFetch('/api/trial', { action: 'status', trialToken: localStorage.getItem(TRIAL_KEY) || '', licenseToken: localStorage.getItem(LICENSE_KEY) || '' });
      if (data && data.ok && data.state) {
        const st = { state: data.state, message: data.message || '', subscription: data.subscription || null, session: isLoggedIn() };
        writeCache(st);
        return st;
      }
      throw new Error('bad response');
    } catch (e) {
      if (cache) return { state: cache.state, message: cache.message + ' (آفلاین)' };
      return { state: 'not_started', message: 'دوره آزمایشی شروع نشده' };
    }
  }

  async function startTrial() {
    try {
      const data = await authFetch('/api/trial', { action: 'start', trialToken: localStorage.getItem(TRIAL_KEY) || '', licenseToken: localStorage.getItem(LICENSE_KEY) || '' });
      if (data && data.ok) {
        if (data.trialToken) localStorage.setItem(TRIAL_KEY, data.trialToken);
        writeCache({ state: data.state, message: data.message, session: isLoggedIn() });
        return { state: data.state, message: data.message };
      }
      return { state: 'unknown', message: (data && data.error) || 'خطا در شروع دوره آزمایشی' };
    } catch (e) {
      return { state: 'unknown', message: 'خطا در ارتباط با سرور' };
    }
  }

  /** فعال‌سازی دائمی با کد (برای مهمان‌ها؛ کاربران واردشده اشتراک می‌خرند). */
  async function activate(code) {
    try {
      const res = await fetch('/api/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (data && data.ok && data.token) {
        localStorage.setItem(LICENSE_KEY, data.token);
        writeCache({ state: 'activated', message: 'فعال‌سازی دائمی', session: isLoggedIn() });
        return { ok: true, message: data.message || 'برنامه فعال شد.' };
      }
      return { ok: false, message: (data && data.error) || 'خطا در فعال‌سازی' };
    } catch (e) {
      return { ok: false, message: 'خطا در ارتباط با سرور' };
    }
  }

  /* ---------------- اشتراک ---------------- */
  async function getPlans() {
    try { return await authFetch('/api/subscription', { action: 'plans' }); }
    catch (e) { return { ok: false, error: 'خطا در ارتباط با سرور' }; }
  }
  async function createCheckout(planId) {
    return authFetch('/api/subscription', { action: 'create', plan: planId });
  }
  async function subscriptionStatus() {
    return authFetch('/api/subscription', { action: 'status' });
  }

  /* ---------------- تاریخچه رزرو ---------------- */
  async function saveBooking(data) {
    return authFetch('/api/bookings', { action: 'save', ...data });
  }
  async function bookingResult(id, result) {
    return authFetch('/api/bookings', { action: 'result', id, result });
  }
  async function listBookings() {
    return authFetch('/api/bookings', { action: 'list' });
  }

  /* ---------------- اطلاع‌رسانی ---------------- */
  async function sendNotification(type, data) {
    // بهترین تلاش؛ نباید هرگز جریان اصلی را خراب کند
    try {
      if (!isLoggedIn()) return { ok: false, skipped: true };
      return await authFetch('/api/notify', { action: 'send', type, data });
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  /* ---------------- مسیرها (ذخیره محلی مرورگر) ---------------- */
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

  /* ---------------- تاریخ شمسی ---------------- */
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

  /* ---------------- اعتبارسنجی‌ها ---------------- */
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

  /* ---------------- تنظیمات مشترک ---------------- */
  let sharedConfig = null;

  async function loadSharedConfig() {
    if (sharedConfig) return sharedConfig;
    try {
      const res = await fetch('/api/config');
      sharedConfig = await res.json();
    } catch (e) { sharedConfig = {}; }
    return sharedConfig;
  }
  function getPollIntervalMs() {
    const n = parseInt(sharedConfig && sharedConfig.refresh_interval, 10);
    return (n > 0 ? n * 1000 : 3000);
  }
  function getCaptchaMaxAttempts() {
    const c = (sharedConfig && sharedConfig.captcha) || {};
    const n = parseInt(c.max_attempts, 10);
    return (n > 0 ? n : 5);
  }

  /* ---------------- پایش همزمان مسیرها (هماهنگی بین تب‌ها) ----------------
   * هر تبِ در حال جستجو، خودش را در یک رجیستری مشترک (localStorage) با
   * «ضربان قلب» زمانی ثبت می‌کند. فاصله درخواست‌ها به نسبت تعداد مسیرهای
   * فعال زیاد می‌شود تا نرخ کل درخواست‌ها به سایت صفیر ریل ثابت بماند و
   * محدودسازی/بلاک رخ ندهد. */
  const MONITOR_KEY = 'bilitfast_active_monitors';
  const MAX_CONCURRENT_MONITORS = 5;
  const MONITOR_TTL_MS = 25000; // باید از حداکثر فاصله ممکن بین دو درخواست بیشتر باشد

  function readMonitors() {
    try {
      const m = JSON.parse(localStorage.getItem(MONITOR_KEY) || '{}');
      return (m && typeof m === 'object') ? m : {};
    } catch (e) { return {}; }
  }
  function writeMonitors(m) {
    try { localStorage.setItem(MONITOR_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
  }
  function pruneMonitors(m) {
    const now = Date.now();
    const out = {};
    for (const k of Object.keys(m || {})) {
      if (typeof m[k] === 'number' && now - m[k] <= MONITOR_TTL_MS) out[k] = m[k];
    }
    return out;
  }
  function activeMonitors() {
    return pruneMonitors(readMonitors());
  }
  /** ثبت/تازه‌سازی حضور این مسیر؛ تعداد مسیرهای فعال را برمی‌گرداند. */
  function heartbeatMonitor(routeId) {
    const m = pruneMonitors(readMonitors());
    m[String(routeId)] = Date.now();
    writeMonitors(m);
    return Object.keys(m).length;
  }
  function unregisterMonitor(routeId) {
    const m = pruneMonitors(readMonitors());
    delete m[String(routeId)];
    writeMonitors(m);
  }
  /** آیا برای این مسیر جا هست؟ (حداکثر ۵ مسیر همزمان) */
  function monitorSlotAvailable(routeId) {
    const m = activeMonitors();
    const others = Object.keys(m).filter((k) => k !== String(routeId));
    return others.length < MAX_CONCURRENT_MONITORS;
  }
  /**
   * فاصله بین درخواست‌ها = فاصله پایه × تعداد مسیرهای فعال (+ جیتر ۱۵±٪).
   * با این فرمول «نرخ مجموع» درخواست‌ها به سایت تقریباً ثابت می‌ماند.
   */
  function monitorIntervalMs(baseMs, activeCount) {
    const n = Math.min(Math.max(1, activeCount || 1), MAX_CONCURRENT_MONITORS);
    const interval = (baseMs || 3000) * n;
    const jitter = Math.round(interval * 0.3 * (Math.random() - 0.5));
    return Math.max(1500, interval + jitter);
  }

  /* ---------------- حالت توسعه ---------------- */
  function isDebugMode() {
    try {
      if (new URLSearchParams(window.location.search).has('debug')) return true;
      return localStorage.getItem('bilitfast_debug') === '1';
    } catch (e) { return false; }
  }
  function setDebugMode(on) {
    try { localStorage.setItem('bilitfast_debug', on ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  /* ---------------- روش حل کپچا (خودکار/دستی) ----------------
   * قاعده اصلی (طبق درخواست کاربر): حالت حل کپچا از «انتخاب شماره قطار»
   * مشتق می‌شود، نه ترجیح ذخیره‌شده:
   *   - شماره قطار مشخص وارد شده  → خودکار (حل + ارسال + رفرش و تلاش مجدد
   *     تا زمانی که صفیر ریل کد را بپذیرد).
   *   - شماره قطار وارد نشده      → دستی (کاربر از لیست قطارها انتخاب می‌کند
   *     و کد را خودش وارد می‌کند). */
  function captchaModeForTrain(trainNumber) {
    const t = String(trainNumber == null ? '' : trainNumber).trim();
    return t ? 'auto' : 'manual';
  }
  /** سقف کل تلاش‌های خودکار کپچا در حالت «قطار خاص» (۰ = نامحدود). */
  function getCaptchaAutoSolveMaxTotal() {
    const c = (sharedConfig && sharedConfig.captcha) || {};
    const n = parseInt(c.auto_solve_max_total, 10);
    return (Number.isFinite(n) && n >= 0) ? n : 0;
  }
  /** تصمیم ارسالِ خودکارِ نتیجهٔ حل کپچا.
   *
   * مشکل نسخه قبل: حلقهٔ «تلاش تا پذیرش» فقط وقتی نتیجهٔ حل «مطمئن»
   * (ok=true) بود ارسال می‌کرد؛ روی کپچاهای واقعیِ دیده‌نشده، اعتماد مدل
   * معمولاً پایین است و در نتیجه حلقه هرگز چیزی ارسال نمی‌کرد و فقط رفرش +
   * پیام متنی تولید می‌شد.
   *
   * قاعده جدید:
   *  - حالت «تا پذیرش» (untilAccepted=true، قطار مشخص): هر حدس معتبرِ
   *    الفبایی-عددی ارسال می‌شود، حتی با اعتماد پایین؛ چون ارسال اشتباه در
   *    صفیر ریل جریمه‌ای ندارد و فقط کپچای تازه برمی‌گرداند.
   *  - حالت موردی (تا پذیرش نیست): فقط نتیجهٔ مطمئن خودکار ارسال می‌شود؛
   *    حدس کم‌اعتماد فقط داخل ورودی نمایش داده می‌شود تا کاربر تأیید/اصلاح کند.
   */
  function shouldAutoSubmit(solveResult, untilAccepted) {
    const text = String((solveResult && solveResult.text) || '').trim();
    if (!/^[A-Za-z0-9]{3,8}$/.test(text)) return false;
    if (untilAccepted) return true;
    return !!(solveResult && solveResult.ok);
  }
  /** (سازگاری با نسخه‌های قبل) — حالت مؤثر دیگر از شماره قطار مشتق می‌شود. */
  function getCaptchaMode() {
    const c = (sharedConfig && sharedConfig.captcha) || {};
    return (c.auto_solve === false) ? 'manual' : 'auto';
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
    // نشست و حساب
    getSessionToken, setSessionToken, isLoggedIn, authFetch,
    // مجوز و اشتراک
    fetchLicenseState, startTrial, activate,
    getPlans, createCheckout, subscriptionStatus,
    // تاریخچه و اطلاع‌رسانی
    saveBooking, bookingResult, listBookings, sendNotification,
    // داده محلی
    loadRoutes, saveRoutes, getRoute, upsertRoute, removeRoute, nextRouteId,
    getCookies, setCookies,
    // تاریخ و اعتبارسنجی
    todayJalali, isValidJalaliDate, shiftJalaliDate, isValidNationalCode,
    // تنظیمات
    loadSharedConfig, getPollIntervalMs, getCaptchaMaxAttempts,
    isDebugMode, setDebugMode,
    captchaModeForTrain, getCaptchaAutoSolveMaxTotal, getCaptchaMode, shouldAutoSubmit,
    // پایش همزمان
    activeMonitors, heartbeatMonitor, unregisterMonitor, monitorSlotAvailable,
    monitorIntervalMs, MAX_CONCURRENT_MONITORS,
    // API پایه
    apiSearch, apiReserve, apiLogin,
  };
})();
