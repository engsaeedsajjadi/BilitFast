// تست‌های تطبیق نمونه‌محور (k-NN) برای کپچا (lib/charlearn.js)
// اجرا: node test/charlearn.test.js
process.env.BILITFAST_DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/bf-knn-');

const Jimp = require('jimp');
const ops = require('../lib/imageops');
const { renderDigit } = require('../lib/digitsynth');
const { mulberry32 } = require('../lib/ml');
const { extractCharVectors, cosineDist, matchPrototype, loadPrototypes } = require('../lib/charlearn');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

/** ساخت تصویر کپچای چندرقمی از رندر برداری (قطعی با بذر). */
async function compose(text, seed) {
  const rng = mulberry32(seed);
  const parts = [...text].map((d) => renderDigit(d, rng));
  const gap = 8;
  const w = parts.reduce((a, p) => a + p.width, 0) + gap * (parts.length - 1);
  const h = Math.max(...parts.map((p) => p.height));
  const img = ops.makeImage(w, h);
  let x = 0;
  for (const p of parts) {
    for (let y = 0; y < p.height; y++) {
      for (let i = 0; i < p.width; i++) img.data[y * w + x + i] = p.data[y * p.width + i];
    }
    x += p.width + gap;
  }
  return ops.toPngBuffer(img);
}

(async () => {
  /* ---------------- استخراج بردار کاراکترها ---------------- */
  const buf = await compose('7291', 777);
  const vecs = await extractCharVectors(buf, '7291');
  test('استخراج ۴ بردار برای کپچای ۴رقمی', !!vecs && vecs.length === 4);
  test('بردارها برچسب درست و اندازه ۴۰۰ دارند', !!vecs && vecs.every((c) => /^[0-9]$/.test(c.digit) && c.v.length === 400));
  test('ترتیب برچسب‌ها حفظ می‌شود', !!vecs && vecs.map((c) => c.digit).join('') === '7291');

  const badLen = await extractCharVectors(buf, '123');
  test('اگر طول برچسب با تعداد قطعه‌ها نخواند، نمونه‌ای ذخیره نمی‌شود', badLen === null);

  /* ---------------- فاصله و تطبیق نمونه (معیار مقاوم) ---------------- */
  const { robustDist } = require('../lib/charlearn');
  test('فاصله بردار با خودش صفر است', robustDist(vecs[0].v, vecs[0].v) < 1e-6);

  // همان تصویر، فقط ۱ پیکسل جابه‌جا شده → باید همچنان به رقم درست تطبیق دهد
  function shiftVec(v, dx, dy) {
    const S = 20, out = new Array(S * S).fill(0);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const sx = x - dx, sy = y - dy;
      if (sx >= 0 && sy >= 0 && sx < S && sy < S) out[y * S + x] = v[sy * S + sx];
    }
    return out;
  }
  const shifted7 = shiftVec(vecs[0].v, 1, 0);
  const mShift = matchPrototype(shifted7, vecs, 0.3);
  test('کاراکتر کمی جابه‌جاشده همچنان به رقم درست تطبیق می‌دهد', !!mShift && mShift.digit === '7');

  // یک رقم کاملاً متفاوت نباید به نمونه «7» تطبیق داده شود
  const bufOnes = await compose('1111', 55);
  const vecsOnes = await extractCharVectors(bufOnes, '1111');
  const dFar = robustDist(vecsOnes[0].v, vecs[0].v);
  test('رقم متفاوت فاصله زیاد دارد و تطبیق نمی‌دهد', dFar > 0.3 && matchPrototype(vecsOnes[0].v, [vecs[0]], 0.3) === null);

  /* ---------------- تست سرتاسری: یادگیری → تشخیص ---------------- */
  // ۱) نمونه تأییدشده از طریق /api/learn ذخیره می‌شود (مثل جریان واقعی کاربر)
  const learnHandler = require('../api/learn');
  const dataUri = 'data:image/png;base64,' + buf.toString('base64');
  const res1 = { _status: 200, _json: null, status(c) { this._status = c; return this; }, json(j) { this._json = j; return this; } };
  await learnHandler({
    method: 'POST',
    headers: {},
    body: { action: 'captcha-sample', image: dataUri, text: '7291', source: 'manual' },
  }, res1);
  test('api/learn بردار کاراکترها را یاد می‌گیرد', res1._json.ok === true && res1._json.chars_learned === 4);

  const loaded = loadPrototypes();
  test('نمونه‌ها از دیتابیس بارگذاری می‌شوند', loaded.length === 4);

  // ۲) حالا همان کپچا دوباره حل می‌شود — باید با اتکا به نمونه‌ها درست خوانده شود
  // (طول کپچای واقعی ۵ است؛ برای تست سرتاسری از کپچای ۵کاراکتری استفاده می‌کنیم)
  const buf5 = await compose('72914', 4242);
  const res5 = { _status: 200, _json: null, status(c) { this._status = c; return this; }, json(j) { this._json = j; return this; } };
  await learnHandler({
    method: 'POST',
    headers: {},
    body: { action: 'captcha-sample', image: 'data:image/png;base64,' + buf5.toString('base64'), text: '72914', source: 'manual' },
  }, res5);
  const { solveWithModel } = require('../lib/captcha');
  const solved = await solveWithModel(buf5);
  test('solveWithModel با کمک نمونه‌ها متن درست برمی‌گرداند', !!solved && solved.text === '72914');
  test('حداقل یک کاراکتر از مسیر نمونه (prototype) حل شده', !!solved && solved.chars.some((c) => c.source === 'prototype'));

  console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('خطای غیرمنتظره:', e); process.exit(1); });
