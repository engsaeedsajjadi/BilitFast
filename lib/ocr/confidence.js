// -*- coding: utf-8 -*-
/**
 * lib/ocr/confidence.js — تفکیک اصولی سطوح اطمینان.
 *
 * چهار کمیت مستقل و با تعریف صریح:
 *  1) perCharConf      — اطمینان هر کاراکتر (احتمال کالیبره‌شدهٔ کلاس برنده)
 *  2) meanCharConf     — میانگین حسابی اطمینان کاراکترها
 *  3) minCharConf      — کمینهٔ اطمینان کاراکترها (حلقهٔ ضعف زنجیر)
 *  4) sequenceConf     — اطمینان کل توالی؛ ترکیب وزن‌دار «میانگین» و «کمینه»
 *                         با جریمهٔ طول و پاداش توافق ensemble:
 *     seq = (mean^wm · min^wmin) · lengthPenalty · agreementBonus
 *     که در آن طول برابر طول مورد انتظار → جریمه ۱ و توافق کامل کاراکتری
 *     بین مدل‌ها → پاداش تا ۱٫۰۵. تعریف ثابت و مستقل از آستانه‌هاست؛
 *     آستانه‌های تصمیم فقط روی بخش کالیبراسیون تعیین می‌شوند (نه تست).
 */

/** محاسبهٔ اطمینان توالی از اجزای آن. */
function sequenceConfidence(charConfs, opts = {}) {
  const {
    expectedLength = null,
    meanWeight = 0.5,
    minWeight = 0.5,
    agreement = 1, // نسبت توافق مدل‌ها در حالت آنسامبل (۱ = بدون آنسامبل)
  } = opts;
  if (!charConfs.length) return 0;
  const mean = charConfs.reduce((a, b) => a + b, 0) / charConfs.length;
  const min = Math.min(...charConfs);
  const wm = meanWeight / (meanWeight + minWeight);
  const wn = minWeight / (meanWeight + minWeight);
  let seq = Math.pow(Math.max(mean, 1e-9), wm) * Math.pow(Math.max(min, 1e-9), wn);
  // جریمهٔ طول: خروج از طول مورد انتظار نشانهٔ قطعه‌بندی نادرست است
  if (expectedLength && charConfs.length !== expectedLength) {
    seq *= Math.max(0.2, 1 - 0.25 * Math.abs(charConfs.length - expectedLength));
  }
  seq *= 0.9 + 0.15 * Math.max(0, Math.min(1, agreement)); // پاداش توافق
  return Math.max(0, Math.min(1, seq));
}

/** خلاصهٔ کامل اطمینان برای یک پیش‌بینی. */
function confidenceSummary(charConfs, opts = {}) {
  const mean = charConfs.length ? charConfs.reduce((a, b) => a + b, 0) / charConfs.length : 0;
  const min = charConfs.length ? Math.min(...charConfs) : 0;
  return {
    perChar: charConfs.map((c) => c),
    meanCharConf: mean,
    minCharConf: min,
    sequenceConf: sequenceConfidence(charConfs, opts),
  };
}

/**
 * تعیین آستانهٔ تصمیم فقط روی دادهٔ کالیبراسیون:
 * آستانه‌ای که روی (conf, درست/نادرست)های کالیبراسیون بیشترین F1 را بدهد.
 */
function pickThreshold(calRows, { gridStep = 0.02 } = {}) {
  let bestT = 0.3, bestF1 = -1;
  for (let t = 0; t <= 1.0001; t += gridStep) {
    let tp = 0, fp = 0, fn = 0;
    for (const r of calRows) {
      const accepted = r.confidence >= t;
      if (accepted && r.correct) tp++;
      else if (accepted && !r.correct) fp++;
      else if (!accepted && r.correct) fn++;
    }
    const p = tp + fp ? tp / (tp + fp) : 0;
    const rec = tp + fn ? tp / (tp + fn) : 0;
    const f1 = p + rec ? (2 * p * rec) / (p + rec) : 0;
    if (f1 > bestF1) { bestF1 = f1; bestT = t; }
  }
  // حالت انحطا: هیچ پیش‌بینی درستی در کالیبراسیون نبود → آستانه محافظه‌کارانه
  if (bestF1 <= 0) return { threshold: 0.5, f1: 0 };
  return { threshold: Math.round(bestT * 100) / 100, f1: bestF1 };
};

module.exports = { sequenceConfidence, confidenceSummary, pickThreshold };
