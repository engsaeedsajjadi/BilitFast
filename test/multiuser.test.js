// -*- coding: utf-8 -*-
/**
 * test/multiuser.test.js — جداسازی کاربران، مجوزدهی، سهمیه و امنیت نشست.
 *
 * این تست‌ها روی یک دیتابیس موقت اجرا می‌شوند (BILITFAST_DATA_DIR) تا داده
 * واقعی کاربر هرگز دست نخورد.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

// دیتابیس موقت + کلیدهای ثابت، پیش از بارگذاری هر ماژول پروژه
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-multiuser-'));
process.env.BILITFAST_DATA_DIR = TMP;
process.env.BILITFAST_SESSION_KEY = 'a'.repeat(64);
process.env.BILITFAST_LICENSE_KEY = 'b'.repeat(64);
process.env.BILITFAST_TOKEN_KEY = 'c'.repeat(64);
process.env.BILITFAST_MULTIUSER = '1';

const db = require('../lib/db');
const auth = require('../lib/auth');
const accounts = require('../lib/accounts');
const apiauth = require('../lib/apiauth');
const activity = require('../lib/activity');

let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name); }
}

/** پاسخ ساختگی برای بررسی کد وضعیت و بدنه. */
function mockRes() {
  return {
    code: null, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function reqWith(token) {
  return { headers: token ? { authorization: 'Bearer ' + token } : {}, socket: { remoteAddress: '127.0.0.1' } };
}

/* ============ ۱) ساخت کاربران ============ */

const A = auth.registerUser('usera', 'passwordA1');
const B = auth.registerUser('userb', 'passwordB1');
test('ساخت کاربر A موفق است', A.ok === true);
test('ساخت کاربر B موفق است', B.ok === true);
test('نام کاربری تکراری رد می‌شود', auth.registerUser('usera', 'other123').ok === false);
test('گذرواژه کوتاه رد می‌شود', auth.registerUser('userc', '12').ok === false);

/* ============ ۲) پیش‌فرض امن برای کاربران قدیمی ============ */

const legacy = accounts.normalizeUser({ id: 'x', username: 'old' });
test('کاربر قدیمی بدون فیلد نقش، نقش user می‌گیرد', legacy.role === 'user');
test('کاربر قدیمی به‌صورت پیش‌فرض فعال است', legacy.is_active === true);
test('کاربر قدیمی محدودیت جستجو ندارد', legacy.max_searches === null);
test('حساب کاربر قدیمی مجاز شمرده می‌شود', accounts.accountStatus(legacy).ok === true);

/* ============ ۳) جداسازی نشست دو کاربر ============ */

const sessA = auth.verifySession(A.token);
const sessB = auth.verifySession(B.token);
test('توکن A به کاربر A اشاره می‌کند', sessA.uid === A.user.id);
test('توکن B به کاربر B اشاره می‌کند', sessB.uid === B.user.id);
test('توکن دو کاربر یکسان نیست', A.token !== B.token);

const rA = apiauth.resolveUser(reqWith(A.token), {});
const rB = apiauth.resolveUser(reqWith(B.token), {});
test('نشست A کاربر A را برمی‌گرداند', rA.user && rA.user.id === A.user.id);
test('نشست B کاربر B را برمی‌گرداند', rB.user && rB.user.id === B.user.id);
test('کاربر A با توکن خود به کاربر B نمی‌رسد', rA.user.id !== rB.user.id);

/* ============ ۴) توکن دستکاری‌شده ============ */

const tampered = A.token.slice(0, -4) + 'AAAA';
test('توکن دستکاری‌شده رد می‌شود', auth.verifySession(tampered) === null);
test('توکن بی‌معنا رد می‌شود', auth.verifySession('garbage') === null);
test('توکن خالی رد می‌شود', auth.verifySession('') === null);

/* ============ ۵) جداسازی کوکی صفیر ریل ============ */

db.update('users', A.user.id, { safir_cookies: ['PHPSESSID=AAA111', 'cookname=alice'] });
db.update('users', B.user.id, { safir_cookies: ['PHPSESSID=BBB222', 'cookname=bob'] });
const freshA = db.findById('users', A.user.id);
const freshB = db.findById('users', B.user.id);
test('کوکی A و B متفاوت‌اند', freshA.safir_cookies[0] !== freshB.safir_cookies[0]);
test('کوکی A متعلق به خود A است', freshA.safir_cookies[0] === 'PHPSESSID=AAA111');
test('کوکی B متعلق به خود B است', freshB.safir_cookies[0] === 'PHPSESSID=BBB222');

// نمای عمومی و نمای ادمین نباید کوکی یا هش گذرواژه لو بدهند
const pub = auth.publicUser(freshA);
test('نمای عمومی کاربر شامل کوکی صفیر نیست', !('safir_cookies' in pub));
test('نمای عمومی کاربر شامل هش گذرواژه نیست', !('pass' in pub));
const av = accounts.adminView(freshA);
test('نمای ادمین شامل کوکی صفیر نیست', !('safir_cookies' in av));
test('نمای ادمین شامل هش گذرواژه نیست', !('pass' in av));
test('نمای ادمین شامل اعتبارنامه صفیر نیست', !('safir_credentials' in av));

/* ============ ۶) بازیابی کوکی نباید بین کاربران نشت کند ============ */

const fallback = require('../lib/session-fallback');
(async () => {
  // کاربری که اعتبارنامه ندارد نباید کوکی کاربر دیگر یا نشست محلی را بگیرد
  const out = await fallback.ensureCookies([], db.findById('users', B.user.id));
  test('کاربر بدون اعتبارنامه، کوکی بازیابی‌شده نمی‌گیرد',
    out.recovered === false && out.cookies.length === 0);

  const withSess = await fallback.ensureCookies(['PHPSESSID=zzz'], db.findById('users', A.user.id));
  test('اگر کوکی نشست موجود باشد، دست نمی‌خورد',
    withSess.recovered === false && withSess.cookies[0] === 'PHPSESSID=zzz');
  finish();
})();

/* ============ ۷) حساب غیرفعال و منقضی ============ */

const C = auth.registerUser('userc2', 'passwordC1');
accounts.applyAdminPatch(C.user.id, { is_active: false });
const cFresh = db.findById('users', C.user.id);
test('حساب غیرفعال مجاز نیست', accounts.accountStatus(cFresh).ok === false);
test('دلیل رد، غیرفعال بودن است', accounts.accountStatus(cFresh).reason === 'disabled');

const D = auth.registerUser('userd2', 'passwordD1');
accounts.applyAdminPatch(D.user.id, { expires_at: new Date(Date.now() - 86400000).toISOString() });
const dFresh = db.findById('users', D.user.id);
test('حساب منقضی مجاز نیست', accounts.accountStatus(dFresh).ok === false);
test('دلیل رد، انقضا است', accounts.accountStatus(dFresh).reason === 'expired');

const E = auth.registerUser('usere2', 'passwordE1');
accounts.applyAdminPatch(E.user.id, { expires_at: new Date(Date.now() + 86400000).toISOString() });
test('حساب با انقضای فردا مجاز است', accounts.accountStatus(db.findById('users', E.user.id)).ok === true);

// غیرفعال‌سازی باید نشست‌های باز را ببندد
const resC = mockRes();
const gateC = apiauth.requireUser(reqWith(C.token), resC, {}, { allowLocal: false });
test('کاربر غیرفعال با توکن قبلی رد می‌شود', gateC.ok === false);
test('کد پاسخ کاربر غیرفعال 403 است', resC.code === 403);

/* ============ ۸) ابطال نشست پس از خروج ============ */

const F = auth.registerUser('userf2', 'passwordF1');
test('پیش از خروج، نشست زنده است',
  accounts.isSessionLive(db.findById('users', F.user.id), auth.verifySession(F.token)) === true);
accounts.revokeSessions(F.user.id);
test('پس از خروج، توکن قدیمی باطل است',
  accounts.isSessionLive(db.findById('users', F.user.id), auth.verifySession(F.token)) === false);

const resF = mockRes();
const gateF = apiauth.requireUser(reqWith(F.token), resF, {}, { allowLocal: false });
test('توکن باطل‌شده به API راه ندارد', gateF.ok === false && resF.code === 401);

// ورود دوباره باید توکن معتبر بدهد
const reF = auth.loginUser('userf2', 'passwordF1');
test('ورود مجدد پس از خروج موفق است', reF.ok === true);
test('توکن تازه پس از خروج معتبر است',
  accounts.isSessionLive(db.findById('users', F.user.id), auth.verifySession(reF.token)) === true);

/* ============ ۹) گذرواژه نادرست ============ */

test('گذرواژه نادرست رد می‌شود', auth.loginUser('usera', 'wrongpass').ok === false);
test('کاربر ناموجود رد می‌شود', auth.loginUser('nobody999', 'whatever').ok === false);
test('گذرواژه به‌صورت متن ساده ذخیره نشده است',
  JSON.stringify(db.findById('users', A.user.id).pass).indexOf('passwordA1') === -1);
test('هش گذرواژه از scrypt است', db.findById('users', A.user.id).pass.alg === 'scrypt');

/* ============ ۱۰) کنترل دسترسی مبتنی بر نقش ============ */

const ADM = auth.registerUser('admin1', 'adminPass1');
accounts.applyAdminPatch(ADM.user.id, { role: 'admin' });
const TES = auth.registerUser('tester1', 'testerPass1');
accounts.applyAdminPatch(TES.user.id, { role: 'tester' });

const resAdm = mockRes();
test('ادمین به API مدیریتی دسترسی دارد',
  apiauth.requireAdmin(reqWith(ADM.token), resAdm, {}).ok === true);

const resTes = mockRes();
const gateTes = apiauth.requireAdmin(reqWith(TES.token), resTes, {});
test('کاربر tester به API مدیریتی دسترسی ندارد', gateTes.ok === false);
test('کد پاسخ منع دسترسی 403 است', resTes.code === 403);
test('پیام منع دسترسی جزئیات لو نمی‌دهد',
  /دسترسی ندارید/.test(resTes.body.error) && !/admin/i.test(resTes.body.error));

const resAnon = mockRes();
test('کاربر بدون ورود به API مدیریتی دسترسی ندارد',
  apiauth.requireAdmin(reqWith(null), resAnon, {}).ok === false && resAnon.code === 401);

/* ============ ۱۱) دسترسی بدون ورود در حالت چندکاربره ============ */

const resNo = mockRes();
const gateNo = apiauth.requireUser(reqWith(null), resNo, {}, { allowLocal: false });
test('بدون ورود، API محافظت‌شده رد می‌شود', gateNo.ok === false);
test('کد پاسخ بدون ورود 401 است', resNo.code === 401);
test('پاسخ بدون ورود پرچم loginRequired دارد', resNo.body.loginRequired === true);

/* ============ ۱۲) سهمیه نسخه آزمایشی ============ */

const T = auth.registerUser('trial1', 'trialPass1');
accounts.applyAdminPatch(T.user.id, { role: 'tester', max_searches: 5, max_reservations: 2 });

let okCount = 0;
for (let i = 0; i < 5; i += 1) {
  if (accounts.consumeQuota(T.user.id, 'searches').ok) okCount += 1;
}
test('پنج جستجوی نخست مجاز است', okCount === 5);
const sixth = accounts.consumeQuota(T.user.id, 'searches');
test('جستجوی ششم مسدود می‌شود', sixth.ok === false && sixth.reason === 'quota');
test('پیام سهمیه، حد مجاز را می‌گوید', /۵|5/.test(String(sixth.error)));
test('شمارنده پس از رد شدن بالا نمی‌رود',
  db.findById('users', T.user.id).usage.searches === 5);

test('رزرو اول مجاز است', accounts.consumeQuota(T.user.id, 'reservations').ok === true);
test('رزرو دوم مجاز است', accounts.consumeQuota(T.user.id, 'reservations').ok === true);
test('رزرو سوم مسدود می‌شود', accounts.consumeQuota(T.user.id, 'reservations').ok === false);
test('سهمیه جستجو و رزرو مستقل‌اند',
  db.findById('users', T.user.id).usage.reservations === 2);

// سهمیه یک کاربر نباید روی کاربر دیگر اثر بگذارد
test('سهمیه کاربر دیگر دست‌نخورده است',
  accounts.quotaStatus(db.findById('users', A.user.id), 'searches').unlimited === true);

// صفر کردن شمارنده توسط ادمین
accounts.applyAdminPatch(T.user.id, { reset_usage: true });
test('ادمین می‌تواند شمارنده را صفر کند',
  db.findById('users', T.user.id).usage.searches === 0);
test('پس از صفر شدن، جستجو دوباره مجاز است',
  accounts.consumeQuota(T.user.id, 'searches').ok === true);

/* ============ ۱۳) محافظت از آخرین ادمین ============ */

test('نقش نامعتبر پذیرفته نمی‌شود',
  accounts.applyAdminPatch(A.user.id, { role: 'superuser' }).ok === false);
test('تاریخ انقضای نامعتبر پذیرفته نمی‌شود',
  accounts.applyAdminPatch(A.user.id, { expires_at: 'دیروز' }).ok === false);
test('سهمیه منفی پذیرفته نمی‌شود',
  accounts.applyAdminPatch(A.user.id, { max_searches: -5 }).ok === false);
test('شمارش ادمین‌های فعال درست است', accounts.countAdmins() >= 1);

/* ============ ۱۴) لاگ فعالیت بدون داده حساس ============ */

activity.log({ userId: A.user.id, type: 'LOGIN' });
activity.log({
  userId: A.user.id,
  type: 'SEARCH',
  meta: { password: 'secret123', cookie: 'PHPSESSID=LEAK', origin: 'THR', destination: 'MHD' },
});
const events = activity.list({ userId: A.user.id });
test('رویداد ورود ثبت می‌شود', events.some((e) => e.type === 'LOGIN'));
test('رویداد جستجو ثبت می‌شود', events.some((e) => e.type === 'SEARCH'));

const searchEvent = events.find((e) => e.type === 'SEARCH');
test('گذرواژه در لاگ ذخیره نمی‌شود', searchEvent.meta.password === '[حذف‌شده]');
test('کوکی در لاگ ذخیره نمی‌شود', searchEvent.meta.cookie === '[حذف‌شده]');
test('داده غیرحساس در لاگ می‌ماند', searchEvent.meta.origin === 'THR');
test('کل لاگ عاری از مقدار کوکی است',
  JSON.stringify(events).indexOf('LEAK') === -1);
test('کل لاگ عاری از گذرواژه است',
  JSON.stringify(events).indexOf('secret123') === -1);

const scrubbed = activity.scrubMeta({ token: 'abc', api_key: 'k', authorization: 'Bearer x', safe: 'ok' });
test('کلیدهای حساس پالایش می‌شوند',
  scrubbed.token === '[حذف‌شده]' && scrubbed.api_key === '[حذف‌شده]' && scrubbed.authorization === '[حذف‌شده]');
test('کلید بی‌خطر باقی می‌ماند', scrubbed.safe === 'ok');

const cm = activity.cookieMeta(['PHPSESSID=abc123', 'cookname=alice']);
test('فراداده کوکی فقط تعداد و نام دارد',
  cm.cookieCount === 2 && cm.hasSessionCookie === true &&
  JSON.stringify(cm).indexOf('abc123') === -1);

// لاگ یک کاربر نباید در فهرست کاربر دیگر بیاید
activity.log({ userId: B.user.id, type: 'LOGIN' });
test('لاگ کاربران از هم جدا است',
  activity.list({ userId: B.user.id }).every((e) => e.user_id === B.user.id));

/* ============ ۱۵) حالت تک‌کاربره سازگار با گذشته ============ */

const saved = process.env.BILITFAST_MULTIUSER;
process.env.BILITFAST_MULTIUSER = '0';
const resLocal = mockRes();
const gateLocal = apiauth.requireUser(reqWith(null), resLocal, {});
test('در حالت تک‌کاربره، بدون ورود هم کار می‌کند',
  gateLocal.ok === true && gateLocal.localMode === true);
test('در حالت تک‌کاربره کاربر null است', gateLocal.user === null);
process.env.BILITFAST_MULTIUSER = saved;

test('کلید جداسازی برای کاربر، شناسه او را دارد',
  apiauth.scopeKey({ id: 'u1' }) === 'u:u1');
test('کلید جداسازی بدون کاربر، local است', apiauth.scopeKey(null) === 'local');

/* ============ پایان ============ */

function finish() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* بی‌اهمیت */ }
  console.log('');
  if (fail) {
    console.log(fail + ' تست شکست خورد از ' + (pass + fail));
    process.exit(1);
  }
  console.log('همه ' + pass + ' تست چندکاربره پاس شدند');
}
