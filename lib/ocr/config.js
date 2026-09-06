// -*- coding: utf-8 -*-
/**
 * lib/ocr/config.js — اسکیمای تایپ‌سیف تنظیمات موتور OCR + اعتبارسنجی.
 *
 * همهٔ تنظیمات موتور (چارست، اندازه تصویر، آستانه‌ها، افزون‌سازی، مورفولوژی،
 * قطعه‌بندی، کالیبراسیون) در یک اسکیمای واحد با نوع، بازه و پیام خطای واضح.
 * هر مقدار نامعتبر → استثنا با مسیر دقیق کلید (مثل `segmentation.minArea`).
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DEFAULT_DIGITS = '0123456789';
const SAFIR_CHARSET = '123456789ACDEHKLMRSTUZabdefghijmnpqrstvxyz'; // بدون 0/O/l/I

const PIPELINE_VERSION = 'ocr-engine/1.0.0';

/** تعریف اسکیمای هر بخش: [نوع, اعتبارسنج, پیام] */
function num(key, min, max, def, int = false) {
  return { key, type: 'number', min, max, def, int };
}
function bool(key, def) { return { key, type: 'boolean', def }; }
function str(key, def, re = null) { return { key, type: 'string', def, re }; }
function enumOf(key, values, def) { return { key, type: 'enum', values, def }; }

const SCHEMA = {
  mode: enumOf('mode', ['alnum', 'digits'], 'alnum'),
  charsetAlnum: str('charsetAlnum', DEFAULT_ALNUM, /^[A-Za-z0-9]{2,128}$/),
  charsetDigits: str('charsetDigits', DEFAULT_DIGITS, /^[0-9]{2,32}$/),
  image: {
    inputSize: num('image.inputSize', 8, 64, 20, true),
    innerSize: num('image.innerSize', 4, 60, 16, true),
    minInk: num('image.minInk', 1, 200, 8, true),
    minWidth: num('image.minWidth', 64, 1024, 320, true),
  },
  polarity: {
    method: enumOf('polarity.method', ['ensemble', 'border'], 'ensemble'),
    minConfidence: num('polarity.minConfidence', 0, 1, 0.5),
  },
  preprocess: {
    denoise: enumOf('preprocess.denoise', ['none', 'median3', 'gaussian3'], 'median3'),
    contrastNormalize: bool('preprocess.contrastNormalize', true),
    threshold: enumOf('preprocess.threshold', ['otsu', 'adaptive', 'both'], 'both'),
    morphOpen: num('preprocess.morphOpen', 0, 2, 1, true),   // ۰ = غیرفعال
    morphClose: num('preprocess.morphClose', 0, 2, 1, true),
    maxMorphIterations: num('preprocess.maxMorphIterations', 1, 2, 1, true), // محافظ استروک‌های نازک
    deskew: bool('preprocess.deskew', true),
  },
  segmentation: {
    minArea: num('segmentation.minArea', 2, 100, 6, true),
    minCharHeightFrac: num('segmentation.minCharHeightFrac', 0, 1, 0.25),
    maxComponents: num('segmentation.maxComponents', 1, 16, 10, true),
    spacingTolerance: num('segmentation.spacingTolerance', 0.1, 5, 1.6),
    mergeGapPx: num('segmentation.mergeGapPx', 0, 10, 2, true),
    multiFactorWeights: {
      geometry: num('segmentation.weights.geometry', 0, 10, 1.0),
      area: num('segmentation.weights.area', 0, 10, 1.0),
      aspect: num('segmentation.weights.aspect', 0, 10, 0.8),
      vAlign: num('segmentation.weights.vAlign', 0, 10, 1.2),
      spacing: num('segmentation.weights.spacing', 0, 10, 1.5),
      overlap: num('segmentation.weights.overlap', 0, 10, 1.0),
    },
  },
  confidence: {
    minCharConf: num('confidence.minCharConf', 0, 1, 0.05),
    seqThreshold: num('confidence.seqThreshold', 0, 1, 0.35),
    seqMinWeight: num('confidence.seqMinWeight', 0, 1, 0.5),  // وزن کمینهٔ کاراکتر در اطمینان توالی
    seqMeanWeight: num('confidence.seqMeanWeight', 0, 1, 0.5), // وزن میانگین
  },
  model: {
    cnnPath: str('model.cnnPath', 'models/char-cnn.json'),
    mlpPath: str('model.mlpPath', 'models/char-model.json'),
    temperatureDefault: num('model.temperatureDefault', 0.1, 50, 1),
  },
  calibration: {
    bins: num('calibration.bins', 2, 50, 10, true),
    maxTemperature: num('calibration.maxTemperature', 1, 50, 10),
    minSamples: num('calibration.minSamples', 1, 500, 10, true),
  },
  augmentation: {
    // اعوجاج‌های هندسی ملایم مطابق تغییرات واقعی رندر کپچا (چرخش/جابه‌جایی/مقیاس)؛
    // هیچ تبدیل توزیع‌ساز غیر واقعی (مثل تغییر رنگ یا حذف استروک) مجاز نیست.
    perSample: num('augmentation.perSample', 0, 64, 19, true),
    angle: num('augmentation.angle', 0, 30, 10),
    shift: num('augmentation.shift', 0, 5, 1.5),
    scaleMin: num('augmentation.scaleMin', 0.5, 1, 0.9),
    scaleMax: num('augmentation.scaleMax', 1, 2, 1.1),
  },
  training: {
    epochs: num('training.epochs', 1, 500, 60, true),
    batchSize: num('training.batchSize', 2, 256, 32, true),
    lrInitial: num('training.lrInitial', 1e-5, 1, 0.002),
    lrDecayEvery: num('training.lrDecayEvery', 1, 100, 15, true),
    lrDecayFactor: num('training.lrDecayFactor', 0.1, 1, 0.5),
    earlyStopPatience: num('training.earlyStopPatience', 0, 100, 12, true),
    dropout: num('training.dropout', 0, 0.9, 0.2),
    valRatio: num('training.valRatio', 0, 0.5, 0.15),
    seed: num('training.seed', 0, 2 ** 31, 1397, true),
  },
  benchmark: {
    splitSeed: num('benchmark.splitSeed', 0, 2 ** 31, 1397, true),
    ratios: { // train/val/cal/test — مجموع باید ۱ باشد (در اعتبارسنجی چک می‌شود)
      train: num('benchmark.ratios.train', 0, 1, 0.5),
      val: num('benchmark.ratios.val', 0, 1, 0.15),
      cal: num('benchmark.ratios.cal', 0, 1, 0.15),
      test: num('benchmark.ratios.test', 0, 1, 0.2),
    },
  },
};

