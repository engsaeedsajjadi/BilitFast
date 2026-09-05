// train/char-cnn.js — آموزش CNN تشخیص کاراکتر روی نمونه‌های واقعی سایت (tfjs).
//
// داده: کاراکترهای برچسب‌خوردهٔ کپچاهای واقعی (captcha_samples → char_vectors)
// + افزون‌سازی هندسی. خروجی: models/char-cnn.json (توپولوژی ضمنی + وزن‌ها
// + دمای کالیبراسیون اطمینان).
//
// تابع آموزش به‌صورت ماژول صادر می‌شود تا اسکریپت‌های ارزیابی (مثل
// scripts/eval-holdout.js) از همان خط لولهٔ آموزش استفاده کنند — بدون
// پیاده‌سازی موازی.
//
// اجرا:  node train/char-cnn.js

const fs = require('fs');
const path = require('path');
// بک‌اند بومی برای سرعت آموزش (اختیاری؛ بدون آن tfjs خالص استفاده می‌شود)
try { require('@tensorflow/tfjs-node'); } catch (e) { /* pure-JS fallback */ }
const { mulberry32 } = require('../lib/ml');
const { loadPrototypes, transformVec } = require('../lib/charlearn');
const { buildCharCNN, getTf } = require('../lib/cnn');

const OUT = path.join(__dirname, '..', 'models', 'char-cnn.json');

function augmentVec(vec, rng, { ang = 10, shift = 1.5, scaleMin = 0.9, scaleMax = 1.1 } = {}) {
  return transformVec(vec, {
    dx: Math.round((rng() * 2 - 1) * shift),
    dy: Math.round((rng() * 2 - 1) * shift),
    ang: (rng() * 2 - 1) * ang,
    scale: scaleMin + rng() * (scaleMax - scaleMin),
  });
}

/**
 * کالیبراسیون دمایی روی مجموعهٔ اعتبارسنجی.
 * معیار اصلی: کمینه‌کردن ECE (خطای کالیبراسیون). جستجو فقط در جهت «نرم‌کردن»
 * (T ≥ ۱) انجام می‌شود: حالت شکست شناخته‌شدهٔ این مدل‌ها بیش‌اطمینانی است و
 * تیزترکردن احتمال‌ها روی مجموعهٔ اعتبارسنجی کوچک، بیش‌برازش است.
 * بین مقادیری که ECE تقریباً کمینه دارند (اختلاف ≤ ۰٫۰۱)، آن که NLL کمتری
 * دارد انتخاب می‌شود.
 */
function calibrateTemperature(probsList, labels, t = 1) {
  const grid = [];
  for (let T = 1; T <= 6.001; T += 0.1) grid.push(Math.round(T * 100) / 100);
  const rows = grid.map((T) => {
    const ece = computeECE(probsList, labels, { temperature: T });
    let nll = 0;
    for (let i = 0; i < probsList.length; i++) {
      const probs = probsList[i];
      let s = 0;
      const q = new Array(probs.length);
      for (let j = 0; j < probs.length; j++) {
        q[j] = Math.pow(Math.max(probs[j], 1e-12), 1 / T);
        s += q[j];
      }
      nll += -Math.log(Math.max(q[labels[i]] / s, 1e-12));
    }
    return { T, ece, nll };
  });
  const minEce = Math.min(...rows.map((r) => r.ece));
  const cands = rows.filter((r) => r.ece <= minEce + 0.01);
  cands.sort((a, b) => a.nll - b.nll);
  return cands[0].T;
}

/** خطای کالیبراسیون مورد انتظار (ECE) با سطل‌بندی اطمینان. */
function computeECE(probsList, labels, { bins = 10, temperature = 1 } = {}) {
  const buckets = new Array(bins).fill(null).map(() => ({ n: 0, conf: 0, acc: 0 }));
  for (let i = 0; i < probsList.length; i++) {
    const probs = probsList[i];
    // اعمال دما (مثل استنتاج واقعی)
    let p = probs;
    if (Math.abs(temperature - 1) > 1e-6) {
      let s = 0;
      p = new Array(probs.length);
      for (let j = 0; j < probs.length; j++) { p[j] = Math.pow(Math.max(probs[j], 1e-12), 1 / temperature); s += p[j]; }
      for (let j = 0; j < p.length; j++) p[j] /= s;
    }
    let label = 0;
    for (let j = 1; j < p.length; j++) if (p[j] > p[label]) label = j;
    const conf = p[label];
    const b = Math.min(bins - 1, Math.floor(conf * bins));
    buckets[b].n++;
    buckets[b].conf += conf;
    buckets[b].acc += (label === labels[i]) ? 1 : 0;
  }
  let ece = 0;
  for (const bk of buckets) {
    if (!bk.n) continue;
    ece += (bk.n / probsList.length) * Math.abs(bk.acc / bk.n - bk.conf / bk.n);
  }
  return ece;
}

