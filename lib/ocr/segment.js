// -*- coding: utf-8 -*-
/**
 * lib/ocr/segment.js — قطعه‌بندی کاراکتر با امتیازدهی چندعاملی.
 *
 * به‌جای فرض شکنندهٔ «بزرگ‌ترین مؤلفه‌ها = کاراکترها»، هر مؤلفه با ترکیبی از
 * هندسه جعبه، مساحت، نسبت ابعاد، تراز عمودی، سازگاری فاصله و هم‌پوشانی
 * امتیاز می‌گیرد و بهترین «چیدمان» (با جستجو روی زیرمجموعه‌ها + ادغام خرده‌ها
 * + شکافت کاراکترهای چسبیده) انتخاب می‌شود. حالت‌های پشتیبانی‌شده:
 * کاراکترهای چسبیده، کاراکترهای تکه‌تکه، کاراکتر کوچک، فاصله متغیر،
 * عرض‌های ناهمسان، نویز زمینه.
 */

const ops = require('../imageops');

/** ویژگی‌های یک مؤلفه برای امتیازدهی. */
function compFeatures(bin, stat, imgH) {
  const w = stat.maxX - stat.minX + 1;
  const h = stat.maxY - stat.minY + 1;
  const fill = stat.area / (w * h);
  return {
    w, h, area: stat.area, fill,
    aspect: Math.max(w, h) / Math.max(1, Math.min(w, h)),
    cx: (stat.minX + stat.maxX) / 2,
    cy: (stat.minY + stat.maxY) / 2,
    heightFrac: h / Math.max(1, imgH),
  };
}

/** استخراج نامزدهای اولیه: مؤلفه‌های همبند + حذف ذرات ریز. */
function candidateComponents(bin, { minArea = 6, minCharHeightFrac = 0.2 } = {}) {
  const cc = ops.connectedComponents(bin);
  const out = [];
  for (const s of cc.stats) {
    if (s.area < minArea) continue;
    const f = compFeatures(bin, s, bin.height);
    if (f.heightFrac < minCharHeightFrac && f.w < bin.width * 0.15) continue;
    out.push({ stat: s, f, score: 0 });
  }
  return out;
}

/** برش مؤلفه از تصویر اصلی. */
function cropComp(bin, stat) {
  const w = stat.maxX - stat.minX + 1;
  const h = stat.maxY - stat.minY + 1;
  const out = ops.makeImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out.data[y * w + x] = bin.data[(stat.minY + y) * bin.width + (stat.minX + x)];
    }
  }
  return out;
}

/**
 * ادغام خرده‌های یک کاراکتر (تکه‌تکه‌شدگی): دو مؤلفه که هم‌پوشانی افقی قابل‌توجه
 * دارند یا در یک ردیف بسیار نزدیک‌اند، یکی می‌شوند (مثل نقطهٔ i/j یا شکستگی).
 * هندسه فقط از stat خوانده می‌شود (برای مؤلفه‌های ادغام‌شده نیز امن است).
 */
function mergeFragments(comps, opts = {}) {
  const bb = (c) => c.stat;
  const aspectOf = (s) => {
    const w = s.maxX - s.minX + 1, h = s.maxY - s.minY + 1;
    return Math.max(w, h) / Math.max(1, Math.min(w, h));
  };
  function shouldMerge(a, b) {
    const A = bb(a), B = bb(b);
    // ساختارهای خط‌گونه (نویز) هرگز ادغام نمی‌شوند
    if (aspectOf(A) > 6 || aspectOf(B) > 6) return false;
    const bwA = A.maxX - A.minX + 1, bwB = B.maxX - B.minX + 1;
    const hA = A.maxY - A.minY + 1, hB = B.maxY - B.minY + 1;
    const xo = Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX) + 1;
    const yGap = Math.max(A.minY, B.minY) - Math.min(A.maxY, B.maxY); // >0 = جدا در عمود
    if (xo >= 1) {
      // هم‌ستون: خرده‌های یک حرف (نقطهٔ i یا شکستگی استروک)
      if (xo / Math.min(bwA, bwB) < 0.4) return false;
      const yTol = Math.max(3, 0.15 * Math.max(hA, hB) + 0.5 * Math.min(hA, hB));
      return yGap <= yTol;
    }
    // بدون هم‌پوشانی افقی: فقط چسبیدهٔ افقیِ هم‌ردیف (فاصلهٔ صفر، نه بیشتر)
    if (xo < 0) return false;
    const yo = Math.min(A.maxY, B.maxY) - Math.max(A.minY, B.minY) + 1;
    return yo > 0;
  }
  let list = [...comps];
  let changed = true;
  while (changed && list.length > 1) {
    changed = false;
    outer:
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (!shouldMerge(a, b)) continue;
        const minX = Math.min(a.stat.minX, b.stat.minX), minY = Math.min(a.stat.minY, b.stat.minY);
        const maxX = Math.max(a.stat.maxX, b.stat.maxX), maxY = Math.max(a.stat.maxY, b.stat.maxY);
        // محافظ: جعبه ادغامی نباید از «دو کاراکتر» پهن‌تر شود
        const wA = a.stat.maxX - a.stat.minX + 1, wB = b.stat.maxX - b.stat.minX + 1;
        if ((maxX - minX + 1) > (Math.max(wA, wB) * 1.6 + 4)) continue;
        const merged = {
          stat: { label: -1, area: a.stat.area + b.stat.area, minX, minY, maxX, maxY },
          f: null, score: 0, mergedFrom: [a, b],
        };
        list.splice(j, 1); list.splice(i, 1); list.push(merged);
        changed = true;
        break outer;
      }
    }
  }
  return list;
}

