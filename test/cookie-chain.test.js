// -*- coding: utf-8 -*-
/**
 * test/cookie-chain.test.js — زنجیرهٔ انتقال کوکی از افزونه تا صفیر ریل.
 *
 * دو نقطهٔ قطع که رفع شدند:
 *
 * ۱) روی استقرار آنلاین، /api/cookie-sync هر سه اکشن را پشت «ورود به حساب»
 *    قفل کرده بود. ولی افزونه مرورگر ذاتاً نشست حساب ندارد، پس push همیشه
 *    ۴۰۱ می‌گرفت و کوکی هرگز به برنامه نمی‌رسید. حالا فقط pair و poll —
 *    که از سمت خود برنامه صدا زده می‌شوند — به حساب نیاز دارند. امنیت push
 *    را کد ۶ رقمیِ یک‌بارمصرف تأمین می‌کند.
 *
 * ۲) اگر کوکی از sessionStorage به payload جستجو/رزرو نمی‌رسید، سایت
 *    «موجودی صفر» برمی‌گرداند و کاربر فکر می‌کرد قطار پر است. حالا سرور
 *    یک بار خودش نشست را از اعتبارنامهٔ محلی می‌سازد.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BILITFAST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-chain-'));
process.env.BILITFAST_LICENSE_KEY = 'test-license-key';
process.env.BILITFAST_SESSION_KEY = 'test-session-key';
process.env.BILITFAST_TOKEN_KEY = 'test-token-key';

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

const sync = require(path.join(ROOT, 'api', 'cookie-sync.js'));
const call = (handler, body, ip) => new Promise((resolve) => {
  const res = { status(c) { this._c = c; return this; }, json(j) { resolve({ code: this._c, body: j }); } };
  handler({ method: 'POST', body, headers: {}, socket: { remoteAddress: ip || '127.0.0.1' } }, res);
});

const NET = '5.5.5.5';      // درخواست از اینترنت (نه localhost)
const OTHER = '6.6.6.6';    // یک طرف سوم

(async () => {
  /* ---- بخش ۱: افزونه روی استقرار آنلاین ---- */
  const p = await call(sync, { action: 'pair' });           // برنامه، محلی
  test('برنامه می‌تواند کد جفت‌سازی بسازد', p.body.ok === true && /^\d{6}$/.test(p.body.code));

  const pushed = await call(sync, {
    action: 'push', code: p.body.code, cookies: ['PHPSESSID=REAL', 'x=1'], source: 'extension',
  }, NET);
  test('افزونه از اینترنت می‌تواند کوکی بفرستد (باگ ۴۰۱ رفع شد)', pushed.body.ok === true);
  test('تعداد کوکی درست گزارش می‌شود', pushed.body.count === 2);
  test('وجود کوکی نشست تشخیص داده می‌شود', pushed.body.has_session === true);

  const got = await call(sync, { action: 'poll', nonce: p.body.nonce });
  test('برنامه کوکی را تحویل می‌گیرد', got.body.ok === true);
  test('همان کوکی واقعی تحویل داده می‌شود',
    Array.isArray(got.body.cookies) && got.body.cookies.includes('PHPSESSID=REAL'));

  /* ---- امنیت: آنچه نباید باز شده باشد ---- */
  const p2 = await call(sync, { action: 'pair' });
  await call(sync, { action: 'push', code: p2.body.code, cookies: ['PHPSESSID=FIRST'] }, NET);
  const second = await call(sync, { action: 'push', code: p2.body.code, cookies: ['PHPSESSID=ATTACK'] }, OTHER);
  test('کد یک‌بارمصرف است؛ push دوم رد می‌شود', second.body.ok !== true);
  const delivered = await call(sync, { action: 'poll', nonce: p2.body.nonce });
  test('کوکی مهاجم جایگزین نمی‌شود',
    Array.isArray(delivered.body.cookies) && !String(delivered.body.cookies).includes('ATTACK'));

  const noCode = await call(sync, { action: 'push', code: '000000', cookies: ['PHPSESSID=X'] }, OTHER);
  test('push بدون کد معتبر رد می‌شود', noCode.body.ok !== true);

  const badPoll = await call(sync, { action: 'poll', nonce: 'zzz' }, OTHER);
  test('poll از اینترنت بدون حساب همچنان بسته است (ضد ربودن نشست)',
    badPoll.code === 401 && badPoll.body.loginRequired === true);

  const pairNet = await call(sync, { action: 'pair' }, NET);
  test('pair از اینترنت بدون حساب همچنان بسته است', pairNet.code === 401);

  /* ---- بخش ۲: تور ایمنی کوکی سمت سرور ---- */
  const { ensureCookies, hasSession } = require(path.join(ROOT, 'lib', 'session-fallback.js'));
  test('hasSession کوکی نشست را می‌شناسد', hasSession(['a=1', 'PHPSESSID=Q']) === true);
  test('hasSession روی لیست بدون نشست false است', hasSession(['a=1']) === false);

  const keep = await ensureCookies(['PHPSESSID=MINE', 'a=1']);
  test('اگر نشست معتبر باشد، دست‌نخورده می‌ماند',
    keep.recovered === false && keep.cookies.includes('PHPSESSID=MINE'));

  const empty = await ensureCookies([]);
  test('بدون اعتبارنامه ذخیره‌شده، تور ایمنی بی‌صدا رد می‌شود',
    empty.recovered === false && Array.isArray(empty.cookies));

  const nullish = await ensureCookies(undefined);
  test('ورودی نامعتبر باعث خطا نمی‌شود', Array.isArray(nullish.cookies));

  /* ---- سیم‌کشی ---- */
  const searchSrc = fs.readFileSync(path.join(ROOT, 'api', 'search.js'), 'utf8');
  const reserveSrc = fs.readFileSync(path.join(ROOT, 'api', 'reserve.js'), 'utf8');
  const routeSrc = fs.readFileSync(path.join(ROOT, 'public', 'route.html'), 'utf8');
  test('جستجو از تور ایمنی استفاده می‌کند', /ensureCookies\(body\.cookies\)/.test(searchSrc));
  test('رزرو از تور ایمنی استفاده می‌کند', /ensureCookies\(body\.cookies\)/.test(reserveSrc));
  test('کلاینت نشست بازیابی‌شده را ذخیره می‌کند',
    /data\.sessionRecovered[\s\S]{0,160}setCookies\(data\.cookies\)/.test(routeSrc));
  test('جستجو همچنان کوکی را در payload می‌فرستد',
    (routeSrc.match(/cookies:\s*BilitFast\.getCookies\(\)/g) || []).length >= 3);

  console.log('\n' + (fail === 0
    ? 'همه ' + pass + ' تست زنجیره کوکی پاس شدند'
    : fail + ' تست شکست خورد از ' + (pass + fail)));
  process.exit(fail ? 1 : 0);
})();
