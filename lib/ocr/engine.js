// -*- coding: utf-8 -*-
/**
 * lib/ocr/engine.js — موتور OCR بازنویسی‌شده.
 *
 * مسیر کامل:
 *   Image → preprocessing → polarity detection → segmentation → normalization
 *   → recognition → confidence → sequence decision (+ logging)
 *
 * طراحی: همهٔ مراحل از ماژول‌های مجزا (preprocess/polarity/segment/...) تشکیل
 * شده‌اند؛ هر مرحله قابل تعویض/حذف برای ablation است. خطاها هرگز استثنا نمی‌دهند
 * بلکه به‌صورت structured failureReason برمی‌گردند (جریان رزرو نباید بشکند).
 */

const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');
const ops = require('../imageops');
const { PIPELINE_VERSION } = require('./config');
const polarity = require('./polarity');
const preprocess = require('./preprocess');
const segment = require('./segment');
const { confidenceSummary } = require('./confidence');
const { applyTemperature, argmaxConf } = require('./calibration');
const { ensemblePredict } = require('./ensemble');
const { logInference } = require('./logging');

/** تبدیل بافر تصویر به خاکستری + بزرگ‌نمایی در صورت کوچکی. */
async function toGray(bufferOrImg, minWidth = 320) {
  let gray;
  if (bufferOrImg && bufferOrImg.data && bufferOrImg.width && !bufferOrImg.bitmap) {
    gray = { width: bufferOrImg.width, height: bufferOrImg.height, data: new Uint8Array(bufferOrImg.data) };
  } else {
    const base = Buffer.isBuffer(bufferOrImg) || typeof bufferOrImg === 'string'
      ? await Jimp.read(bufferOrImg) : bufferOrImg;
    gray = ops.fromJimp(base);
  }
  if (gray.width < minWidth) gray = ops.resizeBilinear(gray, minWidth / gray.width);
  return gray;
}

/**
 * ساخت مدل‌های تشخیص از کانفیگ.
 * خروجی: { cnn, mlp, temperature, modelVersion } — هرکدام ممکن است null باشد.
 */
function loadModels(cfg, rootDir = path.join(__dirname, '..', '..')) {
  const out = { cnn: null, mlp: null, temperature: cfg.model.temperatureDefault, modelVersion: null };
  try {
    const p = path.join(rootDir, cfg.model.cnnPath);
    if (fs.existsSync(p)) {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      const { CnnRecognizer } = require('./recognizer');
      const charset = cfg.mode === 'digits' ? cfg.charsetDigits : cfg.charsetAlnum;
      out.cnn = new CnnRecognizer(json, { charset });
      if (json.meta && typeof json.meta.temperature === 'number' && json.meta.temperature > 1e-6) {
        out.temperature = json.meta.temperature;
      }
      out.modelVersion = (json.meta && json.meta.trained_at) || 'cnn';
    }
  } catch (e) { out.cnn = null; }
  try {
    if (!out.cnn) {
      const p = path.join(rootDir, cfg.model.mlpPath);
      if (fs.existsSync(p)) {
        const { MlpRecognizer } = require('./recognizer');
        out.mlp = new MlpRecognizer(JSON.parse(fs.readFileSync(p, 'utf8')));
        out.modelVersion = 'mlp';
      }
    }
  } catch (e) { out.mlp = null; }
  return out;
}

/**
 * قطعه‌بندی چندمسیره: ۱) مسیر رنگی اثبات‌شدهٔ کپچای واقعی،
 * ۲) مسیر خاکستری با امتیازدهی چندعاملی (جدید).
 * خروجی: { chars:[bin], source, segInfo }
 */
function extractChars(jimg, gray, binVariants, expectedLength, segCfg) {
  // مسیر رنگی (کپچای واقعی صفیر ریل رنگی است)
  try {
    const cl = require('../charlearn');
    const comps = cl.extractComponents(jimg, expectedLength || undefined);
    if (comps && (!expectedLength || comps.length === expectedLength)) {
      return { chars: comps, source: 'color', segInfo: { count: comps.length, ok: true } };
    }
  } catch (e) { /* ادامه با خاکستری */ }
  // مسیر خاکستری جدید روی هر واریانت آستانه
  let best = null;
  for (const v of binVariants) {
    try {
      const r = segment.segmentCharacters(v.img, {
        expectedCount: expectedLength || null,
        minArea: segCfg.minArea,
        weights: segCfg.multiFactorWeights,
      });
      if (!r.chars.length) continue;
      const valid = r.ok;
      const score = (valid ? 10 : 0) + (r.layout ? r.layout.spacing + r.layout.vAlign : 0) - Math.abs(r.count - (expectedLength || r.count)) * 2;
      if (!best || score > best.score) best = { chars: r.chars.map((c) => c.bin), source: 'gray-multifactor', segInfo: r, score };
    } catch (e) { /* واریانت بعدی */ }
  }
  if (best) return best;
  return { chars: [], source: 'none', segInfo: { ok: false, reason: 'no-segmentation' } };
}

