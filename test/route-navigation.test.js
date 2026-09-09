// -*- coding: utf-8 -*-
/**
 * test/route-navigation.test.js
 *
 * رگرسیون باگ «مسیر یافت نشد» هنگام زدن دکمه «افزودن مسیر جدید».
 *
 * ریشه باگ یک وضعیت مسابقه (race condition) بود:
 *   ۱) index.html مسیر را در ذخیره‌ساز امن می‌نوشت. کش حافظه فوراً به‌روز
 *      می‌شد ولی نوشتن رمزشده روی localStorage غیرهمگام بود.
 *   ۲) openRoute بعد از ۱۸۰ میلی‌ثانیه ناوبری می‌کرد.
 *   ۳) route.html در لحظه parse شدن getRoute را همگام صدا می‌زد؛ کش صفحه
 *      جدید هنوز خالی بود و مقدار روی دیسک با 'enc1:' شروع می‌شد، پس
 *      secureGet به‌درستی null برمی‌گرداند → «مسیر یافت نشد».
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

/* ---------- محیط مرورگر ساختگی ---------- */
const disk = {};
const localStorage = {
  getItem: (k) => (k in disk ? disk[k] : null),
  setItem: (k, v) => { disk[k] = String(v); },
  removeItem: (k) => { delete disk[k]; },
};
const idbData = {};
function fakeIndexedDB() {
  return {
    open() {
      const req = {
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          transaction() {
            return {
              objectStore() {
                return {
                  get(k) { const t = {}; setTimeout(() => { t.result = idbData[k]; if (t.onsuccess) t.onsuccess(); }, 0); return t; },
                  put(v, k) { const t = {}; setTimeout(() => { idbData[k] = v; if (t.onsuccess) t.onsuccess(); }, 0); return t; },
                };
              },
            };
          },
        },
      };
      setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
  };
}
function newPage() {
  const g = {
    localStorage, sessionStorage: localStorage, indexedDB: fakeIndexedDB(), crypto: webcrypto,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextEncoder, TextDecoder, setTimeout, Promise, console, Uint8Array,
  };
  g.window = g; g.global = g;
  vm.createContext(g);
  vm.runInContext(read('public/secure-store.js'), g);
  return g;
}
// همان منطق secureGet در public/app.js
function makeSecureGet(store) {
  return function secureGet(k) {
    if (store.available) {
      const v = store.getItem(k);
      if (v !== null && v !== undefined) return v;
      const raw = localStorage.getItem(k);
      return (raw && raw.indexOf('enc1:') === 0) ? null : raw;
    }
    return localStorage.getItem(k);
  };
}

const KEYS = ['bilitfast_routes'];

(async () => {
  /* ---------- ۱) رفتار زمان اجرا ---------- */
  const page1 = newPage();
  const S1 = page1.BilitSecureStore;
  test('ذخیره‌ساز امن whenReady و flush را ارائه می‌دهد',
    typeof S1.whenReady === 'function' && typeof S1.flush === 'function');

  await S1.init(KEYS);
  S1.setItem('bilitfast_routes', JSON.stringify([{ id: 1, fields: { from_city: 'تهران' } }]));
  await S1.flush();
  test('flush() تضمین می‌کند نوشتن رمزشده روی دیسک نشسته است',
    typeof disk.bilitfast_routes === 'string' && disk.bilitfast_routes.indexOf('enc1:') === 0);

  // صفحه دوم = ناوبری به route.html با کش خالی
  const page2 = newPage();
  const S2 = page2.BilitSecureStore;
  const secureGet = makeSecureGet(S2);
  S2.init(KEYS);
  test('خواندن همگام پیش از رمزگشایی null است (شرط بروز باگ قدیمی)',
    secureGet('bilitfast_routes') === null);

  await S2.whenReady();
  const loaded = secureGet('bilitfast_routes');
  test('پس از whenReady مسیر تازه‌ساخته پیدا می‌شود',
    !!loaded && JSON.parse(loaded)[0].id === 1);

  test('init چندبار صدا زده شود کار اضافه نمی‌کند', S2.init(KEYS) === S2.init(KEYS));

  const fastResolve = await Promise.race([
    S2.whenReady().then(() => true),
    new Promise((r) => setTimeout(() => r(false), 20)),
  ]);
  test('whenReady بعد از آماده شدن، فوراً resolve می‌شود', fastResolve);

  /* ---------- ۲) صفحات از این محافظ استفاده می‌کنند ---------- */
  const app = read('public/app.js');
  const index = read('public/index.html');
  const route = read('public/route.html');
  const account = read('public/account.html');

  test('app.js توابع whenStorageReady و flushStorage را صادر می‌کند',
    /whenStorageReady, flushStorage/.test(app) &&
    /function whenStorageReady/.test(app) && /function flushStorage/.test(app));
  // رمزگشایی باید در بدنه ماژول شروع شود، نه داخل شاخه وابسته به document
  test('app.js رمزگشایی را زودهنگام (مستقل از DOM) شروع می‌کند',
    app.indexOf('BilitSecureStore.init(SECURE_KEYS)')
      < app.indexOf("if (typeof document !== 'undefined')"));

  test('route.html دیگر در لحظه parse مسیر را همگام بررسی نمی‌کند',
    !/if \(!ROUTE_ID \|\| !BilitFast\.getRoute\(ROUTE_ID\)\)/.test(route));
  test('route.html پیش از بررسی وجود مسیر منتظر ذخیره‌ساز می‌ماند',
    /await BilitFast\.whenStorageReady\(\);[\s\S]{0,120}getRoute\(ROUTE_ID\)/.test(route));
  test('route.html در نبود واقعی مسیر پیام مناسب نشان می‌دهد',
    /function showRouteMissing/.test(route) && /if \(!route\) \{ showRouteMissing\(\); return; \}/.test(route));
  test('شناسه نامعتبر همچنان بلافاصله رد می‌شود',
    /if \(!ROUTE_ID\) \{[\s\S]{0,80}showRouteMissing\(\)/.test(route));

  test('index.html پیش از ناوبری، نوشتن را flush می‌کند',
    /BilitFast\.flushStorage\(\)/.test(index) && /Promise\.all\(\[settled, minDelay\]\)/.test(index));
  test('index.html پس از آماده شدن ذخیره‌ساز دوباره رندر می‌کند',
    /BilitFast\.whenStorageReady\(\)\.then\(\(\) => \{[\s\S]{0,80}renderRoutes\(\)/.test(index));
  test('account.html هم پس از رمزگشایی رندر می‌شود',
    /BilitFast\.whenStorageReady\(\)\.then\(render\)/.test(account));

  /* ---------- ۳) هیچ صفحه‌ای در لحظه بارگذاری همگام مسیر نمی‌خواند ---------- */
  test('نگهبان همگام «مسیر یافت نشد» حذف شده است',
    !/!BilitFast\.getRoute\(ROUTE_ID\)\) \{\s*document\.body\.innerHTML/.test(route));

  console.log('\n' + (fail === 0
    ? 'همه ' + pass + ' تست ناوبری مسیر پاس شدند'
    : fail + ' تست شکست خورد از ' + (pass + fail)));
  process.exit(fail ? 1 : 0);
})();