/**
 * آموزش CNN کاراکتر روی بردارهای نمونهٔ واقعی.
 * ورودی: protos = [{ digit, v }]
 * خروجی: { model, classes, temperature, metrics }
 *   metrics = { valAcc, origAcc, eceBefore, eceAfter, samples, valSamples }
 */
async function trainCharCNN(protos, {
  epochs = 30,
  batchSize = 32,
  seed = 1397,
  augPerSample = 19,
  augAng = 10,
  augShift = 1.5,
  augScaleMin = 0.9,
  augScaleMax = 1.1,
  valRatio = 0.15,
  lr = 0.002,
  verbose = true,
} = {}) {
  const t = getTf();
  const classes = [...new Set(protos.map((p) => p.digit))].sort();
  const idx = new Map(classes.map((c, i) => [c, i]));
  if (verbose) console.log('کلاس‌ها (' + classes.length + '):', classes.join(' '));

  // تفکیک «طبقه‌بندی‌شده» آموزش/اعتبارسنجی قبل از افزون‌سازی:
  // از هر کلاس حداکثر ۱۵٪ به اعتبارسنجی می‌رود، اما همیشه حداقل یک نمونهٔ
  // آن کلاس در آموزش باقی می‌ماند (کلاس‌های تک‌نمونه کلاً در آموزش می‌مانند).
  // تفکیک تصادفی ساده می‌توانست کلاس‌های کمیاب را کاملاً از آموزش حذف کند.
  const rng = mulberry32(seed);
  const byClass = new Map();
  protos.forEach((p, i) => {
    if (!byClass.has(p.digit)) byClass.set(p.digit, []);
    byClass.get(p.digit).push(i);
  });
  const valIdx = new Set();
  for (const idxs of byClass.values()) {
    for (let i = idxs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
    }
    const nVal = Math.min(Math.floor(idxs.length * valRatio), idxs.length - 1);
    for (let i = 0; i < nVal; i++) valIdx.add(idxs[i]);
  }

  const xs = [], ys = [];
  protos.forEach((p, i) => {
    if (valIdx.has(i)) { xs.push(Array.from(p.v)); ys.push(idx.get(p.digit)); return; }
    const variants = [Float64Array.from(p.v)];
    const augOpts = { ang: augAng, shift: augShift, scaleMin: augScaleMin, scaleMax: augScaleMax };
    for (let k = 0; k < augPerSample; k++) variants.push(augmentVec(Float64Array.from(p.v), rng, augOpts));
    for (const v of variants) { xs.push(Array.from(v)); ys.push(idx.get(p.digit)); }
  });
  // درهم‌سازی مجموعهٔ آموزش
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
    [ys[i], ys[j]] = [ys[j], ys[i]];
  }
  if (verbose) console.log('نمونه‌های آموزش:', xs.length, '| اعتبارسنجی:', valIdx.size);

  const X = t.tensor4d(new Float32Array(xs.flat()), [xs.length, 20, 20, 1]);
  const Y = t.oneHot(t.tensor1d(ys, 'int32'), classes.length);

  const model = buildCharCNN(classes.length);
  model.compile({ optimizer: t.train.adam(lr), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });

  await model.fit(X, Y, {
    epochs,
    batchSize,
    verbose: 0,
    callbacks: {
      onEpochEnd: (ep, logs) => {
        if (verbose && (ep + 1) % 5 === 0) {
          console.log('دور ' + (ep + 1) + ': loss=' + logs.loss.toFixed(3) +
            ' acc=' + (logs.acc * 100).toFixed(1) + '٪');
        }
      },
    },
  });

  // ارزیابی روی اعتبارسنجی + کالیبراسیون دما + ECE
  const valX = t.tensor4d(
    new Float32Array([...valIdx].map((i) => Array.from(protos[i].v)).flat()),
    [valIdx.size, 20, 20, 1]
  );
  const valProbs = model.predict(valX).arraySync();
  const valLabels = [...valIdx].map((i) => idx.get(protos[i].digit));
  let valOk = 0;
  valProbs.forEach((probs, i) => {
    let label = 0;
    for (let j = 1; j < probs.length; j++) if (probs[j] > probs[label]) label = j;
    if (label === valLabels[i]) valOk++;
  });
  const valAcc = valOk / valLabels.length;
  const eceBefore = computeECE(valProbs, valLabels);
  const temperature = calibrateTemperature(valProbs, valLabels);
  const eceAfter = computeECE(valProbs, valLabels, { temperature });
  if (verbose) {
    console.log('اعتبارسنجی: ' + (valAcc * 100).toFixed(1) + '٪ | ECE قبل از کالیبراسیون: ' +
      eceBefore.toFixed(3) + ' | دمای بهینه: ' + temperature + ' | ECE بعد: ' + eceAfter.toFixed(3));
  }

  // دقت روی کاراکترهای اصلی (بدون افزون‌سازی)
  const origX = t.tensor4d(new Float32Array(protos.map((p) => Array.from(p.v)).flat()), [protos.length, 20, 20, 1]);
  const pred = model.predict(origX).argMax(1).dataSync();
  let ok = 0;
  protos.forEach((p, i) => { if (classes[pred[i]] === p.digit) ok++; });
  const origAcc = ok / protos.length;
  if (verbose) console.log('دقت روی کاراکترهای اصلی: ' + (origAcc * 100).toFixed(1) + '٪');

  X.dispose(); Y.dispose(); valX.dispose(); origX.dispose();

  return {
    model,
    classes,
    temperature,
    metrics: { valAcc, origAcc, eceBefore, eceAfter, samples: xs.length, valSamples: valIdx.size },
  };
}

