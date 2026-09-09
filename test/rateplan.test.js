// تست‌های «نرخ تطبیقی جستجو» برای پایش همزمان مسیرها (lib/rateplan.js)
// اجرا: node test/rateplan.test.js

const { monitorIntervalMs, MAX_CONCURRENT_MONITORS, MIN_GAP_MS } = require('../lib/rateplan');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

// با rnd=0.5 جیتر صفر است و اعداد دقیق به دست می‌آیند.
// elapsed=0 یعنی درخواست قبلی زمانی نبرده (حالت مرجع).
test('یک مسیر → همان فاصله پایه', monitorIntervalMs(2000, 1, 0.5, 0) === 2000);
test('دو مسیر → دو برابر فاصله پایه', monitorIntervalMs(2000, 2, 0.5, 0) === 4000);
test('پنج مسیر → پنج برابر فاصله پایه', monitorIntervalMs(2000, 5, 0.5, 0) === 10000);

test('سقف: بیش از ۵ مسیر هم مثل ۵ مسیر است', monitorIntervalMs(2000, 99, 0.5, 0) === 10000);
test('ورودی صفر/نامعتبر مثل یک مسیر رفتار می‌کند', monitorIntervalMs(2000, 0, 0.5, 0) === 2000);

test('جیتر: حداقل ۸۵٪ فاصله', monitorIntervalMs(2000, 2, 0, 0) === Math.round(4000 * 0.85));
test('جیتر: حداکثر ۱۱۵٪ فاصله', monitorIntervalMs(2000, 2, 1, 0) === Math.round(4000 * 1.15));

test('کف مطلق ' + MIN_GAP_MS + ' میلی‌ثانیه رعایت می‌شود',
  monitorIntervalMs(300, 1, 0, 0) === MIN_GAP_MS);

test('نرخ مجموع تقریباً ثابت می‌ماند (فاصله × تعداد ≈ ثابت)', (() => {
  const base = 3000;
  for (let n = 1; n <= MAX_CONCURRENT_MONITORS; n++) {
    const total = monitorIntervalMs(base, n, 0.5, 0) / n; // سهم هر مسیر از نرخ
    if (Math.abs(total - base) > base * 0.01) return false;
  }
  return true;
})());

/* ---- فاصله از «شروع تا شروع» سنجیده می‌شود، نه از پایان پاسخ ----
 * باگ گزارش‌شده: وقتی سامانه کند بود (پاسخ ۹.۵ ثانیه)، برنامه کل فاصله
 * پایه را *بعد از* پاسخ صبر می‌کرد و فاصله واقعی به ۱۲.۵ ثانیه می‌رسید. */
test('زمان صرف‌شده درخواست از فاصله کسر می‌شود',
  monitorIntervalMs(3000, 1, 0.5, 1000) === 2000);
test('درخواست کند، انتظار اضافه ایجاد نمی‌کند',
  monitorIntervalMs(3000, 1, 0.5, 9549) === MIN_GAP_MS);
// تا وقتی زمان پاسخ کمتر از (base - کف) باشد، فاصله شروع‌تا‌شروع دقیقاً
// برابر base می‌ماند. فراتر از آن، کف MIN_GAP_MS غالب می‌شود (رفتار درست:
// هرگز سریع‌تر از کف به سایت درخواست نمی‌زنیم).
test('فاصله کل شروع‌تا‌شروع تقریباً ثابت می‌ماند', (() => {
  const base = 3000;
  for (const spent of [0, 500, 1500, base - MIN_GAP_MS]) {
    const total = spent + monitorIntervalMs(base, 1, 0.5, spent);
    if (Math.abs(total - base) > 1) return false;
  }
  return true;
})());
test('پس از عبور از آستانه، کف غالب می‌شود نه فاصله پایه', (() => {
  const base = 3000, spent = 2900; // بیش از base - MIN_GAP_MS
  return monitorIntervalMs(base, 1, 0.5, spent) === MIN_GAP_MS;
})());
test('حتی با پاسخ بسیار کند، کف فاصله حفظ می‌شود',
  monitorIntervalMs(3000, 1, 0.5, 60000) === MIN_GAP_MS);
test('کف با تعداد مسیر مقیاس می‌خورد (فشار به سایت کنترل شود)',
  monitorIntervalMs(3000, 3, 0.5, 60000) === MIN_GAP_MS * 3);
test('نبود elapsed مثل صفر رفتار می‌کند (سازگاری عقب‌رو)',
  monitorIntervalMs(2000, 1, 0.5) === 2000);

/* ---- هم‌ارزی فرمول کلاینت و سرور ----
 * public/app.js نسخه‌ای از همین فرمول دارد؛ اگر واگرا شوند رفتار مرورگر
 * با تست‌ها یکی نخواهد بود. */
const appSrc = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
test('کلاینت هم زمان سپری‌شده را کسر می‌کند',
  /target \+ jitter - spent/.test(appSrc));
test('کلاینت همان کف MIN_GAP_MS را دارد',
  /const MIN_GAP_MS = 1000;/.test(appSrc) && /MIN_GAP_MS \* n/.test(appSrc));

console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
process.exit(failures === 0 ? 0 : 1);
