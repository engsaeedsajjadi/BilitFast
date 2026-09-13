// -*- coding: utf-8 -*-
/**
 * test/cookie-trace.test.js — گزارش گام‌به‌گام انتقال کوکی.
 *
 * چرا: کاربر گزارش داد دکمه‌های انتقال کوکی کار نمی‌کنند ولی هیچ‌کدام
 * نمی‌گفتند «کجا» شکست خوردند. زنجیره چند حلقه دارد — یافتن پروفایل،
 * باز کردن فایل، رمزگشایی، فیلتر دامنه، وجود PHPSESSID — و شکست هر حلقه
 * از بیرون یک‌شکل دیده می‌شود.
 *
 * این تست‌ها تضمین می‌کنند گزارش واقعاً نقطه شکست را نشان بدهد و در عین
 * حال هیچ مقدار کوکی یا مسیر کامل فایل را لو ندهد.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Module = require('module');

process.env.BILITFAST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-tr-'));
process.env.BILITFAST_LICENSE_KEY = 'test-license-key';
process.env.BILITFAST_SESSION_KEY = 'test-session-key';
process.env.BILITFAST_TOKEN_KEY = 'test-token-key';

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

const trace = require(path.join(ROOT, 'lib', 'cookie-trace.js'));

/* ---- رفتار پایه دفترچه ---- */
trace.clear();
trace.log('x', 'گام یک', { ok: true });
trace.log('x', 'گام دو', { ok: false });
let e = trace.getEntries();
test('گام‌ها به ترتیب ثبت می‌شوند',
  e.length === 2 && e[0].step === 'گام یک' && e[1].step === 'گام دو');
test('هر گام زمان دارد', typeof e[0].at === 'number');

trace.logError('x', 'خطا', Object.assign(new Error('boom'), { code: 'E1' }));
e = trace.getEntries();
test('خطا با کد ثبت می‌شود',
  e[2].error === 'boom' && e[2].code === 'E1' && e[2].ok === false);

trace.clear();
test('پاک کردن دفترچه کار می‌کند', trace.getEntries().length === 0);

/* ---- حریم خصوصی ---- */
test('مسیر فایل کوتاه می‌شود، نام کاربری لو نمی‌رود',
  trace.safePath('/home/someuser/.mozilla/firefox/p1/cookies.sqlite') === '…/firefox/p1/cookies.sqlite');
const names = trace.cookieNames(['PHPSESSID=SECRETVALUE', '_ga=GA1.2.9']);
test('فقط نام کوکی ثبت می‌شود، نه مقدار',
  names.join(',') === 'PHPSESSID,_ga' && !JSON.stringify(names).includes('SECRETVALUE'));

/* ---- دفترچه نباید بی‌نهایت رشد کند ---- */
trace.clear();
for (let i = 0; i < 400; i++) trace.log('s', 'i' + i);
test('دفترچه سقف دارد (نشت حافظه نمی‌دهد)', trace.getEntries().length <= 300);

