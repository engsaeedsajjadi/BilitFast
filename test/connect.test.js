// -*- coding: utf-8 -*-
/**
 * test/connect.test.js — «اتصال هوشمند» به صفیر ریل.
 *
 * مسئله‌ای که این قابلیت حل می‌کند: کاربر با چهار روش موازی انتقال کوکی
 * روبه‌رو بود (ورود مستقیم، افزونه، خواندن پروفایل مرورگر، چسباندن دستی) و
 * باید خودش تصمیم فنی می‌گرفت. حالا یک endpoint همه را به ترتیبِ کمترین
 * زحمت امتحان می‌کند.
 *
 * نکته مهمی که تست می‌شود: «معتبر بودن نشست» با یک درخواست واقعی سنجیده
 * می‌شود، نه با صرفِ وجود PHPSESSID — چون سایت به مهمانِ وارد نشده هم
 * PHPSESSID می‌دهد و همین باعث پیام گمراه‌کننده «متصل شدید» می‌شد.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BILITFAST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connect-'));
process.env.BILITFAST_LICENSE_KEY = 'test-license-key';
process.env.BILITFAST_SESSION_KEY = 'test-session-key';
process.env.BILITFAST_TOKEN_KEY = 'test-token-key';

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

/* ---- سایت جعلی صفیر ریل ---- */
let siteMode = 'guest';   // guest | loggedin | down
let fetchCount = 0;
const httpPath = require.resolve(path.join(ROOT, 'lib', 'http.js'));
require.cache[httpPath] = {
  id: httpPath, filename: httpPath, loaded: true,
  exports: {
    safirFetch: async () => {
      fetchCount++;
      if (siteMode === 'down') throw new Error('fetch failed');
      const body = (siteMode === 'loggedin')
        ? '<html><body>خوش آمدید، پروفایل کاربری</body></html>'
        : '<html><form action="/fa/Login/process.php"><input name="pass"></form>گذرواژه</html>';
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
    },
  },
};

const core = require(path.join(ROOT, 'lib', 'core.js'));
const connect = require(path.join(ROOT, 'api', 'connect.js'));

function callConnect(body, headers) {
  return new Promise((resolve) => {
    const res = {
      status(c) { this._code = c; return this; },
      json(j) { resolve({ code: this._code, body: j }); },
    };
    connect({
      method: 'POST', body: body || {}, headers: headers || {},
      socket: { remoteAddress: '127.0.0.1' },
    }, res);
  });
}

