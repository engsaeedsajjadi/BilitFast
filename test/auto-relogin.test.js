// -*- coding: utf-8 -*-
/**
 * test/auto-relogin.test.js — ورود خودکار مجدد بدون نیاز به حساب BilitFast.
 *
 * زمینه: کاربر تأیید کرد که سامانه صفیر ریل برای ورود کپچا نمی‌خواهد.
 * پس هر بار که نشست منقضی شود، برنامه می‌تواند خودش دوباره وارد شود —
 * به شرطی که اعتبارنامه را داشته باشد.
 *
 * مشکلی که رفع شد: اعتبارنامه فقط وقتی ذخیره می‌شد که کاربر «حساب
 * BilitFast» داشت و تیک «زنده نگه داشتن نشست» را می‌زد. کاربری که برنامه
 * را محلی اجرا می‌کرد و فقط شناسه/گذرواژه صفیر ریل را وارد کرده بود،
 * هیچ اعتبارنامه‌ای ذخیره نمی‌کرد؛ بنابراین وسط رزرو با «نیاز به ورود»
 * گیر می‌افتاد و باید دستی دوباره وارد می‌شد.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BILITFAST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-relogin-'));
process.env.BILITFAST_LICENSE_KEY = 'test-license-key';
process.env.BILITFAST_SESSION_KEY = 'test-session-key';
process.env.BILITFAST_TOKEN_KEY = 'test-token-key';

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

/* ---- سایت جعلی: GET وضعیت نشست، POST ورود ---- */
let siteMode = 'guest';
let loginPosts = 0;
const httpPath = require.resolve(path.join(ROOT, 'lib', 'http.js'));
require.cache[httpPath] = {
  id: httpPath, filename: httpPath, loaded: true,
  exports: {
    safirFetch: async (url, opt) => {
      if (opt && opt.method === 'POST') {
        loginPosts++;
        if (siteMode === 'badcreds') {
          return { ok: true, status: 200, headers: { get: () => null },
            text: async () => '<html><form><input name="pass"></form>گذرواژه نادرست</html>' };
        }
        return { ok: true, status: 302,
          headers: { get: (k) => (k === 'set-cookie' ? 'PHPSESSID=FRESH' + loginPosts + '; path=/' : null) },
          text: async () => '<html>خوش آمدید</html>' };
      }
      const body = (siteMode === 'loggedin')
        ? '<html>خوش آمدید کاربر</html>'
        : '<html><form><input name="pass"></form>گذرواژه</html>';
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
    },
  },
};

const keeper = require(path.join(ROOT, 'lib', 'session-keeper.js'));
const loginApi = require(path.join(ROOT, 'api', 'login.js'));
const connect = require(path.join(ROOT, 'api', 'connect.js'));

const call = (h, body) => new Promise((resolve) => {
  const res = { status(c) { this._c = c; return this; }, json(j) { resolve(j); } };
  h({ method: 'POST', body, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
});

(async () => {
  test('اجرای محلی تشخیص داده می‌شود', keeper.isLocalMode() === true);
  test('در ابتدا اعتبارنامه‌ای ذخیره نشده', keeper.hasLocalCredentials() === false);

  /* ---- ورود ساده (بدون حساب BilitFast) باید اعتبارنامه را ذخیره کند ---- */
  siteMode = 'guest';
  const l = await call(loginApi, { username: 'u1', password: 'p1' });
  test('ورود با شناسه/گذرواژه موفق است', l.ok === true);
  test('ورود، ذخیره اعتبارنامه را اعلام می‌کند', l.autoRelogin === true);
  test('اعتبارنامه پس از ورود ذخیره شده', keeper.hasLocalCredentials() === true);

  /* ---- اعتبارنامه نباید متن ساده روی دیسک باشد ---- */
  const dump = JSON.stringify(require(path.join(ROOT, 'lib', 'db.js'))
    .find('local_safir', () => true));
  test('گذرواژه به‌صورت متن ساده ذخیره نشده', !/p1/.test(dump));
  test('شناسه هم به‌صورت متن ساده ذخیره نشده', !/u1/.test(dump));

  /* ---- نشست منقضی → بازیابی خودکار بدون دخالت کاربر ---- */
  siteMode = 'guest';           // سایت می‌گوید وارد نشده‌ای
  const before = loginPosts;
  const c = await call(connect, { cookies: ['PHPSESSID=OLD'] });
  test('نشست منقضی به‌صورت خودکار بازیابی می‌شود', c.ok === true);
  test('بازیابی از راه ورود مجدد انجام شد', c.method === 'login');
  test('واقعاً یک ورود تازه به سایت زده شد', loginPosts === before + 1);
  test('کوکی تازه برگردانده می‌شود',
    Array.isArray(c.cookies) && /FRESH/.test(c.cookies.join(',')));
  test('پیام برای کاربر قابل فهم است', /خودکار/.test(c.message || ''));

  /* ---- نشست معتبر نباید ورود بیهوده بزند ---- */
  siteMode = 'loggedin';
  const before2 = loginPosts;
  const c2 = await call(connect, { cookies: ['PHPSESSID=GOOD'] });
  test('نشست معتبر دست‌نخورده می‌ماند', c2.ok === true && c2.method === 'existing');
  test('برای نشست معتبر، ورود اضافه زده نمی‌شود', loginPosts === before2);

  /* ---- اعتبارنامه غلط: پیام درست، نه ادعای موفقیت ---- */
  siteMode = 'badcreds';
  const c3 = await call(connect, { cookies: [] });
  test('با اعتبارنامه نادرست، ادعای اتصال نمی‌شود', c3.ok === false);
  test('گزارش مراحل شامل تلاش ورود است',
    Array.isArray(c3.tried) && c3.tried.some((t) => t.method === 'login'));

  /* ---- پاک کردن اعتبارنامه ---- */
  const dbmod = require(path.join(ROOT, 'lib', 'db.js'));
  const rec = dbmod.find('local_safir', () => true)[0];
  test('رکورد محلی قابل یافتن است', !!rec);

  /* ---- رابط کاربری ---- */
  const login = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');
  test('به کاربر گفته می‌شود حساب BilitFast اختیاری است',
    /حساب BilitFast اختیاری است/.test(login));
  test('پس از ورود، وضعیت اتصال تازه می‌شود', /smartConnect\(true\)/.test(login));
  test('پیام ورود خودکار مجدد به کاربر نشان داده می‌شود',
    /برنامه خودکار دوباره وارد می‌شود/.test(login));

  console.log('\n' + (fail === 0
    ? 'همه ' + pass + ' تست ورود خودکار مجدد پاس شدند'
    : fail + ' تست شکست خورد از ' + (pass + fail)));
  process.exit(fail ? 1 : 0);
})();
