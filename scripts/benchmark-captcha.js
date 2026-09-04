// scripts/benchmark-captcha.js — benchmark آفلاین جامع برای pipeline کپچا.
// اجرا: node scripts/benchmark-captcha.js
// این اسکریپت فقط روی نمونه‌های مجاز داخل ریپو کار می‌کند و هیچ درخواست شبکه‌ای نمی‌زند.

const fs = require('fs');
const path = require('path');
const os = require('os');
const Jimp = require('jimp');
const { createWorker, PSM } = require('tesseract.js');
const captcha = require('../lib/captcha');
const charlearn = require('../lib/charlearn');
const { normalizeComponent } = require('../lib/digitsynth');
const { MLP } = require('../lib/ml');

const ROOT = path.join(__dirname, '..');
const DATASETS = [
  { name: 'real', dir: path.join(ROOT, 'samples', 'real'), labels: path.join(ROOT, 'samples', 'labels.json') },
  { name: 'real2', dir: path.join(ROOT, 'samples', 'real2'), labels: path.join(ROOT, 'samples', 'labels2.json') },
  { name: 'real3', dir: path.join(ROOT, 'samples', 'real3'), labels: path.join(ROOT, 'samples', 'labels3.json') },
];

function resolveLangPath() {
  const candidates = [
    path.join(ROOT, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int'),
    path.join(ROOT, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'eng.traineddata.gz'))) return p;
  }
  return null;
}

function workerOptions() {
  const langPath = resolveLangPath();
  const opts = { logger: () => {} };
  if (langPath) {
    opts.langPath = langPath;
    opts.gzip = true;
    opts.cacheMethod = 'none';
    opts.cachePath = os.tmpdir();
  }
  return opts;
}

function loadItems() {
  const items = [];
  for (const ds of DATASETS) {
    if (!fs.existsSync(ds.dir) || !fs.existsSync(ds.labels)) continue;
    const labels = JSON.parse(fs.readFileSync(ds.labels, 'utf8'));
    for (const file of fs.readdirSync(ds.dir).sort()) {
      if (!/\.png$/i.test(file)) continue;
      items.push({
        dataset: ds.name,
        name: file,
        file: path.join(ds.dir, file),
        label: String(labels[file] || ''),
      });
    }
  }
  return items;
}

function editDistance(a, b) {
  const A = String(a || '');
  const B = String(b || '');
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = 0; i <= A.length; i++) dp[i][0] = i;
  for (let j = 0; j <= B.length; j++) dp[0][j] = j;
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[A.length][B.length];
}

function summarizeRecords(records) {
  let exact = 0;
  let charOk = 0;
  let charAll = 0;
  let confSum = 0;
  let confN = 0;
  let timeSum = 0;
  let editSum = 0;
  let fail = 0;
  const strategyCounts = {};
  for (const r of records) {
    const out = r.text || '';
    if (out === r.label) exact++;
    if (!r.ok) fail++;
    for (let i = 0; i < Math.max(out.length, r.label.length); i++) {
      charAll++;
      if (out[i] === r.label[i]) charOk++;
    }
    editSum += editDistance(r.label, out);
    timeSum += r.ms;
    if (typeof r.confidence === 'number') {
      confSum += r.confidence;
      confN++;
    }
    const strategy = r.variant || 'null';
    strategyCounts[strategy] = (strategyCounts[strategy] || 0) + 1;
  }
  return {
    total: records.length,
    exact_match: `${exact}/${records.length}`,
    exact_match_percent: +(100 * exact / Math.max(1, records.length)).toFixed(1),
    character_accuracy_percent: +(100 * charOk / Math.max(1, charAll)).toFixed(1),
    average_edit_distance: +(editSum / Math.max(1, records.length)).toFixed(3),
    average_confidence: confN ? +(confSum / confN).toFixed(1) : 'NOT AVAILABLE',
    average_inference_ms: +(timeSum / Math.max(1, records.length)).toFixed(1),
    failure_rate_percent: +(100 * fail / Math.max(1, records.length)).toFixed(1),
    strategy_counts: strategyCounts,
  };
}

async function runBench(items, runner) {
  const records = [];
  for (const item of items) {
    const buf = fs.readFileSync(item.file);
    const t0 = Date.now();
    let result = null;
    try {
      result = await runner(buf, item);
    } catch (e) {
      result = { ok: false, text: '', error: e && e.message ? e.message : String(e) };
    }
    const text = result && result.text ? result.text : '';
    const ok = result && typeof result.ok === 'boolean' ? result.ok : text.length > 0;
    records.push({
      dataset: item.dataset,
      file: item.name,
      label: item.label,
      text,
      confidence: result && typeof result.confidence === 'number' ? result.confidence : null,
      variant: result && result.variant ? result.variant : null,
      whitelist: result && result.whitelist ? result.whitelist : null,
      engine: result && result.engine ? result.engine : null,
      ok,
      ms: Date.now() - t0,
    });
  }
  const byDataset = {};
  for (const ds of DATASETS.map((d) => d.name)) {
    const subset = records.filter((r) => r.dataset === ds);
    if (subset.length) byDataset[ds] = summarizeRecords(subset);
  }
  return {
    summary: summarizeRecords(records),
    by_dataset: byDataset,
    mismatches: records.filter((r) => r.text !== r.label).slice(0, 15),
  };
}

