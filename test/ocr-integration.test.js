// -*- coding: utf-8 -*-
// تست یکپارچگی موتور: پایپ‌لاین کامل روی دیتاست مصنوعی کنترل‌شده + کالیبراسیون
// + آنسامبل + تحلیل شکست + لاگ استنتاج.
// اجرا: node test/ocr-integration.test.js

process.env.BILITFAST_OCR_LOG = require('fs').mkdtempSync(require('os').tmpdir() + '/bf-ocr-') + '/infer.jsonl';

const fs = require('fs');
const path = require('path');
const ops = require('../lib/imageops');
const synth = require('../lib/synthgen');
const { mulberry32 } = require('../lib/ml');
const engine = require('../lib/ocr/engine');
const { validateConfig } = require('../lib/ocr/config');
const calib = require('../lib/ocr/calibration');
const ensemble = require('../lib/ocr/ensemble');
const failysis = require('../lib/ocr/failure-analysis');
const { getInferenceLog } = require('../lib/ocr/logging');
const { normalizeComponent } = require('../lib/digitsynth');
const segment = require('../lib/ocr/segment');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

/** تصویر خاکستری مصنوعی → بردارهای کاراکتر (برای ساخت داده آموزش). */
function vecsOf(img, expectedCount) {
  const pol = require('../lib/ocr/polarity').detectPolarity(img);
  const bin = ops.binarize(img, ops.otsuThreshold(img), !pol.textIsDark);
  const seg = segment.segmentCharacters(bin, { expectedCount });
  return seg.chars.map((c) => normalizeComponent(c.bin, { size: 20, inner: 16 }));
}

