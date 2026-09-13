// -*- coding: utf-8 -*-
/**
 * test/session-recovery.test.js
 *
 * مشکل گزارش‌شده: «صفحه رزرو نیاز به ورود دارد. کوکی‌های نشست (PHPSESSID)
 * معتبر نیست. در صفحه ورود کوکی‌ها را همگام‌سازی کنید.»
 *
 * ریشه: کوکی نشست صفیر ریل عمر محدود دارد و در sessionStorage مرورگر
 * می‌نشیند. هیچ‌چیز آن را تازه نمی‌کرد. وقتی ظرفیت پیدا می‌شد و رزرو شروع
 * می‌شد، اگر نشست منقضی شده بود برنامه فقط پیام خطا می‌داد و کاربر باید
 * دستی به صفحه ورود می‌رفت — یعنی از دست دادن همان ظرفیتی که ساعت‌ها
 * دنبالش بوده.
 *
 * راه‌حل: بازیابی خودکار نشست از طریق /api/connect، هم پیش از شروع رزرو
 * (پیشگیرانه) و هم در واکنش به login_required (درمانی).
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

const route = read('public/route.html');
const reserve = read('lib/reserve.js');

/* ---- ۱) تشخیص درست صفحه ورود در لایه رزرو (نباید عوض شود) ---- */
test('لایه رزرو هنوز صفحه «ورود» را تشخیص می‌دهد',
  /case 'login':/.test(reserve) && /step = 'login_required'/.test(reserve));

/* ---- ۲) بازیابی خودکار نشست ---- */
test('تابع بازیابی نشست وجود دارد', /async function recoverSession\(\)/.test(route));
test('بازیابی از endpoint اتصال هوشمند استفاده می‌کند',
  /recoverSession[\s\S]{0,400}\/api\/connect/.test(route));
test('کوکی تازه در مرورگر نشانده می‌شود',
  /recoverSession[\s\S]{0,500}BilitFast\.setCookies\(d\.cookies\)/.test(route));
test('از اجرای همزمان چند بازیابی جلوگیری می‌شود',
  /sessionRecoveryInFlight/.test(route));

/* ---- ۳) واکنش به login_required: تلاش خودکار، نه تسلیم ---- */
test('login_required دیگر مستقیماً پیام خطا نمی‌دهد',
  !/case 'login_required':\s*\n\s*showReserveError/.test(route));
test('login_required به کنترل‌کننده اختصاصی می‌رود',
  /case 'login_required':\s*\n\s*handleLoginRequired\(data\);/.test(route));
test('کنترل‌کننده یک بار خودکار نشست را تازه می‌کند',
  /async function handleLoginRequired/.test(route) && /loginRetryDone/.test(route));
test('پس از تازه‌سازی، همان رزرو ادامه می‌یابد',
  /handleLoginRequired[\s\S]{0,700}await reserveStart\(\)/.test(route));
test('هر رزرو جدید یک فرصت بازیابی تازه دارد', /loginRetryDone = false;/.test(route));

/* ---- ۴) اگر خودکار نشد: راهنمای عملی، نه بن‌بست ---- */
test('دکمه «اتصال دوباره» به کاربر داده می‌شود', /btn-fix-session/.test(route));
test('دکمه، رزرو را از همان‌جا ادامه می‌دهد',
  /btn-fix-session[\s\S]{0,900}await reserveStart\(\)/.test(route));
test('لینک صفحه ورود هم به‌عنوان راه آخر هست',
  /btn-fix-session[\s\S]{0,400}login\.html/.test(route));

/* ---- ۵) پیشگیری: بررسی نشست پیش از شروع رزرو ---- */
test('اگر کوکی نداریم، پیش از رزرو گرفته می‌شود',
  /if \(!BilitFast\.getCookies\(\)\.length\)[\s\S]{0,200}await recoverSession\(\)/.test(route));
test('پیشگیری قبل از reserveStart انجام می‌شود',
  route.indexOf('!BilitFast.getCookies().length') < route.indexOf('async function reserveStart'));

/* ---- ۶) پیام‌ها به زبان کاربر ---- */
test('پیام تازه‌سازی برای کاربر قابل فهم است',
  /در حال اتصال دوباره|در حال تازه‌سازی خودکار/.test(route));
test('پیام فنی PHPSESSID به کاربر نهایی تحمیل نمی‌شود',
  /نشست شما در سامانه صفیر ریل منقضی شده است/.test(route));

/* ---- ۷) سازگاری: چیزی از جریان رزرو نشکسته ---- */
test('جریان رزرو دست‌نخورده باقی مانده',
  /async function reserveStart/.test(route) && /async function reserveSubmit/.test(route)
  && /async function callReserve/.test(route));
test('حلقه کپچای خودکار دست‌نخورده است', /async function autoSolveLoop/.test(route));
const ids = ['reserve-section', 'reserve-error', 'reserve-message', 'btn-captcha-submit'];
const missing = ids.filter((id) => !route.includes('id="' + id + '"'));
test('شناسه‌های رزرو سالم‌اند' + (missing.length ? ' (گم‌شده: ' + missing.join(', ') + ')' : ''),
  missing.length === 0);

console.log('\n' + (fail === 0
  ? 'همه ' + pass + ' تست بازیابی نشست پاس شدند'
  : fail + ' تست شکست خورد از ' + (pass + fail)));
process.exit(fail ? 1 : 0);
