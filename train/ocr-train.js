// -*- coding: utf-8 -*-
/**
 * train/ocr-train.js — آموزش CNN با پروتکل بدون نشت.
 *
 * تفاوت با نسخهٔ قدیمی:
 *  - تفکیک سطح-تصویر (نه سطح-برش) به train/val/cal/test قبل از هر چیزی
 *  - افزون‌سازی فقط روی بخش آموزش
 *  - اعتبارسنجی واقعی + توقف زودهنگام (جلوگیری از بیش‌برازش)
 *  - زمان‌بندی نرخ یادگیری + دراپ‌اوت (نظم‌دهی)
 *  - کالیبراسیون دما فقط روی بخش کالیبراسیون (نه تست، نه هلداوت)
 *  - گزارش جداگانهٔ دقت آموزش/اعتبارسنجی/تست برای تشخیص بیش‌برازش
 *
 * خروجی: { model, classes, temperature, metrics }
 */

const path = require('path');
try { require('@tensorflow/tfjs-node'); } catch (e) { /* pure-JS fallback */ }
const { mulberry32 } = require('../lib/ml');
const { buildCharCNN, getTf } = require('../lib/cnn');
const { transformVec } = require('../lib/charlearn');
const { fitTemperature, applyTemperature, argmaxConf, computeECE } = require('../lib/ocr/calibration');

/** ارزیابی یک مدل روی بردارها؛ خروجی { acc, probsList, labelIdx, preds } */
function evaluateVecs(model, vecs, labels, classes) {
  const t = getTf();
  if (!vecs.length) return { acc: 0, probsList: [], labelIdx: [], preds: [] };
  const X = t.tensor4d(new Float32Array(vecs.map((v) => Array.from(v)).flat()), [vecs.length, 20, 20, 1]);
  const probsList = model.predict(X).arraySync();
  X.dispose();
  const idx = new Map(classes.map((c, i) => [c, i]));
  let ok = 0;
  const labelIdx = [], preds = [];
  probsList.forEach((probs, i) => {
    const am = argmaxConf(probs);
    labelIdx.push(idx.get(labels[i]));
    preds.push(classes[am.label]);
    if (classes[am.label] === labels[i]) ok++;
  });
  return { acc: ok / vecs.length, probsList, labelIdx, preds };
}

/**
 * آموزش با پروتکل کامل.
 * ورودی: samples = [{ imageId, digit, v }] (بردارهای استخراج‌شده)
 *        split = { train:[imageId], val:[], cal:[], test:[] }
 */