(async () => {
  /* ---- verifySession: قلب راه‌حل ---- */
  siteMode = 'guest';
  let v = await core.verifySession(['PHPSESSID=abc123']);
  test('کوکی مهمان (وارد نشده) نامعتبر تشخیص داده می‌شود',
    v.valid === false && v.reason === 'not_logged_in');

  siteMode = 'loggedin';
  v = await core.verifySession(['PHPSESSID=abc123']);
  test('کوکی نشستِ واردشده معتبر تشخیص داده می‌شود', v.valid === true);

  v = await core.verifySession([]);
  test('نبود کوکی نشست بدون درخواست شبکه رد می‌شود',
    v.valid === false && v.reason === 'no_session_cookie');

  const before = fetchCount;
  await core.verifySession(['other=1']);
  test('وقتی PHPSESSID نیست، درخواست بیهوده به سایت زده نمی‌شود',
    fetchCount === before);

  siteMode = 'down';
  v = await core.verifySession(['PHPSESSID=abc']);
  test('قطعی شبکه با «نامعتبر» اشتباه گرفته نمی‌شود',
    v.valid === false && v.reason === 'network');

  /* ---- مسیر ۱: نشست فعلی مرورگر ---- */
  siteMode = 'loggedin';
  let r = await callConnect({ cookies: ['PHPSESSID=live'] });
  test('نشست معتبر موجود → بدون هیچ کار اضافه متصل می‌شود',
    r.body.ok === true && r.body.method === 'existing');
  test('کوکی‌ها برای نشاندن در مرورگر برگردانده می‌شوند',
    Array.isArray(r.body.cookies) && r.body.cookies.length === 1);
  test('پیام موفقیت به زبان کاربر است', /اتصال/.test(r.body.message || ''));

  /* ---- مسیر شکست: قدم بعدی مشخص ---- */
  siteMode = 'guest';
  r = await callConnect({ cookies: ['PHPSESSID=stale'] });
  test('نشست منقضی → ادعای اتصال نمی‌کند', r.body.ok === false);
  test('در شکست، قدم بعدیِ مشخص داده می‌شود',
    r.body.nextStep === 'browser_login' || r.body.nextStep === 'extension');

  r = await callConnect({ cookies: [] });
  test('کاربر تازه بدون کوکی → راهنمای ورود در مرورگر', r.body.ok === false);
  test('گزارش شفاف از روش‌های امتحان‌شده برمی‌گردد',
    Array.isArray(r.body.tried) && r.body.tried.length >= 2);
  test('هر مرحله دلیل خوانا دارد',
    r.body.tried.every((t) => t.method && typeof t.detail === 'string' && t.detail.length > 0));

  /* ---- قطعی شبکه: پیام درست، نه «وارد نشده‌اید» ---- */
  siteMode = 'down';
  r = await callConnect({ cookies: ['PHPSESSID=x'] });
  test('قطعی سامانه از «عدم ورود» تفکیک می‌شود', r.body.reason === 'network');
  test('پیام قطعی شبکه راهنمای محیط اجرا دارد', /صفیر ریل/.test(r.body.error || ''));
  test('پیام قطعی شبکه روی اجرای محلی نامی از ورسل نمی‌برد',
    !/Vercel|ورسل/i.test(r.body.error || ''));

  /* ---- متد غیرمجاز ---- */
  const res405 = await new Promise((resolve) => {
    const res = { status(c) { this._code = c; return this; }, json(j) { resolve({ code: this._code, body: j }); } };
    connect({ method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  });
  test('فقط POST پذیرفته می‌شود', res405.code === 405);

  /* ---- رابط کاربری: یک مسیر اصلی، بقیه در بخش پیشرفته ---- */
  const login = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');
  test('کارت اتصال هوشمند با یک دکمه اصلی وجود دارد',
    /id="btn-smart-connect"/.test(login) && /smart-connect-card/.test(login));
  test('وضعیت اتصال به‌صورت زنده نشان داده می‌شود',
    /id="conn-dot"/.test(login) && /id="conn-text"/.test(login));
  test('در بدو ورود، وضعیت بی‌صدا بررسی می‌شود', /smartConnect\(true\)/.test(login));
  test('راهنمای قدم بعدی در رابط پیاده شده است',
    /function showNextStep/.test(login) && /id="next-step-box"/.test(login));
  test('حالت کپچا راهنمای اختصاصی دارد', /captcha_required/.test(login));

  const advIdx = login.indexOf('advanced-block');
  test('افزونه مرورگر به بخش «روش‌های جایگزین» منتقل شد',
    advIdx > 0 && login.indexOf('btn-ext-sync') > advIdx);
  test('خواندن از پروفایل مرورگر هم در بخش پیشرفته است',
    advIdx > 0 && login.indexOf('btn-sync-firefox') > advIdx);
  test('چسباندن دستی کوکی هم در بخش پیشرفته است',
    advIdx > 0 && login.indexOf('id="cookie-input"') > advIdx);
  test('دکمه اتصال هوشمند قبل از بخش پیشرفته می‌آید',
    login.indexOf('btn-smart-connect') < advIdx);

  test('تابع esc برای جلوگیری از تزریق HTML تعریف شده',
    /function esc\(v\)/.test(login));
  test('خروجی سرور پیش از درج در HTML فرار داده می‌شود',
    /esc\(d\.message/.test(login) && /esc\(\(d && d\.error\)/.test(login));

  // شناسه‌هایی که جاوااسکریپت موجود به آن‌ها وابسته است نباید گم شده باشند
  const ids = ['login-form', 'username', 'password', 'keep-session', 'btn-ext-sync',
    'ext-sync-result', 'btn-account-cookies', 'account-cookie-card', 'account-cookie-result',
    'btn-sync-firefox', 'btn-sync-chrome', 'sync-result', 'cookie-input', 'btn-save-cookies',
    'cookie-warn', 'session-keeper-card', 'prereq-box'];
  const missing = ids.filter((id) => !login.includes('id="' + id + '"'));
  test('هیچ شناسه‌ای که JS به آن وابسته است گم نشده' +
    (missing.length ? ' (گم‌شده: ' + missing.join(', ') + ')' : ''), missing.length === 0);

  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  test('استایل نشانگر وضعیت تعریف شده',
    /\.conn-dot\.ok/.test(css) && /\.conn-dot\.bad/.test(css) && /\.next-step/.test(css));

  console.log('\n' + (fail === 0
    ? 'همه ' + pass + ' تست اتصال هوشمند پاس شدند'
    : fail + ' تست شکست خورد از ' + (pass + fail)));
  process.exit(fail ? 1 : 0);
})();
