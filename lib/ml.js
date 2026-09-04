// -*- coding: utf-8 -*-
/**
 * lib/ml.js — شبکه عصبی کوچک (MLP) به جاوااسکریپت خالص.
 *
 * برای طبقه‌بندی کاراکترهای کپچا: ورودی بیت‌مپ نرمال‌شده (مثلاً 20×20)،
 * خروجی احتمال ۱۰ رقم. عمداً بدون TensorFlow/ONNX تا روی محیط سرورلس بدون
 * وابستگی بومی اجرا شود؛ آموزش آفلاین (train/train-digits.js) و استنتاج آنلاین.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function accuracy(model, X, Y) {
  if (!model || !Array.isArray(X) || !Array.isArray(Y) || X.length !== Y.length || X.length === 0) return 0;
  let ok = 0;
  for (let i = 0; i < X.length; i++) {
    if (model.predict(X[i]).label === Y[i]) ok++;
  }
  return ok / X.length;
}

function calibrateTemperature(model, X, Y, { start = 0.2, end = 1.0, step = 0.05 } = {}) {
  if (!model || !Array.isArray(X) || !Array.isArray(Y) || X.length !== Y.length || X.length === 0) return model && model.temperature ? model.temperature : 1;
  let bestT = 1;
  let bestNll = Infinity;
  const raw = X.map((x) => model.forward(x).probs);
  for (let T = start; T <= end + 1e-9; T += step) {
    let nll = 0;
    for (let i = 0; i < raw.length; i++) {
      const probs = raw[i];
      let s = 0;
      const q = new Array(probs.length);
      for (let j = 0; j < probs.length; j++) {
        q[j] = Math.pow(Math.max(probs[j], 1e-12), 1 / T);
        s += q[j];
      }
      nll += -Math.log(Math.max(q[Y[i]] / s, 1e-12));
    }
    if (nll < bestNll) {
      bestNll = nll;
      bestT = Math.round(T * 100) / 100;
    }
  }
  return bestT;
}

class MLP {
  /** sizes مثل [400, 40, 10]; فعال‌سازی میانی tanh، خروجی softmax. */
  constructor(sizes, seed = 42) {
    this.sizes = sizes;
    this.temperature = 1; // کالیبراسیون اطمینان (بعد از آموزش تنظیم می‌شود)
    const rng = mulberry32(seed);
    this.W = []; // W[l]: Float64Array (in × out)
    this.b = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const nin = sizes[l], nout = sizes[l + 1];
      const w = new Float64Array(nin * nout);
      const scale = Math.sqrt(2 / nin);
      for (let i = 0; i < w.length; i++) w[i] = (rng() * 2 - 1) * scale;
      this.W.push(w);
      this.b.push(new Float64Array(nout));
    }
  }

  forward(x) {
    const acts = [x];
    let cur = x;
    for (let l = 0; l < this.W.length; l++) {
      const nin = this.sizes[l], nout = this.sizes[l + 1];
      const w = this.W[l], b = this.b[l];
      const out = new Float64Array(nout);
      for (let j = 0; j < nout; j++) {
        let s = b[j];
        for (let i = 0; i < nin; i++) s += cur[i] * w[i * nout + j];
        out[j] = (l === this.W.length - 1) ? s : Math.tanh(s);
      }
      acts.push(out);
      cur = out;
    }
    // softmax روی آخرین لایه
    const logits = acts[acts.length - 1];
    let max = -Infinity;
    for (let j = 0; j < logits.length; j++) if (logits[j] > max) max = logits[j];
    let sum = 0;
    const probs = new Float64Array(logits.length);
    for (let j = 0; j < logits.length; j++) { probs[j] = Math.exp(logits[j] - max); sum += probs[j]; }
    for (let j = 0; j < probs.length; j++) probs[j] /= sum;
    return { acts, probs };
  }

  predict(x) {
    const { probs } = this.forward(x);
    // کالیبراسیون دمایی: احتمال‌ها را تیزتر/نرم‌تر می‌کند (بدون تغییر رتبه‌بندی)
    let p = probs;
    const T = this.temperature || 1;
    if (T > 1e-6 && Math.abs(T - 1) > 1e-6) {
      const q = new Float64Array(probs.length);
      let s = 0;
      for (let j = 0; j < probs.length; j++) {
        q[j] = Math.pow(Math.max(probs[j], 1e-12), 1 / T);
        s += q[j];
      }
      for (let j = 0; j < q.length; j++) q[j] /= s;
      p = q;
    }
    let label = 0;
    for (let j = 1; j < p.length; j++) if (p[j] > p[label]) label = j;
    return { label, probs: p };
  }

  /** یک گام آموزش روی یک بَچ؛ خروجی: میانگین تلفات. */
  trainBatch(X, Y, lr) {
    const L = this.W.length;
    const gW = this.W.map((w) => new Float64Array(w.length));
    const gb = this.b.map((b) => new Float64Array(b.length));
    let lossSum = 0;

    for (let s = 0; s < X.length; s++) {
      const x = X[s];
      const y = Y[s];
      const { acts } = this.forward(x);
      const probs = acts[L];

      // تلفات آنتروپی متقاطع
      lossSum += -Math.log(Math.max(probs[y], 1e-12));

      // گرادیان‌ها (بک‌پراپ استاندارد)
      let delta = new Float64Array(probs.length);
      for (let j = 0; j < probs.length; j++) delta[j] = probs[j] - (j === y ? 1 : 0);

      for (let l = L - 1; l >= 0; l--) {
        const ain = acts[l];
        const nout = this.sizes[l + 1];
        for (let j = 0; j < nout; j++) {
          const d = delta[j];
          gb[l][j] += d;
          for (let i = 0; i < ain.length; i++) gW[l][i * nout + j] += ain[i] * d;
        }
        if (l > 0) {
          const nin = this.sizes[l];
          const prev = new Float64Array(nin);
          const w = this.W[l];
          for (let i = 0; i < nin; i++) {
            let sum = 0;
            for (let j = 0; j < nout; j++) sum += w[i * nout + j] * delta[j];
            const a = ain[i];
            prev[i] = sum * (1 - a * a); // مشتق tanh
          }
          delta = prev;
        }
      }
    }

    // به‌روزرسانی وزن‌ها
    const n = X.length;
    for (let l = 0; l < L; l++) {
      for (let i = 0; i < this.W[l].length; i++) this.W[l][i] -= (lr * gW[l][i]) / n;
      for (let j = 0; j < this.b[l].length; j++) this.b[l][j] -= (lr * gb[l][j]) / n;
    }
    return lossSum / n;
  }

  toJSON() {
    return {
      sizes: this.sizes,
      temperature: this.temperature || 1,
      layers: this.W.map((w, l) => ({
        w: Array.from(w, (v) => Math.round(v * 10000) / 10000),
        b: Array.from(this.b[l], (v) => Math.round(v * 10000) / 10000),
      })),
    };
  }

  static fromJSON(obj) {
    const m = new MLP(obj.sizes, 1);
    m.temperature = obj.temperature || 1;
    m.W = obj.layers.map((l) => Float64Array.from(l.w));
    m.b = obj.layers.map((l) => Float64Array.from(l.b));
    return m;
  }
}

module.exports = { MLP, mulberry32, accuracy, calibrateTemperature };
