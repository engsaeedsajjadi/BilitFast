// تست‌های ماژول‌های امنیتی جدید: توکن رمزنگاری‌شده وضعیت، لایسنس سروری،
// محدودسازی نرخ و اعتبارسنجی کد ملی.
// اجرا: node test/security.test.js

const { encryptState, decryptState } = require('../lib/token');
const {
  signPayload, verifyPayload, licenseStatus, makeLicenseToken, makeTrialToken, isActivated,
  makeCaptchaLearnToken, verifyCaptchaLearnToken,
} = require('../lib/license');
const { checkRate, sweepExpired } = require('../lib/guard');
const { isValidNationalCode, isValidIranMobile } = require('../lib/validation');
const { getRequiredEnv } = require('../lib/http');
const { isAllowedSafirUrl, hashCaptchaDataUri } = require('../lib/reserve');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

/* ---------------- توکن وضعیت (رمزنگاری) ---------------- */
const state = { step: 'start', jar: ['PHPSESSID=abc123'], passengers: [{ national_code: '0499370899' }] };
const token = encryptState(state);

test('توکن رمزنگاری‌شده قابل بازگشایی است (roundtrip)', (() => {
  const d = decryptState(token);
  return d && d.step === 'start' && d.jar[0] === 'PHPSESSID=abc123';
})());

test('توکن، متن خواندنی (base64 ساده) نیست', !Buffer.from(token, 'base64url').toString('utf8').includes('PHPSESSID'));

test('توکن دستکاری‌شده باز نمی‌شود (اصالت‌سنجی GCM)', (() => {
  const t = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
  return decryptState(t) === null;
})());

test('توکن منقضی‌شده باز نمی‌شود', (() => {
  const expired = encryptState({ a: 1 }, -1000);
  return decryptState(expired) === null;
})());

test('توکن قدیمی (base64 ساده نسخه قبل) باز نمی‌شود', (() => {
  const legacy = Buffer.from(JSON.stringify({ step: 'start' }), 'utf8').toString('base64url');
  return decryptState(legacy) === null;
})());

test('ورودی نامعتبر → null', decryptState('') === null && decryptState('not-a-token') === null);

/* ---------------- لایسنس سروری ---------------- */
process.env.BILITFAST_ACTIVATION_CODE = 'test-code-123';

const lic = makeLicenseToken();
test('توکن لایسنس معتبر تشخیص داده می‌شود', isActivated(lic));

test('توکن لایسنس دستکاری‌شده رد می‌شود', (() => {
  const tampered = lic.slice(0, -2) + 'xx';
  return !isActivated(tampered) && verifyPayload(tampered) === null;
})());

test('وضعیت: فعال‌سازی دائمی', licenseStatus({ licenseToken: lic }).state === 'activated');
test('وضعیت: بدون توکن → شروع نشده', licenseStatus({}).state === 'not_started');

const trial = makeTrialToken(null);
test('توکن دوره آزمایشی فعال است', licenseStatus({ trialToken: trial }, 2).state === 'active');

test('شروع مجدد، تاریخ قبلی را حفظ می‌کند (جلوگیری از تمدید با پاک‌کردن مرورگر)', (() => {
  const again = makeTrialToken(trial);
  const a = verifyPayload(trial);
  const b = verifyPayload(again);
  return again === trial && a.startDate === b.startDate;
})());

test('وضعیت: دوره آزمایشی منقضی', (() => {
  const old = signPayload({ type: 'trial', startDate: new Date(Date.now() - 3 * 86400000).toISOString() });
  return licenseStatus({ trialToken: old }, 2).state === 'expired';
})());

test('توکن جعلی کلاینت (بدون امضای سرور) رد می‌شود', (() => {
  const fake = Buffer.from(JSON.stringify({ type: 'license', activated: true }), 'utf8').toString('base64url') + '.fake';
  return verifyPayload(fake) === null && !isActivated(fake);
})());

