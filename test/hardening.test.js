// تست‌های سخت‌سازی endpointها
process.env.BILITFAST_DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/bf-hard-');
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret';

const syncCookiesHandler = require('../api/sync-cookies');
const reserveHandler = require('../api/reserve');
const telegramWebhookHandler = require('../api/telegram-webhook');
const { encryptState } = require('../lib/token');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}
function mockRes() {
  return {
    _status: 200, _json: null,
    status(c) { this._status = c; return this; },
    json(j) { this._json = j; return this; },
    set() { return this; },
    send(s) { this._send = s; return this; },
  };
}

(async () => {
  let r = mockRes();
  await syncCookiesHandler({
    method: 'GET',
    query: { source: 'firefox' },
    headers: { host: 'example.com', 'x-forwarded-for': '192.168.1.7' },
    socket: { remoteAddress: '192.168.1.7' },
  }, r);
  test('sync-cookies فقط برای localhost مجاز است', r._status === 403 && r._json && r._json.ok === false);

  const stateToken = encryptState({ jar: [], fromUrl: 'https://safirrail.ir/etrain/TresV.php' });
  r = mockRes();
  await reserveHandler({
    method: 'POST',
    body: { action: 'captcha-image', captchaImageUrl: 'http://127.0.0.1:3000/', stateToken },
    headers: { 'x-forwarded-for': '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  }, r);
  test('reserve از fetch کردن URL خارجی/لوکال برای کپچا جلوگیری می‌کند', r._status === 400 && r._json && r._json.ok === false);

  r = mockRes();
  await telegramWebhookHandler({
    method: 'POST',
    body: { message: { text: 'BF-ABCDEF', chat: { id: 1 } } },
    headers: { 'x-forwarded-for': '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  }, r);
  test('webhook تلگرام بدون secret معتبر رد می‌شود', (r._status === 400 || r._status === 403) && r._json && r._json.ok === false);

  console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('خطای غیرمنتظره:', e); process.exit(1); });
