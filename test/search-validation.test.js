// تست‌های اعتبارسنجی جستجو (بدون شبکه): مبدا=مقصد، ورودی ناقص، تاریخ نامعتبر
// اجرا: node test/search-validation.test.js

const { searchOnce } = require('../lib/core');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

const onePassenger = [{ quota_type: 'بزرگسال' }];

(async () => {
  // مبدا = مقصد → باید پیش از هر درخواست شبکه رد شود
  let r = await searchOnce({
    fields: { from_city: 'مشهد', to_city: 'مشهد', date: '1404/06/10', gender: 'عادی' },
    passengers: onePassenger,
  });
  test('مبدا=مقصد رد می‌شود', r.ok === false && /یکسان/.test(r.error));

  // شهر نامعتبر
  r = await searchOnce({
    fields: { from_city: 'شهر-وجود-ندارد', to_city: 'مشهد', date: '1404/06/10' },
    passengers: onePassenger,
  });
  test('شهر نامعتبر رد می‌شود', r.ok === false);

  // تاریخ با فرمت اشتباه
  r = await searchOnce({
    fields: { from_city: 'تهران', to_city: 'مشهد', date: '2025-01-01' },
    passengers: onePassenger,
  });
  test('فرمت تاریخ میلادی رد می‌شود', r.ok === false && /تاریخ/.test(r.error));

  // بدون مسافر
  r = await searchOnce({
    fields: { from_city: 'تهران', to_city: 'مشهد', date: '1404/06/10' },
    passengers: [],
  });
  test('بدون مسافر رد می‌شود', r.ok === false);

  console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('خطای غیرمنتظره:', e); process.exit(1); });
