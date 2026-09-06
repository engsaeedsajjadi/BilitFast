// scripts/eval-holdout.js — بنچمارک «تعمیم‌پذیری» روی کپچای ندیده.
//
// چرا این اسکریپت لازم است؟ بنچمارک استاندارد (eval-solve.js) همان ۴۹ تصویری
// را می‌سنجد که بردارشان در حافظهٔ نمونه‌ها و دادهٔ آموزش CNN هست — عملاً
// حافظه‌سنجی است. اینجا با تفکیک سطح-تصویر (تصادفی با بذر ثابت)، بخشی از
// تصاویر کاملاً از آموزش و حافظه بیرون نگه داشته می‌شوند و خط لوله روی آن‌ها
// سنجیده می‌شود:
//
//   ۱) بردار کاراکترهای تصاویر «آموزش» استخراج می‌شود
//   ۲) یک CNN تازه فقط روی همان‌ها آموزش می‌بیند (همان خط لولهٔ تولید)
//   ۳) تصاویر «نگه‌داشته‌شده» سه‌گونه حل می‌شوند:
//        a) فقط k-NN با بردارهای آموزش (مسیر نمونه‌محور در دنیای واقعی)
//        b) فقط CNN تازه (مسیر مدل بدون حافظه)
//        c) ترکیب: نمونه‌محور کامل اگر همهٔ کاراکترها تطبیق یافتند، وگرنه CNN
//
// اجرا:
//   node scripts/eval-holdout.js                 # تفکیک پیش‌فرض (بذر ۱۳۹۷، ۲۵٪ نگه‌داشته)
//   node scripts/eval-holdout.js --seed 7 --holdout 12
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { mulberry32 } = require('../lib/ml');
const cl = require(path.join(__dirname, '..', 'lib', 'charlearn'));
const { normalizeComponent } = require(path.join(__dirname, '..', 'lib', 'digitsynth'));
const { getTf } = require(path.join(__dirname, '..', 'lib', 'cnn'));
const { trainCharCNN, calibrateOnHoldout } = require(path.join(__dirname, '..', 'train', 'char-cnn'));

const ROOT = path.join(__dirname, '..');
const dirs = ['samples/real', 'samples/real2', 'samples/real3'];
const MIN_LEN = 5, MAX_LEN = 5;

function argNum(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Array(n + 1).fill(0);
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[m][n];
}

