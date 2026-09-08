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
  // ⚠️ از نسخه امن به بعد: جریان بر پایه «کد جفت‌سازی یک‌بارمصرف» است.
  // poll بدون nonce دیگر آخرین رکورد را تحویل نمی‌دهد (رفع ربودن نشست).

  // ۱) poll بدون nonce → رد می‌شود (نه تحویل کوکی)
  let r = mockRes();
  await handler(mockReq({ action: 'poll' }), r);
  test('poll بدون nonce کوکی نمی‌دهد', !r._json.cookies);

  // ۲) push بدون کد جفت‌سازی → رد
  r = mockRes();
  await handler(mockReq({ action: 'push', cookies: ['PHPSESSID=abc123'] }), r);
  test('push بدون کد جفت‌سازی رد می‌شود', r._json.ok !== true);

  // ۳) ساخت کد جفت‌سازی
  r = mockRes();
  await handler(mockReq({ action: 'pair' }), r);
  const pair = r._json;
  test('pair کد و nonce تولید می‌کند', pair.ok === true && /^\d{6}$/.test(pair.code) && !!pair.nonce);

  // ۴) push با کد درست
  r = mockRes();
  await handler(mockReq({ action: 'push', code: pair.code, cookies: ['PHPSESSID=abc123', 'lang=fa'], source: 'extension' }), r);
  test('push با کد درست + تشخیص کوکی نشست',
    r._json.ok === true && r._json.count === 2 && r._json.has_session === true);

  // ۵) push بدون کوکی رد می‌شود
  r = mockRes();
  await handler(mockReq({ action: 'push', code: pair.code, cookies: [] }), r);
  test('push خالی رد می‌شود', r._status === 400 && r._json.ok === false);

  // ۶) poll با nonce درست → تحویل کوکی
  r = mockRes();
  await handler(mockReq({ action: 'poll', nonce: pair.nonce }), r);
  test('poll با nonce درست کوکی‌ها را می‌دهد',
    r._json.ok === true && r._json.cookies.length === 2 && r._json.has_session === true);

  // ۷) poll دوم با همان nonce → رکورد حذف شده (یک‌بارمصرف)
  r = mockRes();
  await handler(mockReq({ action: 'poll', nonce: pair.nonce }), r);
  test('poll مجدد → رکورد مصرف/حذف شده', !r._json.cookies);

  // ۶) GET رد می‌شود
  r = mockRes();
  await handler({ method: 'GET', headers: {}, body: {} }, r);
  test('متد غیر از POST رد می‌شود', r._status === 405);

  console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('خطای غیرمنتظره:', e); process.exit(1); });
