// -*- coding: utf-8 -*-
// تست‌های بینایی موتور: قطبیت، آستانه‌گذاری، برش، نرمال‌سازی، مؤلفه‌های همبند،
// قطعه‌بندی چندعاملی (حالت‌های لبه) و اعتبارسنجی ورودی مدل.
// اجرا: node test/ocr-vision.test.js

const ops = require('../lib/imageops');
const polarity = require('../lib/ocr/polarity');
const preprocess = require('../lib/ocr/preprocess');
const segment = require('../lib/ocr/segment');
const { normalizeComponent } = require('../lib/digitsynth');
const { validateInput, InputValidationError } = require('../lib/ocr/recognizer');
const synth = require('../lib/synthgen');
const { mulberry32 } = require('../lib/ml');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

/** تصویر خاکستری → دودویی (متن=0) با اوتسو + قطبیت درست. */
function binOf(gray) {
  const pol = polarity.detectPolarity(gray);
  return { bin: ops.binarize(gray, ops.otsuThreshold(gray), !pol.textIsDark), pol };
}

/* ---------------- قطبیت ---------------- */
{
  const dark = synth.renderText('AB12', {}, mulberry32(5)).img;         // متن تیره/زمینه روشن
  const light = synth.renderText('AB12', { bgDark: true }, mulberry32(5)).img; // متن روشن/زمینه تیره
  const pd = polarity.detectPolarity(dark);
  const pl = polarity.detectPolarity(light);
  test('قطبیت: متن تیره روی زمینه روشن تشخیص داده می‌شود', pd.textIsDark === true);
  test('قطبیت: متن روشن روی زمینه تیره تشخیص داده می‌شود', pl.textIsDark === false);
  test('قطبیت: اطمینان در بازه [0,1]', pd.confidence >= 0.5 && pd.confidence <= 1);
  test('قطبیت: رأی‌گیری چند هیوریستیک ثبت می‌شود', pd.votes.length >= 5);
  const amb = ops.makeImage(60, 30);
  for (let i = 0; i < amb.data.length; i++) amb.data[i] = 128; // تصویر یکدست = مبهم
  const pa = polarity.detectPolarity(amb);
  test('قطبیت: تصویر یکدست اطمینان پایین دارد', pa.confidence <= 0.75);
}

/* ---------------- آستانه‌گذاری + پیش‌پردازش ---------------- */
{
  const bimodal = ops.makeImage(80, 40);
  for (let y = 10; y < 30; y++) for (let x = 20; x < 60; x++) bimodal.data[y * 80 + x] = 30;
  const t = ops.otsuThreshold(bimodal);
  test('اوتسو بین دو مُد می‌نشیند', t >= 30 && t < 250);
  const bin = ops.binarize(bimodal, t, false);
  let ink = 0;
  for (const v of bin.data) if (v === 0) ink++;
  test('دودویی‌سازی: جوهر = ناحیه تیره', ink === 20 * 40);

  const lowC = synth.renderText('XY', { contrast: 0.4 }, mulberry32(3)).img;
  const norm = preprocess.contrastNormalize(lowC);
  let minV = 255, maxV = 0;
  for (const v of norm.data) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
  test('نرمال‌سازی کنتراست بازه را می‌کشاند', maxV - minV > 150);

  const ctx = { polarity: { textIsDark: true }, morph: { openIter: 1, closeIter: 1, maxIter: 1 } };
  const pipe = preprocess.runPipeline(lowC, preprocess.defaultSteps({
    denoise: 'median3', contrastNormalize: true, threshold: 'otsu', morphOpen: 1, morphClose: 1, maxMorphIterations: 1,
  }), ctx);
  test('پایپ‌لاین ماژولار بدون خطا اجرا می‌شود', pipe.errors.length === 0);
  test('پایپ‌لاین خروجی هر مرحله را نگه می‌دارد (ablation)', pipe.stages.thresholdOtsu && pipe.stages.denoiseMedian3);

  const b2 = preprocess.invertBinary(bin);
  let ink2 = 0;
  for (const v of b2.data) if (v === 0) ink2++;
  test('معکوس‌سازی دودویی', ink2 === bin.data.length - ink);
}

