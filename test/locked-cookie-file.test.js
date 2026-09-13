// -*- coding: utf-8 -*-
/**
 * test/locked-cookie-file.test.js — خواندن فایل کوکیِ قفل‌شده توسط مرورگرِ باز.
 *
 * از لاگ واقعی کاربر (ویندوز):
 *   EBUSY: resource busy or locked, open
 *   'C:\Users\hp\AppData\Local\Google\Chrome\User Data\Profile 18\Network\Cookies'
 *
 * چرا این باگ کشنده بود: ویندوز قفل اجباری دارد. تا وقتی کروم باز است،
 * فایل کوکیِ پروفایلِ فعال با readFileSync باز نمی‌شود. یعنی دقیقاً همان
 * پروفایلی که کاربر در آن وارد صفیر ریل شده — تنها پروفایلی که به درد
 * می‌خورد — رد می‌شد، و در عوض پروفایل‌های بی‌ربط (۲۱۸ کوکی، هیچ‌کدام
 * safirrail.ir) خوانده می‌شدند. نتیجه: «کوکی یافت نشد».
 *
 * راه‌حل: کپی گرفتن در پوشه موقت و خواندن از روی کپی.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-lock-'));
const walPath = require.resolve(path.join(ROOT, 'lib', 'sqlite-wal.js'));

/** اجرای تابع با شبیه‌سازی قفل ویندوز روی یک فایل مشخص. */
function withLockedFile(target, code, fn) {
  const realRead = fs.readFileSync;
  const realCopy = fs.copyFileSync;
  let copyUsed = false;
  let tmpLeft = null;
  fs.readFileSync = function (p, ...a) {
    if (String(p) === target) {
      const e = new Error(code + ': resource busy or locked, open ' + p);
      e.code = code;
      throw e;
    }
    return realRead.call(fs, p, ...a);
  };
  fs.copyFileSync = function (src, dst) {
    if (String(src) === target) { copyUsed = true; tmpLeft = dst; }
    return realCopy.call(fs, src, dst);
  };
  try {
    const out = fn();
    return { out, copyUsed, tmpLeft, error: null };
  } catch (e) {
    return { out: null, copyUsed, tmpLeft, error: e };
  } finally {
    fs.readFileSync = realRead;
    fs.copyFileSync = realCopy;
  }
}

delete require.cache[walPath];
const { readDatabase, readPossiblyLocked } = require(walPath);

/* ---- بازتولید و رفع باگ ---- */
const locked = path.join(tmp, 'Cookies');
fs.writeFileSync(locked, Buffer.from('SQLite format 3\u0000REAL_COOKIE_DATA'));

let r = withLockedFile(locked, 'EBUSY', () => readDatabase(locked));
test('فایل قفل‌شده (EBUSY) دیگر خطا نمی‌دهد', r.error === null);
test('برای دور زدن قفل، از کپی استفاده می‌شود', r.copyUsed === true);
test('محتوای واقعی فایل خوانده می‌شود',
  !!r.out && r.out.toString().indexOf('REAL_COOKIE_DATA') !== -1);
test('فایل موقت پس از خواندن باقی نمی‌ماند',
  !r.tmpLeft || !fs.existsSync(r.tmpLeft));

/* ---- سایر کدهای قفل ویندوز ---- */
r = withLockedFile(locked, 'EPERM', () => readDatabase(locked));
test('EPERM هم با کپی حل می‌شود', r.error === null && r.copyUsed === true);

r = withLockedFile(locked, 'EACCES', () => readDatabase(locked));
test('EACCES هم با کپی حل می‌شود', r.error === null && r.copyUsed === true);

/* ---- خطاهایی که نباید بلعیده شوند ---- */
r = withLockedFile(locked, 'ENOENT', () => readPossiblyLocked(locked));
test('فایل ناموجود همچنان خطا می‌دهد (پنهان نمی‌شود)',
  r.error !== null && r.error.code === 'ENOENT');
test('برای ENOENT بیهوده کپی گرفته نمی‌شود', r.copyUsed === false);

/* ---- مسیر عادی نباید کند یا خراب شود ---- */
const normal = path.join(tmp, 'normal.sqlite');
fs.writeFileSync(normal, Buffer.from('SQLite format 3\u0000NORMAL'));
const realCopy = fs.copyFileSync;
let copiedWhenNotNeeded = false;
fs.copyFileSync = function (...a) { copiedWhenNotNeeded = true; return realCopy.apply(fs, a); };
const normalOut = readDatabase(normal);
fs.copyFileSync = realCopy;
test('فایل غیرقفل مستقیم خوانده می‌شود (بدون کپی اضافه)', copiedWhenNotNeeded === false);
test('فایل غیرقفل درست خوانده می‌شود',
  normalOut.toString().indexOf('NORMAL') !== -1);

/* ---- برچسب مرورگر در لاگ ---- */
const chSrc = fs.readFileSync(path.join(ROOT, 'lib', 'chrome-cookies.js'), 'utf8');
test('لاگ نام مرورگر را مشخص می‌کند', /function browserLabel/.test(chSrc));
test('Edge از Chrome تفکیک می‌شود', /return 'Edge'/.test(chSrc));
test('خطای خواندن فایل هم نام مرورگر دارد',
  /خطا در خواندن فایل[\s\S]{0,200}browser: browserLabel/.test(chSrc));
test('کد خطا در لاگ ثبت می‌شود', /code: \(e && e\.code\)/.test(chSrc));

/* ---- سیم‌کشی ---- */
const ffSrc = fs.readFileSync(path.join(ROOT, 'lib', 'cookies.js'), 'utf8');
test('فایرفاکس هم از مسیر مقاوم استفاده می‌کند', /readDatabase\(file\)/.test(ffSrc));
test('کروم هم از مسیر مقاوم استفاده می‌کند', /readDatabase\(file\)/.test(chSrc));

console.log('\n' + (fail === 0
  ? 'همه ' + pass + ' تست فایل قفل‌شده پاس شدند'
  : fail + ' تست شکست خورد از ' + (pass + fail)));
process.exit(fail ? 1 : 0);