/* ---- سناریوی واقعی: فایرفاکس با کوکی مهمان در WAL ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-ffp-'));
const profDir = path.join(tmp, 'abc.default');
fs.mkdirSync(profDir, { recursive: true });
const live = path.join(profDir, 'live.sqlite');
const snap = path.join(profDir, 'cookies.sqlite');

let built = true;
try {
  execFileSync('python3', ['-c', `
import sqlite3, shutil
p = ${JSON.stringify(live)}
con = sqlite3.connect(p)
con.execute('PRAGMA journal_mode=WAL')
con.execute('CREATE TABLE moz_cookies(name TEXT, value TEXT, host TEXT)')
con.execute("INSERT INTO moz_cookies VALUES('_ga','GA1.2.55','.safirrail.ir')")
con.execute("INSERT INTO moz_cookies VALUES('other','x','example.com')")
con.commit()
shutil.copy(p, ${JSON.stringify(snap)})
try: shutil.copy(p + '-wal', ${JSON.stringify(snap + '-wal')})
except Exception: pass
con.close()
`], { stdio: 'pipe' });
} catch (err) { built = false; }

(async () => {
  if (!built) {
    console.log('SKIP  ساخت پروفایل آزمایشی ممکن نشد');
  } else {
    // ماژول فایرفاکس را با مسیر پروفایل آزمایشی بارگذاری می‌کنیم
    const ckPath = require.resolve(path.join(ROOT, 'lib', 'cookies.js'));
    let src = fs.readFileSync(ckPath, 'utf8')
      .replace(/function getFirefoxProfileBases\(\) \{/,
        'function getFirefoxProfileBases() { return [' + JSON.stringify(tmp) + '];');
    const m = new Module(ckPath);
    m.filename = ckPath;
    m.paths = Module._nodeModulePaths(path.dirname(ckPath));
    trace.clear();
    m._compile(src, ckPath);
    const out = await m.exports.readFirefoxCookies();

    const entries = trace.getEntries();
    const steps = entries.map((x) => x.step);
    const result = entries.filter((x) => x.step === 'نتیجه')[0];

    test('گزارش، جستجوی پروفایل را ثبت می‌کند',
      steps.some((s) => /جستجوی پروفایل/.test(s)));
    test('گزارش، پیدا شدن فایل کوکی را ثبت می‌کند',
      steps.some((s) => /فایل‌های کوکی پیدا شد/.test(s)));
    test('گزارش، وجود فایل WAL را ثبت می‌کند',
      entries.some((x) => x.hasWal === true));
    test('گزارش، تعداد ردیف‌های جدول را ثبت می‌کند',
      entries.some((x) => x.totalRows === 2));
    test('گزارش، تعداد کوکی‌های دامنه صفیر ریل را ثبت می‌کند',
      entries.some((x) => x.matched === 1));
    test('گزارش صریح می‌گوید کوکی نشست وجود ندارد',
      !!result && result.hasSession === false);
    test('نام کوکی‌های پیداشده گزارش می‌شود',
      !!result && Array.isArray(result.names) && result.names.indexOf('_ga') !== -1);
    test('مقدار کوکی در گزارش نیست',
      !JSON.stringify(entries).includes('GA1.2.55'));
    test('کوکی دامنه دیگر وارد نتیجه نمی‌شود',
      out.length === 1 && /^_ga=/.test(out[0]));
  }

  /* ---- سیم‌کشی به مسیرهای واقعی ---- */
  const syncSrc = fs.readFileSync(path.join(ROOT, 'api', 'sync-cookies.js'), 'utf8');
  const connSrc = fs.readFileSync(path.join(ROOT, 'api', 'connect.js'), 'utf8');
  const chSrc = fs.readFileSync(path.join(ROOT, 'lib', 'chrome-cookies.js'), 'utf8');
  const loginSrc = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');

  test('دکمه همگام‌سازی گزارش را برمی‌گرداند', /trace: trace\.getEntries\(\)/.test(syncSrc));
  test('دکمه اتصال گزارش را برمی‌گرداند', /trace: trace\.getEntries\(\)/.test(connSrc));
  test('هر بار فشردن دکمه، گزارش تازه می‌شود', /trace\.clear\(\)/.test(syncSrc));
  test('کروم هم لاگ‌گذاری شده', /trace\.log\('chrome'/.test(chSrc));
  test('کلید رمزگشایی کروم گزارش می‌شود', /کلید رمزگشایی/.test(chSrc));
  test('رابط کاربری گزارش را نمایش می‌دهد', /function renderTrace/.test(loginSrc));
  test('گزارش برای دکمه‌های مرورگر نمایش داده می‌شود', /renderTrace\(data\.trace, 'sync-trace'\)/.test(loginSrc));
  test('گزارش حتی در حالت موفق هم در دسترس است',
    /renderTrace\(d\.trace, 'doctor-result'\)/.test(loginSrc));

  console.log('\n' + (fail === 0
    ? 'همه ' + pass + ' تست گزارش انتقال کوکی پاس شدند'
    : fail + ' تست شکست خورد از ' + (pass + fail)));
  process.exit(fail ? 1 : 0);
})();
