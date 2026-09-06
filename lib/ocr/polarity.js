// -*- coding: utf-8 -*-
/**
 * lib/ocr/polarity.js — تشخیص قطبیت (متن تیره/روشن) با رأی‌گیری چند هیوریستیک.
 *
 * به‌جای یک آستانهٔ ساده روی borderMean، پنج هیوریستیک مستقل رأی می‌دهند و
 * قطبیت نهایی با مجموع وزن انتخاب می‌شود؛ «اطمینان» = سهم وزنِ رأی برنده.
 */

const ops = require('../imageops');

function meanOf(pixels) {
  if (!pixels.length) return 128;
  return pixels.reduce((a, b) => a + b, 0) / pixels.length;
}

/** هیوریستیک ۱: میانگین حاشیه‌ها ≈ رنگ زمینه. */
function hBorderMean(img) {
  const { width: w, height: h, data: s } = img;
  const px = [];
  for (let x = 0; x < w; x++) { px.push(s[x], s[(h - 1) * w + x]); }
  for (let y = 1; y < h - 1; y++) { px.push(s[y * w], s[y * w + w - 1]); }
  const m = meanOf(px);
  return { textIsDark: m > 128, weight: 1.0, evidence: { borderMean: m } };
}

/** هیوریستیک ۲: میانهٔ چهار گوشه (زمینه معمولاً در گوشه‌ها خالی است). */
function hCorners(img, patch = 4) {
  const { width: w, height: h, data: s } = img;
  const px = [];
  const collect = (x0, y0) => {
    for (let y = y0; y < Math.min(h, y0 + patch); y++) {
      for (let x = x0; x < Math.min(w, x0 + patch); x++) px.push(s[y * w + x]);
    }
  };
  collect(0, 0); collect(w - patch, 0); collect(0, h - patch); collect(w - patch, h - patch);
  px.sort((a, b) => a - b);
  const med = px[Math.floor(px.length / 2)] || 128;
  return { textIsDark: med > 128, weight: 1.2, evidence: { cornerMedian: med } };
}

/** هیوریستیک ۳: مُد غالب هیستوگرام = زمینه (متن معمولاً اقلیت است). */
function hHistogramMode(img) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]]++;
  // مُد با هموارسازی سبک تا نویز رأی نیاورد
  let best = 0, bestV = -1;
  for (let t = 4; t < 252; t++) {
    const v = hist[t - 4] + hist[t - 2] + hist[t] + hist[t + 2] + hist[t + 4];
    if (v > bestV) { bestV = v; best = t; }
  }
  return { textIsDark: best > 128, weight: 1.4, evidence: { histMode: best } };
}

/** هیوریستیک ۴: نسبت جوهر — قطبیتی که جوهر کمتری می‌دهد معمولاً درست است. */
function hInkFraction(img, t) {
  const thr = t !== undefined ? t : ops.otsuThreshold(img);
  let dark = 0;
  for (let i = 0; i < img.data.length; i++) if (img.data[i] <= thr) dark++;
  const frac = dark / img.data.length;
  const textIsDark = frac <= 0.5;
  // هرچه عدم‌تقارن بیشتر، رأی قوی‌تر (زمینه باید غالب باشد)
  const weight = 0.5 + Math.abs(frac - 0.5) * 2.5;
  return { textIsDark, weight, evidence: { inkFractionDark: frac } };
}

/** هیوریستیک ۵: کنتراست مرکز/حاشیه — مرکز تیره‌تر از حاشیه ⇒ متن تیره. */
function hCenterVsBorder(img) {
  const { width: w, height: h, data: s } = img;
  const x0 = Math.floor(w * 0.3), x1 = Math.ceil(w * 0.7);
  const y0 = Math.floor(h * 0.3), y1 = Math.ceil(h * 0.7);
  const center = [], border = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) center.push(s[y * w + x]);
      else if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) border.push(s[y * w + x]);
    }
  }
  const dc = meanOf(center) - meanOf(border);
  return { textIsDark: dc < 0, weight: Math.min(1.5, Math.abs(dc) / 40), evidence: { centerMinusBorder: dc } };
}

/**
 * رأی‌گیری نهایی. خروجی:
 * { textIsDark, confidence (0..1), votes: [{heuristic, textIsDark, weight, evidence}] }
 */
function detectPolarity(img, opts = {}) {
  const votes = [
    hBorderMean(img),
    hCorners(img),
    hHistogramMode(img),
    hInkFraction(img),
    hCenterVsBorder(img),
  ].map((v, i) => ({ heuristic: ['borderMean', 'corners', 'histMode', 'inkFraction', 'centerVsBorder'][i], ...v }));

  let wDark = 0, wLight = 0;
  for (const v of votes) {
    if (v.textIsDark) wDark += v.weight; else wLight += v.weight;
  }
  const textIsDark = wDark >= wLight;
  const total = wDark + wLight;
  const confidence = total > 0 ? Math.max(wDark, wLight) / total : 0.5;
  if (opts.method === 'border') {
    const b = votes[0];
    return { textIsDark: b.textIsDark, confidence: 0.6, votes: [b] };
  }
  return { textIsDark, confidence, votes };
}

module.exports = { detectPolarity, hBorderMean, hCorners, hHistogramMode, hInkFraction, hCenterVsBorder };
