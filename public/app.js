/* app.js — منطق مشترک سمت کلاینت (پورت از هسته پایتون به مرورگر) */

/* =====================================================================
 * مدیریت دوره آزمایشی (پورت از TrialManager در BilitFast.py)
 * به‌جای رجیستری ویندوز / فایل، در localStorage مرورگر ذخیره می‌شود.
 * ===================================================================== */
const BilitFast = (function () {
  const TRIAL_KEY = 'bilitfast_trial';
  const ROUTES_KEY = 'bilitfast_routes';
  const COOKIES_KEY = 'bilitfast_cookies';
  const ACTIVATION_CODE = 'Sa@0946517835';
  const TRIAL_PERIOD_DAYS = 2;

  /* ---------------- Trial (TrialManager) ---------------- */
  function loadTrial() {
    try {
      const raw = localStorage.getItem(TRIAL_KEY);
      if (!raw) return { startDate: null, activated: false };
      return JSON.parse(raw);
    } catch (e) {
      return { startDate: null, activated: false };
    }
  }
  function saveTrial(t) {
    localStorage.setItem(TRIAL_KEY, JSON.stringify(t));
  }
  function trialState() {
    const t = loadTrial();
    if (t.activated) return { state: 'activated', message: 'فعال‌سازی دائمی' };
    if (!t.startDate) return { state: 'not_started', message: 'دوره آزمایشی شروع نشده' };
    const start = new Date(t.startDate).getTime();
    const expiry = start + TRIAL_PERIOD_DAYS * 86400000;
    if (Date.now() > expiry) return { state: 'expired', message: 'دوره آزمایشی به پایان رسیده' };
    return { state: 'active', message: 'دوره آزمایشی فعال' };
  }
  function startTrial() {
    const t = loadTrial();
    if (!t.startDate) {
      t.startDate = new Date().toISOString();
      saveTrial(t);
    }
  }
  function activate(code) {
    if (code === ACTIVATION_CODE) {
      const t = loadTrial();
      t.activated = true;
      saveTrial(t);
      return true;
    }
    return false;
  }
  function trialExpired() {
    return trialState().state === 'expired';
  }

  /* ---------------- Routes (معادل route_search_data / route_windows) ---------------- */
  function loadRoutes() {
    try {
      const raw = localStorage.getItem(ROUTES_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
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

  /* ---------------- Cookies (نشست صفیر ریل) ---------------- */
  function getCookies() {
    try { return JSON.parse(localStorage.getItem(COOKIES_KEY)) || []; }
    catch (e) { return []; }
  }
  function setCookies(c) {
    localStorage.setItem(COOKIES_KEY, JSON.stringify(c || []));
  }

  /* ---------------- تاریخ شمسی (با jalaali) ---------------- */
  function jalali() { return window.jalaali; }
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
    ACTIVATION_CODE, TRIAL_PERIOD_DAYS,
    loadTrial, saveTrial, trialState, startTrial, activate, trialExpired,
    loadRoutes, saveRoutes, getRoute, upsertRoute, removeRoute, nextRouteId,
    getCookies, setCookies,
    todayJalali, isValidJalaliDate, shiftJalaliDate,
    apiSearch, apiReserve, apiLogin,
  };
})();
