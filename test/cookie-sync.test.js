// تست‌های همگام‌سازی کوکی از افزونه مرورگر (api/cookie-sync.js)
// اجرا: node test/cookie-sync.test.js
process.env.BILITFAST_DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/bf-csync-');

const handler = require('../api/cookie-sync');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

function mockReq(body) {
  return { method: 'POST', body, headers: { 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
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

  // ۵) poll دوم: رکورد مصرف شده → دوباره در انتظار
  r = mockRes();
  await handler(mockReq({ action: 'poll' }), r);
  test('poll مجدد → مصرف‌شده (در انتظار)', r._json.waiting === true);

  // ۶) GET رد می‌شود
  r = mockRes();
  await handler({ method: 'GET', headers: {}, body: {} }, r);
  test('متد غیر از POST رد می‌شود', r._status === 405);

  console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('خطای غیرمنتظره:', e); process.exit(1); });
