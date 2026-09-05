// -*- coding: utf-8 -*-
// تست‌های اسکیمای کانفیگ + تفکیک دیتاست + اطمینان + معیارها.
// اجرا: node test/ocr-config.test.js

const { validateConfig, charsetFor, loadOcrConfig } = require('../lib/ocr/config');
const { splitByIdentity, assertNoLeakage } = require('../lib/ocr/split');
const { sequenceConfidence, confidenceSummary, pickThreshold } = require('../lib/ocr/confidence');
const { editDistance, prf, confusionMatrix, fullReport } = require('../lib/ocr/metrics');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

/* ---------------- کانفیگ ---------------- */
{
  const { config, errors } = validateConfig({});
  test('کانفیگ خالی با پیش‌فرض‌ها معتبر است', errors.length === 0);
  test('پیش‌فرض حالت الفبایی', config.mode === 'alnum');
  test('کاراکترست الفبایی شامل ارقام', /[0-9]/.test(charsetFor(config)));

  const bad = validateConfig({ mode: 'hex', image: { inputSize: 'بیست' } });
  test('مقدار نامعتبر مود خطا می‌دهد', bad.errors.some((e) => e.includes('mode')));
  test('مقدار غیرعدد خطا می‌دهد', bad.errors.some((e) => e.includes('image.inputSize')));

  const bad2 = validateConfig({ benchmark: { ratios: { train: 0.9, val: 0.9, cal: 0.9, test: 0.9 } } });
  test('مجموع نسبت‌های نادرست خطا می‌دهد', bad2.errors.some((e) => e.includes('ratios')));

  const bad3 = validateConfig({ image: { inputSize: 20, innerSize: 20 } });
  test('innerSize ≥ inputSize خطا می‌دهد', bad3.errors.length > 0);

  const dig = validateConfig({ mode: 'digits' });
  test('حالت رقمی کاراکترست رقمی می‌دهد', charsetFor(dig.config) === '0123456789');
  test('کانفیگ ریپازیتوری معتبر است', (() => { try { loadOcrConfig(); return true; } catch (e) { return false; } })());
}

/* ---------------- تفکیک دیتاست ---------------- */
{
  const ids = Array.from({ length: 49 }, (_, i) => 'img' + i);
  const s1 = splitByIdentity(ids, { seed: 1397 });
  const s2 = splitByIdentity(ids, { seed: 1397 });
  const s3 = splitByIdentity(ids, { seed: 77 });
  test('بذر ثابت → تفکیک یکسان', JSON.stringify(s1) === JSON.stringify(s2));
  test('بذر دیگر → تفکیک دیگر', JSON.stringify(s1.test) !== JSON.stringify(s3.test));
  test('بدون نشت (هیچ شناسه‌ای در دو بخش نیست', assertNoLeakage(s1));
  const total = s1.train.length + s1.val.length + s1.cal.length + s1.test.length;
  test('همه شناسه‌ها تخصیص یافته‌اند', total === 49);
  test('هر چهار بخش غیرخالی‌اند', s1.train.length > 0 && s1.val.length > 0 && s1.cal.length > 0 && s1.test.length > 0);
  let threw = false;
  try { splitByIdentity(ids, { ratios: { train: 0.5, val: 0.5, cal: 0.5, test: 0.5 } }); } catch (e) { threw = true; }
  test('نسبت‌های نامعتبر استثنا می‌دهند', threw);
  // تفکیک روی داده کم
  const small = splitByIdentity(['a', 'b', 'c', 'd'], { seed: 1 });
  test('داده کم: همه بخش‌ها حداقل یک نمونه', small.train.length >= 1 && small.test.length >= 1);
}

/* ---------------- اطمینان ---------------- */
{
  const high = sequenceConfidence([0.9, 0.9, 0.9, 0.9, 0.9]);
  const low = sequenceConfidence([0.9, 0.9, 0.2, 0.9, 0.9]);
  test('اطمینان توالی با یک کاراکتر ضعیف افت می‌کند', low < high - 0.1);
  test('اطمینان توالی در بازه [0,1]', high >= 0 && high <= 1);
  const lenPen = sequenceConfidence([0.9, 0.9], { expectedLength: 5 });
  const lenOk = sequenceConfidence([0.9, 0.9, 0.9, 0.9, 0.9], { expectedLength: 5 });
  test('طول نادرست جریمه دارد', lenPen < sequenceConfidence([0.9, 0.9]));
  test('توافق آنسامبل اطمینان را بالا می‌برد',
    sequenceConfidence([0.8, 0.8], { agreement: 1 }) > sequenceConfidence([0.8, 0.8], { agreement: 0 }));
  const sum = confidenceSummary([0.7, 0.5, 0.9]);
  test('خلاصه اطمینان: کمینه/میانگین/توالی جدا هستند',
    Math.abs(sum.minCharConf - 0.5) < 1e-9 && Math.abs(sum.meanCharConf - 0.7) < 1e-9 && sum.sequenceConf > 0);

  const calRows = [
    { confidence: 0.9, correct: true }, { confidence: 0.85, correct: true },
    { confidence: 0.8, correct: true }, { confidence: 0.6, correct: false },
    { confidence: 0.5, correct: false }, { confidence: 0.2, correct: false },
  ];
  const th = pickThreshold(calRows);
  test('آستانه کالیبراسیون بین دو خوشه می‌نشیند', th.threshold >= 0.6 && th.threshold <= 0.9 && th.f1 === 1);
}

/* ---------------- معیارها ---------------- */
{
  test('فاصله ویرایش', editDistance('abc', 'axc') === 1 && editDistance('', 'abc') === 3);
  const pairs = [{ pred: 'ab5', gt: 'abc' }, { pred: 'abc', gt: 'abc' }];
  const f = prf(pairs);
  test('P/R/F1: دو اشتباه → کمتر از ۱', f.precision < 1 && f.recall < 1 && f.f1 > 0.8);
  const cm = confusionMatrix(pairs, ['a', 'b', 'c', '5']);
  test('ماتریس درهم‌ریختگی قطر درست', cm.a.a === 2 && cm.b.b === 2 && cm.c.c === 1 && cm.c['5'] === 1);
  const rep = fullReport([
    { pred: 'abc', gt: 'abc', confidence: 0.9, timeMs: 10 },
    { pred: 'abx', gt: 'abc', confidence: 0.4, timeMs: 20 },
  ]);
  test('گزارش کامل: دقیقاً نیمی', rep.exactMatch === 1 && Math.abs(rep.sequenceAccuracy - 0.5) < 1e-9);
  test('نرخ شکست صفر (هیچ‌کدام خطای فنی نبودند)', rep.failureRate === 0);
  test('CER میانگین نرمال‌شده', rep.cer > 0 && rep.cer < 0.5);
}

if (failures) { console.log(failures + ' تست ناموفق'); process.exit(1); }
console.log('\nهمه تست‌ها پاس شدند');