/**
 * شکافت کاراکتر چسبیده: کمینهٔ پروجکشن ستونی در بازهٔ میانی، نقطهٔ برش است.
 * خروجی: آرایهٔ دو مؤلفه یا null اگر شکافت معنادار نبود.
 */
function splitTouching(bin, comp) {
  const { stat } = comp;
  const w = stat.maxX - stat.minX + 1;
  const h = stat.maxY - stat.minY + 1;
  if (w < 6) return null;
  const proj = new Array(w).fill(0);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (bin.data[(stat.minY + y) * bin.width + (stat.minX + x)] === 0) proj[x]++;
    }
  }
  const lo = Math.floor(w * 0.25), hi = Math.ceil(w * 0.75);
  let best = Infinity;
  for (let x = lo; x < hi; x++) if (proj[x] < best) best = proj[x];
  if (best === Infinity) return null;
  const peak = Math.max(...proj);
  if (best > peak * 0.6) return null; // شکاف معناداری وجود ندارد
  // بین کمینه‌های تقریباً هم‌عمق، برش نزدیک به مرکز انتخاب می‌شود تا دو نیمه
  // متعادل باشند (برش درهٔ اول، کاراکترها را نامتقارن می‌کرد).
  let cut = -1, cutScore = Infinity;
  for (let x = lo; x < hi; x++) {
    if (proj[x] > best + peak * 0.1) continue;
    const s = Math.abs(x - w / 2);
    if (s < cutScore) { cutScore = s; cut = x; }
  }
  if (cut <= 1 || cut >= w - 2) return null;
  const mk = (x0, x1) => {
    const sw = x1 - x0;
    const sub = ops.makeImage(sw, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < sw; x++) {
        sub.data[y * sw + x] = bin.data[(stat.minY + y) * bin.width + (stat.minX + x0 + x)];
      }
    }
    return sub;
  };
  const left = mk(0, cut), right = mk(cut, w);
  const bbL = ops.boundingBox(left), bbR = ops.boundingBox(right);
  if (!bbL || !bbR) return null;
  const toComp = (sub, bb, offX) => {
    const cw = bb.maxX - bb.minX + 1, ch = bb.maxY - bb.minY + 1;
    const c = ops.makeImage(cw, ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) c.data[y * cw + x] = sub.data[(bb.minY + y) * sub.width + (bb.minX + x)];
    return {
      stat: { label: -2, area: 0, minX: stat.minX + offX + bb.minX, minY: stat.minY + bb.minY, maxX: stat.minX + offX + bb.maxX, maxY: stat.minY + bb.maxY },
      bin: c, f: null, score: 0, splitFrom: comp,
    };
  };
  const A = toComp(left, bbL, 0), B = toComp(right, bbR, cut);
  for (const p of [A, B]) {
    let a = 0;
    for (let i = 0; i < p.bin.data.length; i++) if (p.bin.data[i] === 0) a++;
    p.stat.area = a;
  }
  return [A, B];
}

