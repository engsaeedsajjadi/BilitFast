// train/char-cnn.js — آموزش CNN تشخیص کاراکتر روی نمونه‌های واقعی سایت (tfjs).
//
// داده: کاراکترهای برچسب‌خوردهٔ کپچاهای واقعی (captcha_samples → char_vectors)
// + افزون‌سازی هندسی. خروجی: models/char-cnn.json (توپولوژی ضمنی + وزن‌ها).
//
// اجرا:  node train/char-cnn.js

const fs = require('fs');
const path = require('path');
// بک‌اند بومی برای سرعت آموزش (اختیاری؛ بدون آن tfjs خالص استفاده می‌شود)
try { require('@tensorflow/tfjs-node'); } catch (e) { /* pure-JS fallback */ }
const { mulberry32 } = require('../lib/ml');
const { loadPrototypes, transformVec, VEC_SIZE } = require('../lib/charlearn');
const { buildCharCNN, getTf } = require('../lib/cnn');

const OUT = path.join(__dirname, '..', 'models', 'char-cnn.json');

function augmentVec(vec, rng) {
  return transformVec(vec, {
    dx: Math.round((rng() * 2 - 1) * 1.5),
    dy: Math.round((rng() * 2 - 1) * 1.5),
    ang: (rng() * 2 - 1) * 10,
    scale: 0.9 + rng() * 0.2,
  });
}

function splitPrototypesForValidation(protos, rng, valRatio = 0.15) {
  const groups = new Map();
  for (const p of protos) {
    const arr = groups.get(p.digit) || [];
    arr.push(p);
    groups.set(p.digit, arr);
  }
  const train = [], val = [];
  for (const arr of groups.values()) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const takeVal = arr.length >= 3 ? Math.min(arr.length - 1, Math.max(1, Math.round(arr.length * valRatio))) : 0;
    val.push(...arr.slice(0, takeVal));
    train.push(...arr.slice(takeVal));
  }
  return { train, val };
}

function accuracyFromPred(classes, protos, pred) {
  let ok = 0;
  protos.forEach((p, i) => { if (classes[pred[i]] === p.digit) ok++; });
  return protos.length ? ok / protos.length : 0;
}

async function main() {
  const t = getTf();
  const protos = loadPrototypes();
  if (protos.length < 10) {
    console.log('نمونه کافی نیست. ابتدا نمونه واقعی جمع کنید (حلقه یادگیری یا import-labeled).');
    return;
  }
  const classes = [...new Set(protos.map((p) => p.digit))].sort();
  const idx = new Map(classes.map((c, i) => [c, i]));
  console.log('کلاس‌ها (' + classes.length + '):', classes.join(' '));

  const rng = mulberry32(1397);
  const { train: trainProtos, val: valProtos } = splitPrototypesForValidation(protos, rng);
  const xs = [], ys = [];
  for (const p of trainProtos) {
    const variants = [Float64Array.from(p.v)];
    for (let k = 0; k < 19; k++) variants.push(augmentVec(Float64Array.from(p.v), rng));
    for (const v of variants) {
      xs.push(Array.from(v));
      ys.push(idx.get(p.digit));
    }
  }
  // درهم‌سازی
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
    [ys[i], ys[j]] = [ys[j], ys[i]];
  }
  console.log('نمونه‌های آموزش:', xs.length);
  console.log('کاراکترهای واقعی آموزش:', trainProtos.length, '| اعتبارسنجی نگه‌داشته‌شده:', valProtos.length);

  const X = t.tensor4d(new Float32Array(xs.flat()), [xs.length, 20, 20, 1]);
  const Y = t.oneHot(t.tensor1d(ys, 'int32'), classes.length);
  const valX = valProtos.length
    ? t.tensor4d(new Float32Array(valProtos.map((p) => Array.from(p.v)).flat()), [valProtos.length, 20, 20, 1])
    : null;
  const valY = valProtos.length
    ? t.oneHot(t.tensor1d(valProtos.map((p) => idx.get(p.digit)), 'int32'), classes.length)
    : null;

  const model = buildCharCNN(classes.length);
  model.compile({ optimizer: t.train.adam(0.002), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });

  const fitOpts = {
    epochs: 30,
    batchSize: 32,
    verbose: 0,
    callbacks: {
      onEpochEnd: (ep, logs = {}) => {
        if ((ep + 1) % 5 === 0) {
          const acc = logs.acc ?? logs.accuracy ?? 0;
          const valAcc = logs.val_acc ?? logs.val_accuracy;
          console.log(
            'دور ' + (ep + 1) + ': loss=' + (logs.loss || 0).toFixed(3) +
            ' acc=' + (acc * 100).toFixed(1) + '٪' +
            (valAcc == null ? ' | val_acc=NOT AVAILABLE' : ' | val_acc=' + (valAcc * 100).toFixed(1) + '٪')
          );
        }
      },
    },
  };
  if (valX && valY) fitOpts.validationData = [valX, valY];
  else fitOpts.validationSplit = 0.15;

  await model.fit(X, Y, fitOpts);

  const trainEvalX = t.tensor4d(new Float32Array(trainProtos.map((p) => Array.from(p.v)).flat()), [trainProtos.length, 20, 20, 1]);
  const trainPred = model.predict(trainEvalX).argMax(1).dataSync();
  const trainAcc = accuracyFromPred(classes, trainProtos, trainPred);
  console.log('دقت نهایی روی کاراکترهای آموزش: ' + (100 * trainAcc).toFixed(1) + '٪');

  let valAcc = null;
  if (valProtos.length) {
    const valPred = model.predict(valX).argMax(1).dataSync();
    valAcc = accuracyFromPred(classes, valProtos, valPred);
    console.log('دقت نهایی روی کاراکترهای نگه‌داشته‌شده: ' + (100 * valAcc).toFixed(1) + '٪');
  } else {
    console.log('دقت نگه‌داشته‌شده: NOT AVAILABLE (برای هیچ کلاسی ≥۳ نمونه وجود نداشت)');
  }

  const weights = model.getWeights().map((w) => ({ shape: w.shape, data: Array.from(w.dataSync()) }));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    classes,
    weights,
    meta: {
      trained_at: new Date().toISOString(),
      real_chars: protos.length,
      train_chars: trainProtos.length,
      validation_chars: valProtos.length,
      validation_accuracy: valAcc == null ? null : Math.round(valAcc * 10000) / 100,
    },
  }));
  console.log('مدل CNN ذخیره شد: ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
  X.dispose(); Y.dispose();
  if (valX) valX.dispose();
  if (valY) valY.dispose();
  trainEvalX.dispose();
}

main().catch((e) => { console.error(e); process.exit(1); });
