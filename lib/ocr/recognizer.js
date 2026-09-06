// -*- coding: utf-8 -*-
/**
 * lib/ocr/recognizer.js — مدل‌های تشخیص مجزا با ورودی اعتبارسنجی‌شده.
 *
 * هر مدل: ۱) شکل ورودی را اعتبارسنجی می‌کند (خطای واضح به‌جای نتیجهٔ غلط)،
 * ۲) کاراکترست را از بیرون (کانفیگ) می‌گیرد نه هاردکد داخلی،
 * ۳) بردار احتمال کامل برمی‌گرداند تا کالیبراسیون/آنسامبل ممکن باشد.
 * حالت رقمی و الفبایی با دو کاراکترست مجزا کاملاً جدا هستند.
 */

const INPUT_SIZE = 20; // اندازهٔ استاندارد ورودی (از کانفیگ تصویر هم خوانده می‌شود)

class InputValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'InputValidationError'; }
}

/** اعتبارسنجی شکل ورودی: آرایه‌ای از بردارهای size×size با مقادیر [0,1]. */
function validateInput(vecs, expectedSize = INPUT_SIZE) {
  if (!Array.isArray(vecs) || !vecs.length) {
    throw new InputValidationError('ورودی باید آرایهٔ غیرخالی از بردارها باشد');
  }
  const n = expectedSize * expectedSize;
  for (let i = 0; i < vecs.length; i++) {
    const v = vecs[i];
    if (!v || v.length !== n) {
      throw new InputValidationError(`بردار ${i}: طول ${v ? v.length : 'null'} ≠ ${n} (انتظار ${expectedSize}×${expectedSize})`);
    }
  }
  return true;
}

/** فیلتر کاراکترست مدل به کاراکترهای مجاز حالت فعال. */
function restrictClasses(classes, charset) {
  const allowed = new Set([...charset]);
  return classes.filter((c) => allowed.has(c));
}

/** تشخیص با CNN (tfjs) — بردار احتمال روی کلاس‌های مجاز. */
class CnnRecognizer {
  constructor(modelJson, { charset = null, temperature = 1 } = {}) {
    if (!modelJson || !Array.isArray(modelJson.classes) || !Array.isArray(modelJson.weights)) {
      throw new InputValidationError('مدل CNN نامعتبر: کلاس‌ها یا وزن‌ها موجود نیست');
    }
    const { buildCharCNN, getTf } = require('../cnn');
    this.tf = getTf();
    this.allClasses = modelJson.classes;
    this.classes = charset ? restrictClasses(modelJson.classes, charset) : modelJson.classes.slice();
    if (!this.classes.length) throw new InputValidationError('هیچ کلاس مدل در کاراکترست فعال نیست');
    this.model = buildCharCNN(modelJson.classes.length);
    this.model.setWeights(modelJson.weights.map((w) => this.tf.tensor(w.data, w.shape)));
    this.temperature = temperature > 1e-6 ? temperature : 1;
    this.version = (modelJson.meta && modelJson.meta.trained_at) || 'unknown';
    this.name = 'cnn';
  }

  /** خروجی: برای هر بردار { labelIdx, char, probs(روی allClasses) } */
  predict(vecs, { inputSize = INPUT_SIZE } = {}) {
    validateInput(vecs, inputSize);
    const flat = new Float32Array(vecs.length * inputSize * inputSize);
    vecs.forEach((v, i) => flat.set(v, i * inputSize * inputSize));
    const xs = this.tf.tensor4d(flat, [vecs.length, inputSize, inputSize, 1]);
    const probsArr = this.model.predict(xs).arraySync();
    xs.dispose();
    const allowedIdx = new Set(this.classes.map((c) => this.allClasses.indexOf(c)));
    return probsArr.map((probs) => {
      let label = -1, best = -1;
      for (let j = 0; j < probs.length; j++) {
        if (!allowedIdx.has(j)) continue;
        if (probs[j] > best) { best = probs[j]; label = j; }
      }
      return { labelIdx: label, char: this.allClasses[label] || '?', probs };
    });
  }
}

/** تشخیص با MLP فال‌بک (بدون نیاز به tfjs). */
class MlpRecognizer {
  constructor(modelJson, { charset = null } = {}) {
    const { MLP } = require('../ml');
    this.model = MLP.fromJSON(modelJson);
    // مدل رقمی قدیمی: کلاس‌ها ارقام ۰-۹
    this.classes = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    if (charset) this.classes = restrictClasses(this.classes, charset);
    this.name = 'mlp';
    this.version = 'legacy-mlp';
  }
  predict(vecs, { inputSize = INPUT_SIZE } = {}) {
    validateInput(vecs, inputSize);
    return vecs.map((v) => {
      const { probs } = this.model.forward(Float64Array.from(v));
      const p = Array.from(probs);
      let label = 0;
      for (let j = 1; j < p.length; j++) if (p[j] > p[label]) label = j;
      return { labelIdx: label, char: this.classes[label] || '?', probs: p };
    });
  }
}

/** تشخیص نمونه‌محور k-NN — تنها با نمونه‌هایی که به آن داده می‌شود (بدون حافظهٔ پنهان). */
class KnnRecognizer {
  constructor(prototypes, { maxDist = 0.3 } = {}) {
    this.protos = prototypes || [];
    this.maxDist = maxDist;
    this.name = 'knn';
    this.version = 'protos:' + this.protos.length;
  }
  predict(vecs) {
    const { matchPrototype } = require('../charlearn');
    return vecs.map((v) => {
      const m = this.protos.length ? matchPrototype(Float64Array.from(v), this.protos, this.maxDist) : null;
      if (!m) return { labelIdx: -1, char: null, probs: null, conf: 0 };
      return { labelIdx: 0, char: m.digit, probs: null, conf: Math.min(0.99, 1 - m.dist), dist: m.dist };
    });
  }
}

module.exports = {
  CnnRecognizer, MlpRecognizer, KnnRecognizer,
  validateInput, restrictClasses, InputValidationError, INPUT_SIZE,
};