/** امتیاز «کاراکتر بودن» یک مؤلفه (بدون نیاز به بقیه). */
function charLikeness(c, medH, medArea) {
  const f = c.f;
  let s = 0;
  s += Math.min(1, f.area / Math.max(1, medArea));          // مساحت
  s += Math.max(0, 1 - Math.abs(f.h - medH) / Math.max(1, medH)); // هندسه: ارتفاع نزدیک میانه
  s += Math.max(0, 1 - Math.max(0, f.aspect - 2.5) / 3);   // نسبت ابعاد
  s += Math.min(1, f.fill / 0.25);                          // پُری جعبه
  return s / 4;
}

/** امتیاز چیدمان یک مجموعهٔ مرتب‌شده (فاصله‌ها + تراز عمودی). */
function layoutScore(set, weights) {
  if (set.length < 2) return { spacing: 1, vAlign: 1, overlap: 1 };
  const sorted = [...set].sort((a, b) => a.f.cx - b.f.cx);
  const gaps = [];
  let overlapPenalty = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    gaps.push(cur.f.cx - prev.f.cx);
    const xo = prev.stat.maxX - cur.stat.minX + 1;
    if (xo > 0) overlapPenalty += xo / Math.max(1, Math.min(prev.f.w, cur.f.w));
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) * (g - mean), 0) / gaps.length);
  const spacing = 1 / (1 + sd / Math.max(6, mean)); // سازگاری فاصله
  const cys = sorted.map((c) => c.f.cy);
  const cyMean = cys.reduce((a, b) => a + b, 0) / cys.length;
  const cySd = Math.sqrt(cys.reduce((a, c) => a + (c - cyMean) * (c - cyMean), 0) / cys.length);
  const medH = sorted.map((c) => c.f.h).sort((a, b) => a - b)[Math.floor(sorted.length / 2)];
  const vAlign = 1 / (1 + cySd / Math.max(4, medH * 0.5)); // تراز عمودی
  const overlap = Math.max(0, 1 - overlapPenalty); // هم‌پوشانی
  return { spacing, vAlign, overlap };
}

/** امتیاز کل یک چیدمان نامزد. */
function scoreLayout(set, weights, medH, medArea) {
  const lay = layoutScore(set, weights);
  const lik = set.reduce((a, c) => a + charLikeness(c, medH, medArea), 0) / set.length;
  return (
    weights.geometry * lik +
    weights.area * Math.min(1, set.reduce((a, c) => a + c.f.area, 0) / (set.length * Math.max(1, medArea))) +
    weights.aspect * (set.reduce((a, c) => a + Math.max(0, 1 - Math.max(0, c.f.aspect - 2.5) / 3), 0) / set.length) +
    weights.vAlign * lay.vAlign +
    weights.spacing * lay.spacing +
    weights.overlap * lay.overlap
  );
}

/**
 * قطعه‌بندی اصلی.
 * ورودی: تصویر دودویی (متن=0)، گزینه‌ها شامل تعداد مورد انتظار (اختیاری).
 * خروجی: { chars:[{bin,box,score,f}], count, expected, ok, log }
 */