/**
 * اجرای کامل پایپ‌لاین روی یک تصویر.
 * گزینه‌ها: { expectedLength, protos, threshold(seq), models, diag }
 * خروجی غنی برای لاگ/بنچمارک:
 * { ok, text, seqConfidence, meanCharConf, minCharConf, chars[], polarity,
 *   segSource, segCount, latencyMs, failureReason, modelVersion, preprocessSteps,
 *   diag: { altTexts } (در صورت درخواست) }
 */
async function solveImage(bufferOrImg, opts = {}) {
  const t0 = Date.now();
  const cfg = opts.config || require('./config').loadOcrConfig();
  const expectedLength = opts.expectedLength || null;
  const models = opts.models || loadModels(cfg);
  const threshold = opts.threshold !== undefined ? opts.threshold : cfg.confidence.seqThreshold;
  const doLog = opts.log !== false;
  const entry = { pipelineVersion: PIPELINE_VERSION, modelVersion: models.modelVersion };

  const fail = (reason, extra = {}) => {
    const res = { ok: false, text: '', failureReason: reason, latencyMs: Date.now() - t0, ...extra };
    if (doLog) logInference({ ...entry, ...res, seqConf: res.seqConfidence ?? null, charConfs: (res.chars || []).map((c) => c.conf) });
    return res;
  };

  let gray;
  try {
    gray = await toGray(bufferOrImg, cfg.image.minWidth);
  } catch (e) {
    return fail('load-failure');
  }

  // --- قطبیت (چند هیوریستیک + اطمینان) ---
  const pol = polarity.detectPolarity(gray, { method: cfg.polarity.method });
  entry.polarity = { textIsDark: pol.textIsDark, confidence: pol.confidence };

  // --- پیش‌پردازش ماژولار ---
  const steps = preprocess.defaultSteps(cfg.preprocess);
  const ctx = { polarity: pol, morph: { openIter: cfg.preprocess.morphOpen, closeIter: cfg.preprocess.morphClose, maxIter: cfg.preprocess.maxMorphIterations } };
  const pipe = preprocess.runPipeline(gray, steps, ctx);
  entry.preprocess = { steps, threshold: ctx.lastThreshold || null, errors: pipe.errors };

  const binVariants = [];
  if (pipe.stages.thresholdOtsu) binVariants.push({ name: 'otsu', img: pipe.stages.thresholdOtsu });
  if (pipe.stages.thresholdAdaptive) binVariants.push({ name: 'adaptive', img: pipe.stages.thresholdAdaptive });
  if (!binVariants.length) {
    // فال‌بک ساده
    const t = ops.otsuThreshold(gray);
    binVariants.push({ name: 'otsu-fallback', img: ops.binarize(gray, t, !pol.textIsDark) });
  }
  // وقتی قطبیت کم‌اطمینان است، نسخهٔ معکوس هم امتحان می‌شود
  if (pol.confidence < cfg.polarity.minConfidence + 0.15) {
    binVariants.push({ name: 'otsu-inv', img: preprocess.invertBinary(binVariants[0].img) });
  }

  // --- قطعه‌بندی ---
  const jimg = (Buffer.isBuffer(bufferOrImg) || typeof bufferOrImg === 'string') ? await Jimp.read(bufferOrImg) : null;
  let ext;
  if (jimg) {
    ext = extractChars(jimg, gray, binVariants, expectedLength, cfg.segmentation);
  } else {
    // ورودی غیر جیمپ (مثل تصاویر مصنوعی تست): فقط مسیر خاکستری
    ext = { chars: [], source: 'none', segInfo: { ok: false } };
    let best = null;
    for (const v of binVariants) {
      try {
        const r = segment.segmentCharacters(v.img, {
          expectedCount: expectedLength || null,
          minArea: cfg.segmentation.minArea,
          weights: cfg.segmentation.multiFactorWeights,
        });
        if (!r.chars.length) continue;
        const score = (r.ok ? 10 : 0) + (r.layout ? r.layout.spacing + r.layout.vAlign : 0);
        if (!best || score > best.score) best = { chars: r.chars.map((c) => c.bin), source: 'gray-multifactor', segInfo: r, score };
      } catch (e) { /* بعدی */ }
    }
    if (best) ext = best;
  }
  entry.segCount = ext.chars.length;
  if (!ext.chars.length) return fail('segmentation-failure', { polarity: entry.polarity });
  if (expectedLength && ext.chars.length !== expectedLength) {
    return fail('segmentation-count-mismatch', { segCount: ext.chars.length });
  }

  // --- نرمال‌سازی + اعتبارسنجی ورودی ---
  const { normalizeComponent } = require('../digitsynth');
  const { validateInput } = require('./recognizer');
  const vecs = ext.chars.map((c) => Array.from(normalizeComponent(c, { size: cfg.image.inputSize, inner: cfg.image.innerSize })));
  try {
    validateInput(vecs, cfg.image.inputSize);
  } catch (e) {
    return fail('input-validation', { detail: e.message });
  }
  // نمونه‌های خالی (جوهر ناکافی) اعتبار ندارند
  for (const v of vecs) {
    let ink = 0;
    for (const x of v) if (x > 0) ink++;
    if (ink < cfg.image.minInk) return fail('empty-component');
  }

  // --- تشخیص ---
  const modelOutputs = [];
  let cnnProbs = null;
  if (models.cnn) {
    try {
      const preds = models.cnn.predict(vecs, { inputSize: cfg.image.inputSize });
      cnnProbs = preds.map((p) => p.probs);
      const T = models.temperature;
      modelOutputs.push({
        name: 'cnn',
        chars: preds.map((p) => {
          const q = applyTemperature(p.probs, T);
          const am = argmaxConf(q);
          return { char: models.cnn.allClasses[am.label], conf: am.conf };
        }),
      });
    } catch (e) { /* فال‌بک */ }
  }
  if (models.mlp && !modelOutputs.length) {
    try {
      const preds = models.mlp.predict(vecs, { inputSize: cfg.image.inputSize });
      modelOutputs.push({ name: 'mlp', chars: preds.map((p) => ({ char: p.char, conf: p.probs[p.labelIdx] })) });
    } catch (e) { /* هیچ */ }
  }
  if (opts.protos && opts.protos.length) {
    const { KnnRecognizer } = require('./recognizer');
    const knn = new KnnRecognizer(opts.protos);
    try {
      const preds = knn.predict(vecs);
      modelOutputs.push({ name: 'knn', chars: preds.map((p) => ({ char: p.char, conf: p.conf || 0 })) });
    } catch (e) { /* هیچ */ }
  }
  if (!modelOutputs.length) return fail('no-model');

  // --- اطمینان و تصمیم توالی ---
  let text = '', charConfs = [];
  const chars = [];
  let agreement = 1;
  if (modelOutputs.length > 1) {
    const ens = ensemblePredict(modelOutputs);
    text = ens.chars.map((c) => c.char || '').join('');
    charConfs = ens.chars.map((c) => c.conf);
    agreement = ens.chars.filter((c) => c.voters.length > 1).length / Math.max(1, ens.chars.length);
    chars.push(...ens.chars.map((c, i) => ({ ch: c.char, conf: c.conf })));
    entry.contributions = ens.contributions;
  } else {
    const m = modelOutputs[0];
    text = m.chars.map((c) => c.char || '').join('');
    charConfs = m.chars.map((c) => c.conf);
    chars.push(...m.chars.map((c) => ({ ch: c.char, conf: c.conf })));
  }
  const conf = confidenceSummary(charConfs, {
    expectedLength: expectedLength || null,
    meanWeight: cfg.confidence.seqMeanWeight,
    minWeight: cfg.confidence.seqMinWeight,
    agreement,
  });

  const lengthOk = text.length >= (opts.minLength || 3) && text.length <= (opts.maxLength || 8);
  const ok = lengthOk && conf.sequenceConf >= threshold;
  const result = {
    ok,
    text,
    confidence: Math.round(conf.sequenceConf * 100),
    seqConfidence: conf.sequenceConf,
    meanCharConf: conf.meanCharConf,
    minCharConf: conf.minCharConf,
    chars: chars.map((c, i) => ({ ch: c.ch, conf: c.conf, sources: modelOutputs.map((m) => m.name) })),
    polarity: entry.polarity,
    segSource: ext.source,
    segCount: ext.chars.length,
    latencyMs: Date.now() - t0,
    modelVersion: models.modelVersion,
    pipelineVersion: PIPELINE_VERSION,
    preprocessSteps: steps,
    failureReason: ok ? null : (!lengthOk ? 'length' : 'low-sequence-confidence'),
  };
  if (doLog) {
    logInference({
      ...entry, text: result.text, ok: result.ok, seqConf: result.seqConfidence,
      charConfs, latencyMs: result.latencyMs, failureReason: result.failureReason,
    });
  }
  return result;
}

module.exports = { solveImage, loadModels, extractChars, toGray };
