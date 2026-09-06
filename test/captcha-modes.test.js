// -*- coding: utf-8 -*-
// تست «دو حالت کپچا» + تغذیه حلقه یادگیری از بازآموزی CNN
//   ۱) قاعده مشتق‌شدن حالت حل کپچا از شماره قطار (خودکار/دستی)
//   ۲) وجود و معنای تنظیم captcha.auto_solve_max_total
//   ۳) loadTrainingPrototypes: بردارهای ذخیره‌شده + استخراج فال‌بک از تصویر
//   ۴) زنجیره کامل: ثبت کپچا → پذیرش توسط صفیر ریل → ورود به داده آموزش
// اجرا: node test/captcha-modes.test.js
process.env.BILITFAST_DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/bf-mode-');

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

function dataUri(file) {
  const buf = fs.readFileSync(file);
  return 'data:image/png;base64,' + buf.toString('base64');
}

(async () => {
  /* --- ۱) قاعده حالت کپچا (کد واقعی سمت کلاینت، بدون تکرار منطق) --- */
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const sandbox = { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(appSrc + '\n;this.__BF = BilitFast;', sandbox);
  const BF = sandbox.__BF;
  test('app.js قابل بارگذاری و صدور captchaModeForTrain است', !!(BF && BF.captchaModeForTrain));
  test('شماره قطار مشخص → حالت خودکار', BF.captchaModeForTrain('12345') === 'auto');
  test('بدون شماره قطار → حالت دستی', BF.captchaModeForTrain('') === 'manual');
  test('شماره قطار فقط فاصله → دستی', BF.captchaModeForTrain('   ') === 'manual');
  test('شماره قطار null/undefined → دستی', BF.captchaModeForTrain(null) === 'manual' && BF.captchaModeForTrain(undefined) === 'manual');
  test('صدور تابع سقف تلاش‌های خودکار', typeof BF.getCaptchaAutoSolveMaxTotal === 'function');

  /* --- ۱-ب) قاعده ارسال نتیجه حل (رفع باگ «فقط پیام متنی») ---
   * نسخه قبلی فقط نتیجه «مطمئن» (ok=true) را ارسال می‌کرد؛ روی کپچاهای
   * واقعیِ دیده‌نشده اعتماد معمولاً پایین است و حلقه هرگز ارسال نمی‌کرد. */
  test('صدور تابع تصمیم ارسال', typeof BF.shouldAutoSubmit === 'function');
  test('تا پذیرش: حدس کم‌اعتماد ولی معتبر ارسال می‌شود',
    BF.shouldAutoSubmit({ ok: false, text: '4a7H4', confidence: 12 }, true) === true);
  test('تا پذیرش: متن نامعتبر (نمادهای غیرالفبایی) ارسال نمی‌شود',
    BF.shouldAutoSubmit({ ok: true, text: '=====', confidence: 90 }, true) === false);
  test('تا پذیرش: متن خالی/ناموجود ارسال نمی‌شود',
    BF.shouldAutoSubmit({ ok: true, text: '', confidence: 90 }, true) === false &&
    BF.shouldAutoSubmit(null, true) === false);
  test('حالت موردی: فقط نتیجه مطمئن ارسال می‌شود',
    BF.shouldAutoSubmit({ ok: false, text: '4a7H4' }, false) === false &&
    BF.shouldAutoSubmit({ ok: true, text: '4a7H4' }, false) === true);

  /* --- ۱-ج) رگرسیون فرانت‌اند: حلقه و دکمه ارسال در route.html --- */
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'route.html'), 'utf8');
  test('حلقه حل خودکار از قاعده shouldAutoSubmit استفاده می‌کند (نه فقط solved.ok)',
    routeSrc.includes('BilitFast.shouldAutoSubmit(solved, untilAccepted)'));
  test('دکمه «ادامه رزرو» هنگام نمایش کپچا دوباره فعال می‌شود (رفع قفل حالت دستی)',
    /\$\('btn-captcha-submit'\)\.disabled\s*=\s*false/.test(routeSrc));
  test('پیشنهاد کم‌اعتماد با نمایش دوباره فرم پاک نمی‌شود (keepInput)',
    routeSrc.includes('keepInput: keepSuggestion') &&
    /if \(!\(data && data\.keepInput\)\) \$\('reserve-captcha-input'\)\.value = ''/.test(routeSrc));

  /* --- ۲) تنظیمات سرور --- */
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  test('captcha.auto_solve_max_total وجود دارد و >= 0 است (۰ = نامحدود)',
    Number.isFinite(cfg.captcha.auto_solve_max_total) && cfg.captcha.auto_solve_max_total >= 0);

  /* --- ۳) loadTrainingPrototypes: ذخیره‌شده + فال‌بک استخراج از تصویر --- */
  const dbDir = process.env.BILITFAST_DATA_DIR;
  const realDir = path.join(__dirname, '..', 'samples', 'real');
  const labels = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'labels.json'), 'utf8'));
  const img1 = dataUri(path.join(realDir, '1.png'));   // برچسب واقعی در labels.json
  const text1 = labels['1.png'];

  const goodVec = { digit: 'A', v: new Array(400).fill(0.5) };
  const dbSeed = {
    captcha_samples: [
      // الف) بردارهای ازقبل‌ذخیره‌شده
      { image: null, text: 'AAAAA', source: 'manual', char_vectors: [goodVec, goodVec] },
      // ب) تصویر بدون بردار → باید هنگام آموزش استخراج شود
      { image: img1, text: text1, source: 'auto-confirm' },
      // ج) برچسب نامعتبر → رد می‌شود
      { image: img1, text: '!!bad!!', source: 'manual' },
    ],
  };
  fs.writeFileSync(path.join(dbDir, 'db.json'), JSON.stringify(dbSeed));

  const { loadTrainingPrototypes } = require('../lib/charlearn');
  const r1 = await loadTrainingPrototypes();
  test('بردارهای ذخیره‌شده خوانده می‌شوند', r1.stats.withVectors === 1);
  test('نمونه بدون بردار از تصویر استخراج می‌شود', r1.stats.extractedNow === 1);
  test('برچسب نامعتبر رد می‌شود', r1.stats.failed === 1);
  test('مجموع کاراکترها = ذخیره‌شده + استخراجی',
    r1.protos.length === 2 + text1.length);
  test('کاراکترهای استخراج‌شده با برچسب واقعی مطابقت دارند',
    r1.protos.filter((p) => p.digit !== 'A').map((p) => p.digit).join('') === text1);

  /* --- ۴) زنجیره کامل: ثبت → پذیرش سرور → ورود به داده آموزش --- */
  fs.writeFileSync(path.join(dbDir, 'db.json'), JSON.stringify({}));
  // بارگیری تازهٔ ماژول‌ها با دادهٔ خالی
  delete require.cache[require.resolve('../lib/db')];
  delete require.cache[require.resolve('../lib/captures')];
  delete require.cache[require.resolve('../lib/charlearn')];
  const db2 = require('../lib/db');
  const captures2 = require('../lib/captures');
  const charlearn2 = require('../lib/charlearn');

  const captureId = captures2.recordCapture({ image: img1, text: text1, confidence: 61, variant: 'ocr-engine' });
  test('کپچای حل‌شده ذخیره می‌شود (ثبت تلاش)', !!captureId);
  // شبیه‌سازی پاسخ صفیر ریل: عبور از مرحله کپچا (مرحله بعدی فرم مسافر است)
  await captures2.markOutcomeBySubmit({ captureId, text: text1, result: { ok: true, step: 'passenger_form' } });
  const accepted = db2.find('captcha_samples', (s) => s.source === 'auto-confirm');
  test('کپچای پذیرفته‌شده به نمونه‌های آموزشی می‌رود', accepted.length === 1 && accepted[0].text === text1);

  const r2 = await charlearn2.loadTrainingPrototypes();
  test('نمونه پذیرفته‌شده در داده بازآموزی CNN حاضر است',
    r2.stats.samples === 1 && r2.protos.length === text1.length &&
    r2.protos.map((p) => p.digit).join('') === text1);

  // ردشده توسط سرور → در صف برچسب‌گذاری دستی می‌ماند (نه داده آموزشی)
  const id3 = captures2.recordCapture({ image: img1, text: 'ZZZZZ', confidence: 22, variant: 'ocr-engine' });
  await captures2.markOutcomeBySubmit({ captureId: id3, text: 'ZZZZZ', result: { ok: true, step: 'captcha' } });
  const r3 = await charlearn2.loadTrainingPrototypes();
  test('کپچای ردشده وارد داده آموزشی نمی‌شود', r3.stats.samples === 1);
  const queue = captures2.listCaptures();
  test('کپچای ردشده برای برچسب‌گذاری دستی در صف می‌ماند',
    queue.some((c) => c.text === 'ZZZZZ' && c.outcome === 'failed'));

  console.log(failures === 0 ? '\nهمه تست‌ها موفق بودند.' : '\n' + failures + ' تست ناموفق بود.');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