test('توکن یادگیری کپچا معتبر و زمان‌دار است', (() => {
  const t = makeCaptchaLearnToken({ workflow_id: 'wf1', captcha_text: '72914', image_hash: 'abc123', proof_id: 'p1' });
  const v = verifyCaptchaLearnToken(t);
  return !!(v && v.workflow_id === 'wf1' && v.captcha_text === '72914' && v.image_hash === 'abc123' && v.proof_id === 'p1');
})());

test('توکن یادگیری کپچای منقضی رد می‌شود', (() => {
  const t = makeCaptchaLearnToken({ workflow_id: 'wf1', captcha_text: '72914', image_hash: 'abc123', proof_id: 'p2', ttlMs: -1 });
  return verifyCaptchaLearnToken(t) === null;
})());

test('فقط URLهای safirrail برای fetch کپچا مجازند', isAllowedSafirUrl('https://safirrail.ir/etrain/captcha.php') && !isAllowedSafirUrl('http://127.0.0.1:3000/') && !isAllowedSafirUrl('https://example.com/captcha.png'));

test('هش data-URI کپچا پایدار است', (() => {
  const d = 'data:image/png;base64,' + Buffer.from('hello').toString('base64');
  return !!hashCaptchaDataUri(d) && hashCaptchaDataUri(d) === hashCaptchaDataUri(d);
})());

test('در محیط توسعه fallback secret مجاز است', getRequiredEnv('BILITFAST_LICENSE_KEY', { devFallback: 'dev-secret' }) === 'dev-secret');

test('در محیط تولید نبودن secret خطا می‌دهد', (() => {
  const prev = process.env.NODE_ENV;
  const prevKey = process.env.BILITFAST_LICENSE_KEY;
  delete process.env.BILITFAST_LICENSE_KEY;
  process.env.NODE_ENV = 'production';
  let ok = false;
  try {
    getRequiredEnv('BILITFAST_LICENSE_KEY', { devFallback: 'dev-secret' });
  } catch (e) {
    ok = /BILITFAST_LICENSE_KEY/.test(String(e && e.message ? e.message : e));
  }
  if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
  if (prevKey === undefined) delete process.env.BILITFAST_LICENSE_KEY; else process.env.BILITFAST_LICENSE_KEY = prevKey;
  return ok;
})());

/* ---------------- محدودسازی نرخ ---------------- */
test('محدودسازی: درخواست‌های داخل حد مجازند', checkRate('t1:ip', 3, 60000) && checkRate('t1:ip', 3, 60000));
test('محدودسازی: عبور از حد رد می‌شود', (() => {
  checkRate('t2:ip', 2, 60000);
  checkRate('t2:ip', 2, 60000);
  return checkRate('t2:ip', 2, 60000) === false;
})());
test('محدودسازی: بعد از پایان پنجره، مجاز می‌شود', (() => {
  checkRate('t3:ip', 1, 30);
  const until = Date.now() + 100; while (Date.now() < until) { /* wait */ }
  return checkRate('t3:ip', 1, 30) === true;
})());
test('نظافت شمارنده‌های منقضی بدون خطا', (() => { sweepExpired(); return true; })());

/* ---------------- اعتبارسنجی کد ملی ---------------- */
test('کد ملی معتبر ۱ (0499370899)', isValidNationalCode('0499370899'));
test('کد ملی معتبر ۲ (0790419904)', isValidNationalCode('0790419904'));
test('کد ملی با رقم چک اشتباه رد می‌شود', !isValidNationalCode('0499370898'));
test('کد ملی با طول اشتباه رد می‌شود', !isValidNationalCode('123456789') && !isValidNationalCode('01234567890'));
test('کد ملی تمام‌تکراری رد می‌شود', !isValidNationalCode('0000000000') && !isValidNationalCode('1111111111'));
test('کد ملی غیرعددی رد می‌شود', !isValidNationalCode('049937089a') && !isValidNationalCode(''));
test('شماره همراه معتبر/نامعتبر', isValidIranMobile('09123456789') && !isValidIranMobile('08123456789') && !isValidIranMobile('0912345678'));

console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
process.exit(failures === 0 ? 0 : 1);
