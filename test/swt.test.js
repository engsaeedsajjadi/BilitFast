// تست‌های «تحلیل عرض ضربه» (SWT) در lib/imageops.js
// اجرا: node test/swt.test.js
const ops = require('../lib/imageops');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

/** ساخت تصویر دودویی (0=جوهر) با اشکال ساده. */
function make(W, H, draw) {
  const img = ops.makeImage(W, H);
  draw((x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) img.data[y * W + x] = 0; });
  return img;
}

/* ---------- تبدیل فاصله ---------- */
{
  // مربع ۵×۵: فاصلهٔ مرکز تا پس‌زمینه = ۳، لبه‌ها = ۱
  const sq = make(9, 9, (px) => { for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) px(x, y); });
  const d = ops.distanceTransform(sq);
  test('تبدیل فاصله: لبهٔ مربع ۵×۵ مقدار ۱ دارد', d[2 * 9 + 2] === 1);
  test('تبدیل فاصله: مرکز مربع ۵×۵ مقدار ۳ دارد', d[4 * 9 + 4] === 3);
  test('تبدیل فاصله: پس‌زمینه صفر است', d[0] === 0);
}

/* ---------- فیلتر عرض ضربه ---------- */
{
  // یک مربع پهن ۷×۷ + یک خط نازک ۱پیکسلی که از آن عبور می‌کند
  const img = make(30, 20, (px) => {
    for (let y = 6; y < 13; y++) for (let x = 4; x < 11; x++) px(x, y);
    for (let x = 0; x < 30; x++) px(x, 10); // خط افقی نازک
  });
  const out = ops.strokeWidthFilter(img, { coreWidth: 5, allowWidth: 3 });
  // بدنهٔ مربع باید بماند
  test('فیلتر عرض ضربه: بدنهٔ کاراکتر پهن حفظ می‌شود', out.data[9 * 30 + 7] === 0);
  // دنبالهٔ خط نازک در سمت دور از مربع باید حذف شود
  test('فیلتر عرض ضربه: خط نازکِ متصل حذف می‌شود', out.data[10 * 30 + 25] === 255);
  // تصویر یکسره نازک دست نخورده برمی‌گردد
  const thin = make(20, 20, (px) => { for (let x = 0; x < 20; x++) px(x, 10); });
  const same = ops.strokeWidthFilter(thin);
  test('فیلتر عرض ضربه: تصویر کاملاً نازک دست نمی‌خورد', same === thin);
}

/* ---------- واریانس جهت ضربه ---------- */
{
  // خط افقی کاملاً راست → واریانس نزدیک صفر
  const line = make(40, 10, (px) => { for (let x = 2; x < 38; x++) { px(x, 4); px(x, 5); } });
  const dvLine = ops.strokeDirectionVariance(line);
  test('واریانس جهت: خط راست نزدیک صفر است', dvLine < 0.15);
  // شکل L (دو جهت عمود بر هم) → واریانس به‌وضوح بزرگ‌تر
  const ell = make(30, 30, (px) => {
    for (let y = 4; y < 26; y++) { px(6, y); px(7, y); }
    for (let x = 6; x < 26; x++) { px(x, 24); px(x, 25); }
  });
  const dvEll = ops.strokeDirectionVariance(ell);
  test('واریانس جهت: شکل L بزرگ‌تر از خط راست است', dvEll > dvLine + 0.2);
}

/* ---------- آمار ضربه (تشخیص خط از کاراکتر) ---------- */
{
  // خط مورب بلند و نازک
  const diag = make(50, 50, (px) => { for (let i = 2; i < 48; i++) { px(i, i); px(i, i + 1); } });
  const stLine = ops.strokeStats(diag);
  // کاراکتر جمع‌شده (مربع توخالی مثل «0»)
  const zero = make(30, 40, (px) => {
    for (let y = 4; y < 36; y++) for (let x = 6; x < 24; x++) {
      const border = y < 7 || y > 32 || x < 9 || x > 20;
      if (border) px(x, y);
    }
  });
  const stChar = ops.strokeStats(zero);
  test('آمار ضربه: عرض ضربهٔ خط نازک ≤ ۴ است', stLine.w <= 4);
  test('آمار ضربه: نسبت نواری خط ≈ ۱ یا کمتر', stLine.ribbon <= 1.15);
  test('آمار ضربه: کاراکتر حلقوی نسبت نواری بزرگ‌تری دارد', stChar.ribbon > stLine.ribbon);
  test('آمار ضربه: جهت محور اصلی خط مورب بین ۲۰ تا ۷۰ درجه است', stLine.orient > 20 && stLine.orient < 70);
  test('آمار ضربه: جهت محور اصلی «0» تقریباً عمودی است', stChar.orient > 70);
}

console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : `\n${failures} تست ناموفق بود`);
process.exit(failures === 0 ? 0 : 1);
