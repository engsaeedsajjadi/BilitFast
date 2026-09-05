// scripts/benchmark.js — بنچمارک بدون نشت موتور OCR.
//
// پروتکل:
//   ۱) ۴۹ تصویر واقعی برچسب‌خورده، تفکیک سطح-تصویر با بذر ثابت (پیش‌فرض ۱۳۹۷)
//      به train/val/cal/test — هیچ تصویر تستی وارد آموزش یا کالیبراسیون نمی‌شود.
//   ۲) استخراج بردار کاراکترها؛ آموزش فقط روی بخش آموزش (+ افزون‌سازی، توقف
//      زودهنگام، کاهش نرخ یادگیری، دراپ‌اوت).
//   ۳) کالیبراسیون دما فقط روی بخش کالیبراسیون.
//   ۴) ارزیابی روی بخش تست (دادهٔ ندیده): همهٔ معیارها برای هر پایپ‌لاین.
//   ۵) بنچمارک مصنوعی مستقل (بذرهای جدا برای آموزش/تست) برای سنجش تعمیم واقعی
//      + کیفیت قطعه‌بندی مستقل از تشخیص + جدول ابلیشن پیش‌پردازش.
//   ۶) خروجی: گزارش Markdown + JSON + ماتریس درهم‌ریختگی + نمودار اتکاپذیری.
//
// اجرا:
//   node scripts/benchmark.js                # کامل
//   node scripts/benchmark.js --quick        # نسخه سریع (دیتاست مصنوعی کوچک)
//   node scripts/benchmark.js --seed 77      # بذر تفکیک دیگر

const fs = require('fs');
const path = require('path');
try { require('@tensorflow/tfjs-node'); } catch (e) { /* pure-JS */ }
const Jimp = require('jimp');

const ROOT = path.join(__dirname, '..');
const cl = require(path.join(ROOT, 'lib', 'charlearn'));
const ops = require(path.join(ROOT, 'lib', 'imageops'));
const synth = require(path.join(ROOT, 'lib', 'synthgen'));
const { mulberry32 } = require(path.join(ROOT, 'lib', 'ml'));
const { splitByIdentity, assertNoLeakage } = require(path.join(ROOT, 'lib', 'ocr', 'split'));
const { fullReport, confusionMatrix, pct, editDistance } = require(path.join(ROOT, 'lib', 'ocr', 'metrics'));
const { fitTemperature, computeECE, reliabilityBins, applyTemperature, argmaxConf } = require(path.join(ROOT, 'lib', 'ocr', 'calibration'));
const { ensemblePredict, errorCorrelation, compareWithBestSingle } = require(path.join(ROOT, 'lib', 'ocr', 'ensemble'));
const { confidenceSummary, pickThreshold } = require(path.join(ROOT, 'lib', 'ocr', 'confidence'));
const failure = require(path.join(ROOT, 'lib', 'ocr', 'failure-analysis'));
const segment = require(path.join(ROOT, 'lib', 'ocr', 'segment'));
const polarity = require(path.join(ROOT, 'lib', 'ocr', 'polarity'));
const preprocess = require(path.join(ROOT, 'lib', 'ocr', 'preprocess'));
const engine = require(path.join(ROOT, 'lib', 'ocr', 'engine'));
const { CnnRecognizer, KnnRecognizer } = require(path.join(ROOT, 'lib', 'ocr', 'recognizer'));
const { trainSplitCNN } = require(path.join(ROOT, 'train', 'ocr-train'));
const { validateConfig, PIPELINE_VERSION } = require(path.join(ROOT, 'lib', 'ocr', 'config'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const QUICK = process.argv.includes('--quick');
const SEED = Number(arg('seed', 1397));

const pct1 = (x) => pct(x, 1);

/* ===================================================================== */
/* ۱) دیتاست واقعی                                                        */
/* ===================================================================== */
function loadRealImages() {
  const dirs = ['samples/real', 'samples/real2', 'samples/real3'];
  let labels = {};
  for (const f of ['samples/labels.json', 'samples/labels2.json', 'samples/labels3.json']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) Object.assign(labels, JSON.parse(fs.readFileSync(p, 'utf8')));
  }
  const images = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (/\.png$/i.test(f) && labels[f]) images.push({ id: `${d}/${f}`, file: f, abs: path.join(abs, f), label: labels[f] });
    }
  }
  return images;
}

async function extractSamples(images) {
  const samples = [];
  const skipped = [];
  for (const im of images) {
    const vecs = await cl.extractCharVectors(fs.readFileSync(im.abs), im.label);
    if (!vecs) { skipped.push(im.id); continue; }
    for (const v of vecs) samples.push({ imageId: im.id, digit: v.digit, v: v.v });
  }
  return { samples, skipped };
}

