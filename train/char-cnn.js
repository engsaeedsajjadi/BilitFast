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
  const xs = [], ys = [];
  for (const p of protos) {
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

  const X = t.tensor4d(new Float32Array(xs.flat()), [xs.length, 20, 20, 1]);
  const Y = t.oneHot(t.tensor1d(ys, 'int32'), classes.length);

  const model = buildCharCNN(classes.length);
  model.compile({ optimizer: t.train.adam(0.002), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });

  await model.fit(X, Y, {
    epochs: 30,
    batchSize: 32,
    validationSplit: 0.15,
    verbose: 0,
    callbacks: {
      onEpochEnd: (ep, logs) => {
        if ((ep + 1) % 5 === 0) {
          console.log('دور ' + (ep + 1) + ': loss=' + logs.loss.toFixed(3) +
            ' acc=' + (logs.acc * 100).toFixed(1) + '٪ | val_acc=' + (logs.val_acc * 100).toFixed(1) + '٪');
        }
      },
    },
  });

  // دقت روی کاراکترهای اصلی (بدون افزون‌سازی)
  const origX = t.tensor4d(new Float32Array(protos.map((p) => Array.from(p.v)).flat()), [protos.length, 20, 20, 1]);
  const pred = model.predict(origX).argMax(1).dataSync();
  let ok = 0;
  protos.forEach((p, i) => { if (classes[pred[i]] === p.digit) ok++; });
  console.log('دقت نهایی روی کاراکترهای اصلی: ' + (100 * ok / protos.length).toFixed(1) + '٪');

  const weights = model.getWeights().map((w) => ({ shape: w.shape, data: Array.from(w.dataSync()) }));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ classes, weights, meta: { trained_at: new Date().toISOString(), real_chars: protos.length } }));
  console.log('مدل CNN ذخیره شد: ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + 'KB)');
  X.dispose(); Y.dispose(); origX.dispose();
}

main().catch((e) => { console.error(e); process.exit(1); });