/* ---------------- برش + نرمال‌سازی + مؤلفه‌ها ---------------- */
{
  const img = ops.makeImage(60, 40);
  for (let y = 10; y < 20; y++) for (let x = 15; x < 30; x++) img.data[y * 60 + x] = 0;
  const bb = ops.boundingBox(img);
  test('boundingBox درست', bb.minX === 15 && bb.maxX === 29 && bb.minY === 10 && bb.maxY === 19);
  const cropped = ops.cropToContent(img, 2);
  test('cropToContent ابعاد را کوچک می‌کند', cropped.width < 60 && cropped.height < 40);

  const cc = ops.connectedComponents(img);
  test('مؤلفه‌های همبند: یک مستطیل = یک مؤلفه', cc.count === 1);
  const img2 = ops.makeImage(80, 40);
  for (let x = 10; x < 20; x++) img2.data[20 * 80 + x] = 0;
  for (let x = 40; x < 50; x++) img2.data[20 * 80 + x] = 0;
  test('مؤلفه‌های همبند: دو مستطیل جدا = دو مؤلفه', ops.connectedComponents(img2).count === 2);

  const vec = normalizeComponent(img, { size: 20, inner: 16 });
  test('نرمال‌سازی: اندازه ۲۰×۲۰', vec.length === 400);
  let vink = 0;
  for (const v of vec) if (v > 0) vink++;
  test('نرمال‌سازی: جوهر حفظ شده', vink > 40);
  const empty = normalizeComponent(ops.makeImage(10, 10), { size: 20, inner: 16 });
  let eInk = 0;
  for (const v of empty) if (v > 0) eInk++;
  test('نرمال‌سازی: تصویر خالی → بردار خالی', eInk === 0);
}

/* ---------------- اعتبارسنجی ورودی مدل ---------------- */
{
  let threw = false;
  try { validateInput([new Array(300).fill(0)], 20); } catch (e) { threw = e instanceof InputValidationError; }
  test('بردار با طول غلط رد می‌شود', threw);
  threw = false;
  try { validateInput([], 20); } catch (e) { threw = true; }
  test('آرایه خالی رد می‌شود', threw);
  test('ورودی معتبر پذیرفته می‌شود', validateInput([new Array(400).fill(0.5)], 20));
}

/* ---------------- قطعه‌بندی: حالت‌های لبه ---------------- */
function segOf(text, opts = {}, segOpts = {}) {
  const rng = mulberry32(42);
  const r = synth.renderText(text, opts, rng);
  const { bin } = binOf(r.img);
  return { seg: segment.segmentCharacters(bin, segOpts), gtBoxes: r.boxes, img: r.img, bin };
}

