// تست حلقه بازخورد یادگیری کپچا (lib/captures.js + api/learn.js)
// اجرا: node test/captures.test.js
process.env.BILITFAST_DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/bf-cap-');

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const captures = require('../lib/captures');
const { loadPrototypes } = require('../lib/charlearn');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

function dataUri(file) {
  const buf = fs.readFileSync(file);
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function mockLearnApi(body) {
  const handler = require('../api/learn');
  let out = null;
  const req = { method: 'POST', body, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { status(c) { this.code = c; return this; }, json(p) { out = p; return this; } };
  await handler(req, res);
  return { code: res.code, body: out };
}

(async () => {
  const realDir = path.join(__dirname, '..', 'samples', 'real');
  const labels = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'labels.json'), 'utf8'));
  const img1 = dataUri(path.join(realDir, '1.png'));  // 447H4
  const img2 = dataUri(path.join(realDir, '2.png'));  // K3136
  const img3 = dataUri(path.join(realDir, '3.png'));  // 19z16

  // --- ۱) ثبت تلاش کپچا ---
  const id1 = captures.recordCapture({ image: img1, text: labels['1.png'], confidence: 55, variant: 'proto+cnn' });
  const id2 = captures.recordCapture({ image: img2, text: 'XXXXX', confidence: 40, variant: 'proto+cnn' });
  test('recordCapture شناسه برمی‌گرداند', !!id1 && !!id2 && id1 !== id2);
  test('کپچای نامعتبر (بدون data-URI) ثبت نمی‌شود', captures.recordCapture({ image: 'ftp://x', text: 'abc12' }) === null);

  // --- ۲) نتیجه «پذیرفته‌شد» → نمونه آموزشی تأییدشده ---
  const r1 = await captures.markOutcomeBySubmit({ captureId: id1, text: labels['1.png'], result: { ok: true, step: 'payment' } });
  test('markOutcome(passed) رکورد را پیدا می‌کند', r1 === id1);
  const sample = db.findOne('captcha_samples', (s) => s.text === labels['1.png'] && s.source === 'auto-confirm');
  test('نمونه تأییدشده به captcha_samples می‌رود', !!sample);
  test('بردار کاراکترها استخراج شده (۵ کاراکتر)', Array.isArray(sample.char_vectors) && sample.char_vectors.length === 5);
  test('کپچای پذیرفته‌شده از صف حذف می‌شود', !db.findById('captcha_captures', id1));

  // --- ۳) حافظه نمونه‌محور بلافاصله تقویت می‌شود (بدون بازآموزی) ---
  const protos = loadPrototypes();
  test('loadPrototypes بردارهای جدید را می‌بیند', protos.length === 5);

  // --- ۴) نتیجه «رد شد» → در صف برچسب‌گذاری دستی می‌ماند ---
  const r2 = await captures.markOutcomeBySubmit({ captureId: id2, text: 'XXXXX', result: { ok: true, step: 'captcha', captchaError: true } });
  test('markOutcome(failed) رکورد را علامت می‌زند', r2 === id2);
  const rec2 = db.findById('captcha_captures', id2);
  test('کپچای ردشده در صف می‌ماند با وضعیت failed', !!rec2 && rec2.outcome === 'failed');

  // --- ۵) مسیر پشتیبان: یافتن کپچا از روی متن (بدون captureId) ---
  const id3 = captures.recordCapture({ image: img3, text: labels['3.png'], confidence: 60, variant: 'proto+cnn' });
  const r3 = await captures.markOutcomeBySubmit({ captureId: null, text: labels['3.png'], result: { ok: true, step: 'passenger_form' } });
  test('fallback با متن، کپچا را پیدا و تأیید می‌کند', r3 === id3);

  // --- ۶) خطای شبکه → هیچ نتیجه‌ای ثبت نمی‌شود ---
  const id4 = captures.recordCapture({ image: img2, text: 'K3136', confidence: 41, variant: 'proto+cnn' });
  const r4 = await captures.markOutcomeBySubmit({ captureId: id4, text: 'K3136', result: { ok: false, error: 'timeout' } });
  test('نتیجه نامعلوم (خطا) قابل انتساب نیست', r4 === null);

  // --- ۷) برچسب‌گذاری دستی از صف ---
  const lab = await captures.labelCapture(id4, labels['2.png']);
  test('labelCapture نمونه دستی می‌سازد', lab.ok === true);
  test('نمونه دستی با منبع manual-corrected ثبت شد',
    !!db.findOne('captcha_samples', (s) => s.text === labels['2.png'] && s.source === 'manual-corrected'));

  // --- ۸) جلوگیری از نمونه تکراری ---
  const before = db.find('captcha_samples', () => true).length;
  const dup = await captures.addLabeledSample(img1, labels['1.png'], 'auto-confirm');
  test('نمونه تکراری ثبت نمی‌شود', dup === false && db.find('captcha_samples', () => true).length === before);

  // --- ۹) اکشن‌های api/learn.js ---
  const caps = await mockLearnApi({ action: 'captures', limit: 10 });
  test('اکشن captures فهرست می‌دهد', caps.code === 200 && caps.body.ok && Array.isArray(caps.body.captures));

  const stats = await mockLearnApi({ action: 'stats' });
  test('اکشن stats آمار صف و نمونه‌ها را دارد',
    stats.code === 200 && stats.body.ok && stats.body.captures && stats.body.count >= 3);

  // ثبت دستی از طریق API (مسیر پشتیبان کلاینت) — یک جفت تصویر/متن تازه
  const post = await mockLearnApi({ action: 'captcha-sample', image: img1, text: 'ZZZZ9', source: 'manual' });
  test('اکشن captcha-sample متن الفبایی-عددی را می‌پذیرد و ثبت می‌کند',
    post.code === 200 && post.body.ok && !post.body.duplicate);

  // تکراری: این جفت قبلاً در مرحله برچسب‌گذاری دستی ثبت شده است
  const postDup = await mockLearnApi({ action: 'captcha-sample', image: img2, text: labels['2.png'], source: 'manual' });
  test('اکشن captcha-sample نمونه تکراری را دوباره ثبت نمی‌کند', postDup.body.duplicate === true);

  // برچسب/حذف از طریق API (صفحه یادگیری)
  const id5 = captures.recordCapture({ image: img3, text: 'xxxxx', confidence: 10, variant: 'proto+cnn' });
  const viaApi = await mockLearnApi({ action: 'label-capture', id: id5, text: labels['3.png'] });
  test('اکشن label-capture از صف برچسب‌گذاری می‌کند', viaApi.code === 200 && viaApi.body.ok);
  const id6 = captures.recordCapture({ image: img3, text: 'yyyyy', confidence: 10, variant: 'proto+cnn' });
  const del = await mockLearnApi({ action: 'delete-capture', id: id6 });
  test('اکشن delete-capture از صف حذف می‌کند', del.code === 200 && del.body.ok && !db.findById('captcha_captures', id6));

  console.log(failures === 0 ? '\nهمه تست‌ها قبول شدند ✅' : '\n' + failures + ' تست ناموفق ❌');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
