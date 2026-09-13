// -*- coding: utf-8 -*-
/**
 * test/cookie-doctor.test.js — تشخیص علت شکست خواندن خودکار کوکی.
 *
 * زمینه: کاربر گزارش داد فقط چسباندن دستی کوکی کار می‌کند. اما «کار
 * نمی‌کند» چند علت کاملاً متفاوت دارد و هرکدام راه‌حل دیگری می‌خواهد:
 *   - مرورگر روی این دستگاه نیست (برنامه روی سرور اجرا می‌شود)
 *   - مرورگر هست ولی کاربر در سایت وارد نشده
 *   - کوکی هست ولی نشست ورود ندارد
 *   - کروم/اج جدید با App-Bound Encryption (از بیرون قابل خواندن نیست)
 *
 * بدون تشخیص، هر اصلاحی حدس است. این تست‌ها تضمین می‌کنند هر حالت به
 * پیام درست و راهنمایی درست ختم شود.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BILITFAST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-doc-'));
process.env.BILITFAST_LICENSE_KEY = 'test-license-key';
process.env.BILITFAST_SESSION_KEY = 'test-session-key';
process.env.BILITFAST_TOKEN_KEY = 'test-token-key';

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

const DOC = path.join(ROOT, 'api', 'cookie-doctor.js');
const FF = require.resolve(path.join(ROOT, 'lib', 'cookies.js'));
const CH = require.resolve(path.join(ROOT, 'lib', 'chrome-cookies.js'));

function setup(ffMock, chMock) {
  require.cache[FF] = { id: FF, filename: FF, loaded: true, exports: ffMock };
  require.cache[CH] = { id: CH, filename: CH, loaded: true, exports: chMock };
  delete require.cache[require.resolve(DOC)];
  return require(DOC);
}

const call = (handler, ip) => new Promise((resolve) => {
  const res = { status(c) { this._c = c; return this; }, json(j) { resolve({ code: this._c, body: j }); } };
  handler({ method: 'GET', query: {}, headers: {}, socket: { remoteAddress: ip || '127.0.0.1' } }, res);
});

(async () => {
  /* ---- حالت ۱: هیچ مرورگری روی این دستگاه نیست ---- */
  let api = setup(
    { findCookiesFiles: () => [], readFirefoxCookies: async () => [] },
    { getChromeCookiePaths: () => [], readChromeCookies: async () => [] });
  let r = await call(api);
  test('بدون مرورگر: گزارش موفق تولید می‌شود', r.body.ok === true);
  test('بدون مرورگر: علت درست تشخیص داده می‌شود',
    /هیچ پروفایل مرورگری/.test((r.body.findings || []).join(' ')));
  test('بدون مرورگر: افزونه یا روش دستی پیشنهاد می‌شود',
    /افزونه|دستی/.test((r.body.advice || []).join(' ')));

  /* ---- حالت ۲: مرورگر هست ولی کوکی صفیر ریل ندارد ---- */
  api = setup(
    { findCookiesFiles: () => ['/x/cookies.sqlite'], readFirefoxCookies: async () => [] },
    { getChromeCookiePaths: () => [], readChromeCookies: async () => [] });
  r = await call(api);
  test('بدون کوکی: تشخیص می‌دهد کاربر وارد سایت نشده',
    /وارد سایت نشده‌اید|کوکی‌ای برای safirrail/.test(
      (r.body.findings || []).concat(r.body.advice || []).join(' ')));

  /* ---- حالت ۳: کوکی هست ولی نشست ورود نیست ---- */
  api = setup(
    { findCookiesFiles: () => ['/x/cookies.sqlite'], readFirefoxCookies: async () => ['_ga=1'] },
    { getChromeCookiePaths: () => [], readChromeCookies: async () => [] });
  r = await call(api);
  test('کوکی مهمان: تشخیص می‌دهد نشست ورود نیست',
    /نشست \(ورود\) بینشان نبود/.test((r.body.findings || []).join(' ')));
  test('کوکی مهمان: می‌گوید در مرورگر وارد حساب شوید',
    /وارد حساب صفیر ریل شوید/.test((r.body.advice || []).join(' ')));

  /* ---- حالت ۴: نشست واقعی موجود ---- */
  api = setup(
    { findCookiesFiles: () => ['/x/cookies.sqlite'],
      readFirefoxCookies: async () => ['PHPSESSID=ABC', '_ga=1'] },
    { getChromeCookiePaths: () => [], readChromeCookies: async () => [] });
  r = await call(api);
  test('نشست موجود: وضعیت سالم گزارش می‌شود',
    /کوکی نشست صفیر ریل روی این دستگاه پیدا شد/.test((r.body.findings || []).join(' ')));
  const ffEntry = r.body.browsers.filter((b) => b.name === 'Firefox')[0];
  test('نشست موجود: فایرفاکس درست علامت می‌خورد', ffEntry && ffEntry.session === true);

  /* ---- حالت ۵: رمزنگاری App-Bound کروم ---- */
  const abErr = new Error('App-Bound'); abErr.code = 'CHROME_APP_BOUND';
  api = setup(
    { findCookiesFiles: () => [], readFirefoxCookies: async () => [] },
    { getChromeCookiePaths: () => ['/x/Cookies'],
      readChromeCookies: async () => { throw abErr; } });
  r = await call(api);
  test('App-Bound: علت واقعی تشخیص داده می‌شود',
    /App-Bound/.test((r.body.findings || []).join(' ')));
  test('App-Bound: فایرفاکس به‌عنوان راه‌حل پیشنهاد می‌شود',
    /فایرفاکس/.test((r.body.advice || []).join(' ')));

  /* ---- امنیت و حریم خصوصی ---- */
  api = setup(
    { findCookiesFiles: () => ['/x/cookies.sqlite'],
      readFirefoxCookies: async () => ['PHPSESSID=SECRETVALUE'] },
    { getChromeCookiePaths: () => [], readChromeCookies: async () => [] });
  r = await call(api);
  test('مقدار کوکی هرگز افشا نمی‌شود', !/SECRETVALUE/.test(JSON.stringify(r.body)));

  const remote = await call(api, '5.5.5.5');
  test('از اینترنت قابل دسترسی نیست', remote.code === 403);

  /* ---- پشتیبانی از مرورگرهای بیشتر ---- */
  delete require.cache[FF]; delete require.cache[CH];
  const chSrc = fs.readFileSync(path.join(ROOT, 'lib', 'chrome-cookies.js'), 'utf8');
  const ffSrc = fs.readFileSync(path.join(ROOT, 'lib', 'cookies.js'), 'utf8');
  test('Edge پشتیبانی می‌شود', /Microsoft.*Edge|microsoft-edge/.test(chSrc));
  test('Brave پشتیبانی می‌شود', /Brave/.test(chSrc));
  test('نسخه snap فایرفاکس پشتیبانی می‌شود', /snap.*firefox/.test(ffSrc));
  test('رمزنگاری v20 تشخیص داده می‌شود', /v20/.test(chSrc));

  const loginSrc = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');
  test('دکمه تشخیص در صفحه ورود هست', /btn-cookie-doctor/.test(loginSrc));

  console.log('\n' + (fail === 0
    ? 'همه ' + pass + ' تست تشخیص کوکی پاس شدند'
    : fail + ' تست شکست خورد از ' + (pass + fail)));
  process.exit(fail ? 1 : 0);
})();
