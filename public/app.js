/* app.js — منطق مشترک سمت کلاینت
 *
 * نسخه تجاری: مجوز سروری + حساب کاربری + اشتراک + تاریخچه + اطلاع‌رسانی.
 * مهمان‌ها (بدون ورود) همچنان با توکن‌های امضاشده دوره آزمایشی کار می‌کنند؛
 * کاربران واردشده اولویت با «اشتراک فعال» دارند و تاریخچه/اطلاعیه دارند.
 */

const BilitFast = (function (global) {
  const TRIAL_KEY = 'bilitfast_trial_token';
  const LICENSE_KEY = 'bilitfast_license_token';
  const SESSION_KEY = 'bilitfast_session_token';
  const CACHE_KEY = 'bilitfast_license_cache';
  const CACHE_TTL_MS = 15000;

  /* ---------------- لایه ذخیره‌سازی امن ----------------
   * داده‌های هویتی (مسیرها و الگوهای مسافر شامل کد ملی، تاریخ تولد، نام و
   * موبایل) دیگر متن ساده ذخیره نمی‌شوند: با AES-256-GCM و کلید
   * غیرقابل‌استخراج (IndexedDB) رمز می‌شوند. اگر مرورگر WebCrypto نداشته
   * باشد، رفتار قبلی حفظ می‌شود تا برنامه نشکند. */
  const SECURE_KEYS = ['bilitfast_routes', 'bilitfast_passenger_profiles'];

  // رمزگشایی را همین حالا شروع کن (نه بعد از DOMContentLoaded) تا صفحاتی که
  // در لحظه بارگذاری مسیر را می‌خوانند، کمترین انتظار را داشته باشند.
  try {
    if (global.BilitSecureStore && global.BilitSecureStore.available) {
      global.BilitSecureStore.init(SECURE_KEYS);
    }
  } catch (e) { /* ignore */ }

  function secureGet(k) {
    if (global.BilitSecureStore && global.BilitSecureStore.available) {
      const v = global.BilitSecureStore.getItem(k);
      if (v !== null && v !== undefined) return v;
      // اگر هنوز بارگذاری نشده، از متن ساده قدیمی بخوان (کوچ در حال انجام)
      const raw = localStorage.getItem(k);
      return (raw && raw.indexOf('enc1:') === 0) ? null : raw;
    }
    return localStorage.getItem(k);
  }
  function secureSet(k, v) {
    if (global.BilitSecureStore && global.BilitSecureStore.available) {
      global.BilitSecureStore.setItem(k, v);
      return;
    }
    try { localStorage.setItem(k, v); } catch (e) { /* ignore */ }
  }
  /**
   * تا وقتی ذخیره‌ساز امن داده‌های رمزشده را رمزگشایی نکرده، خواندن مسیرها
   * null برمی‌گرداند. هر صفحه‌ای که در لحظه بارگذاری به مسیرها نیاز دارد باید
   * اول این را await کند، وگرنه دچار وضعیت مسابقه («مسیر یافت نشد») می‌شود.
   */
  function whenStorageReady() {
    try {
      if (global.BilitSecureStore && global.BilitSecureStore.available) {
        return global.BilitSecureStore.whenReady();
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve();
  }

  /** اطمینان از نشستن نوشتن‌های رمزشده روی دیسک، پیش از ناوبری به صفحه دیگر. */
  function flushStorage() {
    try {
      if (global.BilitSecureStore && global.BilitSecureStore.flush) {
        return global.BilitSecureStore.flush();
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve();
  }

  /** پاک‌کردن کامل داده‌های شخصی این دستگاه (حق فراموش‌شدن). */
  function purgeLocalData() {
    try {
      if (global.BilitSecureStore) global.BilitSecureStore.purge(SECURE_KEYS);
      SECURE_KEYS.forEach((k) => localStorage.removeItem(k));
      clearCookies();
    } catch (e) { /* ignore */ }
  }

  /* ---------------- نشست کاربر ---------------- */
  function getSessionToken() { return localStorage.getItem(SESSION_KEY) || ''; }
  function setSessionToken(t) { if (t) localStorage.setItem(SESSION_KEY, t); else localStorage.removeItem(SESSION_KEY); }
  function isLoggedIn() { return !!getSessionToken(); }

  /** فراخوانی API با توکن نشست (هدر + بدنه برای سازگاری). */
  /* ---------------- نشانه نصب دسکتاپ (رجیستری ویندوز) ---------------- */
  const INSTALL_INFO_KEY = 'bilitfast_install_info_v1';
  let installInfoPromise = null;

  function isDesktopShell() {
    return !!(window.bilitDesktop && window.bilitDesktop.isDesktop);
  }
  // اطلاعات نصب (تاریخ نصب + شناسه دستگاه + امضا) را یک بار از پوسته دسکتاپ
  // می‌گیریم و کش می‌کنیم؛ در نسخه وب (PWA) چیزی برنمی‌گردد.
  function loadInstallInfo(force = false) {
    if (!isDesktopShell()) return Promise.resolve(null);
    if (!force && installInfoPromise) return installInfoPromise;
    installInfoPromise = (async () => {
      try {
        const info = await window.bilitDesktop.getInstallInfo();
        if (info && info.ok && info.signature) {
          const compact = {
            installDate: info.installDate, deviceId: info.deviceId,
            appVersion: info.appVersion, signature: info.signature, created: !!info.created,
          };
          try { localStorage.setItem(INSTALL_INFO_KEY, JSON.stringify(compact)); } catch (e) { /* ignore */ }
          return compact;
        }
        // fallback: اگر پوسته جواب نداد ولی کش قبلی هست، از همان استفاده کن
        try { return JSON.parse(localStorage.getItem(INSTALL_INFO_KEY) || 'null'); } catch (e) { return null; }
      } catch (e) {
        try { return JSON.parse(localStorage.getItem(INSTALL_INFO_KEY) || 'null'); } catch (e2) { return null; }
      }
    })();
    return installInfoPromise;
  }

  async function authFetch(path, payload) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getSessionToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const body = { ...(payload || {}) };
    if (token) body.sessionToken = token;
    // در نسخه دسکتاپ، اطلاعات امضاشده نصب هم همراه درخواست‌های مجوز/حساب می‌رود.
    try {
      const install = await loadInstallInfo();
      if (install) body.install = install;
    } catch (e) { /* ignore */ }
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
      // با authFetch توکن نشست هم فرستاده می‌شود تا اگر کاربر وارد حساب است،
      // فعال‌سازی روی خود حساب (license_activated) ثبت شود و روی همه دستگاه‌ها
      // و بعد از خروج/ورود هم فعال بماند.
      const data = await authFetch('/api/activate', { code });
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

  /* ---------------- کوکی بین‌دستگاهی (از طریق حساب کاربری) ----------------
   * کاربر روی دسکتاپ کوکی صفیر ریل را می‌گیرد؛ هنگام دریافت/ذخیره، کوکی به
   * حسابش هم منتقل می‌شود. روی هر دستگاه دیگری (مثل موبایل) پس از ورود به
   * حساب با pullAccountCookies همان کوکی در localStorage نشسته و آماده
   * جستجو/رزرو می‌شود. توجه: کوکی نشست عمر محدود دارد و باید گهگاه از
   * دستگاهی که به صفیر ریل دسترسی دارد دوباره تمدید شود. */
  async function pushCookiesToAccount(cookies) {
    if (!isLoggedIn() || !Array.isArray(cookies) || !cookies.length) return { ok: false };
    try {
      return await authFetch('/api/auth', { action: 'import-local', cookies: cookies.slice(0, 30) });
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function pullAccountCookies() {
    if (!isLoggedIn()) return { ok: false, error: 'not_logged_in' };
    try {
      const data = await authFetch('/api/auth', { action: 'export-local' });
      if (data && data.ok && Array.isArray(data.cookies) && data.cookies.length) {
        setCookies(data.cookies);
        return { ok: true, cookies: data.cookies, count: data.cookies.length };
      }
      return { ok: false, error: (data && data.error) || 'هیچ کوکی‌ای در حساب شما ذخیره نشده است.' };
    } catch (e) {
      return { ok: false, error: 'خطا در ارتباط با سرور' };
    }
  }

  /* ---------------- نشست خودکار صفیر ریل ----------------
   * کاربر یک بار شناسه/گذرواژه اصلی صفیر ریل خودش را وارد می‌کند؛ سرور آن را
   * رمزشده نگه می‌دارد و هر ۵ دقیقه کوکی تازه می‌گیرد. این تابع کوکی‌های تازه
   * را به مرورگر می‌آورد تا جستجو/رزرو هیچ‌وقت با «نیاز به ورود» نخوابد. */
  const SAFIR_SESSION_POLL_MS = 5 * 60 * 1000;
  let safirSessionTimer = null;

  async function safirSession(action, payload = {}) {
    try {
      return await authFetch('/api/safir-session', { action, ...payload });
    } catch (e) {
      return { ok: false, error: 'خطا در ارتباط با سرور' };
    }
  }

  /** تحویل گرفتن آخرین کوکی‌های تازه از حساب و نشاندن در مرورگر. */
  async function pullFreshSafirCookies() {
    if (!isLoggedIn()) return { ok: false, error: 'not_logged_in' };
    const d = await safirSession('pull');
    if (d && d.ok && Array.isArray(d.cookies) && d.cookies.length) {
      setCookies(d.cookies);
      return { ok: true, count: d.cookies.length, cookiesAt: d.cookiesAt };
    }
    return { ok: false, error: (d && d.error) || 'کوکی تازه‌ای موجود نیست.' };
  }

  /**
   * شروع همگام‌سازی خودکار کوکی در این تب: هر ۵ دقیقه کوکی تازه گرفته
   * می‌شود (سرور خودش ورود مجدد را انجام داده). بی‌صدا کار می‌کند تا کاربر
   * سردرگم نشود.
   */
  function startSafirSessionAutoSync() {
    if (safirSessionTimer || !isLoggedIn()) return false;
    const run = async () => {
      const r = await pullFreshSafirCookies();
      if (r.ok) {
        document.dispatchEvent(new CustomEvent('bilitfast:cookies-refreshed', { detail: r }));
      }
    };
    run();
    safirSessionTimer = setInterval(run, SAFIR_SESSION_POLL_MS);
    return true;
  }
  function stopSafirSessionAutoSync() {
    if (safirSessionTimer) { clearInterval(safirSessionTimer); safirSessionTimer = null; }
  }

  /* ---------------- اعلان (Toast) ---------------- */
  let toastEl = null;
  let toastTimer = null;
  function toast(message, type = 'info', ms = 3500) {
    try {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.id = 'bf-toast';
        toastEl.setAttribute('role', 'alert');
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = message;
      toastEl.className = 'bf-toast show bf-toast-' + type;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { if (toastEl) toastEl.className = 'bf-toast'; }, ms);
    } catch (e) { /* در دسترس نبودن DOM */ }
  }

  /* ---------------- دیالوگ تأیید داخلی (جایگزین confirm مرورگر) ----------------
   * پنجره‌های بومی مرورگر (confirm/alert/prompt) ظاهر متفاوتی دارند، رابط را
   * چندپاره نشان می‌دهند و روی موبایل بد جلوه می‌کنند. این دیالوگ هم‌سبک با
   * خود برنامه است و با انیمیشن باز/بسته می‌شود. */
  function confirmDialog({ title = 'تأیید', message = '', confirmText = 'تأیید', cancelText = 'انصراف', danger = false } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'bf-modal-overlay';
      overlay.innerHTML =
        '<div class="bf-modal" role="dialog" aria-modal="true">' +
        '<h3 class="bf-modal-title"></h3>' +
        '<p class="bf-modal-msg"></p>' +
        '<div class="bf-modal-actions">' +
        '<button class="btn bf-modal-cancel"></button>' +
        '<button class="btn bf-modal-ok ' + (danger ? 'btn-danger' : 'btn-primary') + '"></button>' +
        '</div></div>';
      overlay.querySelector('.bf-modal-title').textContent = title;
      overlay.querySelector('.bf-modal-msg').textContent = message;
      overlay.querySelector('.bf-modal-cancel').textContent = cancelText;
      overlay.querySelector('.bf-modal-ok').textContent = confirmText;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('show'));

      const close = (val) => {
        overlay.classList.remove('show');
        setTimeout(() => { try { overlay.remove(); } catch (e) { /* ignore */ } }, 200);
        document.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Enter') close(true);
      };
      overlay.querySelector('.bf-modal-ok').addEventListener('click', () => close(true));
      overlay.querySelector('.bf-modal-cancel').addEventListener('click', () => close(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', onKey);
      setTimeout(() => { try { overlay.querySelector('.bf-modal-ok').focus(); } catch (e) { /* ignore */ } }, 60);
    });
  }

  /** دیالوگ ورودی متنی داخلی (جایگزین prompt مرورگر). */
  function promptDialog({ title = 'ورودی', message = '', value = '', confirmText = 'ذخیره', placeholder = '' } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'bf-modal-overlay';
      overlay.innerHTML =
        '<div class="bf-modal" role="dialog" aria-modal="true">' +
        '<h3 class="bf-modal-title"></h3>' +
        '<p class="bf-modal-msg"></p>' +
        '<input class="bf-modal-input" type="text">' +
        '<div class="bf-modal-actions">' +
        '<button class="btn bf-modal-cancel">انصراف</button>' +
        '<button class="btn btn-primary bf-modal-ok"></button>' +
        '</div></div>';
      overlay.querySelector('.bf-modal-title').textContent = title;
      overlay.querySelector('.bf-modal-msg').textContent = message;
      overlay.querySelector('.bf-modal-ok').textContent = confirmText;
      const input = overlay.querySelector('.bf-modal-input');
      input.value = value; input.placeholder = placeholder;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('show'));

      const close = (val) => {
        overlay.classList.remove('show');
        setTimeout(() => { try { overlay.remove(); } catch (e) { /* ignore */ } }, 200);
        document.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter') close(input.value);
      };
      overlay.querySelector('.bf-modal-ok').addEventListener('click', () => close(input.value));
      overlay.querySelector('.bf-modal-cancel').addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', onKey);
      setTimeout(() => { try { input.focus(); input.select(); } catch (e) { /* ignore */ } }, 60);
    });
  }

  /* ---------------- ارقام فارسی ---------------- */
  function faNum(n) {
    return String(n == null ? '' : n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  }

  /* ---------------- تاریخچه رزرو ----------------
   * saveBooking عمداً با keepalive فرستاده می‌شود: در حالت رزرو خودکار
   * مرورگر بلافاصله به درگاه بانک می‌رود (window.location) و بدون keepalive
   * این درخواست پیش از رسیدن به سرور قطع می‌شد و لینک پرداخت به پیام‌رسان
   * ارسال نمی‌شد. keepalive درخواست را پس از ناوبری هم زنده نگه می‌دارد. */
  async function saveBooking(data) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getSessionToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const body = { action: 'save', ...(data || {}) };
    if (token) body.sessionToken = token;
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        keepalive: true,
      });
      return await res.json();
    } catch (e) {
      // حتی اگر پاسخ به‌خاطر ناوبری خوانده نشد، درخواست با keepalive ارسال شده
      return { ok: false, error: String(e) };
    }
  }
  async function bookingResult(id, result) {
    return authFetch('/api/bookings', { action: 'result', id, result });
  }
  async function notifyPayment(id) {
    return authFetch('/api/bookings', { action: 'notify-payment', id });
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

  // مسیرها شامل اطلاعات هویتی مسافران (کد ملی، تاریخ تولد، نام، موبایل)
  // هستند؛ بنابراین از طریق لایه امن ذخیره می‌شوند (AES-256-GCM با کلید
  // غیرقابل‌استخراج در IndexedDB) نه متن ساده در localStorage.
  function loadRoutes() {
    try {
      const raw = secureGet(ROUTES_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveRoutes(routes) {
    secureSet(ROUTES_KEY, JSON.stringify(routes));
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

  /* ---------------- الگوی مسافران (پرتکرار) ---------------- */
  const PASSENGER_PROFILES_KEY = 'bilitfast_passenger_profiles';

  function loadPassengerProfiles() {
    try {
      const arr = JSON.parse(secureGet(PASSENGER_PROFILES_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function savePassengerProfiles(list) {
    // الگوهای مسافر هم داده هویتی دارند → رمزشده ذخیره می‌شوند
    try { secureSet(PASSENGER_PROFILES_KEY, JSON.stringify(Array.isArray(list) ? list.slice(0, 50) : [])); }
    catch (e) { /* ignore */ }
  }
  function savePassengerProfile(name, passengers) {
    const list = loadPassengerProfiles().filter((p) => p.name !== name);
    list.unshift({ name, passengers: passengers || [], savedAt: Date.now() });
    savePassengerProfiles(list);
    return list;
  }
  function deletePassengerProfile(name) {
    savePassengerProfiles(loadPassengerProfiles().filter((p) => p.name !== name));
  }

  /* ---------------- کوکی‌ها (نشست صفیر ریل) ----------------
   * ⚠️ کوکی نشست صفیر عملاً «کلید حساب» کاربر است. دیگر در localStorage
   * (که ماندگار است و با پروفایل مشترک/پشتیبان/افزونه خوانده می‌شود)
   * نگهداری نمی‌شود؛ به sessionStorage منتقل شد که با بستن مرورگر پاک
   * می‌شود. منبع پایدارِ آن حساب کاربر روی سرور است و نگهدارنده نشست هر
   * ۵ دقیقه تازه‌اش می‌کند. */
  const COOKIES_KEY = 'bilitfast_cookies';

  function getCookies() {
    try {
      const v = sessionStorage.getItem(COOKIES_KEY);
      return v ? (JSON.parse(v) || []) : [];
    } catch (e) { return []; }
  }
  function setCookies(c) {
    try { sessionStorage.setItem(COOKIES_KEY, JSON.stringify(c || [])); }
    catch (e) { /* ignore */ }
  }
  /** پاک‌کردن کوکی نشست از این دستگاه. */
  function clearCookies() {
    try { sessionStorage.removeItem(COOKIES_KEY); } catch (e) { /* ignore */ }
    try { localStorage.removeItem(COOKIES_KEY); } catch (e) { /* ignore */ }
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
  // تعداد روزهای باقی‌مانده تا تاریخ شمسی (مثبت=آینده). null اگر نامعتبر.
  function daysUntilJalali(s) {
    const m = (s || '').trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) return null;
    const j = jalali();
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (!j.isValidJalaaliDate(y, mo, d)) return null;
    const g = j.toGregorian(y, mo, d);
    const target = new Date(g.gy, g.gm - 1, g.gd);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((target - today) / 86400000);
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
  function withLicenseTokens(payload) {
    return Object.assign({
      trialToken: localStorage.getItem(TRIAL_KEY) || '',
      licenseToken: localStorage.getItem(LICENSE_KEY) || '',
    }, payload || {});
  }
  async function apiSearch(payload) {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withLicenseTokens(payload)),
    });
    return res.json();
  }
  async function apiReserve(payload) {
    const res = await fetch('/api/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withLicenseTokens(payload)),
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

  /* ---------------- منوی همبرگری موبایل ----------------
   * دکمه منو به‌صورت خودکار به ناوبری اضافه می‌شود و فقط در موبایل
   * (طبق CSS، @media max-width:720px) نمایش داده می‌شود. */
  function initMobileNav() {
    try {
      const nav = document.querySelector('.topnav');
      if (!nav || nav.dataset.bfNav) return;
      nav.dataset.bfNav = '1';

      // علامت‌گذاری لینک صفحه فعلی برای دسترس‌پذیری
      const here = (location.pathname.split('/').pop() || 'index.html');
      nav.querySelectorAll('a').forEach((a) => {
        const href = (a.getAttribute('href') || '').split('?')[0];
        if (href === here || (here === '' && href === 'index.html')) a.setAttribute('aria-current', 'page');
      });

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-toggle';
      btn.setAttribute('aria-label', 'منو');
      btn.setAttribute('aria-expanded', 'false');
      btn.textContent = '☰';
      btn.addEventListener('click', () => {
        const open = nav.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      nav.addEventListener('click', (e) => {
        if (e.target.tagName === 'A') {
          nav.classList.remove('open');
          btn.setAttribute('aria-expanded', 'false');
        }
      });
      nav.parentNode.insertBefore(btn, nav);
    } catch (e) { /* ignore */
    }
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMobileNav);
    else initMobileNav();
    // در نسخه دسکتاپ، اطلاعات نصب را یک بار در ابتدا آماده کن تا authFetch بفرستد
    try { loadInstallInfo(); } catch (e) { /* ignore */ }
    // راه‌اندازی ذخیره‌سازی امن: رمزگشایی داده‌های موجود و کوچ یک‌بارهٔ
    // داده‌های متن‌سادهٔ نسخه‌های قبلی به حالت رمزشده (بی‌صدا).
    try {
      if (global.BilitSecureStore && global.BilitSecureStore.available) {
        // init یک‌بارمصرف است؛ اگر جای دیگری زودتر صدا شده باشد همان promise برمی‌گردد.
        global.BilitSecureStore.init(SECURE_KEYS).then(function () {
          document.dispatchEvent(new CustomEvent('bilitfast:secure-store-ready'));
        });
      }
    } catch (e) { /* اختیاری */ }
    // ثبت سرویس‌ورکر برای حالت PWA (نصب روی گوشی/دسکتاپ). فقط در محیط امن
    // (https یا localhost) فعال است؛ شکست آن بی‌سروصدا نادیده گرفته می‌شود.
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', () => {
        try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* ignore */ }
      });
    }
  }

  return {
    // نشست و حساب
    getSessionToken, setSessionToken, isLoggedIn, authFetch,
    // مجوز و اشتراک
    fetchLicenseState, startTrial, activate,
    isDesktopShell, loadInstallInfo,
    confirmDialog, promptDialog,
    safirSession, pullFreshSafirCookies,
    startSafirSessionAutoSync, stopSafirSessionAutoSync,
    // انتقال کوکی بین‌دستگاهی، اعلان و ارقام
    pushCookiesToAccount, pullAccountCookies, toast, faNum,
    // تاریخچه و اطلاع‌رسانی
    saveBooking, bookingResult, notifyPayment, listBookings, sendNotification,
    // داده محلی
    loadRoutes, saveRoutes, getRoute, upsertRoute, removeRoute, nextRouteId,
    getCookies, setCookies, clearCookies, purgeLocalData,
    secureGet, secureSet, SECURE_KEYS, whenStorageReady, flushStorage,
    loadPassengerProfiles, savePassengerProfile, deletePassengerProfile,
    // تاریخ و اعتبارسنجی
    todayJalali, isValidJalaliDate, shiftJalaliDate, daysUntilJalali, isValidNationalCode,
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
})(typeof window !== 'undefined' ? window : globalThis);