async function segmentationCoverage(items) {
  const stats = {
    total: items.length,
    color_thin_exact5: 0,
    color_no_thin_exact5: 0,
    grayscale_exact5: 0,
    extract_components_exact5: 0,
    rescued_by_grayscale_only: [],
    rescued_by_no_thin_only: [],
  };
  for (const item of items) {
    const img = await Jimp.read(fs.readFileSync(item.file));
    const a = charlearn.segmentColoredChars(img, 5, true);
    const b = charlearn.segmentColoredChars(img, 5, false);
    const g = charlearn.grayscaleChars(img);
    const e = charlearn.extractComponents(img, 5);
    const okA = !!(a && a.length === 5);
    const okB = !!(b && b.length === 5);
    const okG = !!(g && g.length === 5);
    const okE = !!(e && e.length === 5);
    if (okA) stats.color_thin_exact5++;
    if (okB) stats.color_no_thin_exact5++;
    if (okG) stats.grayscale_exact5++;
    if (okE) stats.extract_components_exact5++;
    if (!okA && okB) stats.rescued_by_no_thin_only.push(`${item.dataset}/${item.name}:${item.label}`);
    if (!(okA || okB) && okG) stats.rescued_by_grayscale_only.push(`${item.dataset}/${item.name}:${item.label}`);
  }
  return stats;
}

async function tesseractOnlyBench(items) {
  const worker = await createWorker('eng', 1, workerOptions());
  try {
    return await runBench(items, async (buf) => {
      let variants = [];
      try { variants = await captcha.advancedVariants(buf); } catch (e) { variants = []; }
      variants = variants.concat(await captcha.preprocessVariants(buf));
      const passes = [];
      for (const v of variants) passes.push({ v, whitelist: '0123456789', wlName: 'digits', psm: 7 });
      for (const v of variants.slice(0, 2)) passes.push({ v, whitelist: '0123456789', wlName: 'digits', psm: PSM.SINGLE_WORD });
      for (const v of variants.slice(0, 2)) passes.push({ v, whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', wlName: 'alnum', psm: 7 });
      let best = null;
      for (const p of passes.slice(0, 10)) {
        const r = await captcha.recognize(p.v.buffer, worker, p.whitelist, p.psm);
        r.variant = p.v.name;
        r.whitelist = p.wlName;
        r.score = captcha.scoreResult(r, false);
        if (!best || r.score > best.score) best = r;
      }
      if (!best) return { ok: false, text: '' };
      return { ...best, ok: best.text.length >= 5 && best.text.length <= 5 };
    });
  } finally {
    await worker.terminate();
  }
}

async function directCharMlpBench(items) {
  const json = require(path.join(ROOT, 'models', 'char-model.json'));
  const model = MLP.fromJSON(json);
  return runBench(items, async (buf, item) => {
    const img = await Jimp.read(buf);
    const comps = charlearn.extractComponents(img, item.label.length);
    if (!comps || comps.length !== item.label.length) {
      return { ok: false, text: '', variant: 'char-mlp-direct', whitelist: 'mixed', engine: 'mlp' };
    }
    let text = '';
    let confSum = 0;
    for (const comp of comps) {
      const pred = model.predict(normalizeComponent(comp, { size: 20, inner: 16 }));
      text += json.classes[pred.label] || '';
      confSum += pred.probs[pred.label] || 0;
    }
    return {
      ok: text.length === item.label.length,
      text,
      confidence: Math.round((confSum / Math.max(1, comps.length)) * 100),
      variant: 'char-mlp-direct',
      whitelist: 'mixed',
      engine: 'mlp',
    };
  });
}

(async () => {
  const items = loadItems();
  const labels = items.map((i) => i.label).join('');
  const uniqueChars = [...new Set(labels.split(''))].sort();
  const datasetSummary = {
    total_samples: items.length,
    fixed_length: [...new Set(items.map((i) => i.label.length))],
    unique_classes: uniqueChars.length,
    alphabet: uniqueChars.join(''),
    samples_with_uppercase: items.filter((i) => /[A-Z]/.test(i.label)).length,
    samples_with_lowercase: items.filter((i) => /[a-z]/.test(i.label)).length,
    samples_all_digits: items.filter((i) => /^\d+$/.test(i.label)).length,
  };

  const segmentation = await segmentationCoverage(items);
  const full = await runBench(items, async (buf) => captcha.solveCaptcha(buf, {}));
  const charModel = await runBench(items, async (buf) => captcha.solveWithCharModel(buf));
  const digitModel = await runBench(items, async (buf) => captcha.solveWithModel(buf));
  const prototype = await runBench(items, async (buf) => captcha.solveWithPrototypes(buf));
  const charMlpDirect = await directCharMlpBench(items);
  const tesseractOnly = await tesseractOnlyBench(items);

  const report = {
    generated_at: new Date().toISOString(),
    dataset: datasetSummary,
    segmentation_coverage: segmentation,
    solvers: {
      solveCaptcha_full: full,
      solveWithCharModel_active: charModel,
      charModel_mlp_direct: charMlpDirect,
      solveWithModel_digit_mlp: digitModel,
      solveWithPrototypes: prototype,
      tesseract_only: tesseractOnly,
    },
  };

  console.log(JSON.stringify(report, null, 2));
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