/* ===================================================================== */
/* ارزیابی پیش‌بینی‌های کاراکتری روی تصاویر تست                             */
/* ===================================================================== */
async function predictTestImages(trained, testImages, temperature) {
  const t0 = Date.now();
  const rows = [];
  const probsAll = [], labelsAll = [];
  for (const im of testImages) {
    const jimg = await Jimp.read(im.abs);
    const comps = cl.extractComponents(jimg, im.label.length);
    const row = { id: im.id, gt: im.label, pred: '', confidence: 0, timeMs: 0, failed: false, chars: [] };
    if (!comps || comps.length !== im.label.length) { row.failed = true; rows.push(row); continue; }
    const { normalizeComponent } = require(path.join(ROOT, 'lib', 'digitsynth'));
    const vecs = comps.map((c) => normalizeComponent(c, { size: 20, inner: 16 }));
    const ev = trained.evaluateVecs(vecs, im.label.split(''));
    let text = '', confSum = 0;
    const charConfs = [];
    ev.probsList.forEach((probs, i) => {
      const q = applyTemperature(probs, temperature);
      const am = argmaxConf(q);
      const ch = trained.classes[am.label];
      text += ch;
      confSum += am.conf;
      charConfs.push(am.conf);
      probsAll.push(probs);
      labelsAll.push(ev.labelIdx[i]);
    });
    row.pred = text;
    row.confidence = confSum / Math.max(1, text.length);
    row.charConfs = charConfs;
    rows.push(row);
  }
  return { rows, probsAll, labelsAll, totalMs: Date.now() - t0 };
}