function segmentCharacters(bin, opts = {}) {
  const {
    expectedCount = null,
    minArea = 6,
    weights = { geometry: 1.0, area: 1.0, aspect: 0.8, vAlign: 1.2, spacing: 1.5, overlap: 1.0 },
    maxSearchComponents = 13,
  } = opts;
  const log = { merged: 0, split: 0, dropped: 0 };

  let comps = candidateComponents(bin, { minArea });
  if (!comps.length) return { chars: [], count: 0, expected: expectedCount, ok: false, log, reason: 'no-components' };
  comps.forEach((c) => { if (!c.bin) c.bin = cropComp(bin, c.stat); });

  // ادغام خرده‌ها
  const beforeMerge = comps.length;
  comps = mergeFragments(comps);
  log.merged = beforeMerge - comps.length;
  comps.forEach((c) => {
    if (!c.f) c.f = compFeatures(bin, c.stat, bin.height);
    if (!c.bin) c.bin = cropComp(bin, c.stat);
  });

  // شکافت مؤلفه‌های پهن (کاراکترهای چسبیده) — فقط وقتی تعداد کم است
  if (expectedCount && comps.length < expectedCount) {
    const sortedW = [...comps].sort((a, b) => b.f.w - a.f.w);
    for (const c of sortedW) {
      if (comps.length >= expectedCount) break;
      const parts = splitTouching(bin, c);
      if (!parts) continue;
      comps.splice(comps.indexOf(c), 1, ...parts);
      parts.forEach((p) => { p.f = compFeatures(bin, p.stat, bin.height); });
      log.split++;
    }
  }

  const areas = comps.map((c) => c.f.area).sort((a, b) => a - b);
  const heights = comps.map((c) => c.f.h).sort((a, b) => a - b);
  const medArea = areas[Math.floor(areas.length / 2)] || 1;
  const medH = heights[Math.floor(heights.length / 2)] || 1;
  comps.forEach((c) => { c.score = charLikeness(c, medH, medArea); });

  let chosen;
  if (!expectedCount || comps.length === expectedCount) {
    chosen = comps.filter((c) => c.score > 0.15).sort((a, b) => a.f.cx - b.f.cx);
    log.dropped = comps.length - chosen.length;
  } else if (comps.length > expectedCount) {
    // جستجوی بهترین زیرمجموعهٔ expectedCountتایی (کران‌دار)
    if (comps.length <= maxSearchComponents) {
      let best = null, bestScore = -Infinity;
      const pick = [];
      const rec = (start) => {
        if (pick.length === expectedCount) {
          const set = pick.map((i) => comps[i]);
          const s = scoreLayout(set, weights, medH, medArea);
          if (s > bestScore) { bestScore = s; best = set; }
          return;
        }
        for (let i = start; i < comps.length; i++) { pick.push(i); rec(i + 1); pick.pop(); }
      };
      rec(0);
      chosen = best.sort((a, b) => a.f.cx - b.f.cx);
      log.dropped = comps.length - expectedCount;
    } else {
      chosen = [...comps].sort((a, b) => b.score - a.score).slice(0, expectedCount).sort((a, b) => a.f.cx - b.f.cx);
      log.dropped = comps.length - expectedCount;
    }
  } else {
    chosen = comps.sort((a, b) => a.f.cx - b.f.cx); // کمتر از انتظار — با گزارش
  }

  return {
    chars: chosen.map((c) => ({ bin: c.bin, box: { minX: c.stat.minX, minY: c.stat.minY, maxX: c.stat.maxX, maxY: c.stat.maxY }, score: c.score, f: c.f })),
    count: chosen.length,
    expected: expectedCount,
    ok: !expectedCount || chosen.length === expectedCount,
    log,
    layout: chosen.length >= 2 ? layoutScore(chosen, weights) : null,
  };
}

/**
 * ارزیابی مستقل کیفیت قطعه‌بندی در برابر جعبه‌های مرجع (بدون نیاز به تشخیص).
 * تطبیق حریصانه با بیشترین IoU؛ آستانهٔ تطبیق ۰٫۵.
 */
function evaluateSegmentation(predBoxes, gtBoxes, iouThr = 0.5) {
  const iou = (a, b) => {
    const ix0 = Math.max(a.minX, b.minX), iy0 = Math.max(a.minY, b.minY);
    const ix1 = Math.min(a.maxX, b.maxX), iy1 = Math.min(a.maxY, b.maxY);
    const iw = Math.max(0, ix1 - ix0 + 1), ih = Math.max(0, iy1 - iy0 + 1);
    const inter = iw * ih;
    const areaA = (a.maxX - a.minX + 1) * (a.maxY - a.minY + 1);
    const areaB = (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1);
    return inter / Math.max(1, areaA + areaB - inter);
  };
  const used = new Set();
  let matched = 0, iouSum = 0;
  for (const g of gtBoxes) {
    let best = -1, bi = -1;
    gtLoop: for (let i = 0; i < predBoxes.length; i++) {
      if (used.has(i)) continue;
      const v = iou(predBoxes[i], g);
      if (v > best) { best = v; bi = i; }
    }
    if (bi >= 0) {
      used.add(bi);
      iouSum += best;
      if (best >= iouThr) matched++;
    }
  }
  return {
    countPred: predBoxes.length,
    countGt: gtBoxes.length,
    countOk: predBoxes.length === gtBoxes.length,
    matched,
    precision: predBoxes.length ? matched / predBoxes.length : 0,
    recall: gtBoxes.length ? matched / gtBoxes.length : 0,
    meanIoU: gtBoxes.length ? iouSum / gtBoxes.length : 0,
  };
}

module.exports = {
  segmentCharacters, candidateComponents, mergeFragments, splitTouching,
  charLikeness, layoutScore, scoreLayout, evaluateSegmentation, cropComp, compFeatures,
};
