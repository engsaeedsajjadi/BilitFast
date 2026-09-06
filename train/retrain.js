// train/retrain.js — بازآموزی مدل با داده مصنوعی + نمونه‌های واقعی کاربران.
// اجرا:  node train/retrain.js
//
// نمونه‌های واقعی از طریق /api/learn جمع‌آوری شده‌اند (کپچاهایی که سرورِ
// صفیر ریل حل‌شدن‌شان را تأیید کرده، پس برچسب‌ها قابل اعتمادند). هر نمونه
// با همان خط لوله استنتاج پردازش می‌شود؛ اگر تعداد کاراکترهای استخراج‌شده با
// طول برچسب برابر نبود، آن نمونه رد می‌شود (نویز/چسبیدگی زیاد).

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { MLP, mulberry32 } = require('../lib/ml');
const { generateDataset, LABELS, normalizeComponent } = require('../lib/digitsynth');
const ops = require('../lib/imageops');

const OUT = path.join(__dirname, '..', 'models', 'captcha-model.json');
const DB_FILE = process.env.BILITFAST_DATA_DIR
  ? path.join(process.env.BILITFAST_DATA_DIR, 'db.json')
  : path.join(__dirname, '..', 'data', 'db.json');

function shuffle(X, Y, rng) {
  for (let i = X.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [X[i], X[j]] = [X[j], X[i]];
    [Y[i], Y[j]] = [Y[j], Y[i]];
  }
}

function accuracy(model, X, Y) {
  let ok = 0;
  for (let i = 0; i < X.length; i++) if (model.predict(X[i]).label === Y[i]) ok++;
  return ok / X.length;
}

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

/** اعتبارسنجی امضای باینری تصویر (PNG/JPEG/GIF) — قبل از هر پردازش. */
function isKnownImage(buf) {
  if (!buf || buf.length < 8) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49) return true; // GIF
  return false;
}

/** Jimp.read با سقف زمانی — نمونه فاسد نباید کل بازآموزی را متوقف کند. */
function readImageWithTimeout(buffer, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('image decode timeout')), ms);
    Jimp.read(buffer)
      .then((img) => { clearTimeout(timer); resolve(img); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

/** استخراج کاراکترها از یک کپچای واقعی (همان خط لوله استنتاج مدل). */
async function extractChars(buffer) {
  if (!isKnownImage(buffer)) return [];
  const base = await readImageWithTimeout(buffer);
  let gray = ops.fromJimp(base);
  if (gray.width < 320) gray = ops.resizeBilinear(gray, 320 / gray.width);
  const polarity = ops.estimatePolarity(gray);
  let bin = ops.binarize(gray, ops.otsuThreshold(gray), !polarity.textIsDark);
  bin = ops.medianBlur3(bin);
  bin = ops.morphOpen(bin, 1);
  bin = ops.morphClose(bin, 1);
  const cc = ops.connectedComponents(bin);
  if (cc.count === 0) return [];
  bin = ops.filterComponentsMask(bin, cc, { minArea: 3, maxCount: 8 });
  const runs = ops.columnRuns(bin);
  return runs.map((run) => ops.cropColumn(bin, run));
}

async function loadRealSamples() {
  if (!fs.existsSync(DB_FILE)) return { X: [], Y: [] };
  let dbj;
  try { dbj = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return { X: [], Y: [] }; }
  const samples = dbj.captcha_samples || [];
  const X = [], Y = [];
  let skipped = 0;
  for (const s of samples) {
    try {
      // ۱) نمونه‌هایی که بردار کاراکتر آماده دارند (واردشده/یادگرفته): فقط ارقام
      //    برای آموزش مدل رقمی استفاده می‌شوند؛ حروف به مدل ۱۰خروجی نمی‌خورند.
      if (Array.isArray(s.char_vectors)) {
        for (const cv of s.char_vectors) {
          if (cv && /^[0-9]$/.test(cv.digit) && Array.isArray(cv.v) && cv.v.length === 400) {
            X.push(Float64Array.from(cv.v));
            Y.push(parseInt(cv.digit, 10));
          }
        }
        continue;
      }
      // ۲) نمونه‌های تصویری: استخراج کاراکترها (همان خط لوله استنتاج)
      const b64 = String(s.image || '').split(',')[1];
      if (!b64) { skipped++; continue; }
      const chars = await extractChars(Buffer.from(b64, 'base64'));
      const label = String(s.text || '');
      if (chars.length !== label.length) { skipped++; continue; }
      for (let i = 0; i < chars.length; i++) {
        const d = LABELS.indexOf(label[i]);
        if (d < 0) { skipped++; continue; }
        X.push(normalizeComponent(chars[i]));
        Y.push(d);
      }
    } catch (e) { skipped++; }
  }
  console.log(`نمونه‌های واقعی: ${samples.length} کپچا → ${X.length} کاراکتر (${skipped} مورد رد شد)`);
  return { X, Y };
}

(async () => {
  const t0 = Date.now();
  console.log('ساخت داده مصنوعی...');
  const synth = generateDataset({ perDigit: 600, seed: 1397 });
  const real = await loadRealSamples();

  const X = synth.X.concat(real.X);
  const Y = synth.Y.concat(real.Y);
  const rng = mulberry32(20260903);
  shuffle(X, Y, rng);

  const split = Math.floor(X.length * 0.9);
  const Xtr = X.slice(0, split), Ytr = Y.slice(0, split);
  const Xte = X.slice(split), Yte = Y.slice(split);
  console.log(`مجموع: ${X.length} نمونه (آموزش ${Xtr.length} / تست ${Xte.length})`);

  const model = new MLP([400, 48, 10], 42);
  const epochs = 12, batch = 32;
  let lr = 0.08;
  for (let ep = 1; ep <= epochs; ep++) {
    shuffle(Xtr, Ytr, rng);
    for (let i = 0; i + batch <= Xtr.length; i += batch) {
      model.trainBatch(Xtr.slice(i, i + batch), Ytr.slice(i, i + batch), lr);
    }
    console.log(`دور ${ep}: دقت تست=${(accuracy(model, Xte, Yte) * 100).toFixed(1)}٪`);
    if (ep % 4 === 0) lr *= 0.6;
  }

  const acc = accuracy(model, Xte, Yte);
  console.log('دقت نهایی تست: ' + (acc * 100).toFixed(2) + '٪');

  model.temperature = calibrateTemperature(model, Xte, Yte);
  console.log('دمای کالیبراسیون: ' + model.temperature);

  const json = model.toJSON();
  json.meta = {
    trained_at: new Date().toISOString(),
    samples: X.length,
    real_chars: real.X.length,
    test_accuracy: Math.round(acc * 10000) / 100,
    temperature: model.temperature,
    note: 'بازآموزی با داده مصنوعی + نمونه‌های واقعی تأییدشده کاربران.',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(json));
  console.log('مدل جدید ذخیره شد: ' + OUT);
  console.log('زمان: ' + Math.round((Date.now() - t0) / 1000) + ' ثانیه');
})().catch((e) => { console.error(e); process.exit(1); });