/**
 * کالیبراسیون دما روی پیش‌بینی‌های یک مدل برای داده‌های «ندیده»:
 * شبکه‌ای که روی دادهٔ کم آموزش دیده، روی نمونه‌های تازه بیش‌اطمینان است
 * (مثلاً ۹۲٪ اطمینان برای ۴۰٪ دقت). این تابع دمایی را می‌یابد که اطمینان را
 * به دقت واقعی نزدیک کند (کمینهٔ ECE). جستجو فقط در جهت نرم‌کردن (T ≥ ۱).
 * ورودی: probsList = آرایهٔ بردارهای احتمال، labels = ایندکس کلاس درست.
 */
function calibrateOnHoldout(probsList, labels) {
  let bestT = 1, bestEce = Infinity;
  const before = computeECE(probsList, labels);
  for (let T = 1; T <= 10.01; T += 0.5) {
    const ece = computeECE(probsList, labels, { temperature: T });
    if (ece < bestEce) { bestEce = ece; bestT = Math.round(T * 10) / 10; }
  }
  return { temperature: bestT, eceBefore: before, eceAfter: bestEce };
}

/**
 * برآورد دمرای کالیبراسیون «دادهٔ ندیده» با پروتکل تفکیک سطح-تصویر:
 * ۱۲ تصویر از مجموعهٔ برچسب‌خورده بیرون نگه داشته می‌شوند، یک مدل تازه روی
 * بقیه آموزش می‌بیند و دما روی پیش‌بینی همان تصاویر نگه‌داشته انتخاب می‌شود.
 * این دما برای مدل نهایی ذخیره می‌شود تا اطمینانِ مسیر CNN در مواجهه با
 * کپچاهای جدید اغراق‌آمیز نباشد. (به بودجهٔ زمانی ≈۲ دقیقه نیاز دارد.)
 */
async function estimateUnseenTemperature({ seed = 1397, holdoutCount = 12, verbose = true } = {}) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
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
      if (/\.png$/i.test(f) && labels[f]) images.push({ abs: path.join(abs, f), label: labels[f] });
    }
  }
  if (images.length < 20) return null; // دادهٔ کافی برای پروتکل هلداوت نیست

  const { mulberry32 } = require('../lib/ml');
  const Jimp = require('jimp');
  const charlearn = require('../lib/charlearn');
  const { normalizeComponent } = require('../lib/digitsynth');
  const rng = mulberry32(seed);
  for (let i = images.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [images[i], images[j]] = [images[j], images[i]];
  }
  const heldOut = images.slice(0, holdoutCount);
  const trainImgs = images.slice(holdoutCount);

  const trainProtos = [];
  for (const im of trainImgs) {
    const vecs = await charlearn.extractCharVectors(fs.readFileSync(im.abs), im.label);
    if (vecs) for (const v of vecs) trainProtos.push(v);
  }
  if (trainProtos.length < 10) return null;
  const trained = await trainCharCNN(trainProtos, { seed, verbose: false });

  const t = getTf();
  const probsList = [], gtIdx = [];
  let charOk = 0, charAll = 0;
  for (const im of heldOut) {
    const jimg = await Jimp.read(im.abs);
    const comps = charlearn.extractComponents(jimg, im.label.length);
    if (!comps || comps.length !== im.label.length) continue;
    const vecs = comps.map((c) => normalizeComponent(c, { size: 20, inner: 16 }));
    const flat = new Float32Array(vecs.length * 400);
    vecs.forEach((v, i) => flat.set(v, i * 400));
    const xs = t.tensor4d(flat, [vecs.length, 20, 20, 1]);
    const probsArr = trained.model.predict(xs).arraySync();
    xs.dispose();
    probsArr.forEach((probs, i) => {
      probsList.push(probs);
      gtIdx.push(trained.classes.indexOf(im.label[i]));
      let l = 0;
      for (let j = 1; j < probs.length; j++) if (probs[j] > probs[l]) l = j;
      if (trained.classes[l] === im.label[i]) charOk++;
      charAll++;
    });
  }
  if (probsList.length < 10) return null;
  const calib = calibrateOnHoldout(probsList, gtIdx);
  trained.model.dispose();
  if (verbose) {
    console.log('کالیبراسیون دادهٔ ندیده: دقت کاراکتری ' + (100 * charOk / charAll).toFixed(1) +
      '٪ | ECE: ' + calib.eceBefore.toFixed(3) + ' → ' + calib.eceAfter.toFixed(3) +
      ' (دما ' + calib.temperature + ')');
  }
  return { temperature: calib.temperature, eceBefore: calib.eceBefore, eceAfter: calib.eceAfter, charAcc: charOk / charAll };
}

