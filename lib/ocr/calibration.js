// -*- coding: utf-8 -*-
/**
 * lib/ocr/calibration.js — کالیبراسیون اطمینان با مقیاس‌بندی دمایی.
 *
 * قانون: دما فقط روی بخش «کالیبراسیون» برازش می‌شود؛ تست دست‌نخورده می‌ماند.
 * ECE قبل و بعد از کالیبراسیون + دادهٔ نمودار اتکاپذیری (reliability diagram)
 * تولید می‌شود.
 */

/** اعمال دما روی یک بردار احتمال (بدون تغییر رتبهٔ کلاس‌ها). */
function applyTemperature(probs, T) {
  if (Math.abs(T - 1) < 1e-9) return probs.slice ? probs.slice() : [...probs];
  let s = 0;
  const p = new Array(probs.length);
  for (let j = 0; j < probs.length; j++) {
    p[j] = Math.pow(Math.max(probs[j], 1e-12), 1 / T);
    s += p[j];
  }
  for (let j = 0; j < p.length; j++) p[j] /= s;
  return p;
}

/** کلاس برنده و اطمینان آن. */
function argmaxConf(probs) {
  let label = 0;
  for (let j = 1; j < probs.length; j++) if (probs[j] > probs[label]) label = j;
  return { label, conf: probs[label] };
}

/** ECE با سطل‌بندی یکنواخت اطمینان. */
function computeECE(probsList, labels, { bins = 10, temperature = 1 } = {}) {
  const buckets = reliabilityBins(probsList, labels, { bins, temperature });
  let ece = 0, n = 0;
  for (const b of buckets) { n += b.n; }
  if (!n) return 0;
  for (const b of buckets) {
    if (!b.n) continue;
    ece += (b.n / n) * Math.abs(b.acc - b.conf);
  }
  return ece;
}

/**
 * دادهٔ نمودار اتکاپذیری: برای هر سطل { lo, hi, conf, acc, n }.
 * conf = میانگین اطمینان، acc = دقت واقعی در سطل.
 */
function reliabilityBins(probsList, labels, { bins = 10, temperature = 1 } = {}) {
  const buckets = Array.from({ length: bins }, (_, i) => ({
    lo: i / bins, hi: (i + 1) / bins, n: 0, confSum: 0, accSum: 0, conf: 0, acc: 0,
  }));
  for (let i = 0; i < probsList.length; i++) {
    const p = applyTemperature(probsList[i], temperature);
    const { label, conf } = argmaxConf(p);
    const b = buckets[Math.min(bins - 1, Math.floor(conf * bins))];
    b.n++;
    b.confSum += conf;
    b.accSum += label === labels[i] ? 1 : 0;
  }
  for (const b of buckets) {
    if (b.n) { b.conf = b.confSum / b.n; b.acc = b.accSum / b.n; }
  }
  return buckets;
}

/**
 * برازش دما روی مجموعهٔ کالیبراسیون (کمینهٔ ECE، جستجوی شبکه‌ای).
 * جهت پیش‌فرض فقط نرم‌کردن (T ≥ ۱) است چون شکست شناخته‌شدهٔ این مدل‌ها
 * بیش‌اطمینانی است؛ با allowSharpening می‌توان جستجو را گسترش داد.
 */
function fitTemperature(probsList, labels, { maxT = 10, step = 0.25, allowSharpening = false, bins = 10 } = {}) {
  const lo = allowSharpening ? 0.25 : 1;
  const before = computeECE(probsList, labels, { bins, temperature: 1 });
  let bestT = 1, bestEce = before;
  for (let T = lo; T <= maxT + 1e-9; T += step) {
    const ece = computeECE(probsList, labels, { bins, temperature: T });
    if (ece < bestEce - 1e-9) { bestEce = ece; bestT = Math.round(T * 100) / 100; }
  }
  return { temperature: bestT, eceBefore: before, eceAfter: bestEce };
}

/** گزارش متنی/داده‌ای کالیبراسیون برای مستندات. */
function calibrationReport(probsList, labels, fit, { bins = 10 } = {}) {
  return {
    temperature: fit.temperature,
    eceBefore: fit.eceBefore,
    eceAfter: fit.eceAfter,
    eceTestNote: 'دما فقط روی بخش کالیبراسیون برازش شده است',
    binsBefore: reliabilityBins(probsList, labels, { bins, temperature: 1 }),
    binsAfter: reliabilityBins(probsList, labels, { bins, temperature: fit.temperature }),
  };
}

module.exports = {
  applyTemperature, argmaxConf, computeECE, reliabilityBins, fitTemperature, calibrationReport,
};