/** اعتبارسنجی یک مقدار برابر تعریف اسکیمایش؛ خطاها با مسیر کامل جمع می‌شوند. */
function checkValue(def, value, errors) {
  if (value === undefined || value === null) return def.def;
  switch (def.type) {
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push(`${def.key}: باید عدد باشد (مقدار داده‌شده: ${JSON.stringify(value)})`);
        return def.def;
      }
      if (def.int && !Number.isInteger(value)) {
        errors.push(`${def.key}: باید عدد صحیح باشد (مقدار: ${value})`);
        return def.def;
      }
      if (value < def.min || value > def.max) {
        errors.push(`${def.key}: باید بین ${def.min} و ${def.max} باشد (مقدار: ${value})`);
        return def.def;
      }
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${def.key}: باید true/false باشد (مقدار: ${JSON.stringify(value)})`);
        return def.def;
      }
      return value;
    case 'string':
      if (typeof value !== 'string') {
        errors.push(`${def.key}: باید رشته باشد`);
        return def.def;
      }
      if (def.re && !def.re.test(value)) {
        errors.push(`${def.key}: قالب نامعتبر (الگو: ${def.re})`);
        return def.def;
      }
      return value;
    case 'enum':
      if (!def.values.includes(value)) {
        errors.push(`${def.key}: باید یکی از [${def.values.join(', ')}] باشد (مقدار: ${value})`);
        return def.def;
      }
      return value;
    default:
      return value;
  }
}

/**
 * اعتبارسنجی و نرمال‌سازی تنظیمات خام.
 * خروجی: { config, errors } — اگر errors خالی نباشد، کانفیگ نامعتبر است.
 */
function validateConfig(raw = {}) {
  const errors = [];
  const out = {};
  for (const [section, spec] of Object.entries(SCHEMA)) {
    if (spec.type) { // فیلد سادهٔ سطح بالا
      out[section] = checkValue(spec, raw[section], errors);
    } else {
      out[section] = {};
      const rawSec = raw[section] || {};
      for (const [k, def] of Object.entries(spec)) {
        if (def.type) {
          out[section][k] = checkValue(def, rawSec[k], errors);
        } else { // زیربخش (مثل multiFactorWeights یا ratios)
          out[section][k] = {};
          const rawSub = rawSec[k] || {};
          for (const [k2, def2] of Object.entries(def)) {
            out[section][k][k2] = checkValue(def2, rawSub[k2], errors);
          }
        }
      }
    }
  }
  // قیدهای بین‌فیلدی
  if (out.image.innerSize >= out.image.inputSize) {
    errors.push('image.innerSize: باید کوچک‌تر از image.inputSize باشد');
  }
  const r = out.benchmark.ratios;
  const sum = r.train + r.val + r.cal + r.test;
  if (Math.abs(sum - 1) > 1e-6) {
    errors.push(`benchmark.ratios: مجموع نسبت‌ها باید ۱ باشد (حاصل: ${sum})`);
  }
  const w = out.segmentation.multiFactorWeights;
  if (Object.values(w).reduce((a, b) => a + b, 0) <= 0) {
    errors.push('segmentation.multiFactorWeights: مجموع وزن‌ها باید مثبت باشد');
  }
  if (out.augmentation.scaleMin > out.augmentation.scaleMax) {
    errors.push('augmentation.scaleMin: نباید از scaleMax بزرگ‌تر باشد');
  }
  return { config: out, errors };
}

/** کاراکترست فعال بر اساس حالت (ارقام/الفبایی) — تنها منبع حقیقت کاراکترها. */
function charsetFor(config) {
  return config.mode === 'digits' ? config.charsetDigits : config.charsetAlnum;
}

/** بارگذاری کانفیگ معتبر از config.json ریپازیتوری (بخش `ocr_engine`). */
function loadOcrConfig(rootDir = path.join(__dirname, '..', '..')) {
  let raw = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
    raw = (cfg && cfg.ocr_engine) || {};
  } catch (e) { /* پیش‌فرض‌ها */ }
  const { config, errors } = validateConfig(raw);
  if (errors.length) {
    throw new Error('تنظیمات ocr_engine نامعتبر است:\n  - ' + errors.join('\n  - '));
  }
  return config;
}

module.exports = {
  SCHEMA, validateConfig, charsetFor, loadOcrConfig,
  DEFAULT_ALNUM, DEFAULT_DIGITS, SAFIR_CHARSET, PIPELINE_VERSION,
};