/** ذخیرهٔ مدل با فرمت سازگار با بارگذاری قبلی (classes + weights) + متادیتای کالیبراسیون. */
function saveCharModel(trained, outPath = OUT, protosCount, metaExtra = {}) {
  const weights = trained.model.getWeights().map((w) => ({ shape: w.shape, data: Array.from(w.dataSync()) }));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    classes: trained.classes,
    weights,
    meta: Object.assign({
      trained_at: new Date().toISOString(),
      real_chars: protosCount,
      temperature: trained.temperature,
      val_acc: trained.metrics.valAcc,
      orig_acc: trained.metrics.origAcc,
      ece_before: trained.metrics.eceBefore,
      ece_after: trained.metrics.eceAfter,
    }, metaExtra),
  }));
  return outPath;
}

async function main() {
  const protos = loadPrototypes();
  if (protos.length < 10) {
    console.log('نمونه کافی نیست. ابتدا نمونه واقعی جمع کنید (حلقه یادگیری یا import-labeled).');
    return;
  }
  // آموزش تصادفی است؛ مدل نهایی باید همهٔ کاراکترهای آموخته‌شده را درست بخواند.
  // با بذرهای مختلف تلاش می‌کنیم؛ بهترین تلاش (دقت اصلی، سپس اعتبارسنجی) نگه
  // داشته می‌شود و اگر به ۱۰۰٪ رسیدیم زودتر متوقف می‌شویم.
  let trained = null;
  for (const seed of [1397, 1400, 1401, 1402, 1403, 2025]) {
    const t = await trainCharCNN(protos, { seed });
    const better = !trained ||
      t.metrics.origAcc > trained.metrics.origAcc ||
      (t.metrics.origAcc === trained.metrics.origAcc && t.metrics.valAcc > trained.metrics.valAcc);
    if (better) trained = t;
    if (trained.metrics.origAcc >= 1) break;
    console.log('→ بهترین تا اینجا: داده‌های اصلی ' + (trained.metrics.origAcc * 100).toFixed(1) +
      '٪ | ادامه با بذر بعدی…');
  }
  // کالیبراسیون دما برای «دادهٔ ندیده»: مدل نهایی همهٔ نمونه‌ها را حفظ کرده
  // (اعتبارسنجی داخل‌نمونه‌ای فروپاشیده است)، پس دمای قابل‌اعتماد از پروتکل
  // تفکیک سطح-تصویر روی مدل هم‌خانواده به دست می‌آید و در مدل ذخیره می‌شود.
  let metaExtra = { temperature_source: 'in-sample' };
  try {
    const unseen = await estimateUnseenTemperature({ verbose: true });
    if (unseen) {
      metaExtra = {
        temperature: unseen.temperature,
        temperature_source: 'unseen-holdout',
        temperature_in_sample: trained.temperature,
        unseen_char_acc: unseen.charAcc,
        unseen_ece_before: unseen.eceBefore,
        unseen_ece_after: unseen.eceAfter,
      };
    }
  } catch (e) {
    console.log('کالیبراسیون دادهٔ ندیده انجام نشد (', e && e.message, ') — دمای داخل‌نمونه‌ای استفاده می‌شود.');
  }
  const out = saveCharModel(trained, OUT, protos.length, metaExtra);
  console.log('مدل CNN ذخیره شد: ' + out + ' (' + Math.round(fs.statSync(out).size / 1024) + 'KB)' +
    ' | دمای نهایی: ' + (metaExtra.temperature !== undefined ? metaExtra.temperature : trained.temperature));
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  trainCharCNN, saveCharModel, augmentVec,
  calibrateTemperature, computeECE, calibrateOnHoldout, estimateUnseenTemperature,
};