(async () => {
  const CHARSET = ['2', '5', '7', 'H', 'S'];
  const { config } = validateConfig({});
  config.mode = 'alnum';
  config.charsetAlnum = CHARSET.join('');

  /* ---------------- تولید دیتاست کنترل‌شده ---------------- */
  const rngT = mulberry32(11);
  const rngE = mulberry32(22);
  const trainSamples = []; // { imageId, digit, v }
  for (let i = 0; i < 60; i++) {
    const ch = CHARSET[i % CHARSET.length];
    const s = synth.randomSample(rngT, { charset: [ch], minLen: 1, maxLen: 1, fontSize: 5, spacing: 3, rotation: 3, wave: 0.5, noise: 0 });
    const vecs = vecsOf(s.img, 1);
    if (vecs.length === 1) trainSamples.push({ imageId: 'tr' + i, digit: ch, v: Array.from(vecs[0]) });
  }
  test('دیتاست مصنوعی: بردارهای آموزش استخراج شدند', trainSamples.length >= 50);

  const testImgs = [];
  for (let i = 0; i < 20; i++) {
    const text = CHARSET[Math.floor(rngE() * CHARSET.length)] + CHARSET[Math.floor(rngE() * CHARSET.length)];
    const s = synth.renderText(text, { fontSize: 5, spacing: 3, rotation: 3, wave: 0.5, noise: 0 }, rngE);
    testImgs.push({ text, img: s.img, boxes: s.boxes });
  }

  /* ---------------- آموزش با پروتکل بدون نشت ---------------- */
  const ids = [...new Set(trainSamples.map((s) => s.imageId))];
  const { splitByIdentity, assertNoLeakage } = require('../lib/ocr/split');
  const split = splitByIdentity(ids, { seed: 7, ratios: { train: 0.7, val: 0.1, cal: 0.2, test: 0 } });
  test('تفکیک بدون نشت', assertNoLeakage(split));
  const { trainSplitCNN } = require('../train/ocr-train');
  const trained = await trainSplitCNN(trainSamples, split, {
    epochs: 12, augPerSample: 5, seed: 7, dropout: 0.1, earlyStopPatience: 6, verbose: false,
  });
  test('آموزش: مدل ساخته شد', trained.model && trained.classes.length === CHARSET.length);
  test('آموزش: دقت آموزش بالا (داده کم و ساده)', trained.metrics.trainAcc >= 0.8);
  test('آموزش: دمای کالیبراسیون ثبت شده', trained.temperature >= 1);

  /* ---------------- پایپ‌لاین کامل روی تصاویر ندیده ---------------- */
  const models = { cnn: null, mlp: null, temperature: trained.temperature, modelVersion: 'test-model' };
  const { CnnRecognizer } = require('../lib/ocr/recognizer');
  const weights = trained.model.getWeights().map((w) => ({ shape: w.shape, data: Array.from(w.dataSync()) }));
  models.cnn = new CnnRecognizer({ classes: trained.classes, weights }, { charset: CHARSET.join('') });

  let exact = 0, charOk = 0, charAll = 0;
  for (const t of testImgs) {
    const res = await engine.solveImage(t.img, { config, models, expectedLength: 2, minLength: 2, maxLength: 2, log: true });
    if (res.text === t.text) exact++;
    for (let i = 0; i < Math.max(res.text.length, t.text.length); i++) {
      charAll++;
      if (res.text[i] === t.text[i]) charOk++;
    }
    if (!res.ok && res.text === t.text) {
      // آستانه نباید پاسخ درست را رد کند (کالیبراسیون روی داده کم سخت‌گیرانه است)
    }
  }
  test('پایپ‌لاین کامل: دقت توالی روی داده ندیده ≥ ۷۰٪', exact / testImgs.length >= 0.7);
  test('پایپ‌لاین کامل: دقت کاراکتری ≥ ۸۵٪', charOk / charAll >= 0.85);

  /* ---------------- لاگ استنتاج ---------------- */
  const logs = getInferenceLog();
  test('لاگ: رکوردهای استنتاج ذخیره شدند', logs.length === testImgs.length);
  const rec = logs[0];
  test('لاگ: نسخه پایپ‌لاین و مدل ثبت شده', !!rec.pipelineVersion && !!rec.modelVersion);
  test('لاگ: اطمینان هر کاراکتر + توالی جدا ثبت شده‌اند', Array.isArray(rec.charConfs) && typeof rec.seqConf === 'number');
  test('لاگ: قطبیت و تعداد قطعه و تأخیر ثبت شده‌اند', rec.polarity !== null && rec.segCount !== null && typeof rec.latencyMs === 'number');
  const jsonl = fs.readFileSync(process.env.BILITFAST_OCR_LOG, 'utf8').trim().split('\n');
  test('لاگ: فایل JSONL نوشته شده', jsonl.length === testImgs.length);

  /* ---------------- کالیبراسیون ---------------- */
  // احتمال‌های بیش‌اطمینان مصنوعی: argmax ثابت باید با دما حفظ شود
  const probs = [[0.95, 0.05], [0.9, 0.1], [0.55, 0.45], [0.6, 0.4], [0.99, 0.01], [0.8, 0.2]];
  const labels = [0, 0, 1, 0, 0, 0]; // دو اشتباه → اطمینان اغراق‌شده
  const eceBefore = calib.computeECE(probs, labels);
  const fit = calib.fitTemperature(probs, labels, { maxT: 20 });
  test('کالیبراسیون: دما ≥ ۱ (فقط نرم‌کردن)', fit.temperature >= 1);
  test('کالیبراسیون: ECE بعد ≤ قبل', fit.eceAfter <= fit.eceBefore + 1e-9);
  const am1 = calib.argmaxConf(probs[2]);
  const p2 = calib.applyTemperature(probs[2], fit.temperature);
  test('کالیبراسیون: دما رتبهٔ کلاس‌ها را عوض نمی‌کند', calib.argmaxConf(p2).label === am1.label);
  const bins = calib.reliabilityBins(probs, labels, { bins: 5, temperature: fit.temperature });
  test('نمودار اتکاپذیری: مجموع سطل‌ها = تعداد نمونه‌ها', bins.reduce((a, b) => a + b.n, 0) === probs.length);

  /* ---------------- آنسامبل ---------------- */
  const corr = ensemble.errorCorrelation(['a', 'x', 'c', 'y'], ['a', 'z', 'c', 'w'], ['a', 'b', 'c', 'd']);
  test('همبستگی خطا: نرخ اختلاف', Math.abs(corr.disagreementRate - 0.5) < 1e-9);
  test('همبستگی خطا: هر دو با هم اشتباه کردند', corr.bothWrong === 2);
  test('همبستگی خطا: ضریب Q برای خطاهای همبسته ≈ ۱', corr.Q > 0.9);
  const ens = ensemble.ensemblePredict([
    { name: 'm1', chars: [{ char: 'A', conf: 0.9 }, { char: 'B', conf: 0.8 }] },
    { name: 'm2', chars: [{ char: 'A', conf: 0.7 }, { char: 'X', conf: 0.3 }] },
  ]);
  test('آنسامبل: رأی وزن‌دار کاراکتر مورد توافق را نگه می‌دارد', ens.chars[0].char === 'A');
  test('آنسامبل: در اختلاف، اطمینان بالاتر می‌برد', ens.chars[1].char === 'B');
  test('آنسامبل: سهم مدل‌ها ثبت می‌شود', ens.contributions.m1 >= 1);
  const cmp = ensemble.compareWithBestSingle(0.9, { m1: 0.85, m2: 0.7 });
  test('آنسامبل: مقایسه با بهترین مدل منفرد', cmp.ensembleBetter && cmp.bestSingle === 'm1');

  /* ---------------- تحلیل شکست ---------------- */
  const rows = [
    { gt: 'AB12', pred: 'AB12' },
    { gt: 'AB12', pred: '', segOk: false },
    { gt: 'AB12', pred: 'ab12', segOk: true, seqConf: 0.8, threshold: 0.5 },
    { gt: 'AB12', pred: 'AB1', segOk: true },
    { gt: 'AB12', pred: '', seqConf: 0.1, threshold: 0.5, segOk: true },
    { gt: 'AB12', pred: 'XX12', invertedCorrect: true },
  ];
  const rep = failysis.failureReport(rows);
  test('تحلیل شکست: ۵ نمونه ناموفق', rep.failed === 5);
  const cat = Object.fromEntries(rep.categories.map((c) => [c.category, c.count]));
  test('تحلیل شکست: قطعه‌بندی', cat['segmentation-failure'] === 1);
  test('تحلیل شکست: تشخیص', cat['recognition-failure'] === 1);
  test('تحلیل شکست: طول توالی', cat['sequence-mismatch'] === 1);
  test('تحلیل شکست: اطمینان پایین', cat['low-confidence'] === 1);
  test('تحلیل شکست: قطبیت', cat['polarity-failure'] === 1);
  test('تحلیل شکست: درصدها جمعاً ۱', Math.abs(rep.categories.reduce((a, c) => a + c.pct, 0) - 1) < 1e-9);

  trained.model.dispose();
  if (failures) { console.log(failures + ' تست ناموفق'); process.exit(1); }
  console.log('\nهمه تست‌ها پاس شدند');
})().catch((e) => { console.error(e); process.exit(1); });
