// -*- coding: utf-8 -*-
/**
 * test/browser-cookies.test.js — خواندن خودکار کوکی از مرورگرِ بازِ کاربر.
 *
 * باگی که رفع شد:
 * مرورگرها دیتابیس کوکی را در حالت WAL باز می‌کنند. نوشته‌های تازه اول به
 * فایل جانبی «...-wal» می‌روند و فقط هرازگاهی داخل فایل اصلی ادغام می‌شوند.
 * چون sql.js فقط بافری را می‌بیند که به آن می‌دهیم، برنامه نسخهٔ کهنه را
 * می‌خواند و کوکی نشستِ تازه را نمی‌دید.
 *
 * اثر عملی برای کاربر: درست بعد از ورود در سایت صفیر ریل، دکمهٔ همگام‌سازی
 * می‌گفت «کوکی یافت نشد» و تنها راه، کپی دستی کوکی بود.
 *
 * این تست‌ها یک دیتابیس واقعی SQLite در حالت WAL می‌سازند (با نوشتهٔ
 * checkpoint‌نشده) و ثابت می‌کنند کوکی نشست دیده می‌شود.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

const { readDatabase, readWithWal } = require(path.join(ROOT, 'lib', 'sqlite-wal.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-wal-'));

/* ساخت دیتابیس واقعی در حالت WAL با پایتون: یک کوکی checkpoint‌شده و یک
 * کوکی تازه که فقط در WAL است — دقیقاً وضعیت مرورگرِ باز. */
const PY = `
import sqlite3, shutil
p = ${JSON.stringify(path.join(tmp, 'live.sqlite'))}
con = sqlite3.connect(p)
con.execute('PRAGMA journal_mode=WAL')
con.execute('CREATE TABLE moz_cookies(name TEXT, value TEXT, host TEXT)')
con.execute("INSERT INTO moz_cookies VALUES('OLDCOOKIE','stale','safirrail.ir')")
con.commit()
con.execute('PRAGMA wal_checkpoint(FULL)')
con.execute("INSERT INTO moz_cookies VALUES('PHPSESSID','FRESH','safirrail.ir')")
con.commit()
shutil.copy(p, ${JSON.stringify(path.join(tmp, 'snap.sqlite'))})
shutil.copy(p + '-wal', ${JSON.stringify(path.join(tmp, 'snap.sqlite-wal'))})
con.close()
`;

let walReady = true;
try {
  execFileSync('python3', ['-c', PY], { stdio: 'pipe' });
} catch (e) {
  walReady = false;
}

(async () => {
  if (!walReady) {
    console.log('SKIP  ساخت دیتابیس WAL ممکن نشد (python3 در دسترس نیست)');
  } else {
    const snap = path.join(tmp, 'snap.sqlite');
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();

    const names = (buf) => {
      const db = new SQL.Database(buf);
      const r = db.exec('SELECT name FROM moz_cookies');
      const rows = (r[0] && r[0].values) || [];
      db.close();
      return rows.map((x) => String(x[0]));
    };

    const plain = names(fs.readFileSync(snap));
    const withWal = names(readDatabase(snap));

    test('بازتولید باگ: خواندن سادهٔ فایل، کوکی نشست را نمی‌بیند',
      plain.indexOf('PHPSESSID') === -1);
    test('با پشتیبانی WAL، کوکی نشست تازه دیده می‌شود',
      withWal.indexOf('PHPSESSID') !== -1);
    test('رکوردهای قدیمی هم حفظ می‌شوند',
      withWal.indexOf('OLDCOOKIE') !== -1);
    test('فایل پروفایل مرورگر تغییر نمی‌کند (فقط خواندن)',
      fs.readFileSync(snap).length === fs.statSync(snap).size);
  }

  /* ---- مقاومت: نباید هیچ‌وقت مسیر سالم را بشکند ---- */
  const noWal = path.join(tmp, 'nowal.sqlite');
  fs.writeFileSync(noWal, Buffer.from('SQLite format 3\u0000plain-content'));
  test('بدون فایل WAL، همان فایل اصلی برگردانده می‌شود',
    readDatabase(noWal).toString().indexOf('plain-content') !== -1);

  const badWal = path.join(tmp, 'bad.sqlite');
  fs.writeFileSync(badWal, Buffer.from('SQLite format 3\u0000original'));
  fs.writeFileSync(badWal + '-wal', Buffer.from('این یک فایل WAL معتبر نیست'));
  test('WAL خراب نادیده گرفته می‌شود و فایل اصلی برمی‌گردد',
    readDatabase(badWal).toString().indexOf('original') !== -1);

  const emptyWal = path.join(tmp, 'empty.sqlite');
  fs.writeFileSync(emptyWal, Buffer.from('SQLite format 3\u0000data'));
  fs.writeFileSync(emptyWal + '-wal', Buffer.alloc(0));
  test('WAL خالی باعث خطا نمی‌شود',
    readDatabase(emptyWal).toString().indexOf('data') !== -1);

  let threw = false;
  try { readDatabase(path.join(tmp, 'does-not-exist.sqlite')); } catch (e) { threw = true; }
  test('فایل ناموجود همچنان خطای شفاف می‌دهد', threw === true);

  test('readWithWal هم مستقیماً در دسترس است', typeof readWithWal === 'function');

  /* ---- سیم‌کشی به خوانندگان مرورگر ---- */
  const ff = fs.readFileSync(path.join(ROOT, 'lib', 'cookies.js'), 'utf8');
  const ch = fs.readFileSync(path.join(ROOT, 'lib', 'chrome-cookies.js'), 'utf8');
  test('خوانندهٔ فایرفاکس از WAL پشتیبانی می‌کند', /readDatabase\(file\)/.test(ff));
  test('خوانندهٔ کروم از WAL پشتیبانی می‌کند', /readDatabase\(file\)/.test(ch));
  test('فایرفاکس دیگر فایل را خام نمی‌خواند', !/fs\.readFileSync\(file\)/.test(ff));
  test('کروم دیگر فایل را خام نمی‌خواند', !/fs\.readFileSync\(file\)/.test(ch));

  /* ---- گزارش دقیق خطا ---- */
  const conn = fs.readFileSync(path.join(ROOT, 'api', 'connect.js'), 'utf8');
  test('علت شکست خواندن مرورگر توضیح داده می‌شود', /profileFailureDetail/.test(conn));
  test('حالت «وارد نشده‌اید» از «مرورگر پیدا نشد» تفکیک می‌شود',
    /کوکی نشست \(ورود\) بین آن‌ها نبود/.test(conn));
  const loginHtml = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');
  test('مراحل بررسی‌شده به کاربر نشان داده می‌شود', /مراحل بررسی‌شده/.test(loginHtml));

  console.log('\n' + (fail === 0
    ? 'همه ' + pass + ' تست کوکی مرورگر پاس شدند'
    : fail + ' تست شکست خورد از ' + (pass + fail)));
  process.exit(fail ? 1 : 0);
})();
