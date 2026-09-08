// تست‌های قابلیت‌های جدید: توقف هوشمند، فیلترها، پیام‌رسان لینک پرداخت و اتصال بله.
// اجرا: node test/new-features.test.js
process.env.BILITFAST_DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/bf-new-');
process.env.BILITFAST_LICENSE_KEY = 'test-license-key';

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

/* ۱) توقف هوشمند: جستجوی روی دامنه غیرقابل‌دسترس، fatal=true برمی‌گرداند */
const core = require('../lib/core');
(async () => {
  // از شبکه واقعی استفاده نمی‌کنیم؛ تابع fetch را شبیه‌سازی می‌کنیم که خطای شبکه بدهد.
  const origFetch = global.fetch;
  global.fetch = async () => { const e = new Error('fetch failed'); throw e; };
  const r = await core.searchOnce({
    fields: { from_city: 'تهران', to_city: 'مشهد', date: '1405/06/10', gender: 'عادی' },
    passengers: [{ quota_type: 'بزرگسال' }],
    cookies: [],
  });
  global.fetch = origFetch;
  test('خطای شبکه دائمی → fatal=true (توقف هوشمند)', r.ok === false && r.fatal === true);

  /* ۲) فیلترها و رتبه‌بندی قطارها (ارزان‌ترین/زودترین/سقف قیمت/حداقل ظرفیت) */
  const { filterAndRankTrains } = require('../lib/agent');
  const trains = [
    { 'شماره قطار': 'A', 'ساعت حرکت': '12:00', 'قیمت': '5,000,000', 'ظرفیت': 3 },
    { 'شماره قطار': 'B', 'ساعت حرکت': '06:00', 'قیمت': '3,000,000', 'ظرفیت': 1 },
    { 'شماره قطار': 'C', 'ساعت حرکت': '20:00', 'قیمت': '4,000,000', 'ظرفیت': 5 },
  ];
  const cheap = filterAndRankTrains(trains, { cheapest: true });
  test('رتبه‌بندی ارزان‌ترین → قطار B اول است', cheap.ranked[0]['شماره قطار'] === 'B');
  const early = filterAndRankTrains(trains, { earliest: true });
  test('رتبه‌بندی زودترین → قطار B (ساعت ۰۶) اول است', early.ranked[0]['شماره قطار'] === 'B');
  const capped = filterAndRankTrains(trains, { max_price: 4000000 });
  test('سقف قیمت ۴ میلیون → قطار ۵ میلیونی حذف می‌شود', capped.keptCount === 2 && !capped.ranked.some((t) => t['شماره قطار'] === 'A'));
  const minCap = filterAndRankTrains(trains, { minimum_capacity: 3 });
  test('حداقل ظرفیت ۳ → فقط قطارهایی با ظرفیت کافی', minCap.keptCount === 2);

  /* ۳) اتصال بله از طریق کد BF */
  const db = require('../lib/db');
  const auth = require('../lib/auth');
  const notify = require('../lib/notify');
  const reg = auth.registerUser('bale.user', 'pass123');
  const code = notify.makeConnectCode(reg.user);
  test('کد اتصال ساخته شد و در کاربر ذخیره شد', /^BF-[0-9A-F]{6}$/.test(code));
  // دریافت پیام با همان کد (شبیه وب‌هوک بله)
  const connected = notify.connectBaleChat('987654', 'hello ' + code + ' bye');
  test('connectBaleChat با کد درست → متصل و شناسه ذخیره شد', connected.ok === true);
  const after = db.findById('users', reg.user.id);
  test('شناسه چت بله در کاربر ذخیره شد', after.bale_chat_id === '987654');
  const again = notify.connectBaleChat('111', 'BF-FFFFFF');
  test('کد نامعتبر رد می‌شود', !again.ok && again.type === 'invalid_code');

  /* ۴) ارسال لینک پرداخت به تلگرام (شبکه تلگرام شبیه‌سازی می‌شود) */
  db.update('users', reg.user.id, {
    telegram_chat_id: '555000',
    payment_notify: { enabled: true, telegram: true },
  });
  const tgCalls = [];
  const tgUser = db.findById('users', reg.user.id);
  // telegramApi را override نمی‌کنیم؛ فقط بررسی می‌کنیم وقتی توکن نیست، skipped برنمی‌گرداند بلکه خطای not configured در results می‌آید و کرش نمی‌کند
  const sent = await notify.sendPaymentLinkToUser(tgUser, { origin: 'تهران', destination: 'مشهد' }, 'https://pec.shaparak.ir/NewIPG/?Token=XYZ');
  test('sendPaymentLinkToUser بدون کرش اجرا شد و خروجی results دارد', Array.isArray(sent.results) && sent.results.length >= 1);

  /* ۵) تابع اتصال بدون توکن ربات بله — پیام خطای واضح در API */
  const httpApi = require('../api/notify');
  const res = { _json: null };
  res.status = function (c) { return this; };
  res.json = function (o) { this._json = o; return this; };
  await httpApi(
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + reg.token },
      body: JSON.stringify({ action: 'test-payment-channel', channel: 'bale', chat_id: '123' }),
      query: {},
    },
    res
  );
  // بدون توکن بله در محیط تست، باید پیام «تنظیم نشده» بدهد نه کرش.
  test('تست بله بدون توکن → پیام واضح پیکربندی', !!res._json && res._json.ok === false && /BALE_BOT_TOKEN|\.env/.test(res._json.error || ''));

  /* ۶) پایشگر سمت سرور (start/list/stop) */
  const monitorApi = require('../api/monitor');
  const resM1 = { _json: null };
  resM1.status = function (c) { this._status = c; return this; };
  resM1.json = function (o) { this._json = o; return this; };
  await monitorApi({
    method: 'POST', headers: { authorization: 'Bearer ' + reg.token },
    body: JSON.stringify({
      action: 'start',
      fields: { from_city: 'تهران', to_city: 'مشهد', date: '1405/07/01', gender: 'عادی' },
      passengers: [{ quota_type: 'بزرگسال' }],
      prefs: { cheapest: true },
      intervalMs: 60000,
    }), query: {},
  }, resM1);
  test('پایشگر سرور: شروع موفق', resM1._json.ok === true && !!resM1._json.monitor_id);
  const monitorId = resM1._json.monitor_id;

  const resMdup = { _json: null };
  resMdup.status = function () { return this; };
  resMdup.json = function (o) { this._json = o; return this; };
  await monitorApi({
    method: 'POST', headers: { authorization: 'Bearer ' + reg.token },
    body: JSON.stringify({
      action: 'start',
      fields: { from_city: 'تهران', to_city: 'مشهد', date: '1405/07/01', gender: 'عادی' },
      passengers: [{ quota_type: 'بزرگسال' }], intervalMs: 60000,
    }), query: {},
  }, resMdup);
  test('پایشگر سرور: مسیر تکراری رد می‌شود', resMdup._json.ok === false);

  // توقف فوری (تایمر اولین تیک را پاک می‌کند تا در تست شبکه نزند)
  const monitorLib = require('../lib/monitor');
  const stopR = monitorLib.stopMonitor(db.findById('users', reg.user.id), monitorId);
  test('پایشگر سرور: توقف موفق', stopR.ok === true);
  const afterList = monitorLib.listUserMonitors(reg.user.id);
  test('پایشگر سرور: پس از توقف غیرفعال است', afterList.every((m) => m.active === false));
  // پاکسازی تایمرهای احتمالی
  monitorLib.stopAllForUser(reg.user.id);

  /* ۷) اتصال خودکار ایتا با کد BF */
  const ecode = notify.makeConnectCode(db.findById('users', reg.user.id));
  const econn = notify.connectEitaaChat('555444', 'کد من ' + ecode);
  test('connectEitaaChat با کد درست → متصل شد', econn.ok === true);
  const euser = db.findById('users', reg.user.id);
  test('شناسه چت ایتا ذخیره شد', euser.eitaa_chat_id === '555444');

  /* ۸) فرمان‌های ربات تلگرام (وضعیت/توقف) */
  db.update('users', reg.user.id, { telegram_chat_id: '700700', telegram_connect_code: '' });
  const tgHook = require('../api/telegram-webhook');
  const hookRes = { _json: null };
  hookRes.status = function () { return this; };
  hookRes.json = function (o) { this._json = o; return this; };
  // ابتدا یک پایشگر فعال بسازیم
  const m2 = monitorLib.startMonitor(db.findById('users', reg.user.id), {
    fields: { from_city: 'تهران', to_city: 'کرج', date: '1405/08/01' },
    passengers: [{ quota_type: 'بزرگسال' }], intervalMs: 600000,
  });
  test('پایشگر دوم برای تست ربات ساخته شد', m2.ok === true);
  await tgHook({
    method: 'POST',
    body: { message: { chat: { id: 700700 }, text: '/status' } },
  }, hookRes);
  test('وب‌هوک تلگرام به /status پاسخ می‌دهد', hookRes._json && hookRes._json.ok === true);
  // /stop باید پایشگر را متوقف کند (ارسال پیام به تلگرام واقعی شکست می‌خورد ولی منطق اجرا می‌شود)
  await tgHook({
    method: 'POST',
    body: { message: { chat: { id: 700700 }, text: '/stop' } },
  }, hookRes);
  const stillActive = monitorLib.activeUserMonitors(reg.user.id).length;
  test('فرمان /stop ربات همه پایشگرهای سرور را متوقف کرد', stillActive === 0);
  monitorLib.stopAllForUser(reg.user.id);

  /* ۹) گیت مجوز سمت سرور (fail-closed در حالت اجبار) */
  const license = require('../lib/license');
  // با کلید تست و بدون اجبار، گیت آزاد است (حالت توسعه)
  test('گیت مجوز در حالت توسعه (کلید پیش‌فرض/تست) آزاد است', license.checkAccess({}).allowed === true);

  // شبیه‌سازی حالت اجباری روی سرور واقعی
  const savedKey = process.env.BILITFAST_LICENSE_KEY;
  const savedEnforce = process.env.BILITFAST_ENFORCE_LICENSE;
  process.env.BILITFAST_LICENSE_KEY = 'production-secret-key-xyz';
  process.env.BILITFAST_ENFORCE_LICENSE = '1';
  // توکن‌های امضاشده با کلید قدیمی در این فرایند معتبر نیستند → رد
  const deniedNoLicense = license.checkAccess({});
  test('گیت مجوز در حالت اجبار بدون لایسنس رد می‌کند', deniedNoLicense.allowed === false);
  const deniedGuestExpired = license.checkAccess({ licenseToken: 'x.y', trialToken: 'a.b' });
  test('توکن جعلی/منقضی در حالت اجبار رد می‌شود', deniedGuestExpired.allowed === false);
  const allowedLicensedUser = license.checkAccess({ user: { id: 1, license_activated: true } });
  test('کاربر دارای لایسنس فعال در حالت اجبار پذیرفته می‌شود', allowedLicensedUser.allowed === true);
  // بازگردانی محیط
  if (savedKey === undefined) delete process.env.BILITFAST_LICENSE_KEY; else process.env.BILITFAST_LICENSE_KEY = savedKey;
  if (savedEnforce === undefined) delete process.env.BILITFAST_ENFORCE_LICENSE; else process.env.BILITFAST_ENFORCE_LICENSE = savedEnforce;

  /* ۱۰) امنیت: ولیدیشن کد ملی سمت سرور */
  const reserve = require('../lib/reserve');
  test('کد ملی نامعتبر تشخیص داده می‌شود', reserve.isValidIranianNationalCode('1234567890') === false);
  // ساخت یک کد معتبر طبق همان الگوریتم
  let validCode = null;
  for (let n = 111111111; n < 111211111; n++) {
    const s = String(n);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(s[i], 10) * (10 - i);
    const r = sum % 11;
    const c = r < 2 ? r : 11 - r;
    const cand = s + c;
    if (reserve.isValidIranianNationalCode(cand)) { validCode = cand; break; }
  }
  test('کد ملی معتبر طبق الگوریتم پذیرفته می‌شود', !!validCode);
  const rBad = await reserve.submitReservation({
    stateToken: 'invalid-token',
    captcha: 'ABCD12',
    passengers: [{ national_code: '1234567890', quota_type: 'بزرگسال' }],
  });
  test('رزرو با توکن وضعیت نامعتبر رد می‌شود (بدون کرش)', rBad && rBad.ok === false);

  /* ۱۱) محافظ SSRF در آدرس‌ها */
  test('SSRF: آدرس متادیتای ابری رد می‌شود', reserve.isSafirUrl('http://169.254.169.254/latest/meta-data') === false);
  test('SSRF: آدرس localhost رد می‌شود', reserve.isSafirUrl('http://localhost:3000/x') === false);
  test('SSRF: دامنه مجاز صفیر پذیرفته می‌شود', reserve.isSafirUrl('https://safirrail.ir/fa/captcha.jpg') === true);
  test('SSRF: data-URI پذیرفته می‌شود', reserve.isSafirUrl('data:image/png;base64,AAAA') === true);
  test('SSRF: مسیر نسبی پذیرفته می‌شود', reserve.isSafirUrl('/fa/captcha.png') === true);

  /* ۱۲) آی‌پی نرخ‌محدودسازی در برابر جعل XFF مقاوم است */
  const guard = require('../lib/guard');
  const ip1 = guard.getClientIp({
    headers: { 'x-forwarded-for': '6.6.6.6' },
    socket: { remoteAddress: '8.8.8.8' },
  });
  test('گارد: با اتصال مستقیم عمومی، XFF جعلی نادیده گرفته می‌شود', ip1 === '8.8.8.8');
  const ip2 = guard.getClientIp({
    headers: { 'x-vercel-forwarded-for': '5.5.5.5', 'x-forwarded-for': '6.6.6.6' },
    socket: { remoteAddress: '8.8.8.8' },
  });
  test('گارد: روی Vercel هدر x-vercel-forwarded-for ملاک است', ip2 === '5.5.5.5');

  /* ۱۳) کلید رمزنگاری در حالت اجبار امنیتی fail-closed است */
  const tokenLib = require('../lib/token.js');
  test('کتابخانه توکن در حالت توسعه بارگذاری می‌شود', typeof tokenLib.encryptState === 'function');
  const failClosed = require('child_process').execSync(
    "node -e \"process.env.BILITFAST_ENFORCE_SECURITY='1'; try { require('./lib/token.js').encryptState({a:1}); console.log('no-throw'); } catch(e){ console.log('threw'); }\"",
    { cwd: require('path').join(__dirname, '..') }
  ).toString().trim();
  test('کلید رمزنگاری در حالت اجبار امنیتی fail-closed است', failClosed === 'threw');

  /* ۱۴) نشانه نصب دسکتاپ (رجیستری + امضا) */
  const marker = require('../lib/install-marker');
  const days = (n) => new Date(Date.now() + n * 86400000).toISOString();
  const sigRecent = marker.signInstallMarker({ installDate: days(-1), deviceId: 'dev123', appVersion: '1.0.0' });
  const recent = marker.verifyInstallMarker(sigRecent);
  test('توکن نصب امضاشده درست خوانده می‌شود', !!recent && recent.deviceId === 'dev123');
  test('توکن نصب دستکاری‌شده (تاریخ) رد می‌شود', marker.verifyInstallMarker(sigRecent.slice(0, 5) + 'XXX' + sigRecent.slice(5)) === null);
  const sigOld = marker.signInstallMarker({ installDate: days(-30), deviceId: 'dev123', appVersion: '1.0.0' });
  // وضعیت آزمایشی مهمان بر اساس تاریخ نصب قدیمی باید منقضی باشد
  const trialApi = require('../api/trial');
  const resInst = { _json: null };
  resInst.status = function () { return this; };
  resInst.json = function (o) { this._json = o; return this; };
  await trialApi({
    method: 'POST',
    body: { action: 'status', install: { installDate: days(-30), deviceId: 'dev123', appVersion: '1.0.0', signature: sigOld } },
  }, resInst);
  test('نصب ۳۰ روز پیش → دوره آزمایشی منقضی (گِره به تاریخ نصب)', resInst._json.state === 'expired');

  const resInst2 = { _json: null };
  resInst2.status = function () { return this; };
  resInst2.json = function (o) { this._json = o; return this; };
  await trialApi({
    method: 'POST',
    body: { action: 'status', install: { installDate: days(-1), deviceId: 'dev123', appVersion: '1.0.0', signature: sigRecent } },
  }, resInst2);
  test('نصب دیروز → دوره آزمایشی فعال', resInst2._json.state === 'active');

  const resInstBad = { _json: null };
  resInstBad.status = function () { return this; };
  resInstBad.json = function (o) { this._json = o; return this; };
  await trialApi({
    method: 'POST',
    body: { action: 'status', install: { installDate: days(-1), deviceId: 'dev123', signature: 'bogus.sig' } },
  }, resInstBad);
  test('امضای نصب جعلی نادیده گرفته می‌شود', resInstBad._json.state === 'not_started' || resInstBad._json.source !== 'guest-install');

  /* ۱۵) رسید ارتباط با صفیر ریل (اثبات ارسال/دریافت واقعی) + سرعت پارس */
  const http2 = require('http');
  const rowHtml = '<tr name="srvc"><td>a</td><td><div>رجا</div></td><td>318</td><td>کوپه</td><td>x</td><td>y</td>' +
    '<td>1404/07/20</td><td>07:30</td><td>12</td><td>500,000</td><input name="srvc" value="v1"></tr>';
  const fakeHtml = '<html><body><table>' + rowHtml.repeat(4) + '</table></body></html>';
  await new Promise((resolve) => {
    const srv = http2.createServer((q, r) => {
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', server: 'nginx' });
      r.end(fakeHtml);
    });
    srv.listen(0, '127.0.0.1', async () => {
      const cfg = require('../config.json');
      const oldBase = cfg.base_url;
      cfg.base_url = 'http://127.0.0.1:' + srv.address().port;
      try {
        const core = require('../lib/core');
        const out = await core.searchOnce({
          fields: { from_city: 'تهران', to_city: 'مشهد', date: '1404/07/20', gender: 'عادی' },
          passengers: [{ quota_type: 'بزرگسال' }],
          cookies: ['PHPSESSID=abc'],
        });
        test('جستجو رسید ارتباط (receipt) برمی‌گرداند', !!out.receipt);
        test('رسید شامل کد وضعیت HTTP واقعی است', out.receipt && out.receipt.httpStatus === 200);
        test('رسید حجم پاسخ دریافتی را گزارش می‌کند', out.receipt && out.receipt.bytes > 0);
        test('رسید زمان پاسخ را اندازه می‌گیرد', out.receipt && typeof out.receipt.totalMs === 'number');
        test('رسید تعداد ردیف‌های بررسی‌شده را دارد', out.receipt && out.receipt.rowsParsed === 4);
        test('قطارها از پاسخ استخراج می‌شوند', Array.isArray(out.trains) && out.trains.length === 4);
      } catch (e) {
        test('جستجو رسید ارتباط (receipt) برمی‌گرداند', false);
      } finally {
        cfg.base_url = oldBase;
        srv.close(resolve);
      }
    });
  });

  // پارس مشترک: extractTrains باید هم رشته و هم شیء cheerio را بپذیرد
  const coreLib = require('../lib/core');
  const $doc = coreLib.loadHtml(fakeHtml);
  test('پارس یک‌باره: extractTrains شیء cheerio را می‌پذیرد', coreLib.extractTrains($doc, 0, null).length === 4);
  test('پارس یک‌باره: extractDiagnostics شیء cheerio را می‌پذیرد', coreLib.extractDiagnostics($doc).totalRows === 4);

  /* ۱۶) لایه شبکه بهینه */
  const httpLib = require('../lib/http');
  test('لایه شبکه safirFetch در دسترس است', typeof httpLib.safirFetch === 'function');
  const ph = httpLib.perfHeaders({ 'User-Agent': 'x' });
  test('هدر فشرده‌سازی gzip به درخواست‌ها اضافه می‌شود', /gzip/.test(ph['Accept-Encoding'] || ''));
  test('اتصال پایدار (keep-alive) درخواست می‌شود', /keep-alive/i.test(ph['Connection'] || ''));

  /* ۱۸) نگهدارنده خودکار نشست صفیر ریل (تازه‌سازی هر ۵ دقیقه) */
  const keeper = require('../lib/session-keeper');
  const dbLib = require('../lib/db');
  const httpMod = require('http');
  let loginHits = 0;
  await new Promise((resolve) => {
    const srv = httpMod.createServer((q, r) => {
      if (String(q.url).includes('UserAut')) {
        r.writeHead(200, { 'set-cookie': 'PHPSESSID=form; path=/', 'content-type': 'text/html' });
        return r.end('<html><form><input type="hidden" name="SiteIdValue" value="9">' +
          '<input name="user"><input name="pass"></form></html>');
      }
      if (String(q.url).includes('process.php')) {
        loginHits++;
        r.writeHead(302, { location: '/fa/panel.php', 'set-cookie': 'PHPSESSID=live' + loginHits + '; path=/' });
        return r.end('');
      }
      r.writeHead(200); return r.end('ok');
    });
    srv.listen(0, '127.0.0.1', async () => {
      const cfgMod = require('../config.json');
      const oldBase = cfgMod.base_url;
      cfgMod.base_url = 'http://127.0.0.1:' + srv.address().port;
      try {
        const u = dbLib.insert('users', { email: 'keeper-test@example.com', name: 'k' });
        keeper.saveCredentials(u.id, 'safiruser', 'safirpass');
        const stored = dbLib.findById('users', u.id);
        test('گذرواژه صفیر رمزنگاری‌شده ذخیره می‌شود (نه متن ساده)',
          !JSON.stringify(stored).includes('safirpass'));
        const back = keeper.readCredentials(stored);
        test('اعتبارنامه صفیر درست رمزگشایی می‌شود',
          !!back && back.username === 'safiruser' && back.password === 'safirpass');

        const r1 = await keeper.refreshUserSession(u.id);
        test('تازه‌سازی نشست کوکی PHPSESSID می‌گیرد',
          r1.ok && r1.cookies.some((c) => /PHPSESSID=live/.test(c)));
        const r2 = await keeper.refreshUserSession(u.id);
        test('هر تازه‌سازی کوکی جدید می‌دهد', r1.cookies[0] !== r2.cookies[0]);

        const st = keeper.getStatus(dbLib.findById('users', u.id));
        test('بازه تازه‌سازی خودکار ۵ دقیقه است', st.intervalMs === 5 * 60 * 1000);
        test('وضعیت نگهدارنده نشست فعال گزارش می‌شود', st.enabled === true && st.cookiesCount > 0);

        keeper.clearCredentials(u.id);
        const st2 = keeper.getStatus(dbLib.findById('users', u.id));
        test('خاموش کردن، اعتبارنامه را حذف می‌کند', st2.enabled === false && st2.hasCredentials === false);
        dbLib.remove('users', u.id);
      } catch (e) {
        test('نگهدارنده نشست صفیر کار می‌کند', false);
      } finally {
        cfgMod.base_url = oldBase;
        srv.close(resolve);
      }
    });
  });

  // بدون ورود به حساب برنامه نباید بتوان اعتبارنامه ذخیره کرد
  let credGuard = false;
  try { keeper.saveCredentials(null, 'a', 'b'); } catch (e) { credGuard = true; }
  test('ذخیره اعتبارنامه بدون حساب کاربری رد می‌شود', credGuard);

  /* ۱۹) پرداخت فقط در تب جدید (بدون جابه‌جایی صفحه کاربر) */
  const routeSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'route.html'), 'utf8');
  const payFn = routeSrc.slice(routeSrc.indexOf('function openPaymentWindow'),
    routeSrc.indexOf('function showPaymentLink'));
  test('انتقال به درگاه، صفحه کاربر را جابه‌جا نمی‌کند', !/window\.location\.href\s*=/.test(payFn));
  test('انتقال به درگاه از تب جدید استفاده می‌کند', /window\.open\(url,\s*'_blank'/.test(payFn));

  /* ۲۰) کد فعال‌سازی ثابت برنامه */
  test('کد فعال‌سازی ثابت Sa0946517835 پذیرفته می‌شود', license.isActivationCodeValid('Sa0946517835') === true);
  test('کد فعال‌سازی غلط رد می‌شود', license.isActivationCodeValid('Sa0000000000') === false);
  test('خروجی activationCode همان کد ثابت است', license.activationCode() === 'Sa0946517835');

  console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
  process.exit(failures === 0 ? 0 : 1);
})();
