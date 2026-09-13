// -*- coding: utf-8 -*-
/**
 * test/session-detect.test.js — تشخیص درست «وارد شده‌ای یا نه».
 *
 * باگی که این تست‌ها جلوی برگشتش را می‌گیرند:
 * verifySession و login موفقیت را با جست‌وجوی کلماتی مثل «گذرواژه» یا
 * «UserAut» در صفحه می‌سنجیدند. ولی صفحهٔ کاربرِ *واردشده* هم این‌ها را
 * دارد: لینک «خروج» به UserAut.php می‌رود و منوی حساب «تغییر گذرواژه»
 * دارد. نتیجه: نشستِ کاملاً سالم «منقضی» تشخیص داده می‌شد، هر چهار روشِ
 * انتقال کوکی پشت‌سرهم رد می‌شدند و ورودِ موفق هم «ناموفق» خوانده می‌شد.
 *
 * قاعدهٔ درست: فقط نشانهٔ ساختاری معتبر است — فیلد گذرواژهٔ واقعی
 * (<input type=password>) یا فرمی که به endpoint ورود POST می‌کند.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

const httpPath = require.resolve(path.join(ROOT, 'lib', 'http.js'));
let GET_PAGE = '', GET_STATUS = 200, POST_PAGE = '', POST_STATUS = 200;
require.cache[httpPath] = {
  id: httpPath, filename: httpPath, loaded: true,
  exports: {
    safirFetch: async (url, opt) => {
      const isPost = opt && opt.method === 'POST';
      return {
        ok: true,
        status: isPost ? POST_STATUS : GET_STATUS,
        headers: {
          get: (k) => (k === 'set-cookie' ? 'PHPSESSID=X; path=/' : null),
          raw: () => ({ 'set-cookie': ['PHPSESSID=X'] }),
        },
        text: async () => (isPost ? POST_PAGE : GET_PAGE),
      };
    },
  },
};
const core = require(path.join(ROOT, 'lib', 'core.js'));
const COOKIES = ['PHPSESSID=abc'];

/* صفحه‌های واقع‌گرایانه */
const LOGIN_FORM =
  '<html><form action="/fa/Login/process.php">' +
  '<input name="user"><input name="pass" type="password"></form></html>';
const ACCOUNT_PAGE =
  '<html><body><a href="/fa/UserAut.php?logout=1">خروج</a>' +
  '<a href="/fa/change">تغییر گذرواژه</a>خوش آمدید</body></html>';

(async () => {
  /* ---- verifySession ---- */
  GET_STATUS = 200;

  GET_PAGE = ACCOUNT_PAGE;
  let v = await core.verifySession(COOKIES);
  test('صفحه حساب با لینک خروج = نشست معتبر', v.valid === true);

  GET_PAGE = '<html><a href="/fa/pass">تغییر گذرواژه</a>خوش آمدید سعید</html>';
  v = await core.verifySession(COOKIES);
  test('کلمه «گذرواژه» به‌تنهایی نشست را باطل نمی‌کند', v.valid === true);

  GET_PAGE = '<html><a href="/fa/UserAut.php">حساب من</a>خوش آمدید</html>';
  v = await core.verifySession(COOKIES);
  test('اشاره به UserAut.php به‌تنهایی نشست را باطل نمی‌کند', v.valid === true);

  GET_PAGE = LOGIN_FORM;
  v = await core.verifySession(COOKIES);
  test('فرم ورود واقعی = نشست نامعتبر',
    v.valid === false && v.reason === 'not_logged_in');

  GET_PAGE = '<html><input type="password" name="pw"></html>';
  v = await core.verifySession(COOKIES);
  test('فیلد گذرواژه واقعی = نشست نامعتبر', v.valid === false);

  GET_STATUS = 302; GET_PAGE = '';
  v = await core.verifySession(COOKIES);
  test('ریدایرکت = نشست معتبر', v.valid === true);

  v = await core.verifySession([]);
  test('بدون کوکی نشست، نامعتبر است',
    v.valid === false && v.reason === 'no_session_cookie');

  /* ---- login ---- */
  GET_STATUS = 200; GET_PAGE = LOGIN_FORM;

  POST_STATUS = 200; POST_PAGE = ACCOUNT_PAGE;
  let r = await core.login('u', 'p');
  test('ورود موفق با صفحه حساب درست تشخیص داده می‌شود', r.ok === true);
  test('ورود موفق کوکی برمی‌گرداند',
    Array.isArray(r.cookies) && r.cookies.length > 0);

  POST_STATUS = 302; POST_PAGE = '';
  r = await core.login('u', 'p');
  test('ورود موفق با ریدایرکت درست تشخیص داده می‌شود', r.ok === true);

  POST_STATUS = 200;
  POST_PAGE = LOGIN_FORM + 'شناسه یا گذرواژه نادرست است';
  r = await core.login('u', 'p');
  test('گذرواژه اشتباه، موفق اعلام نمی‌شود', r.ok === false);

  /* ---- مهم‌ترین قاعده: سازگاری این دو ---- */
  POST_STATUS = 200; POST_PAGE = ACCOUNT_PAGE; GET_PAGE = ACCOUNT_PAGE;
  r = await core.login('u', 'p');
  v = await core.verifySession(r.cookies || COOKIES);
  test('کوکی حاصل از ورودِ موفق، بلافاصله معتبر سنجیده می‌شود',
    r.ok === true && v.valid === true);

  /* ---- محافظت از منطق حساس ---- */
  const src = require('fs').readFileSync(path.join(ROOT, 'lib', 'core.js'), 'utf8');
  const verifyBody = src.slice(src.indexOf('async function verifySession'),
    src.indexOf('async function login'));
  const code = verifyBody.split('\n').filter((l) => !l.trim().startsWith('*')
    && !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');
  test('تشخیص نشست دیگر به کلمه «گذرواژه» تکیه نمی‌کند',
    !/\/[^\n]*گذرواژه[^\n]*\/i\.test/.test(code));
  test('کپچا همچنان در مسیر ورود بررسی می‌شود', /captchaRequired/.test(src));

  console.log('\n' + (fail === 0
    ? 'همه ' + pass + ' تست تشخیص نشست پاس شدند'
    : fail + ' تست شکست خورد از ' + (pass + fail)));
  process.exit(fail ? 1 : 0);
})();
