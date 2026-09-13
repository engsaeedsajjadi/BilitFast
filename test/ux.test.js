// -*- coding: utf-8 -*-
/**
 * test/ux.test.js — تست‌های رگرسیون برای بهبودهای تجربه کاربری.
 * هر تست یکی از یافته‌های بازبینی UX را پوشش می‌دهد و مطمئن می‌شود
 * عناصر لازم (و مهم‌تر: شناسه‌هایی که کد به آن‌ها وابسته است) باقی مانده‌اند.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

const index = read('public/index.html');
const login = read('public/login.html');
const route = read('public/route.html');
const css = read('public/style.css');
const picker = read('public/city-picker.js');

/* ---- ۱) صفحه ورود: مسیر ساده اول، فنی در بخش بازشونده ---- */
// به‌روزرسانی: کارت برجسته دیگر «افزونه» نیست. بازبینی بعدی نشان داد چهار
// روش موازی، بارِ تصمیم فنی را روی کاربر می‌گذاشت؛ حالا یک دکمه «اتصال
// هوشمند» همه روش‌ها را خودش امتحان می‌کند و افزونه به بخش جایگزین رفت.
test('کارت برجسته، اتصال یک‌دکمه‌ای را ارائه می‌دهد',
  /method-card recommended/.test(login) && /id="btn-smart-connect"/.test(login));
test('روش‌های پیشرفته داخل بخش بازشونده جمع شده‌اند',
  /<details class="advanced-block">/.test(login));
const advStart = login.indexOf('advanced-block');
test('همگام‌سازی Firefox/Chrome داخل بخش پیشرفته است',
  advStart > 0 && login.indexOf('btn-sync-firefox') > advStart);
test('چسباندن دستی کوکی داخل بخش پیشرفته است',
  advStart > 0 && login.indexOf('id="cookie-input"') > advStart);
test('ورود مستقیم قبل از بخش پیشرفته می‌آید',
  login.indexOf('id="login-form"') < advStart);

/* ---- ۵) اصطلاحات فنی داخل راهنمای پیشرفته ---- */
const httpOnlyIdx = login.indexOf('HttpOnly');
test('توضیح HttpOnly/Application→Cookies داخل بخش جمع‌شونده است',
  httpOnlyIdx > advStart && /چرا کپی کردن کوکی از کنسول/.test(login));
test('PHPSESSID دیگر در هشدار اصلی صفحه نیست',
  login.indexOf('PHPSESSID') > advStart);

/* ---- ۲) شرط دو حسابی، صریح و مرحله‌ای ---- */
test('پیش‌نیاز دو مرحله‌ای نمایش داده می‌شود',
  /prereq-box/.test(login) && /حساب BilitFast/.test(login) && /شناسه و گذرواژه صفیر ریل/.test(login));
test('لینک ساخت/ورود حساب برنامه در پیش‌نیاز هست', /id="prereq-link"/.test(login));
test('وضعیت زنده مراحل پیش‌نیاز به‌روز می‌شود', /function refreshPrereq/.test(login));
test('استایل مرحله انجام‌شده تعریف شده است', /\.prereq-steps li\.done/.test(css));

