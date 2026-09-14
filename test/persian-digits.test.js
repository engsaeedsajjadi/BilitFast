// -*- coding: utf-8 -*-
/**
 * test/persian-digits.test.js — باگ «۱۶ ردیف ولی found=0».
 *
 * علت ریشه‌ای: در پایتون ۳ الگوی \d یونیکد است و «۱۶» را می‌گیرد، ولی در
 * جاوااسکریپت فقط ASCII است. پورت مستقیم regex از BilitFast.py باعث می‌شد
 * ظرفیتِ نوشته‌شده با ارقام فارسی صفر خوانده شود و کاربر با وجود ظرفیت
 * خالی پیام «قطاری یافت نشد» ببیند.
 */

const core = require('../lib/core');

let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name); }
}

/* ---------- تبدیل ارقام ---------- */

test('رقم فارسی به لاتین تبدیل می‌شود', core.toLatinDigits('۱۲۳۴۵۶۷۸۹۰') === '1234567890');
test('رقم عربی به لاتین تبدیل می‌شود', core.toLatinDigits('٠١٢٣٤٥٦٧٨٩') === '0123456789');
test('رقم لاتین دست‌نخورده می‌ماند', core.toLatinDigits('12345') === '12345');
test('متن فارسی همراه رقم حفظ می‌شود', core.toLatinDigits('۱۶ نفر') === '16 نفر');
test('ورودی خالی خطا نمی‌دهد', core.toLatinDigits(null) === '' && core.toLatinDigits(undefined) === '');

/* ---------- خواندن ظرفیت ---------- */

test('ظرفیت با رقم فارسی خوانده می‌شود', core.parseCapacity('۱۶') === 16);
test('ظرفیت با رقم لاتین خوانده می‌شود', core.parseCapacity('16') === 16);
test('ظرفیت با رقم عربی خوانده می‌شود', core.parseCapacity('٤٢') === 42);
test('ظرفیت همراه متن فارسی خوانده می‌شود', core.parseCapacity('۱۶ نفر') === 16);
test('ظرفیت با برچسب خوانده می‌شود', core.parseCapacity('ظرفیت: ۴') === 4);
test('صفر فارسی صفر خوانده می‌شود', core.parseCapacity('۰') === 0);
test('«تکمیل» صفر خوانده می‌شود', core.parseCapacity('تکمیل') === 0);
test('متن خالی صفر خوانده می‌شود', core.parseCapacity('') === 0);
test('مقدار null صفر خوانده می‌شود', core.parseCapacity(null) === 0);

/* ---------- بازتولید باگ اصلی روی HTML واقعی ---------- */

/** ساخت صفحه نتایج شبیه ساختار صفیر ریل با ارقام دلخواه.
 * ترتیب ستون‌ها دقیقاً مطابق سلکتورهای config.json است:
 *   ۲=شرکت(div) ۳=شماره قطار ۴=نوع کوپه ۸=ساعت ۹=ظرفیت/موجودی ۱۰=قیمت
 */
function buildRows(capacities) {
  const rows = capacities.map((cap, i) => `
    <tr name="srvc">
      <td><input type="checkbox" name="srvc" value="S${i}"></td>
      <td><div>رجا</div></td>
      <td>${700 + i}</td>
      <td>اتوبوسی</td>
      <td>تهران</td>
      <td>مشهد</td>
      <td>۱۴۰۴/۰۷/۰۱</td>
      <td>۰۸:۳۰</td>
      <td>${cap}</td>
      <td>۱٬۲۰۰٬۰۰۰</td>
    </tr>`).join('');
  return `<html><body><table>${rows}</table></body></html>`;
}

// سناریوی گزارش‌شده: ۱۶ ردیف، همه با ظرفیت به رقم فارسی
const persianHtml = buildRows(['۱۶', '۸', '۲۴', '۴', '۱۲', '۶', '۳۲', '۲',
  '۱۰', '۱۸', '۵', '۹', '۲۰', '۷', '۱۴', '۳']);

const diag = core.extractDiagnostics(persianHtml);
test('تشخیص، ۱۶ ردیف را می‌بیند', diag.totalRows === 16);
test('تشخیص، ظرفیت تفسیرشده را گزارش می‌کند', diag.trains[0].capacity === 16);

const foundPersian = core.extractTrains(persianHtml, 1);
test('۱۶ قطار با ارقام فارسی پیدا می‌شوند (باگ اصلی)', foundPersian.length === 16);
test('ظرفیت نخستین قطار درست است', foundPersian[0]['ظرفیت'] === 16);
test('شماره قطار درست استخراج می‌شود', foundPersian[0]['شماره قطار'] === '700');
test('ساعت حرکت درست استخراج می‌شود', foundPersian[0]['ساعت حرکت'] === '۰۸:۳۰');
test('شرکت درست استخراج می‌شود', foundPersian[0]['شرکت'] === 'رجا');
test('مقدار srvc برای رزرو حفظ می‌شود', foundPersian[0]['srvc'] === 'S0');

// همان صفحه با ارقام لاتین باید نتیجه یکسان بدهد
const latinHtml = buildRows(['16', '8', '24', '4', '12', '6', '32', '2',
  '10', '18', '5', '9', '20', '7', '14', '3']);
const foundLatin = core.extractTrains(latinHtml, 1);
test('نتیجه ارقام فارسی و لاتین یکسان است', foundLatin.length === foundPersian.length);
test('ظرفیت‌ها در هر دو حالت یکسان‌اند',
  JSON.stringify(foundLatin.map((t) => t['ظرفیت'])) ===
  JSON.stringify(foundPersian.map((t) => t['ظرفیت'])));

/* ---------- فیلتر ظرفیت باید همچنان کار کند ---------- */

const mixed = buildRows(['۱۶', '۲', '۰', 'تکمیل', '۸']);
test('فیلتر ظرفیت ۱: قطارهای دارای جا', core.extractTrains(mixed, 1).length === 3);
test('فیلتر ظرفیت ۵: فقط ظرفیت کافی', core.extractTrains(mixed, 5).length === 2);
test('فیلتر ظرفیت ۱۰: فقط یک قطار', core.extractTrains(mixed, 10).length === 1);
test('فیلتر ظرفیت ۱۰۰: هیچ قطاری', core.extractTrains(mixed, 100).length === 0);
test('ظرفیت ۰ با نیاز ۰ رد نمی‌شود', core.extractTrains(mixed, 0).length === 5);

/* ---------- جستجوی قطار مشخص ---------- */

const one = core.extractTrains(persianHtml, 1, '700');
test('جستجوی شماره قطار مشخص کار می‌کند', one.length === 1 && one[0]['شماره قطار'] === '700');
test('شماره قطار ناموجود چیزی برنمی‌گرداند', core.extractTrains(persianHtml, 1, '999').length === 0);

console.log('');
if (fail) {
  console.log(fail + ' تست شکست خورد از ' + (pass + fail));
  process.exit(1);
}
console.log('همه ' + pass + ' تست ارقام فارسی پاس شدند');
