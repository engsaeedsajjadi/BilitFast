// تست‌های مدل اختصاصی تشخیص رقم (MLP + سنتز داده + استنتاج کپچا).
// همه تست‌ها قطعی‌اند (بدون تصادف بدون بذر، بدون شبکه).
// اجرا: node test/ml.test.js

const fs = require('fs');
const path = require('path');
const { MLP, mulberry32 } = require('../lib/ml');
const { renderDigit, normalizeComponent, generateDataset, LABELS } = require('../lib/digitsynth');
const ops = require('../lib/imageops');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

(async () => {
  /* ---------------- MLP: آموزش و ذخیره/بارگذاری ---------------- */
  // مسئله اسباب‌بازی: کلاس = (مجموع ۶ ورودی > ۳)
  const rng = mulberry32(123);
  const X = [], Y = [];
  for (let i = 0; i < 400; i++) {
    const x = Float64Array.from({ length: 6 }, () => (rng() < 0.5 ? 0 : 1));
    let s = 0; for (const v of x) s += v;
    X.push(x); Y.push(s > 3 ? 1 : 0);
  }
  const toy = new MLP([6, 8, 2], 7);
  const lossBefore = -Math.log(Math.max(toy.forward(X[0]).probs[Y[0]], 1e-12));
  for (let e = 0; e < 30; e++) toy.trainBatch(X.slice(0, 200), Y.slice(0, 200), 0.3);
  let okCount = 0;
  for (let i = 200; i < 400; i++) if (toy.predict(X[i]).label === Y[i]) okCount++;
  test('MLP مسئله اسباب‌بازی را یاد می‌گیرد (دقت تست ≥ ۹۰٪)', okCount >= 180);
  test('تلفات پس از آموزش کاهش یافته', (() => {
    let l = 0;
    for (let i = 0; i < 50; i++) l += -Math.log(Math.max(toy.forward(X[i]).probs[Y[i]], 1e-12));
    return l / 50 < lossBefore;
  })());

  const restored = MLP.fromJSON(JSON.parse(JSON.stringify(toy.toJSON())));
  test('ذخیره/بارگذاری مدل: پیش‌بینی‌ها یکسان می‌مانند', (() => {
    for (let i = 0; i < 20; i++) {
      if (toy.predict(X[i]).label !== restored.predict(X[i]).label) return false;
    }
    return true;
  })());

  // کالیبراسیون دمایی: دمای کمتر از ۱ باید احتمال برتر را تیزتر کند
  const probsRaw = toy.forward(X[0]).probs;
  let maxRaw = 0; for (const p of probsRaw) maxRaw = Math.max(maxRaw, p);
  toy.temperature = 0.3;
  const probsSharp = toy.predict(X[0]).probs;
  let maxSharp = 0; for (const p of probsSharp) maxSharp = Math.max(maxSharp, p);
  test('کالیبراسیون دمایی: احتمال برتر تیزتر می‌شود', maxSharp >= maxRaw);
  toy.temperature = 1;

  /* ---------------- سنتز داده ---------------- */
  const ds = generateDataset({ perDigit: 3, seed: 99 });
  test('سنتز داده: ۳۰ نمونه با برچسب', ds.X.length === 30 && ds.Y.length === 30);
  test('بردارهای نرمال‌شده ۴۰۰بعدی و دارای جوهرند', (() => {
    return ds.X.every((v) => v.length === 400 && v.some((x) => x > 0));
  })());
  const v0 = normalizeComponent(renderDigit('0', mulberry32(1)));
  const v1 = normalizeComponent(renderDigit('1', mulberry32(2)));
  test('دو رقم مختلف، بردار متفاوت می‌دهند', (() => {
    let diff = 0; for (let i = 0; i < 400; i++) diff += Math.abs(v0[i] - v1[i]);
    return diff > 5;
  })());

  /* ---------------- مدل کامیت‌شده ---------------- */
  const modelPath = path.join(__dirname, '..', 'models', 'captcha-model.json');
  test('فایل وزن‌های مدل در ریپو وجود دارد', fs.existsSync(modelPath));
  const model = MLP.fromJSON(JSON.parse(fs.readFileSync(modelPath, 'utf8')));

  // هر ۱۰ رقم با رندر تمیز (بذر ثابت) باید درست طبقه‌بندی شوند
  let correct = 0;
  for (let d = 0; d < 10; d++) {
    const img = renderDigit(LABELS[d], mulberry32(5000 + d * 7));
    if (model.predict(normalizeComponent(img)).label === d) correct++;
  }
  test('مدل کامیت‌شده: همه ۱۰ رقم تمیز درست طبقه‌بندی می‌شوند', correct === 10);

  /* ---------------- استنتاج کپچای چندرقمی ---------------- */
  const { solveWithModel, solveCaptcha } = require('../lib/captcha');

  async function compose(text, seed) {
    const r = mulberry32(seed);
    const parts = [...text].map((d) => renderDigit(d, r));
    const gap = 8;
    const w = parts.reduce((a, p) => a + p.width, 0) + gap * (parts.length - 1);
    const h = Math.max(...parts.map((p) => p.height));
    const out = ops.makeImage(w, h);
    let x = 0;
    for (const p of parts) {
      for (let y = 0; y < p.height; y++) {
        for (let xx = 0; xx < p.width; xx++) out.data[y * w + x + xx] = p.data[y * p.width + xx];
      }
      x += p.width + gap;
    }
    return ops.toPngBuffer(out);
  }

  const buf = await compose('7291', 777);
  const m = await solveWithModel(buf);
  test('solveWithModel: کپچای ۴رقمی را درست می‌خواند', !!m && m.text === '7291');
  test('solveWithModel: اطمینان کاراکترها پس از کالیبراسیون معقول است', !!m && m.minConf >= 0.5);

  const full = await solveCaptcha(buf);
  test('solveCaptcha: مسیر سریع مدل انتخاب می‌شود', full.variant === 'custom-model' && full.text === '7291');

  console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('خطای غیرمنتظره در تست:', e);
  process.exit(1);
});
