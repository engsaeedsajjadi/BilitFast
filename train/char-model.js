// train/char-model.js — آموزش مدل الفبایی روی کاراکترهای واقعیِ برچسب‌خوردهٔ سایت.
//
// برخلاف مدل رقمی (که روی داده مصنوعی آموزش دید)، این مدل مستقیماً روی
// کاراکترهایی آموزش می‌بیند که از کپچاهای واقعیِ برچسب‌خورده استخراج شده‌اند
// (دیتابیس captcha_samples → char_vectors)؛ با افزون‌سازی هندسی (چرخش/جابه‌جایی/
// مقیاس) تا برای رندرهای ندیدهٔ همان فونت تعمیم پیدا کند.
//
// اجرا:  node train/char-model.js
// خروجی: models/char-model.json  (هرچه نمونه واقعی بیشتر، مدل دقیق‌تر)

const fs = require('fs');
const path = require('path');
const { MLP, mulberry32, accuracy, calibrateTemperature } = require('../lib/ml');
const { loadPrototypes, transformVec, VEC_SIZE } = require('../lib/charlearn');

const OUT = path.join(__dirname, '..', 'models', 'char-model.json');

function augment(vec, rng) {
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

function main() {
  const protos = loadPrototypes();
  if (protos.length < 10) {
    console.log('نمونه کافی نیست (' + protos.length + ' کاراکتر). ابتدا با train/import-labeled.js');
    console.log('یا حلقه یادگیری، نمونه واقعی جمع کنید.');
    return;
  }
  const classes = [...new Set(protos.map((p) => p.digit))].sort();
  const clsIndex = new Map(classes.map((c, i) => [c, i]));
  console.log('کاراکترهای مشاهده‌شده (' + classes.length + '):', classes.join(' '));

  const rng = mulberry32(1397);
  const { train: trainProtos, val: valProtos } = splitPrototypesForValidation(protos, rng);
  const X = [], Y = [];
  for (const p of trainProtos) {
    const base = Float64Array.from(p.v);
    X.push(base); Y.push(clsIndex.get(p.digit));
    for (let k = 0; k < 14; k++) {
      X.push(augment(base, rng)); Y.push(clsIndex.get(p.digit));
    }
  }
  // درهم‌سازی
  for (let i = X.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [X[i], X[j]] = [X[j], X[i]];
    [Y[i], Y[j]] = [Y[j], Y[i]];
  }
  console.log('نمونه‌های آموزش (با افزون‌سازی):', X.length);
  console.log('کاراکترهای واقعی آموزش:', trainProtos.length, '| اعتبارسنجی نگه‌داشته‌شده:', valProtos.length);

  const model = new MLP([VEC_SIZE, 64, classes.length], 42);
  const epochs = 40, batch = 32;
  let lr = 0.1;
  for (let ep = 1; ep <= epochs; ep++) {
    let loss = 0, n = 0;
    for (let i = 0; i + batch <= X.length; i += batch) {
      loss += model.trainBatch(X.slice(i, i + batch), Y.slice(i, i + batch), lr);
      n++;
    }
    if (ep % 10 === 0) {
      const trainAcc = accuracy(model, trainProtos.map((p) => Float64Array.from(p.v)), trainProtos.map((p) => clsIndex.get(p.digit)));
      const valAcc = valProtos.length
        ? accuracy(model, valProtos.map((p) => Float64Array.from(p.v)), valProtos.map((p) => clsIndex.get(p.digit)))
        : null;
      console.log(
        'دور ' + ep + ': تلفات ' + (loss / Math.max(1, n)).toFixed(3) +
        ' | دقت آموزش ' + (100 * trainAcc).toFixed(1) + '٪' +
        (valAcc == null ? ' | دقت اعتبارسنجی: NOT AVAILABLE' : ' | دقت اعتبارسنجی ' + (100 * valAcc).toFixed(1) + '٪')
      );
    }
    if (ep % 15 === 0) lr *= 0.5;
  }

  const trainEvalX = trainProtos.map((p) => Float64Array.from(p.v));
  const trainEvalY = trainProtos.map((p) => clsIndex.get(p.digit));
  const valEvalX = valProtos.map((p) => Float64Array.from(p.v));
  const valEvalY = valProtos.map((p) => clsIndex.get(p.digit));
  const trainAcc = accuracy(model, trainEvalX, trainEvalY);
  const valAcc = valProtos.length ? accuracy(model, valEvalX, valEvalY) : null;
  if (valProtos.length) model.temperature = calibrateTemperature(model, valEvalX, valEvalY);
  console.log('دقت نهایی روی کاراکترهای آموزش: ' + (100 * trainAcc).toFixed(1) + '٪');
  console.log(valAcc == null
    ? 'دقت نگه‌داشته‌شده: NOT AVAILABLE (برای هیچ کلاسی ≥۳ نمونه وجود نداشت)'
    : 'دقت نهایی روی کاراکترهای نگه‌داشته‌شده: ' + (100 * valAcc).toFixed(1) + '٪');
  console.log('دمای کالیبراسیون: ' + model.temperature);

  const json = model.toJSON();
  json.classes = classes;
  json.meta = {
    trained_at: new Date().toISOString(),
    real_chars: protos.length,
    train_chars: trainProtos.length,
    validation_chars: valProtos.length,
    validation_accuracy: valAcc == null ? null : Math.round(valAcc * 10000) / 100,
    classes: classes.length,
    temperature: model.temperature || 1,
    note: 'مدل الفبایی آموزش‌دیده روی کاراکترهای واقعی سایت + افزون‌سازی هندسی + ارزیابی نگه‌داشته‌شده.',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(json));
  console.log('مدل ذخیره شد: ' + OUT);
}

main();
