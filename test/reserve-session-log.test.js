// -*- coding: utf-8 -*-
/**
 * test/reserve-session-log.test.js — تشخیص علت «نیاز به ورود» در رزرو.
 *
 * زمینه از لاگ واقعی کاربر: هنگام رزرو، سایت صفحه ورود برمی‌گرداند
 * (classification: "login") و این چهار بار پشت سر هم تکرار شد.
 *
 * مشکل تشخیصی: این وضعیت دو علت کاملاً متفاوت دارد که راه‌حلشان فرق
 * می‌کند، ولی هر دو یک پیام یکسان می‌گرفتند:
 *   الف) هیچ کوکی نشستی به رزرو نرسیده — زنجیره قبل از سایت پاره شده
 *   ب) کوکی رسیده ولی سایت ردش کرده — نشست منقضی است
 *
 * حالا لاگ RESERVATION_STARTED تعداد و نام کوکی‌ها را ثبت می‌کند و پیام
 * خطا این دو حالت را تفکیک می‌کند.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

const src = fs.readFileSync(path.join(ROOT, 'lib', 'reserve.js'), 'utf8');

/* ---- لاگ کوکی در شروع رزرو ---- */
test('شروع رزرو تعداد کوکی را ثبت می‌کند', /cookieCount: jarNames\.length/.test(src));
test('شروع رزرو نام کوکی‌ها را ثبت می‌کند', /cookieNames: jarNames/.test(src));
test('شروع رزرو وجود کوکی نشست را ثبت می‌کند', /hasSessionCookie: jarNames\.some/.test(src));
test('مقدار کوکی در لاگ ثبت نمی‌شود (فقط نام)',
  /String\(c\)\.split\('='\)\[0\]/.test(src));
test('تعداد نام‌های ثبت‌شده محدود است (لاگ منفجر نشود)',
  /jarNames\.slice\(0, 20\)/.test(src));

/* ---- تفکیک دو حالت در پیام ---- */
test('حالت «کوکی نرسیده» پیام مخصوص دارد',
  /هیچ نشست فعالی به سامانه صفیر ریل ارسال نشد/.test(src));
test('حالت «کوکی رسیده ولی رد شد» پیام مخصوص دارد',
  /نشست شما در سامانه صفیر ریل پذیرفته نشد/.test(src));
test('انتخاب پیام بر اساس وجود واقعی کوکی نشست است',
  /sentSession\s*\?/.test(src));
test('تعداد کوکی ارسالی به پاسخ اضافه می‌شود',
  /extra\.sentCookieCount/.test(src));
test('وضعیت کوکی نشست به پاسخ اضافه می‌شود',
  /extra\.sentSessionCookie/.test(src));

/* ---- پیام کاربرپسند ---- */
const msgLines = src.split('\n').filter((l) => /^\s*message = /.test(l));
test('اصطلاح فنی PHPSESSID به کاربر نهایی نشان داده نمی‌شود',
  !msgLines.some((l) => /PHPSESSID/.test(l)));
test('کاربر به صفحه دیگری حواله نمی‌شود',
  !msgLines.some((l) => /در صفحه «ورود»/.test(l)));

/* ---- منطق حساس نباید شکسته باشد ---- */
test('طبقه‌بندی login همچنان به login_required می‌رسد',
  /case 'login'[\s\S]{0,400}step = 'login_required'/.test(src));
test('مسیر کپچا دست‌نخورده است', /case 'captcha'/.test(src));
test('مسیر موفقیت دست‌نخورده است', /case 'success'/.test(src));
test('مسیر پرداخت دست‌نخورده است', /case 'payment'/.test(src));

/* ---- ماژول باید سالم بارگذاری شود ---- */
let loaded = true;
try { require(path.join(ROOT, 'lib', 'reserve.js')); } catch (e) { loaded = false; }
test('ماژول رزرو بدون خطا بارگذاری می‌شود', loaded);

/* ---- تور ایمنی همچنان به رزرو وصل است ---- */
const reserveApi = fs.readFileSync(path.join(ROOT, 'api', 'reserve.js'), 'utf8');
test('رزرو قبل از شروع، نشست را جبران می‌کند',
  /ensureCookies\(body\.cookies\)/.test(reserveApi));

console.log('\n' + (fail === 0
  ? 'همه ' + pass + ' تست تشخیص نشست رزرو پاس شدند'
  : fail + ' تست شکست خورد از ' + (pass + fail)));
process.exit(fail ? 1 : 0);
