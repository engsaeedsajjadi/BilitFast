// تست‌های «نرخ تطبیقی جستجو» برای پایش همزمان مسیرها (lib/rateplan.js)
// اجرا: node test/rateplan.test.js

const { monitorIntervalMs, MAX_CONCURRENT_MONITORS } = require('../lib/rateplan');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

// با rnd=0.5 جیتر صفر است و اعداد دقیق به دست می‌آیند
test('یک مسیر → همان فاصله پایه', monitorIntervalMs(2000, 1, 0.5) === 2000);
test('دو مسیر → دو برابر فاصله پایه', monitorIntervalMs(2000, 2, 0.5) === 4000);
test('پنج مسیر → پنج برابر فاصله پایه', monitorIntervalMs(2000, 5, 0.5) === 10000);

test('سقف: بیش از ۵ مسیر هم مثل ۵ مسیر است', monitorIntervalMs(2000, 99, 0.5) === 10000);
test('ورودی صفر/نامعتبر مثل یک مسیر رفتار می‌کند', monitorIntervalMs(2000, 0, 0.5) === 2000);

test('جیتر: حداقل ۸۵٪ فاصله', monitorIntervalMs(2000, 2, 0) === Math.round(4000 * 0.85));
test('جیتر: حداکثر ۱۱۵٪ فاصله', monitorIntervalMs(2000, 2, 1) === Math.round(4000 * 1.15));

test('کف مطلق ۱۵۰۰ میلی‌ثانیه رعایت می‌شود', monitorIntervalMs(300, 1, 0) === 1500);

test('نرخ مجموع تقریباً ثابت می‌ماند (فاصله × تعداد ≈ ثابت)', (() => {
  const base = 3000;
  for (let n = 1; n <= MAX_CONCURRENT_MONITORS; n++) {
    const total = monitorIntervalMs(base, n, 0.5) / n; // سهم هر مسیر از نرخ
    if (Math.abs(total - base) > base * 0.01) return false;
  }
  return true;
})());

console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
process.exit(failures === 0 ? 0 : 1);