(async () => {
  const seed = argNum('seed', 1397);
  const holdoutCount = argNum('holdout', 12);
  const labels = Object.assign(
    {},
    JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/labels.json'))),
    JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/labels2.json'))),
    JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/labels3.json')))
  );

  // فهرست تصاویر + تفکیک سطح-تصویر با بذر ثابت
  const images = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (/\.png$/i.test(f) && labels[f]) images.push({ dir: d, file: f, label: labels[f] });
    }
  }
  const rng = mulberry32(seed);
  for (let i = images.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [images[i], images[j]] = [images[j], images[i]];
  }
  const heldOut = images.slice(0, holdoutCount);
  const trainImgs = images.slice(holdoutCount);
  console.log('تصاویر: ' + images.length + ' | آموزش: ' + trainImgs.length + ' | نگه‌داشته: ' + heldOut.length + ' (بذر ' + seed + ')');

  // ۱) استخراج بردارهای آموزش
  const trainProtos = [];
  let skipped = 0;
  for (const im of trainImgs) {
    const buf = fs.readFileSync(path.join(ROOT, im.dir, im.file));
    const vecs = await cl.extractCharVectors(buf, im.label);
    if (!vecs) { skipped++; continue; }
    for (const v of vecs) trainProtos.push(v);
  }
  console.log('بردارهای آموزش: ' + trainProtos.length + (skipped ? ' (تصاویر بدون استخراج: ' + skipped + ')' : ''));

  // ۲) آموزش CNN تازه فقط روی بردارهای آموزش
  // پارامترهای آموزش از متغیرهای محیطی قابل تنظیم‌اند (برای آزمایش):
  //   AUG_ANG, AUG_SHIFT, AUG_SCALE_MIN, AUG_SCALE_MAX, AUG_PER, EPOCHS
  const trained = await trainCharCNN(trainProtos, {
    epochs: process.env.EPOCHS ? Number(process.env.EPOCHS) : 30,
    augPerSample: process.env.AUG_PER ? Number(process.env.AUG_PER) : 19,
    augAng: process.env.AUG_ANG ? Number(process.env.AUG_ANG) : 10,
    augShift: process.env.AUG_SHIFT ? Number(process.env.AUG_SHIFT) : 1.5,
    augScaleMin: process.env.AUG_SCALE_MIN ? Number(process.env.AUG_SCALE_MIN) : 0.9,
    augScaleMax: process.env.AUG_SCALE_MAX ? Number(process.env.AUG_SCALE_MAX) : 1.1,
    verbose: true,
  });
  const tf = getTf();

  // ۳) ارزیابی روی تصاویر نگه‌داشته
  // گذر اول: جمع‌آوری پیش‌بینی‌های CNN و نتایج k-NN برای هر تصویر
  const rows = [];
  const bad = [];
  for (const im of heldOut) {
    const buf = fs.readFileSync(path.join(ROOT, im.dir, im.file));
    const jimg = await Jimp.read(buf);
    const comps = cl.extractComponents(jimg, MIN_LEN);
    if (!comps || comps.length < MIN_LEN || comps.length > MAX_LEN) {
      bad.push(`${im.dir}/${im.file}(${im.label}) → قطعه‌بندی ناموفق (${comps ? comps.length : 0})`);
      rows.push({ im, failed: true });
      continue;
    }
    const vecs = comps.map((c) => normalizeComponent(c, { size: 20, inner: 16 }));

    // a) k-NN فقط با بردارهای آموزش
    let protoText = '', protoConfSum = 0, protoOk = true;
    for (const v of vecs) {
      const m = cl.matchPrototype(v, trainProtos, 0.3);
      if (!m) { protoOk = false; break; }
      protoText += m.digit;
      protoConfSum += Math.min(0.99, 1 - m.dist);
    }
    if (!protoOk) protoText = '';

    // b) پیش‌بینی خام CNN (اعمال دما در گذر دوم، بعد از کالیبراسیون)
    const flat = new Float32Array(vecs.length * 400);
    vecs.forEach((v, i) => flat.set(v, i * 400));
    const xs = tf.tensor4d(flat, [vecs.length, 20, 20, 1]);
    const probsArr = trained.model.predict(xs).arraySync();
    xs.dispose();
    rows.push({ im, protoText, protoConfSum, probsArr, nChars: vecs.length });
  }

  // کالیبراسیون دما روی همین پیش‌بینی‌های دادهٔ ندیده (رفتار مدل تولیدی):
  // با NO_CALIB=1 دما ۱ می‌ماند (شبیه‌سازی رفتار قبل از کالیبراسیون).
  let T = 1, eceBefore = 0, eceAfter = 0;
  const allProbs = [], allGt = [];
  for (const r of rows) {
    if (r.failed) continue;
    r.probsArr.forEach((probs, i) => {
      allProbs.push(probs);
      allGt.push(trained.classes.indexOf(r.im.label[i]));
    });
  }
  if (!process.env.NO_CALIB && allProbs.length >= 10) {
    const calib = calibrateOnHoldout(allProbs, allGt);
    T = calib.temperature;
    eceBefore = calib.eceBefore;
    eceAfter = calib.eceAfter;
    console.log('کالیبراسیون روی دادهٔ ندیده: دما ' + T + ' | ECE: ' +
      eceBefore.toFixed(3) + ' → ' + eceAfter.toFixed(3));
  }

  // گذر دوم: محاسبهٔ آمارها با دمای انتخاب‌شده
  const stats = {
    proto: { exact: 0, charOk: 0, charAll: 0, edit: 0, conf: 0 },
    cnn: { exact: 0, charOk: 0, charAll: 0, edit: 0, conf: 0 },
    combined: { exact: 0, charOk: 0, charAll: 0, edit: 0, conf: 0 },
  };
  for (const r of rows) {
    if (r.failed) {
      for (const key of Object.keys(stats)) stats[key].charAll += r.im.label.length;
      continue;
    }
    const { im, protoText, protoConfSum, probsArr } = r;
    let cnnText = '', cnnConfSum = 0;
    for (const probs of probsArr) {
      let p = probs;
      if (Math.abs(T - 1) > 1e-6) {
        let s = 0;
        p = probs.map((q) => Math.pow(Math.max(q, 1e-12), 1 / T));
        s = p.reduce((a, b) => a + b, 0);
        p = p.map((q) => q / s);
      }
      let label = 0;
      for (let j = 1; j < p.length; j++) if (p[j] > p[label]) label = j;
      cnnText += trained.classes[label];
      cnnConfSum += p[label];
    }

    // c) ترکیب: نمونه‌محور کامل، وگرنه CNN
    const combinedText = protoText || cnnText;
    const combinedConf = protoText
      ? Math.round((protoConfSum / r.nChars) * 100)
      : Math.round((cnnConfSum / r.nChars) * 100);

    const acc = (key, text, conf) => {
      const st = stats[key];
      if (text === im.label) st.exact++;
      st.edit += editDistance(text, im.label);
      st.conf += conf;
      for (let i = 0; i < Math.max(text.length, im.label.length); i++) {
        st.charAll++;
        if (text[i] === im.label[i]) st.charOk++;
      }
    };
    acc('proto', protoText, protoText ? Math.round((protoConfSum / r.nChars) * 100) : 0);
    acc('cnn', cnnText, Math.round((cnnConfSum / r.nChars) * 100));
    acc('combined', combinedText, combinedConf);

    if (combinedText !== im.label) bad.push(`${im.dir}/${im.file}(${im.label}) → proto:${protoText || '—'} cnn:${cnnText}`);
  }

  const n = heldOut.length;
  const pct = (x) => (100 * x).toFixed(1) + '%';
  const row = (name, st) => `${name.padEnd(10)}: Exact ${st.exact}/${n} (${pct(st.exact / n)})` +
    ` | Char ${st.charOk}/${st.charAll} (${pct(st.charOk / Math.max(1, st.charAll))})` +
    ` | Edit ${(st.edit / n).toFixed(2)} | Conf ${(st.conf / n).toFixed(1)}`;
  console.log('================ نتیجه روی تصاویر نگه‌داشته (ندیده) ================');
  console.log(row('kNN-only', stats.proto));
  console.log(row('CNN-only', stats.cnn));
  console.log(row('Combined', stats.combined));
  console.log('اعتبارسنجی داخل آموزش: ' + (trained.metrics.valAcc * 100).toFixed(1) + '٪ | دمای اعمال‌شده: ' + T);
  if (bad.length) { console.log('---------------- موارد ناموفق ----------------'); console.log(bad.join('\n')); }
  process.exit(stats.combined.exact === n ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