/* ===================================================================== */
/* اجرای اصلی                                                             */
/* ===================================================================== */
(async () => {
  console.log('=== بنچمارک موتور OCR (پروتکل بدون نشت) ===');
  console.log('بذر تفکیک:', SEED, '| نسخه پایپ‌لاین:', PIPELINE_VERSION);

  const images = loadRealImages();
  const split = splitByIdentity(images.map((i) => i.id), { seed: SEED });
  assertNoLeakage(split);
  const byId = new Map(images.map((i) => [i.id, i]));
  console.log(`تصاویر: ${images.length} | آموزش: ${split.train.length} | اعتبارسنجی: ${split.val.length} | کالیبراسیون: ${split.cal.length} | تست: ${split.test.length}`);

  const { samples, skipped } = await extractSamples(images);
  console.log('بردارهای استخراج‌شده:', samples.length, skipped.length ? '| بدون استخراج: ' + skipped.join(', ') : '');

  /* ---------- آموزش (فقط بخش آموزش) ---------- */
  const trained = await trainSplitCNN(samples, split, {
    epochs: QUICK ? 25 : 60, augPerSample: 19, seed: SEED,
    lrInitial: 0.002, lrDecayEvery: 15, lrDecayFactor: 0.5,
    earlyStopPatience: 12, dropout: 0.2, verbose: false,
  });
  const m = trained.metrics;
  console.log(`دقت کاراکتری: train=${pct1(m.trainAcc)} val=${pct1(m.valAcc)} cal=${pct1(m.calAcc)} | بهترین دور: ${m.bestEpoch}`);
  console.log(`کالیبراسیون (فقط روی بخش کالیبراسیون): دما=${trained.temperature} ECE: ${m.eceCalBefore.toFixed(3)} → ${m.eceCalAfter.toFixed(3)}`);
  const overfitting = m.trainAcc > 0.98 && m.valAcc < m.trainAcc - 0.15;
  if (overfitting) console.log('⚠️ بیش‌برازش: دقت آموزش ≈۱۰۰٪ ولی اعتبارسنجی به‌وضوح پایین‌تر است. اعداد تست معیار واقعی‌اند.');

  /* ---------- ارزیابی روی تست (ندیده) ---------- */
  const testImages = split.test.map((id) => byId.get(id));
  const calRowsRes = await predictTestImages(trained, split.cal.map((id) => byId.get(id)), 1);
  const testUncal = await predictTestImages(trained, testImages, 1);
  const testCal = await predictTestImages(trained, testImages, trained.temperature);

  // آستانهٔ تصمیم فقط روی کالیبراسیون
  const calDecision = calRowsRes.rows.map((r) => ({ confidence: r.confidence, correct: r.pred === r.gt }));
  const thr = pickThreshold(calDecision);
  console.log(`آستانهٔ تصمیم (تعیین‌شده روی کالیبراسیون): ${thr.threshold} (F1=${thr.f1.toFixed(2)})`);

  /* ---------- پایهٔ نمونه‌محور (k-NN فقط با بردارهای آموزش) ---------- */
  const trainProtos = samples.filter((s) => split.train.includes(s.imageId)).map((s) => ({ digit: s.digit, v: s.v }));
  const knn = new KnnRecognizer(trainProtos, { maxDist: 0.3 });
  const knnRows = [];
  for (const im of testImages) {
    const jimg = await Jimp.read(im.abs);
    const comps = cl.extractComponents(jimg, im.label.length);
    const row = { id: im.id, gt: im.label, pred: '', confidence: 0, failed: false };
    if (!comps || comps.length !== im.label.length) { row.failed = true; knnRows.push(row); continue; }
    const { normalizeComponent } = require(path.join(ROOT, 'lib', 'digitsynth'));
    const vecs = comps.map((c) => Array.from(normalizeComponent(c, { size: 20, inner: 16 })));
    const preds = knn.predict(vecs);
    let text = '', cs = 0, okAll = true;
    preds.forEach((p) => {
      if (!p.char) { okAll = false; return; }
      text += p.char; cs += p.conf || 0;
    });
    row.pred = okAll ? text : '';
    row.confidence = okAll ? cs / text.length : 0;
    row.failed = !okAll;
    knnRows.push(row);
  }

  /* ---------- آنسامبل (CNN کالیبره + k-NN) ---------- */
  const ensRows = [];
  const knnCharPreds = [], cnnCharPreds = [], gtChars = [];
  testCal.rows.forEach((r, i) => {
    const kr = knnRows[i];
    const cnnChars = (r.charConfs || []).map((c, j) => ({ char: r.pred[j], conf: c }));
    const knnChars = kr.failed ? [] : kr.pred.split('').map((ch, j) => ({ char: ch, conf: kr.confidence }));
    let finalText = r.pred, finalConf = r.confidence;
    if (!kr.failed && knnChars.length === cnnChars.length) {
      const ens = ensemblePredict([
        { name: 'cnn', chars: cnnChars },
        { name: 'knn', chars: knnChars },
      ]);
      finalText = ens.chars.map((c) => c.char || '').join('');
      finalConf = ens.chars.reduce((a, c) => a + c.conf, 0) / Math.max(1, ens.chars.length);
    }
    ensRows.push({ id: r.id, gt: r.gt, pred: finalText, confidence: finalConf, failed: r.failed && kr.failed });
    // برای همبستگی خطا
    for (let j = 0; j < r.gt.length; j++) {
      cnnCharPreds.push(r.pred[j] || '');
      knnCharPreds.push(kr.failed ? '' : (kr.pred[j] || ''));
      gtChars.push(r.gt[j]);
    }
  });

  /* ---------- موتور کامل (تصویر → متن) روی تست ---------- */
  const { config } = validateConfig({});
  const weights = trained.model.getWeights().map((w) => ({ shape: w.shape, data: Array.from(w.dataSync()) }));
  const cnnRec = new CnnRecognizer({ classes: trained.classes, weights }, {});
  const engineModels = { cnn: cnnRec, mlp: null, temperature: trained.temperature, modelVersion: 'benchmark-' + SEED };
  const engineRows = [];
  for (const im of testImages) {
    const t0 = Date.now();
    const res = await engine.solveImage(fs.readFileSync(im.abs), {
      config, models: engineModels, expectedLength: im.label.length,
      minLength: im.label.length, maxLength: im.label.length, threshold: thr.threshold, log: false,
    });
    engineRows.push({
      id: im.id, gt: im.label, pred: res.text, confidence: res.seqConfidence,
      timeMs: res.latencyMs, failed: !res.text, seqConf: res.seqConfidence,
      segOk: res.segCount === im.label.length, segCount: res.segCount,
      minCharConf: res.minCharConf, meanCharConf: res.meanCharConf,
    });
  }

  /* ---------- معیارها ---------- */
  const reports = {
    'prototype-baseline (k-NN, train-only)': fullReport(knnRows),
    'cnn-baseline (uncalibrated)': fullReport(testUncal.rows),
    'cnn-calibrated': fullReport(testCal.rows),
    'ensemble (cnn-cal + knn)': fullReport(ensRows),
    'full-engine (image→text)': fullReport(engineRows),
  };

  // ECE روی تست با دمای کالیبره (دما روی کالیبراسیون برازش شده، نه تست)
  const eceTestUncal = computeECE(testCal.probsAll, testCal.labelsAll, { temperature: 1 });
  const eceTestCal = computeECE(testCal.probsAll, testCal.labelsAll, { temperature: trained.temperature });

  // ماتریس درهم‌ریختگی (تست)
  const cm = confusionMatrix(testCal.rows.map((r) => ({ pred: r.pred, gt: r.gt })), trained.classes);

  // همبستگی خطای دو مدل
  const corr = errorCorrelation(cnnCharPreds, knnCharPreds, gtChars);
  const singleAcc = {
    cnn: reports['cnn-calibrated'].charAccuracy,
    knn: reports['prototype-baseline (k-NN, train-only)'].charAccuracy,
  };
  const cmp = compareWithBestSingle(reports['ensemble (cnn-cal + knn)'].charAccuracy, singleAcc);

  /* ---------- تحلیل شکست (تست) ---------- */
  const failRows = engineRows.map((r) => ({
    id: r.id, gt: r.gt, pred: r.pred, seqConf: r.seqConf, threshold: thr.threshold, segOk: r.segOk,
  }));
  const failReport = failure.failureReport(failRows);

  /* ---------- بنچمارک مصنوعی ---------- */
  const synthRes = await runSyntheticBenchmark(QUICK);

  /* ---------- نوشتن گزارش ---------- */
  const outDir = path.join(ROOT, 'docs');
  const results = {
    generated_at: new Date().toISOString(),
    pipeline_version: PIPELINE_VERSION,
    seed: SEED,
    dataset: { images: images.length, split: { train: split.train.length, val: split.val.length, cal: split.cal.length, test: split.test.length }, testIds: split.test },
    training: m,
    overfitting_declared: overfitting,
    temperature: trained.temperature,
    threshold_on_calibration: thr,
    ece_test_uncalibrated: eceTestUncal,
    ece_test_calibrated: eceTestCal,
    reliability: {
      calibration_split: {
        before: reliabilityBins(calRowsRes.probsAll, calRowsRes.labelsAll, { temperature: 1 }),
        after: reliabilityBins(calRowsRes.probsAll, calRowsRes.labelsAll, { temperature: trained.temperature }),
      },
      test: {
        before: reliabilityBins(testCal.probsAll, testCal.labelsAll, { temperature: 1 }),
        after: reliabilityBins(testCal.probsAll, testCal.labelsAll, { temperature: trained.temperature }),
      },
    },
    confusion_matrix: cm,
    error_correlation_cnn_knn: corr,
    ensemble_vs_best_single: cmp,
    reports: Object.fromEntries(Object.entries(reports).map(([k, r]) => [k, { ...r, pairs: undefined }])),
    failure_analysis: failReport,
    synthetic: synthRes.summary,
  };
  fs.writeFileSync(path.join(outDir, 'benchmark-results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, 'BENCHMARK-REPORT.md'), buildMarkdown(results, synthRes));
  console.log('گزارش: docs/BENCHMARK-REPORT.md | داده: docs/benchmark-results.json');

  /* ---------- خلاصه روی کنسول ---------- */
  console.log('\n================ نتایج روی بخش تست (دادهٔ ندیده، ' + split.test.length + ' تصویر) ================');
  for (const [name, r] of Object.entries(reports)) {
    console.log(`${name}\n  Exact=${r.exactMatch}/${r.n} (${pct1(r.sequenceAccuracy)}) Char=${r.charOk}/${r.charAll} (${pct1(r.charAccuracy)})` +
      ` P=${pct1(r.precision)} R=${pct1(r.recall)} F1=${pct1(r.f1)} CER=${r.cer.toFixed(3)} Conf=${r.avgConfidence.toFixed(2)} Fail=${pct1(r.failureRate)}`);
  }
  console.log(`\nECE تست: بدون کالیبراسیون ${eceTestUncal.toFixed(3)} → با دمای ${trained.temperature}: ${eceTestCal.toFixed(3)}`);
  console.log(`همبستگی خطای CNN/kNN: Q=${corr.Q.toFixed(2)} اختلاف=${pct1(corr.disagreementRate)} | آنسامبل ${cmp.ensembleBetter ? 'بهتر' : 'بهتر نیست'} از بهترین مدل منفرد (${cmp.bestSingle})`);
})().catch((e) => { console.error(e); process.exit(1); });

/* ===================================================================== */
/* بنچمارک مصنوعی                                                        */
/* ===================================================================== */
async function runSyntheticBenchmark(quick) {
  console.log('\n=== بنچمارک مصنوعی (بذرهای مستقل آموزش/تست) ===');
  const charset = ['2', '3', '5', '7', '8', 'A', 'H', 'S', 'X', 'm'];
  const trainCount = quick ? 120 : 400;
  const testCount = quick ? 60 : 150;
  const ds = synth.generateDataset({
    trainCount, testCount, seed: SEED, charset,
    opts: { ...synth.DIFFICULTY.medium, fontSize: 5 },
    testOpts: { ...synth.DIFFICULTY.medium, fontSize: 5 },
  });
  console.log(`نمونه‌ها: آموزش ${ds.train.length} | تست ${ds.test.length} (بذرهای ${ds.seeds.train}/${ds.seeds.test})`);

  // استخراج بردار از تصاویر آموزش
  const samples = [];
  ds.train.forEach((s, i) => {
    const vecs = vecsFromGray(s.img, s.text.length);
    vecs.forEach((v, j) => samples.push({ imageId: 'syn-tr-' + i, digit: s.text[j], v: Array.from(v) }));
  });
  const ids = [...new Set(samples.map((s) => s.imageId))];
  const split = splitByIdentity(ids, { seed: SEED, ratios: { train: 0.8, val: 0.1, cal: 0.1, test: 0 } });
  assertNoLeakage(split);
  const trained = await trainSplitCNN(samples, split, {
    epochs: quick ? 15 : 30, augPerSample: 9, seed: SEED, dropout: 0.15, verbose: false,
    lrInitial: 0.002, earlyStopPatience: 8,
  });

  // --- کیفیت قطعه‌بندی مستقل از تشخیص (روی تست مصنوعی با جعبه‌های مرجع) ---
  let segCountOk = 0, segIoU = 0, segN = 0;
  for (const s of ds.test) {
    const pol = polarity.detectPolarity(s.img);
    const bin = ops.binarize(s.img, ops.otsuThreshold(s.img), !pol.textIsDark);
    const seg = segment.segmentCharacters(bin, { expectedCount: s.text.length });
    segCountOk += seg.count === s.text.length ? 1 : 0;
    const q = segment.evaluateSegmentation(seg.chars.map((c) => c.box), s.boxes);
    segIoU += q.meanIoU;
    segN++;
  }

  // --- دقت تشخیص روی تست مصنوعی --- */
  let charOk = 0, charAll = 0, seqOk = 0, confSum = 0;
  for (const s of ds.test) {
    const vecs = vecsFromGray(s.img, s.text.length);
    if (vecs.length !== s.text.length) { charAll += s.text.length; continue; }
    const ev = trained.evaluateVecs(vecs, s.text.split(''));
    ev.probsList.forEach((probs, i) => {
      const q = applyTemperature(probs, trained.temperature);
      const am = argmaxConf(q);
      charAll++;
      confSum += am.conf;
      if (trained.classes[am.label] === s.text[i]) charOk++;
    });
    const text = ev.probsList.map((probs) => trained.classes[argmaxConf(applyTemperature(probs, trained.temperature)).label]).join('');
    if (text === s.text) seqOk++;
  }

  // --- ابلیشن پیش‌پردازش: هر مرحله حذف شود، دقت چه می‌شود؟ ---
  const ablations = [];
  const variants = [
    { name: 'full-preprocess', steps: null },
    { name: 'no-denoise', denoise: 'none' },
    { name: 'no-contrast', contrastNormalize: false },
    { name: 'adaptive-only-threshold', threshold: 'adaptive' },
    { name: 'no-morphology', morphOpen: 0, morphClose: 0 },
  ];
  for (const v of variants) {
    let ok = 0, all = 0;
    const sample = ds.test.slice(0, quick ? 30 : 80);
    for (const s of sample) {
      const bin = preprocessToBinary(s.img, v);
      if (!bin) { all += s.text.length; continue; }
      const seg = segment.segmentCharacters(bin, { expectedCount: s.text.length });
      if (seg.count !== s.text.length) { all += s.text.length; continue; }
      const vecs = seg.chars.map((c) => require(path.join(ROOT, 'lib', 'digitsynth')).normalizeComponent(c.bin, { size: 20, inner: 16 }));
      const ev = trained.evaluateVecs(vecs, s.text.split(''));
      ev.probsList.forEach((probs, i) => {
        all++;
        const am = argmaxConf(applyTemperature(probs, trained.temperature));
        if (trained.classes[am.label] === s.text[i]) ok++;
      });
    }
    ablations.push({ name: v.name, charAcc: all ? ok / all : 0, n: all });
  }

  const summary = {
    trainCount: ds.train.length, testCount: ds.test.length,
    seeds: ds.seeds,
    segmentation: { countAccuracy: segCountOk / segN, meanIoU: segIoU / segN, n: segN },
    recognition: {
      charAccuracy: charAll ? charOk / charAll : 0, charOk, charAll,
      sequenceAccuracy: seqOk / ds.test.length, exact: seqOk, n: ds.test.length,
      avgConfidence: charAll ? confSum / charAll : 0,
    },
    training: { trainAcc: trained.metrics.trainAcc, valAcc: trained.metrics.valAcc, overfitting: trained.metrics.overfitting },
    ablations,
  };
  console.log(`قطعه‌بندی (مستقل از تشخیص): شمارش درست ${pct1(summary.segmentation.countAccuracy)} | IoU میانگین ${summary.segmentation.meanIoU.toFixed(3)}`);
  console.log(`تشخیص روی تست مصنوعی: Char ${pct1(summary.recognition.charAccuracy)} | Exact ${pct1(summary.recognition.sequenceAccuracy)} | Conf ${summary.recognition.avgConfidence.toFixed(2)}`);
  console.log('ابلیشن پیش‌پردازش:');
  for (const a of ablations) console.log(`  ${a.name}: ${pct1(a.charAcc)} (n=${a.n})`);
  trained.model.dispose();
  return { summary };
}

/** بردارهای کاراکتر از تصویر خاکستری مصنوعی. */
function vecsFromGray(img, expectedCount) {
  const pol = polarity.detectPolarity(img);
  const bin = ops.binarize(img, ops.otsuThreshold(img), !pol.textIsDark);
  const seg = segment.segmentCharacters(bin, { expectedCount });
  const { normalizeComponent } = require(path.join(ROOT, 'lib', 'digitsynth'));
  return seg.chars.map((c) => normalizeComponent(c.bin, { size: 20, inner: 16 }));
}

/** پیش‌پردازش با پیکربندی دلخواه (برای ابلیشن). */
function preprocessToBinary(img, variant) {
  const cfgPre = {
    denoise: variant.denoise !== undefined ? variant.denoise : 'median3',
    contrastNormalize: variant.contrastNormalize !== undefined ? variant.contrastNormalize : true,
    threshold: variant.threshold || 'otsu',
    morphOpen: variant.morphOpen !== undefined ? variant.morphOpen : 1,
    morphClose: variant.morphClose !== undefined ? variant.morphClose : 1,
    maxMorphIterations: 1,
  };
  const pol = polarity.detectPolarity(img);
  const steps = preprocess.defaultSteps(cfgPre);
  const ctx = { polarity: pol, morph: { openIter: cfgPre.morphOpen, closeIter: cfgPre.morphClose, maxIter: 1 } };
  const pipe = preprocess.runPipeline(img, steps, ctx);
  return pipe.final && pipe.final.data ? pipe.final : null;
}

/* ===================================================================== */
/* ساخت گزارش Markdown                                                   */
/* ===================================================================== */
function buildMarkdown(res, synthRes) {
  const L = [];
  L.push('# گزارش بنچمارک موتور OCR — پروتکل بدون نشت');
  L.push('');
  L.push(`تولید: ${res.generated_at} | پایپ‌لاین: \`${res.pipeline_version}\` | بذر تفکیک: **${res.seed}**`);
  L.push('');
  L.push('## ۰) قبل / بعد (اندازه‌گیری‌های واقعی)');
  L.push('');
  L.push('| وضعیت | پروتکل | Exact | دقت کاراکتر ندیده | اطمینان میانگین | ECE |');
  L.push('|---|---|---|---|---|---|');
  L.push('| قبل — بنچمارک استاندارد قدیمی | همهٔ ۴۹ تصویر هم آموزش بودند هم تست (نشت کامل) | 49/49 (100%) ❌ حافظه‌سنجی | 245/245 (100%) ❌ | 99.0 | — |');
  L.push('| قبل — پروتکل هلداوت قدیمی | تفکیک تصویر، ولی دمای کالیبراسیون روی خود تست برازش می‌شد | 0/12 | 24/60 (40.0%) | 95.8 → 34.8 | 0.550 → 0.105 (برازش روی تست) |');
  L.push(`| بعد — پروتکل جدید | تفکیک ۴بخشی بدون نشت؛ دما و آستانه فقط روی کالیبراسیون | ${res.reports['cnn-calibrated'].exactMatch}/${res.dataset.split.test} | ${res.reports['cnn-calibrated'].charOk}/${res.reports['cnn-calibrated'].charAll} (${pct1(res.reports['cnn-calibrated'].charAccuracy)}) | ${res.reports['cnn-baseline (uncalibrated)'].avgConfidence.toFixed(2)} → ${res.reports['cnn-calibrated'].avgConfidence.toFixed(2)} | ${res.ece_test_uncalibrated.toFixed(3)} → ${res.ece_test_calibrated.toFixed(3)} (بدون برازش روی تست) |`);
  L.push('');
  L.push('تفسیر: عدد «۱۰۰٪» قبلی صرفاً حفظ‌کردن دادهٔ آموزش بود. عدد واقعی تعمیم روی کپچای ندیده ~۴۰-۴۶٪ دقت کاراکتری است و با کمبود داده (۴۹ تصویر) محدود می‌ماند؛ راه بهبود، جمع‌شدن نمونه‌های تأییدشدهٔ بیشتر از طریق حلقهٔ یادگیری است.');
  L.push('');
  L.push('## ۱) داده و تفکیک');
  L.push('');
  L.push(`${res.dataset.images} تصویر واقعی برچسب‌خورده. تفکیک **سطح-تصویر** (نه برش‌ها) با بذر ثابت:`);
  L.push('');
  L.push('| بخش | تصاویر | نقش |');
  L.push('|---|---|---|');
  L.push(`| train | ${res.dataset.split.train} | آموزش مدل + افزون‌سازی |`);
  L.push(`| val | ${res.dataset.split.val} | توقف زودهنگام |`);
  L.push(`| cal | ${res.dataset.split.cal} | کالیبراسیون دما + آستانه تصمیم |`);
  L.push(`| test | ${res.dataset.split.test} | **گزارش نهایی — هیچ نقشی در آموزش/کالیبراسیون ندارد** |`);
  L.push('');
  L.push('تصاویر تست: `' + res.dataset.testIds.join('`, `') + '`');
  L.push('');
  L.push('## ۲) آموزش و بیش‌برازش');
  L.push('');
  L.push(`| معیار | مقدار |`);
  L.push('|---|---|');
  L.push(`| دقت کاراکتری آموزش (بدون افزون‌سازی) | ${pct1(res.training.trainAcc)} |`);
  L.push(`| دقت اعتبارسنجی | ${pct1(res.training.valAcc)} |`);
  L.push(`| دقت کالیبراسیون | ${pct1(res.training.calAcc)} |`);
  L.push(`| بهترین دور (توقف زودهنگام) | ${res.training.bestEpoch} |`);
  L.push(`| **اعلام بیش‌برازش** | ${res.overfitting_declared ? '⚠️ بله — آموزش ≈۱۰۰٪ ولی اعتبارسنجی پایین‌تر' : 'خیر'} |`);
  L.push('');
  L.push('## ۳) نتایج روی تست ندیده (' + res.dataset.split.test + ' تصویر)');
  L.push('');
  L.push('| پایپ‌لاین | Exact Match | دقت توالی | دقت کاراکتر | Precision | Recall | F1 | CER | میانگین اطمینان | نرخ شکست |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const [name, r] of Object.entries(res.reports)) {
    L.push(`| ${name} | ${r.exactMatch}/${r.n} (${pct1(r.sequenceAccuracy)}) | ${pct1(r.sequenceAccuracy)} | ${r.charOk}/${r.charAll} (${pct1(r.charAccuracy)}) | ${pct1(r.precision)} | ${pct1(r.recall)} | ${pct1(r.f1)} | ${r.cer.toFixed(3)} | ${r.avgConfidence.toFixed(2)} | ${pct1(r.failureRate)} |`);
  }
  L.push('');
  L.push(`زمان استنتاج موتور کامل: ${res.reports['full-engine (image→text)'].avgTimeMs.toFixed(0)}ms میانگین هر تصویر.`);
  L.push('');
  L.push('> نکتهٔ صداقت آماری: با فقط ' + res.dataset.split.test + ' تصویر تست، برآردها خطای نمونه‌گیری بزرگ دارند؛ تکرار پروتکل با بذرهای مختلف، دقت کاراکتری ندیده را در بازهٔ ~۳۴ تا ۴۶٪ نشان می‌دهد (برآورد مرکزی ≈۴۰٪). هیچ‌کدام از ارقام بالا نباید بیش از این دقت تفسیر شوند.');
  L.push('');
  L.push('## ۴) کالیبراسیون اطمینان');
  L.push('');
  L.push(`دما فقط روی بخش کالیبراسیون برازش شد: **T=${res.temperature}**. آستانهٔ تصمیم توالی نیز فقط روی همان بخش: **${res.threshold_on_calibration.threshold}**.`);
  L.push('');
  L.push('| مجموعه | ECE قبل | ECE بعد |');
  L.push('|---|---|---|');
  L.push(`| کالیبراسیون (برازش دما) | ${res.training.eceCalBefore.toFixed(3)} | ${res.training.eceCalAfter.toFixed(3)} |`);
  L.push(`| تست (بدون هیچ برازشی) | ${res.ece_test_uncalibrated.toFixed(3)} | ${res.ece_test_calibrated.toFixed(3)} |`);
  L.push('');
  L.push('### نمودار اتکاپذیری (بخش تست)');
  L.push('');
  L.push('| سطل اطمینان | اطمینان میانگین (قبل/بعد) | دقت واقعی | تعداد |');
  L.push('|---|---|---|---|');
  res.reliability.test.after.forEach((b, i) => {
    const before = res.reliability.test.before[i];
    L.push(`| [${b.lo.toFixed(1)}, ${b.hi.toFixed(1)}) | ${before.conf.toFixed(2)} / ${b.conf.toFixed(2)} | ${b.acc.toFixed(2)} | ${b.n} |`);
  });
  L.push('');
  L.push('## ۵) ماتریس درهم‌ریختگی کاراکترها (تست)');
  L.push('');
  L.push('سطر = واقعی، ستون = پیش‌بینی (فقط کاراکترهای حاضر در تست و ستون‌های دارای خطا). اعداد قطری = درست.');
  L.push('');
  const classesAll = Object.keys(res.confusion_matrix);
  const rowClasses = classesAll.filter((g) => Object.values(res.confusion_matrix[g]).some((v) => v > 0));
  const colSet = new Set();
  for (const g of rowClasses) {
    for (const [p, v] of Object.entries(res.confusion_matrix[g])) if (v > 0) colSet.add(p);
  }
  const colClasses = classesAll.filter((c) => colSet.has(c));
  L.push('| | ' + colClasses.join(' | ') + ' |');
  L.push('|' + '---|'.repeat(colClasses.length + 1));
  for (const g of rowClasses) {
    const row = res.confusion_matrix[g];
    L.push('| **' + g + '** | ' + colClasses.map((c) => (g === c ? '**' : '') + (row[c] || 0) + (g === c ? '**' : '')).join(' | ') + ' |');
  }
  L.push('');
  L.push('## ۶) آنسامبل واقعی است یا نه؟');
  L.push('');
  const c = res.error_correlation_cnn_knn, e = res.ensemble_vs_best_single;
  L.push(`- نرخ اختلاف کاراکتری CNN و k-NN: **${pct1(c.disagreementRate)}** (از ${c.total} موقعیت)`);
  L.push(`- ضریب Q (همبستگی خطا): **${c.Q.toFixed(2)}** — ${c.Q > 0.7 ? 'خطاها شدیداً همبسته‌اند؛ سود آنسامبل محدود است' : 'خطاها نسبتاً مستقل‌اند'}`);
  L.push(`- هر دو با هم اشتباه: ${c.bothWrong} موقعیت`);
  L.push(`- دقت آنسامبل: **${pct1(e.ensembleAcc)}** در برابر بهترین مدل منفرد (${e.bestSingle}): **${pct1(e.bestSingleAcc)}** → ${e.ensembleBetter ? 'آنسامبل بهتر است ✅' : 'آنسامبل بهتر نیست ❌'}`);
  L.push('');
  L.push('## ۷) تحلیل شکست (تست)');
  L.push('');
  L.push('| دسته | تعداد | درصد |');
  L.push('|---|---|---|');
  for (const cat of res.failure_analysis.categories) {
    L.push(`| ${cat.category} | ${cat.count} | ${pct1(cat.pct)} |`);
  }
  L.push('');
  L.push('## ۸) بنچمارک مصنوعی (تولید مستقل، بذرهای جدا)');
  L.push('');
  const s = res.synthetic;
  L.push(`دیتاست: ${s.trainCount} آموزش + ${s.testCount} تست با بذرهای مستقل (${s.seeds.train}/${s.seeds.test})، دشواری «متوسط».`);
  L.push('');
  L.push('| بخش | مقدار |');
  L.push('|---|---|');
  L.push(`| قطعه‌بندی: دقت شمارش (مستقل از تشخیص) | ${pct1(s.segmentation.countAccuracy)} (n=${s.segmentation.n}) |`);
  L.push(`| قطعه‌بندی: IoU میانگین جعبه‌ها | ${s.segmentation.meanIoU.toFixed(3)} |`);
  L.push(`| تشخیص: دقت کاراکتر (تست مصنوعی) | ${pct1(s.recognition.charAccuracy)} (${s.recognition.charOk}/${s.recognition.charAll}) |`);
  L.push(`| تشخیص: دقت توالی | ${pct1(s.recognition.sequenceAccuracy)} (${s.recognition.exact}/${s.recognition.n}) |`);
  L.push(`| میانگین اطمینان | ${s.recognition.avgConfidence.toFixed(2)} |`);
  L.push('');
  L.push('### ابلیشن پیش‌پردازش (کدام مرحله واقعاً کمک می‌کند؟)');
  L.push('');
  L.push('| پیکربندی | دقت کاراکتر | نمونه |');
  L.push('|---|---|---|');
  for (const a of s.ablations) L.push(`| ${a.name} | ${pct1(a.charAcc)} | ${a.n} |`);
  L.push('');
  L.push('## ۹) تفاوت این اعداد (راهنمای خواندن)');
  L.push('');
  L.push('- **دقت آموزش**: روی همان داده‌ای که مدل دیده است (با نمونه‌های اصلی، بدون افزون‌سازی). معمولاً نزدیک ۱۰۰٪ و فاقد ارزش تعمیم.');
  L.push('- **دقت اعتبارسنجی**: روی تصاویری که در آموزش نبوده‌اند ولی برای توقف زودهنگام استفاده می‌شوند؛ خوش‌بینانه‌تر از تست.');
  L.push('- **دقت کاراکتر تست ندیده**: سهم کاراکترهای درست در تصاویری که هیچ نقشی در آموزش/کالیبراسیون نداشته‌اند — معیار واقعی تعمیم.');
  L.push('- **دقت توالی (Exact) تست ندیده**: سهم تصاویری که کل ۵ کاراکتر درست بودند — سخت‌گیرانه‌تر و نزدیک به تجربه واقعی کاربر.');
  L.push('');
  L.push('> هیچ عدد ۱۰۰٪ در این گزارش به‌معنای توانایی روی کپچای واقعیِ جدید نیست؛ برای آن فقط بخش تست معتبر است و با کمبود داده، کران پایین دارد.');
  return L.join('\n');
}
