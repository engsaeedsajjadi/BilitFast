// -*- coding: utf-8 -*-
/**
 * lib/ocr/preprocess.js — مراحل پیش‌پردازش ماژولار و مستقل.
 *
 * هر تبدیل یک تابع خالص روی تصویر خاکستری {width,height,data:Uint8Array} است؛
 * پایپ‌لاین با فهرست «مراحل» ساخته می‌شود تا بتوان هر ترکیب را جداگانه
 * ارزیابی کرد (ablation). قرارداد: خروجی دودویی‌ها متن=0/زمینه=255.
 */

const ops = require('../imageops');

/** نرمال‌سازی کنتراست با کشش صدک‌ها (۲٪–۹۸٪) — مقاوم در برابر نویز شدید. */
function contrastNormalize(img, loPct = 2, hiPct = 98) {
  const sorted = Array.from(img.data).sort((a, b) => a - b);
  const n = sorted.length;
  const lo = sorted[Math.max(0, Math.floor(n * loPct / 100))];
  const hi = sorted[Math.min(n - 1, Math.floor(n * hiPct / 100))];
  if (hi - lo < 1) return ops.cloneImage(img);
  const out = ops.makeImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) {
    const v = ((img.data[i] - lo) / (hi - lo)) * 255;
    out.data[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return out;
}

/** آستانه ثابت ساده. */
function thresholdFixed(img, t = 127) {
  return ops.binarize(img, t, false);
}

/** معکوس‌کردن قطبیت تصویر دودویی. */
function invertBinary(bin) {
  const out = ops.makeImage(bin.width, bin.height);
  for (let i = 0; i < bin.data.length; i++) out.data[i] = bin.data[i] === 0 ? 255 : 0;
  return out;
}

/** معکوس خاکستری. */
function invertGray(img) {
  const out = ops.makeImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) out.data[i] = 255 - img.data[i];
  return out;
}

/**
 * مورفولوژی محافظ: هیچ‌گاه بیش از حد مجاز تکرار نمی‌شود و «فرسایش» فقط وقتی
 * اجرا می‌شود که عرض ضربهٔ غالب به اندازه کافی پهن باشد — تا استروک‌های نازک
 * (مثل «1»، «i»، «l» یا گلیف‌های کوچک) نابود نشوند. بستن (دیلیت→فرسایش)
 * شکاف‌ها را پر می‌کند و شکل را برمی‌گرداند، پس بی‌خطر است.
 */
function morphConservative(bin, { openIter = 1, closeIter = 1, maxIter = 1 } = {}) {
  let cur = bin;
  const o = Math.min(openIter, maxIter);
  const c = Math.min(closeIter, maxIter);
  if (o > 0) {
    const d = ops.distanceTransform(bin);
    const ds = [];
    for (let i = 0; i < bin.data.length; i++) if (bin.data[i] === 0) ds.push(d[i]);
    ds.sort((a, b) => a - b);
    const medStroke = ds.length ? 2 * ds[Math.floor(ds.length / 2)] : 0;
    if (medStroke >= 5) cur = ops.morphOpen(cur, o); // استروک نازک → فرسایش ممنوع
  }
  if (c > 0) cur = ops.morphClose(cur, c);
  return cur;
}

/** فهرست مراحل قابل‌اجرا؛ هر مرحله: (img, ctx) → img */
const STAGES = {
  grayscale: (img) => img, // ورودی از قبل خاکستری است
  denoiseMedian3: (img) => ops.medianBlur3(img),
  denoiseGaussian3: (img) => ops.gaussianBlur3(img),
  contrastNormalize: (img) => contrastNormalize(img),
  thresholdOtsu: (img, ctx) => {
    const t = ops.otsuThreshold(img);
    ctx.lastThreshold = { method: 'otsu', value: t };
    return ops.binarize(img, t, !(ctx.polarity ? ctx.polarity.textIsDark : true));
  },
  thresholdAdaptive: (img, ctx) => {
    ctx.lastThreshold = { method: 'adaptive', value: 'mean-C' };
    return ops.adaptiveThreshold(ops.gaussianBlur3(img), 15, 10);
  },
  morph: (bin, ctx) => morphConservative(bin, ctx.morph || {}),
  cropContent: (bin) => ops.cropToContent(bin, 8),
};

/**
 * اجرای پایپ‌لاین مشخص‌شده و نگهداری خروجی هر مرحله (برای ablation و لاگ).
 * ورودی: img خاکستری، steps آرایه نام مراحل، ctx زمینه (قطبیت/مورفولوژی).
 * خروجی: { final, stages: { name → img }, errors: [] }
 */
function runPipeline(img, steps, ctx = {}) {
  const stages = {};
  const errors = [];
  let cur = img;
  for (const name of steps) {
    const fn = STAGES[name];
    if (!fn) { errors.push(`مرحله ناشناخته: ${name}`); continue; }
    try {
      cur = fn(cur, ctx);
      stages[name] = cur;
    } catch (e) {
      errors.push(`خطا در مرحله ${name}: ${e && e.message}`);
    }
  }
  return { final: cur, stages, errors };
}

/** پایپ‌لاین کامل پیش‌فرض (معادل نسخهٔ بازطراحی‌شده). */
function defaultSteps(cfgPre) {
  const steps = ['grayscale'];
  if (cfgPre.denoise === 'median3') steps.push('denoiseMedian3');
  if (cfgPre.denoise === 'gaussian3') steps.push('denoiseGaussian3');
  if (cfgPre.contrastNormalize) steps.push('contrastNormalize');
  steps.push(cfgPre.threshold === 'adaptive' ? 'thresholdAdaptive' : 'thresholdOtsu');
  if (cfgPre.morphOpen > 0 || cfgPre.morphClose > 0) steps.push('morph');
  return steps;
}

module.exports = {
  contrastNormalize, thresholdFixed, invertBinary, invertGray,
  morphConservative, STAGES, runPipeline, defaultSteps,
};