/* ---- ۳) فرم مسافران روی موبایل کارت می‌شود ---- */
test('جدول مسافران کلاس واکنش‌گرا دارد', /class="table pass-table"/.test(route));
test('هر سلول برچسب فیلد دارد (برای نمای کارتی)',
  (route.match(/data-label="/g) || []).length >= 7);
test('در موبایل جدول به کارت تبدیل می‌شود',
  /@media \(max-width: 760px\)[\s\S]{0,1200}\.pass-table tr \{[\s\S]{0,200}display: block/.test(css) ||
  /\.pass-table, \.pass-table tbody, \.pass-table tr, \.pass-table td \{ display: block/.test(css));
test('عنوان «مسافر N» روی کارت‌ها نمایش داده می‌شود', /counter-increment: passenger-row/.test(css));
test('فیلدهای عددی صفحه‌کلید عددی موبایل را باز می‌کنند',
  (route.match(/inputmode="numeric"/g) || []).length >= 4);

/* ---- ۴) انتخابگر شهر با جستجو ---- */
test('اسکریپت انتخابگر شهر در صفحه مسیر بارگذاری می‌شود', /src="city-picker\.js"/.test(route));
test('انتخابگر روی مبدا و مقصد فعال می‌شود', /BilitCityPicker\.attach\(\['bf_src', 'bf_dst'\]/.test(route));
test('select اصلی حفظ شده (سازگاری کد موجود)',
  /id="bf_src"/.test(route) && /id="bf_dst"/.test(route));
test('شهرهای پرتکرار تعریف شده‌اند', /POPULAR\s*=\s*\[[^\]]*تهران/.test(picker));
test('شهر انتخاب‌شده برجسته می‌شود', /\.city-item\.selected/.test(css));

// رفتار واقعی جستجو (نرمال‌سازی ی/ک عربی)
const sandbox = { window: {}, document: { createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, appendChild() {}, setAttribute() {}, addEventListener() {} }) } };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(picker, sandbox);
const CP = sandbox.BilitCityPicker;
test('انتخابگر شهر قابل بارگذاری است', !!(CP && typeof CP.norm === 'function'));
test('جستجو به «ی» عربی و فارسی حساس نیست', CP.norm('يزد') === CP.norm('یزد'));
test('جستجو به «ک» عربی و فارسی حساس نیست', CP.norm('كرمان') === CP.norm('کرمان'));

/* ---- ۶) راهنمای شروع در صفحه اصلی ---- */
test('راهنمای شروع سریع در صفحه اصلی هست', /id="quickstart"/.test(index));
test('راهنما هر چهار گام را دارد',
  /یک مسیر جدید بسازید/.test(index) && /اطلاعات مسافران/.test(index) &&
  /به صفیر ریل وارد شوید/.test(index) && /جستجو را شروع کنید/.test(index));
test('راهنما پس از ساخت مسیر یا بستن، پنهان می‌شود',
  /function updateQuickstart/.test(index) && /bilitfast_quickstart_hidden/.test(index));
test('دکمه بستن راهنما وجود دارد', /id="qs-hide"/.test(index));

/* ---- ۷) پنل ارتباط: حالت ساده و فنی ---- */
test('کلید تغییر حالت ساده/فنی وجود دارد', /id="live-tech-toggle"/.test(route));
test('خط وضعیت ساده برای کاربر غیرفنی هست', /id="live-simple"/.test(route));
test('حالت پیش‌فرض ساده است (متریک‌های فنی پنهان)',
  /#live-panel \.live-metrics,[\s\S]{0,120}display: none/.test(css));
test('در حالت فنی، متریک‌ها و لاگ نمایش داده می‌شوند',
  /#live-panel\.tech-mode \.live-metrics \{ display: flex/.test(css) &&
  /#live-panel\.tech-mode #live-log-details \{ display: block/.test(css));
test('انتخاب حالت کاربر ذخیره می‌شود', /bilitfast_live_tech_mode/.test(route));
test('پیام‌های ساده بدون اصطلاح فنی‌اند',
  /ظرفیت پیدا شد/.test(route) && /سامانه پاسخ نداد/.test(route) && /در حال جستجو/.test(route));

/* ---- سلامت کلی: هیچ شناسه‌ای که JS به آن وابسته است گم نشده ---- */
const requiredIds = [
  ['login', login, ['login-form', 'username', 'password', 'keep-session', 'alert', 'btn-health',
    'health-result', 'session-keeper-card', 'ses-dot', 'ses-title', 'ses-state', 'ses-count',
    'ses-last', 'ses-next', 'ses-hint', 'btn-ses-refresh', 'btn-ses-pull', 'btn-ses-clear',
    'btn-ext-sync', 'ext-sync-result', 'btn-account-cookies', 'account-cookie-card',
    'account-cookie-result', 'btn-sync-firefox', 'btn-sync-chrome', 'sync-result',
    'cookie-input', 'btn-save-cookies', 'cookie-warn']],
  ['route', route, ['bf_src', 'bf_dst', 'passengers-table', 'btn-add-row', 'btn-save-profile',
    'profile-select', 'bf_contact', 'btn-start', 'btn-stop', 'status', 'attempt-badge',
    'live-panel', 'live-dot', 'live-title', 'live-log', 'next-bar-fill', 'next-text',
    'm-ok', 'm-fail', 'm-code', 'm-ms', 'm-size', 'm-rows', 'm-last']],
  ['index', index, ['btn-add-route', 'btn-group-start', 'btn-close-all', 'routes-table',
    'monitor-badge', 'trial-badge', 'group-links']],
];
for (const [page, src, ids] of requiredIds) {
  const missing = ids.filter((id) => !src.includes('id="' + id + '"'));
  test('صفحه ' + page + ': همه شناسه‌های مورد نیاز JS موجودند' +
    (missing.length ? ' (گم‌شده: ' + missing.join(', ') + ')' : ''), missing.length === 0);
}

// اسکریپت‌های درون‌خطی همه صفحات باید نحو درست داشته باشند
for (const [name, src] of [['index', index], ['login', login], ['route', route]]) {
  let ok = true;
  for (const m of src.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    try { new vm.Script(m[1]); } catch (e) { ok = false; }
  }
  test('نحو جاوااسکریپت صفحه ' + name + ' درست است', ok);
}

console.log('\n' + (fail === 0
  ? 'همه ' + pass + ' تست تجربه کاربری پاس شدند'
  : fail + ' تست شکست خورد از ' + (pass + fail)));
process.exit(fail ? 1 : 0);
