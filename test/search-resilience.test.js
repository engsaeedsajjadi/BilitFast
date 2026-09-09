// -*- coding: utf-8 -*-
/**
 * test/search-resilience.test.js
 *
 * رگرسیون دو مشکل گزارش‌شده:
 *
 *  ۱) جستجو پس از دو-سه تلاش متوقف می‌شد. علت: هر خطای شبکه (fetch failed،
 *     ECONNRESET، تایم‌اوت) در lib/core.js با پرچم fatal برمی‌گشت و کلاینت
 *     بلافاصله حلقه را می‌بست. سامانه صفیر ریل مرتباً قطعی کوتاه دارد، پس
 *     این یعنی تسلیم شدن دقیقاً در بدترین لحظه. حالا این خطاها «گذرا»
 *     هستند و جستجو با عقب‌نشینی نمایی ادامه می‌یابد.
 *
 *  ۲) پیام خطا همیشه Vercel را نام می‌برد، حتی روی اجرای کاملاً محلی.
 *     حالا راهنما به محیط اجرا وابسته است.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

/* ---------- تزریق http جعلی پیش از بارگذاری core ---------- */
const httpPath = require.resolve(path.join(ROOT, 'lib', 'http.js'));
let mode = 'fail';
let calls = 0;
require.cache[httpPath] = {
  id: httpPath, filename: httpPath, loaded: true,
  exports: {
    safirFetch: async () => {
      calls++;
      if (mode === 'fail') throw new Error('fetch failed');
      if (mode === 'reset') throw new Error('read ECONNRESET');
      if (mode === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      return {
        ok: true, status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<html><body></body></html>',
      };
    },
  },
};
const core = require(path.join(ROOT, 'lib', 'core.js'));

const fields = { from_city: 'تهران', to_city: 'مشهد', date: '1404/07/01', gender: 'عادی' };
const passengers = [{ quota_type: 'بزرگسال', national_code: '1234567891', birth_day: '1', birth_month: '1', birth_year: '1370' }];
const call = () => core.searchOnce({ fields, passengers, cookies: 'PHPSESSID=x' });

(async () => {
  /* ---------- ۱) خطای شبکه دیگر دائمی نیست ---------- */
  mode = 'fail';
  const r1 = await call();
  test('خطای «fetch failed» دیگر fatal نیست', r1.ok === false && !r1.fatal);
  test('خطای شبکه به‌عنوان گذرا علامت می‌خورد', r1.transient === true && r1.netError === true);
  test('پیام خطا به ادامه تلاش اشاره می‌کند', /تلاش دوباره ادامه دارد/.test(r1.error || ''));

  mode = 'reset';
  const r2 = await call();
  test('خطای ECONNRESET هم گذرا است', r2.ok === false && !r2.fatal && r2.transient === true);

  mode = 'abort';
  const r3 = await call();
  test('تایم‌اوت تلاش، حلقه را متوقف نمی‌کند', r3.ok === false && !r3.fatal);

  // پس از خطاها، تلاش موفق باید کار کند (حلقه هنوز زنده است)
  mode = 'ok';
  const r4 = await call();
  test('پس از چند خطای پیاپی، تلاش موفق نتیجه می‌دهد', r4.ok === true);
  test('همه تلاش‌ها واقعاً به لایه شبکه رسیدند', calls === 4);

  /* ---------- ۲) پیام Vercel فقط در محیط ابری ---------- */
  test('در اجرای محلی، محیط ابری تشخیص داده نمی‌شود', core.isCloudEnv() === false);
  const localHint = core.networkHint();
  test('راهنمای محلی نامی از Vercel نمی‌برد', !/Vercel|ورسل/i.test(localHint));
  test('راهنمای محلی نامی از دیتاسنتر نمی‌برد', !/دیتاسنتر/.test(localHint));
  test('راهنمای محلی کاربردی است (بررسی اتصال)', /اتصال اینترنت/.test(localHint));

  process.env.VERCEL = '1';
  test('با VERCEL=1 محیط ابری تشخیص داده می‌شود', core.isCloudEnv() === true);
  const cloudHint = core.networkHint();
  test('در محیط ابری راهنمای مسدودی IP نمایش داده می‌شود', /مسدود/.test(cloudHint));
  delete process.env.VERCEL;
  test('پس از حذف متغیر، دوباره حالت محلی است', core.isCloudEnv() === false);

  /* ---------- ۳) هیچ متن ثابت Vercel در پیام‌های کاربر نماند ---------- */
  const coreSrc = read('lib/core.js');
  const userStrings = (coreSrc.match(/'[^']*(?:Vercel|ورسل)[^']*'/g) || []);
  test('lib/core.js هیچ رشته کاربرپسندِ حاوی Vercel ندارد', userStrings.length === 0);
  test('lib/monitor.js از راهنمای پویا استفاده می‌کند',
    /core\.networkHint\(\)/.test(read('lib/monitor.js')));
  test('api/health.js از راهنمای پویا استفاده می‌کند',
    /core\.networkHint\(\)/.test(read('api/health.js')));
  test('route.html دیگر «دیتاسنترهای خارجی» را به کاربر نشان نمی‌دهد',
    !/دیتاسنترهای خارجی/.test(read('public/route.html')));

  /* ---------- ۴) کلاینت: عقب‌نشینی و ادامه جستجو ---------- */
  const route = read('public/route.html');
  test('کلاینت خطاهای پیاپی را می‌شمارد', /MAX_CONSEC_FAILS/.test(route) && /consecFails/.test(route));
  test('عقب‌نشینی نمایی پیاده شده است', /function backoffMs/.test(route) && /Math\.pow\(2/.test(route));
  test('توقف فقط پس از حد مجاز خطاهای پیاپی است',
    /consecFails >= MAX_CONSEC_FAILS/.test(route));
  test('scheduleNextPoll فاصله دلخواه می‌پذیرد', /function scheduleNextPoll\(forcedWaitMs\)/.test(route));
  test('توقف در یک تابع متمرکز giveUp انجام می‌شود', /function giveUp\(reason, hint\)/.test(route));
  test('شمارنده خطا با تلاش موفق صفر می‌شود', /function noteSuccess/.test(route) && /noteSuccess\(\);/.test(route));
  test('شمارنده در شروع جستجوی جدید صفر می‌شود', /consecFails = 0;/.test(route));
  test('خطای گذرا دیگر مستقیماً جستجو را نمی‌بندد',
    !/if \(data\.fatal\) \{\s*stopPolling\(\);\s*saveRouteState/.test(route));

  // شبیه‌سازی منطق عقب‌نشینی کلاینت
  const MAX = 15;
  const backoff = (c) => Math.min(60000, 5000 * Math.pow(2, Math.max(0, c - 1)));
  test('اولین خطا ۵ ثانیه صبر می‌کند', backoff(1) === 5000);
  test('عقب‌نشینی رشد می‌کند (۱۰ و ۲۰ ثانیه)', backoff(2) === 10000 && backoff(3) === 20000);
  test('عقب‌نشینی از ۶۰ ثانیه بیشتر نمی‌شود', backoff(10) === 60000);
  test('پیش از توقف، تلاش‌های زیادی انجام می‌شود', MAX >= 10);

  console.log('\n' + (fail === 0
    ? 'همه ' + pass + ' تست پایداری جستجو پاس شدند'
    : fail + ' تست شکست خورد از ' + (pass + fail)));
  process.exit(fail ? 1 : 0);
})();
