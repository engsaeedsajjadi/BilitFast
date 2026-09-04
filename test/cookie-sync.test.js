// تست‌های همگام‌سازی کوکی از افزونه مرورگر (api/cookie-sync.js)
// اجرا: node test/cookie-sync.test.js
process.env.BILITFAST_DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/bf-csync-');

const handler = require('../api/cookie-sync');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

function mockReq(body, pair = 'pair-token-abcdefghijklmnopqrstuvwxyz') {
  return {
    method: 'POST',
    body,
    headers: {
      'x-forwarded-for': '127.0.0.1',
      cookie: pair ? ('bf_cookie_sync_pair=' + pair) : '',
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
}
function mockRes() {
  return {
    _status: 200, _json: null,
    status(c) { this._status = c; return this; },
    json(j) { this._json = j; return this; },
  };
}

(async () => {
  // ۱) poll اولیه: چیزی نیست → در انتظار
  let r = mockRes();
  await handler(mockReq({ action: 'poll' }), r);
  test('poll بدون کوکی → در انتظار', r._json && r._json.waiting === true);

  // ۲) push از سمت افزونه
  r = mockRes();
  await handler(mockReq({ action: 'push', cookies: ['PHPSESSID=abc123', 'lang=fa'], source: 'extension' }), r);
  test('push موفق + تشخیص کوکی نشست', r._json.ok === true && r._json.count === 2 && r._json.has_session === true);

  // ۳) push بدون کوکی رد می‌شود
  r = mockRes();
  await handler(mockReq({ action: 'push', cookies: [] }), r);
  test('push خالی رد می‌شود', r._status === 400 && r._json.ok === false);

  // ۴) poll کوکی‌ها را برمی‌گرداند
  r = mockRes();
  await handler(mockReq({ action: 'poll' }), r);
  test('poll کوکی‌ها را دریافت می‌کند', r._json.ok === true && r._json.cookies.length === 2 && r._json.has_session === true);

  // ۵) poll دوم: رکورد حذف شده → دوباره در انتظار
  r = mockRes();
  await handler(mockReq({ action: 'poll' }), r);
  test('poll مجدد → مصرف‌شده/حذف‌شده (در انتظار)', r._json.waiting === true);

  // ۶) نشستِ بدون توکن جفت‌شدن رد می‌شود
  r = mockRes();
  await handler(mockReq({ action: 'poll' }, ''), r);
  test('poll بدون pair token رد می‌شود', r._status === 400 && r._json.ok === false);

  // ۷) pair نادرست نمی‌تواند رکورد pair دیگر را بخواند
  r = mockRes();
  await handler(mockReq({ action: 'push', cookies: ['PHPSESSID=abc999'], source: 'extension' }, 'pair-token-AAAAABBBBBCCCCCDDDDDEEEEE'), r);
  r = mockRes();
  await handler(mockReq({ action: 'poll' }, 'pair-token-zzzzz-yyyyy-xxxxx-wwwww-vvvvv'), r);
  test('pair متفاوت به کوکی‌های pair دیگر دسترسی ندارد', r._json.waiting === true);

  // ۸) GET رد می‌شود
  r = mockRes();
  await handler({ method: 'GET', headers: {}, body: {} }, r);
  test('متد غیر از POST رد می‌شود', r._status === 405);

  console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('خطای غیرمنتظره:', e); process.exit(1); });