async function trainSplitCNN(samples, split, {
  epochs = 60, batchSize = 32, seed = 1397,
  augPerSample = 19, augAng = 10, augShift = 1.5, scaleMin = 0.9, scaleMax = 1.1,
  lrInitial = 0.002, lrDecayEvery = 15, lrDecayFactor = 0.5,
  earlyStopPatience = 12, dropout = 0.2, verbose = true,
} = {}) {
  const t = getTf();
  const inSplit = (id) => (part) => split[part].includes(id);
  const trainS = samples.filter((s) => split.train.includes(s.imageId));
  const valS = samples.filter((s) => split.val.includes(s.imageId));
  const calS = samples.filter((s) => split.cal.includes(s.imageId));
  const classes = [...new Set(samples.map((s) => s.digit))].sort();
  const idx = new Map(classes.map((c, i) => [c, i]));
  if (!trainS.length) throw new Error('بخش آموزش خالی است');

  // دادهٔ آموزش با افزون‌سازی (فقط روی خود بخش آموزش)
  const rng = mulberry32(seed);
  const xs = [], ys = [];
  for (const s of trainS) {
    const variants = [Float64Array.from(s.v)];
    for (let k = 0; k < augPerSample; k++) {
      variants.push(transformVec(Float64Array.from(s.v), {
        dx: Math.round((rng() * 2 - 1) * augShift),
        dy: Math.round((rng() * 2 - 1) * augShift),
        ang: (rng() * 2 - 1) * augAng,
        scale: scaleMin + rng() * (scaleMax - scaleMin),
      }));
    }
    for (const v of variants) { xs.push(Array.from(v)); ys.push(idx.get(s.digit)); }
  }
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
    [ys[i], ys[j]] = [ys[j], ys[i]];
  }

  const X = t.tensor4d(new Float32Array(xs.flat()), [xs.length, 20, 20, 1]);
  const Y = t.oneHot(t.tensor1d(ys, 'int32'), classes.length);

  // معماری با دراپ‌اوت (نظم‌دهی)
  const m = t.sequential();
  m.add(t.layers.conv2d({ inputShape: [20, 20, 1], filters: 16, kernelSize: 3, padding: 'same', activation: 'relu' }));
  m.add(t.layers.maxPooling2d({ poolSize: 2 }));
  m.add(t.layers.conv2d({ filters: 32, kernelSize: 3, padding: 'same', activation: 'relu' }));
  m.add(t.layers.maxPooling2d({ poolSize: 2 }));
  m.add(t.layers.flatten());
  if (dropout > 0) m.add(t.layers.dropout({ rate: dropout }));
  m.add(t.layers.dense({ units: 64, activation: 'relu' }));
  m.add(t.layers.dense({ units: classes.length, activation: 'softmax' }));

  let lr = lrInitial;
  m.compile({ optimizer: t.train.adam(lr), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });

  // توقف زودهنگام روی «دقت» اعتبارسنجی (نه تلفات): با مجموعهٔ اعتبارسنجیِ کوچک،
  // تلفات بسیار پرنویز است و معیار دقت پایدارتر است. گرم‌کردن: تا قبل از
  // warmup توقف نمی‌کنیم؛ بازگردانی وزن‌ها فقط وقتی بهترین دور از دور پایانی
  // بهتر بوده باشد (وگرنه مدل کاملِ آموزش‌دیده نگه داشته می‌شود).
  const warmup = 5;
  const valX = valS.length ? t.tensor4d(new Float32Array(valS.map((s) => Array.from(s.v)).flat()), [valS.length, 20, 20, 1]) : null;
  const valY = valS.length ? t.oneHot(t.tensor1d(valS.map((s) => idx.get(s.digit)), 'int32'), classes.length) : null;
  let bestValAcc = -1, bestEpoch = 0, bestWeights = null, patience = earlyStopPatience, lastValAcc = 0;
  const epochResults = [];
  for (let ep = 0; ep < epochs; ep++) {
    const h = await m.fit(X, Y, { epochs: 1, batchSize, verbose: 0 });
    const trainLoss = h.history.loss[0];
    let valLoss = trainLoss, valAcc = null;
    if (valX) {
      const ev = m.evaluate(valX, valY, { verbose: 0 });
      valLoss = ev[0].dataSync()[0];
      valAcc = ev[1].dataSync()[0];
      ev.forEach((xv) => xv.dispose());
    }
    epochResults.push({ epoch: ep + 1, trainLoss, valLoss, valAcc });
    if (verbose && (ep + 1) % 10 === 0) {
      console.log(`دور ${ep + 1}: loss=${trainLoss.toFixed(4)}` +
        (valAcc !== null ? ` valAcc=${(valAcc * 100).toFixed(1)}٪` : ''));
    }
    if (valAcc !== null) {
      lastValAcc = valAcc;
      if (valAcc > bestValAcc + 1e-6) {
        bestValAcc = valAcc; bestEpoch = ep + 1; patience = earlyStopPatience;
        if (bestWeights) bestWeights.forEach((w) => w.dispose());
        bestWeights = m.getWeights().map((w) => w.clone());
      } else if (ep + 1 >= warmup && --patience <= 0) {
        if (verbose) console.log(`توقف زودهنگام در دور ${ep + 1} (بهترین: ${bestEpoch})`);
        break;
      }
    }
    // زمان‌بندی کاهش نرخ یادگیری
    if (lrDecayEvery > 0 && (ep + 1) % lrDecayEvery === 0) {
      lr *= lrDecayFactor;
      m.compile({ optimizer: t.train.adam(lr), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });
      if (verbose) console.log(`نرخ یادگیری → ${lr.toExponential(1)}`);
    }
  }
  // بازگردانی وزن‌های بهترین دور فقط وقتی «به‌طور معناداری» بهتر از وضعیت
  // پایانی باشد؛ با اعتبارسنجیِ بسیار کوچک، نوسان تصادفی نباید مدل را به
  // دورهای کم‌آموزش‌دیده برگرداند.
  const RESTORE_MARGIN = 0.05;
  if (bestWeights && valX && bestValAcc > lastValAcc + RESTORE_MARGIN) {
    m.setWeights(bestWeights);
    if (verbose) console.log(`وزن‌های دور ${bestEpoch} بازگردانی شد (valAcc=${(bestValAcc * 100).toFixed(1)}٪)`);
  } else if (bestWeights) {
    bestWeights.forEach((w) => w.dispose());
    bestWeights = null;
    bestEpoch = epochResults.length;
  }

  // --- ارزیابی همهٔ بخش‌ها (بدون افزون‌سازی، بردارهای اصلی) ---
  const origTrain = samples.filter((s) => split.train.includes(s.imageId));
  const trainEv = evaluateVecs(m, origTrain.map((s) => s.v), origTrain.map((s) => s.digit), classes);
  const valEv = evaluateVecs(m, valS.map((s) => s.v), valS.map((s) => s.digit), classes);
  const calEv = evaluateVecs(m, calS.map((s) => s.v), calS.map((s) => s.digit), classes);

  // کالیبراسیون فقط روی بخش کالیبراسیون
  let temperature = 1, eceBefore = 0, eceAfter = 0;
  if (calEv.probsList.length >= 5) {
    const fit = fitTemperature(calEv.probsList, calEv.labelIdx, { maxT: 10, bins: 10 });
    temperature = fit.temperature;
    eceBefore = fit.eceBefore;
    eceAfter = fit.eceAfter;
  }
  if (verbose) {
    console.log(`دقت: train=${(trainEv.acc * 100).toFixed(1)}٪ val=${(valEv.acc * 100).toFixed(1)}٪ cal=${(calEv.acc * 100).toFixed(1)}٪`);
    console.log(`کالیبراسیون (فقط روی بخش کالیبراسیون): دما=${temperature} ECE: ${eceBefore.toFixed(3)} → ${eceAfter.toFixed(3)}`);
    if (trainEv.acc > 0.98 && valEv.acc < trainEv.acc - 0.15) {
      console.log('⚠️ بیش‌برازش: دقت آموزش ≈۱۰۰٪ ولی اعتبارسنجی به‌وضوح پایین‌تر است.');
    }
  }

  X.dispose(); Y.dispose();
  if (valX) { valX.dispose(); valY.dispose(); }

  return {
    model: m,
    classes,
    temperature,
    metrics: {
      trainAcc: trainEv.acc, valAcc: valEv.acc, calAcc: calEv.acc,
      eceCalBefore: eceBefore, eceCalAfter: eceAfter,
      bestEpoch, trainSamples: xs.length, epochsRun: epochResults.length,
      overfitting: trainEv.acc > 0.98 && valEv.acc < trainEv.acc - 0.15,
    },
    evaluateVecs: (vecs, labels) => evaluateVecs(m, vecs, labels, classes),
  };
}

module.exports = { trainSplitCNN, evaluateVecs };
