// train/train-digits.js — آموزش آفلاین مدل تشخیص رقم کپچا.
// اجرا:  node train/train-digits.js
// خروجی: models/captcha-model.json (همراه پروژه کامیت می‌شود)
//
// داده: نمونه‌های مصنوعی شبیه اعوجاج‌های کپچای سایت (موج سینوسی/چرخش/ضخامت).
// برای بازآموزی با نمونه‌های واقعی جمع‌شده از کاربران، از train/retrain.js استفاده کنید.

const fs = require('fs');
const path = require('path');
const { MLP, mulberry32 } = require('../lib/ml');
const { generateDataset } = require('../lib/digitsynth');

const OUT = path.join(__dirname, '..', 'models', 'captcha-model.json');

function shuffle(X, Y, rng) {
  for (let i = X.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [X[i], X[j]] = [X[j], X[i]];
    [Y[i], Y[j]] = [Y[j], Y[i]];
  }
}

function accuracy(model, X, Y) {
  let ok = 0;
  const conf = Array.from({ length: 10 }, () => [0, 0]); // [correct, total] per label
  for (let i = 0; i < X.length; i++) {
    const p = model.predict(X[i]);
    if (p.label === Y[i]) ok++;
    conf[Y[i]][1]++;
    if (p.label === Y[i]) conf[Y[i]][0]++;
  }
  return { acc: ok / X.length, conf };
}

/** کالیبراسیون دمایی: انتخاب T که آنتروپی متقاطع را روی مجموعه اعتبارسنجی
 * کمینه می‌کند تا «اطمینان خروجی» با «دقت واقعی» هم‌خوان شود. */
function calibrateTemperature(model, X, Y) {
  let bestT = 1, bestNll = Infinity;
  const raw = X.map((x) => model.forward(x).probs);
  for (let T = 0.2; T <= 1.001; T += 0.05) {
    let nll = 0;
    for (let i = 0; i < raw.length; i++) {
      const probs = raw[i];
      let s = 0;
      const q = new Array(probs.length);
      for (let j = 0; j < probs.length; j++) { q[j] = Math.pow(Math.max(probs[j], 1e-12), 1 / T); s += q[j]; }
      nll += -Math.log(Math.max(q[Y[i]] / s, 1e-12));
    }
    if (nll < bestNll) { bestNll = nll; bestT = Math.round(T * 100) / 100; }
  }
  return bestT;
}

function main() {
  const t0 = Date.now();
  console.log('ساخت مجموعه آموزشی...');
  const { X, Y } = generateDataset({ perDigit: 600, seed: 1397 });
  const rng = mulberry32(20260903);
  shuffle(X, Y, rng);

  const split = Math.floor(X.length * 0.9);
  const Xtr = X.slice(0, split), Ytr = Y.slice(0, split);
  const Xte = X.slice(split), Yte = Y.slice(split);
  console.log(`آموزش: ${Xtr.length} نمونه | تست: ${Xte.length} نمونه`);

  const model = new MLP([400, 48, 10], 42);
  const epochs = 16, batch = 32;
  let lr = 0.08;

  for (let ep = 1; ep <= epochs; ep++) {
    shuffle(Xtr, Ytr, rng);
    let loss = 0, batches = 0;
    for (let i = 0; i + batch <= Xtr.length; i += batch) {
      loss += model.trainBatch(Xtr.slice(i, i + batch), Ytr.slice(i, i + batch), lr);
      batches++;
    }
    const te = accuracy(model, Xte, Yte);
    console.log(`دور ${String(ep).padStart(2)}: تلفات=${(loss / batches).toFixed(4)} | دقت تست=${(te.acc * 100).toFixed(1)}٪ | lr=${lr.toFixed(3)}`);
    if (ep % 4 === 0) lr *= 0.6;
  }

  const final = accuracy(model, Xte, Yte);
  console.log('\n--- دقت نهایی روی مجموعه تست ---');
  console.log('دقت کل: ' + (final.acc * 100).toFixed(2) + '٪');
  for (let d = 0; d < 10; d++) {
    const [c, t] = final.conf[d];
    console.log(`رقم ${d}: ${t ? ((c / t) * 100).toFixed(1) : '-'}٪ (${c}/${t})`);
  }

  // کالیبراسیون اطمینان (بدون تغییر دقت — فقط احتمال‌ها را هم‌خوان می‌کند)
  model.temperature = calibrateTemperature(model, Xte, Yte);
  const calibrated = accuracy(model, Xte, Yte);
  console.log('دمای انتخاب‌شده: ' + model.temperature + ' | دقت پس از کالیبراسیون: ' + (calibrated.acc * 100).toFixed(2) + '٪');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const json = model.toJSON();
  json.meta = {
    trained_at: new Date().toISOString(),
    samples: X.length,
    test_accuracy: Math.round(final.acc * 10000) / 100,
    temperature: model.temperature,
    note: 'آموزش روی داده مصنوعی شبیه اعوجاج کپچا؛ با نمونه‌های واقعی از طریق train/retrain.js بازآموزی می‌شود.',
  };
  fs.writeFileSync(OUT, JSON.stringify(json));
  console.log('\nمدل ذخیره شد: ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' کیلوبایت)');
  console.log('زمان کل: ' + Math.round((Date.now() - t0) / 1000) + ' ثانیه');
}

main();
