// -*- coding: utf-8 -*-
/**
 * test/no-false-success.test.js — «پیام موفقیت» باید صادق باشد.
 *
 * شکایت کاربر: چند دکمهٔ انتقال کوکی پیام موفقیت می‌دادند ولی هیچ کوکی
 * فعالی به برنامه منتقل نمی‌شد.
 *
 * علت مشترک: همه‌جا «تعداد کوکی» ملاک موفقیت بود، نه «وجود نشست ورود».
 * سایت صفیر ریل به مهمانِ واردنشده هم کوکی می‌دهد (_ga، cookieconsent و...).
 * پس وقتی کاربر در مرورگر وارد نشده بود، این کوکی‌های بی‌ربط خوانده می‌شدند
 * و رابط کاربری می‌گفت «✅ ۲ کوکی همگام‌سازی و ذخیره شد» — در حالی که جستجو
 * همچنان «موجودی صفر» می‌داد چون هیچ نشستی وجود نداشت.
 *
 * قاعده‌ای که این تست‌ها قفل می‌کنند: بدون PHPSESSID، هیچ مسیری حق ندارد
 * ادعای موفقیت کند.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BILITFAST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-nfs-'));
process.env.BILITFAST_LICENSE_KEY = 'test-license-key';
process.env.BILITFAST_SESSION_KEY = 'test-session-key';
process.env.BILITFAST_TOKEN_KEY = 'test-token-key';

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

/* کوکی‌هایی که سایت به کاربرِ واردنشده هم می‌دهد */
const GUEST_COOKIES = ['_ga=GA1.2.99', 'cookieconsent=yes'];
const REAL_COOKIES = ['PHPSESSID=REALSESSION', '_ga=GA1.2.99'];

function mockBrowsers(list) {
  for (const [mod, fn] of [['cookies', 'readFirefoxCookies'], ['chrome-cookies', 'readChromeCookies']]) {
    const p = require.resolve(path.join(ROOT, 'lib', mod + '.js'));
    require.cache[p] = {
      id: p, filename: p, loaded: true,
      exports: { [fn]: async () => (fn === 'readFirefoxCookies' ? list : []) },
    };
  }
}

const callGet = (handler, query) => new Promise((resolve) => {
  const res = { status(c) { this._c = c; return this; }, json(j) { resolve({ code: this._c, body: j }); } };
  handler({ method: 'GET', query, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
});

(async () => {
  /* ---- /api/sync-cookies (دکمه «از Firefox / از Chrome») ---- */
  mockBrowsers(GUEST_COOKIES);
  const syncPath = require.resolve(path.join(ROOT, 'api', 'sync-cookies.js'));
  delete require.cache[syncPath];
  let syncApi = require(syncPath);

  let r = await callGet(syncApi, { source: 'firefox' });
  test('کوکی مهمان: همگام‌سازی ادعای موفقیت نمی‌کند', r.body.ok === false);
  test('کوکی مهمان: علت صریح گزارش می‌شود', r.body.noSession === true);
  test('کوکی مهمان: به کاربر می‌گوید اول در سایت وارد شود',
    /وارد حساب safirrail\.ir نشده‌اید|وارد سایت شوید/.test(r.body.error || ''));
  test('کوکی مهمان: کوکی بی‌ربط به کلاینت پاس داده نمی‌شود',
    r.body.cookies === undefined);

  mockBrowsers(REAL_COOKIES);
  delete require.cache[syncPath];
  syncApi = require(syncPath);
  r = await callGet(syncApi, { source: 'firefox' });
  test('نشست واقعی: همگام‌سازی موفق است', r.body.ok === true);
  test('نشست واقعی: وجود نشست تأیید می‌شود', r.body.hasSession === true);
  test('نشست واقعی: کوکی نشست تحویل داده می‌شود',
    Array.isArray(r.body.cookies) && r.body.cookies.some((c) => /^PHPSESSID=/.test(c)));

  /* ---- /api/connect (دکمه «اتصال به صفیر ریل») ---- */
  const httpPath = require.resolve(path.join(ROOT, 'lib', 'http.js'));
  require.cache[httpPath] = {
    id: httpPath, filename: httpPath, loaded: true,
    exports: {
      safirFetch: async () => ({
        ok: true, status: 200, headers: { get: () => null, raw: () => ({}) },
        // صفحهٔ فرم ورود = یعنی وارد نشده‌ای
        text: async () => '<form action="/fa/Login/process.php"><input name="pass" type="password"></form>',
      }),
    },
  };
  mockBrowsers(GUEST_COOKIES);
  const connPath = require.resolve(path.join(ROOT, 'api', 'connect.js'));
  delete require.cache[connPath];
  const connect = require(connPath);

  const cres = await new Promise((resolve) => {
    const res = { status(c) { this._c = c; return this; }, json(j) { resolve(j); } };
    connect({ method: 'POST', body: { cookies: [] }, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  });
  test('اتصال: با کوکی مهمان ادعای اتصال نمی‌کند', cres.ok === false);
  const profileStep = (cres.tried || []).filter((t) => t.method === 'profile')[0];
  test('اتصال: مرحلهٔ مرورگر شکست‌خورده گزارش می‌شود',
    !!profileStep && profileStep.ok === false);
  test('اتصال: علت واقعی توضیح داده می‌شود',
    !!profileStep && /نشست \(ورود\) بین آن‌ها نبود|یافت نشد/.test(profileStep.detail || ''));

  /* ---- کلاینت ---- */
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const loginSrc = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');

  test('کلاینت تابع تشخیص نشست دارد', /function hasSessionCookie/.test(appSrc));
  test('تابع تشخیص نشست export شده است', /hasSessionCookie,/.test(appSrc));
  test('«دریافت از حساب» بدون نشست، کوکی را ذخیره نمی‌کند',
    /pullAccountCookies[\s\S]{0,600}!hasSessionCookie\(data\.cookies\)/.test(appSrc));
  test('«دریافت کوکی تازه» بدون نشست، کوکی را ذخیره نمی‌کند',
    /pullFreshSafirCookies[\s\S]{0,500}!hasSessionCookie\(d\.cookies\)/.test(appSrc));
  test('دکمه اتصال بدون نشست، «متصل هستید» نشان نمی‌دهد',
    /!BilitFast\.hasSessionCookie\(d\.cookies\)/.test(loginSrc));

  /* ---- اطمینان از اینکه مسیر سالم نشکسته ---- */
  test('مسیر موفق همچنان کوکی را ذخیره می‌کند',
    /BilitFast\.setCookies\(d\.cookies\)/.test(loginSrc));

  console.log('\n' + (fail === 0
    ? 'همه ' + pass + ' تست «موفقیت صادقانه» پاس شدند'
    : fail + ' تست شکست خورد از ' + (pass + fail)));
  process.exit(fail ? 1 : 0);
})();