{
  // یک کاراکتر
  const one = segOf('A', { fontSize: 6 });
  test('قطعه‌بندی: تک کاراکتر', one.seg.count === 1);

  // کاراکتر چندمؤلفه‌ای (i = نقطه + بدنه) باید ادغام شود
  const frag = segOf('i', { fontSize: 6, wave: 0 });
  test('قطعه‌بندی: خرده‌های یک حرف ادغام می‌شوند (i)', frag.seg.count === 1);

  // کاراکترهای چسبیده باید شکافته شوند (TT با یک پیکسل هم‌پوشانی در خط بالا)
  const touch = segOf('TT', { fontSize: 6, spacing: -1, wave: 0, rotation: 0, noise: 0 }, { expectedCount: 2 });
  test('قطعه‌بندی: کاراکترهای چسبیده شکافته می‌شوند', touch.seg.count === 2);

  // شکافت مستقیم: دو مستطیل با پل نازک (دمبل) — کمینهٔ پروجکشن وسط
  {
    const db = ops.makeImage(50, 30);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 20; x++) db.data[y * 50 + x] = 0;
    for (let y = 5; y < 25; y++) for (let x = 30; x < 45; x++) db.data[y * 50 + x] = 0;
    for (let x = 20; x < 30; x++) db.data[15 * 50 + x] = 0; // پل یک‌پیکسلی
    const comps = segment.candidateComponents(db, { minArea: 4, minCharHeightFrac: 0 });
    const parts = comps.length === 1 ? segment.splitTouching(db, comps[0]) : null;
    test('قطعه‌بندی: دمبل در وسط پل شکافته می‌شود', parts && parts.length === 2 &&
      Math.abs((parts[0].stat.maxX - parts[0].stat.minX) - (parts[1].stat.maxX - parts[1].stat.minX)) <= 4);
  }

  // فاصله متغیر
  const varSp = segOf('ABC12', { fontSize: 5, spacing: 3, spacingJitter: 2, rotation: 0, wave: 0.3 });
  test('قطعه‌بندی: فاصله متغیر', varSp.seg.count === 5);

  // عرض‌های ناهمسان (i در برابر m)
  const widths = segOf('imW1', { fontSize: 5, rotation: 0 });
  test('قطعه‌بندی: عرض‌های ناهمسان', widths.seg.count === 4);

  // زمینه تیره
  const dark = segOf('AB', { fontSize: 5, bgDark: true });
  test('قطعه‌بندی: زمینه تیره', dark.seg.count === 2);

  // نویز زمینه (با تعداد مورد انتظار، جستجوی چیدمان نویز را کنار می‌زند)
  const noisy = segOf('AB', { fontSize: 6, noise: 0.02, rotation: 0 }, { expectedCount: 2 });
  test('قطعه‌بندی: نویز نمک‌وفلفلی', noisy.seg.count === 2);

  // خطوط نویز زمینه
  const lines = segOf('AB', { fontSize: 6, bgNoiseLines: 2, rotation: 0 }, { expectedCount: 2 });
  test('قطعه‌بندی: خطوط نویز زمینه (انتظار ۲ قطعه)', lines.seg.count === 2);

  // کنتراست پایین
  const low = segOf('AB', { fontSize: 6, contrast: 0.5, rotation: 0 });
  test('قطعه‌بندی: کنتراست پایین', low.seg.count === 2);

  // انتخاب زیرمجموعه با امتیاز چیدمان وقتی نویز مؤلفه اضافه می‌کند:
  // یک خط افقی نازک (نویز) زیر خط زمینه اضافه می‌شود؛ جستجو باید ۳ کاراکتر را برگزیند.
  const { bin } = binOf(synth.renderText('ABC', { fontSize: 6, rotation: 0, noise: 0 }, mulberry32(9)).img);
  const lineY = bin.height - 4;
  for (let y = lineY; y < lineY + 2; y++) for (let x = 8; x < bin.width - 8; x++) bin.data[y * bin.width + x] = 0;
  const extra = segment.segmentCharacters(bin, { expectedCount: 3, minArea: 6 });
  test('قطعه‌بندی: مؤلفه اضافه با جستجوی چیدمان حذف می‌شود', extra.count === 3 && extra.ok);

  // ارزیابی مستقل قطعه‌بندی در برابر جعبه‌های مرجع
  const ev = segOf('AB12', { fontSize: 5, rotation: 0, wave: 0.3 });
  const predBoxes = ev.seg.chars.map((c) => c.box);
  const q = segment.evaluateSegmentation(predBoxes, ev.gtBoxes);
  test('ارزیابی مستقل قطعه‌بندی: شمارش برابر', q.countOk);
  test('ارزیابی مستقل قطعه‌بندی: همه جعبه‌ها تطبیق یافتند', q.matched === ev.gtBoxes.length);
  test('ارزیابی مستقل قطعه‌بندی: IoU میانگین بالا', q.meanIoU > 0.6);
}

if (failures) { console.log(failures + ' تست ناموفق'); process.exit(1); }
console.log('\nهمه تست‌ها پاس شدند');
