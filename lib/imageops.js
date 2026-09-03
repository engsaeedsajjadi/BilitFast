// -*- coding: utf-8 -*-
/**
 * lib/imageops.js — عملیات پردازش تصویر به سبک OpenCV، به‌صورت جاوااسکریپت خالص.
 *
 * چرا نه خود OpenCV؟ بسته‌های بومی (opencv4nodejs) روی محیط سرورلس مثل Vercel
 * قابل استقرار نیستند و نسخه WASM هم سنگین/شکننده است. الگوریتم‌های لازم برای
 * کپچای عددی (آستانه اوتسو، مورفولوژی، مؤلفه‌های همبند، اصلاح چرخش، قطعه‌بندی)
 * در اینجا با همان کیفیت مسئله خاص ما پیاده‌سازی شده‌اند و هیچ وابستگی جدیدی ندارند.
 *
 * نمایش تصویر: { width, height, data: Uint8Array } — خاکستری 0..255
 * قرارداد دودویی: متن (پیش‌زمینه) = 0 (سیاه)، پس‌زمینه = 255 (سفید)
 */

const Jimp = require('jimp');

function makeImage(width, height, fill = 255) {
  return { width, height, data: new Uint8Array(width * height).fill(fill) };
}

function cloneImage(img) {
  return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
}

/** تبدیل تصویر jimp به خاکستری. */
function fromJimp(j) {
  const { width, height, data } = j.bitmap;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    // فرمول استاندارد لومینانس
    out[i] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return { width, height, data: out };
}

/** تبدیل تصویر خاکستری به jimp (برای خروجی گرفتن). */
function toJimp(img) {
  const j = new Jimp(img.width, img.height, 0xffffffff);
  const d = j.bitmap.data;
  for (let i = 0; i < img.width * img.height; i++) {
    const g = img.data[i];
    d[i * 4] = g; d[i * 4 + 1] = g; d[i * 4 + 2] = g; d[i * 4 + 3] = 255;
  }
  return j;
}

async function toPngBuffer(img) {
  return toJimp(img).getBufferAsync(Jimp.MIME_PNG);
}

/* ---------------- تغییر اندازه / فیلترها ---------------- */

/** تغییر اندازه دوخطی (bilinear). */
function resizeBilinear(img, scale) {
  if (scale === 1) return cloneImage(img);
  const w2 = Math.max(1, Math.round(img.width * scale));
  const h2 = Math.max(1, Math.round(img.height * scale));
  const out = makeImage(w2, h2);
  for (let y = 0; y < h2; y++) {
    const sy = Math.min(img.height - 1.001, (y + 0.5) / scale - 0.5);
    const y0 = Math.floor(sy), y1 = Math.min(img.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w2; x++) {
      const sx = Math.min(img.width - 1.001, (x + 0.5) / scale - 0.5);
      const x0 = Math.floor(sx), x1 = Math.min(img.width - 1, x0 + 1);
      const fx = sx - x0;
      const a = img.data[y0 * img.width + x0], b = img.data[y0 * img.width + x1];
      const c = img.data[y1 * img.width + x0], d = img.data[y1 * img.width + x1];
      const top = a + (b - a) * fx;
      const bot = c + (d - c) * fx;
      out.data[y * w2 + x] = Math.round(top + (bot - top) * fy);
    }
  }
  return out;
}

/** فیلتر گاوسی ۳×۳ (نویزگیری ملایم). */
function gaussianBlur3(img) {
  const { width: w, height: h, data: s } = img;
  const out = makeImage(w, h);
  const px = (x, y) => s[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sum =
        px(x - 1, y - 1) + 2 * px(x, y - 1) + px(x + 1, y - 1) +
        2 * px(x - 1, y) + 4 * px(x, y) + 2 * px(x + 1, y) +
        px(x - 1, y + 1) + 2 * px(x, y + 1) + px(x + 1, y + 1);
      out.data[y * w + x] = Math.round(sum / 16);
    }
  }
  return out;
}

/** فیلتر میانه ۳×۳ — حذف نویز نمک‌وفلفلی بدون تارکردن لبه‌ها. */
function medianBlur3(img) {
  const { width: w, height: h, data: s } = img;
  const out = makeImage(w, h);
  const win = new Uint8Array(9);
  const px = (x, y) => s[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) win[k++] = px(x + dx, y + dy);
      for (let i = 1; i < 9; i++) {
        const v = win[i]; let j = i - 1;
        while (j >= 0 && win[j] > v) { win[j + 1] = win[j]; j--; }
        win[j + 1] = v;
      }
      out.data[y * w + x] = win[4];
    }
  }
  return out;
}

/* ---------------- آستانه‌گذاری ---------------- */

/** آستانه اوتسو (Otsu) — انتخاب خودکار آستانه از هیستوگرام. */
function otsuThreshold(img) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]]++;
  const total = img.data.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0;
  let maxVar = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = t; }
  }
  return threshold;
}

/** آستانه تطبیقی (میانگین پنجره − C) با تصویر انتگرالی. */
function adaptiveThreshold(img, block = 15, C = 10) {
  const { width: w, height: h, data: s } = img;
  // تصویر انتگرالی
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += s[y * w + x];
      integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const half = Math.floor(block / 2);
  const out = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integ[(y2 + 1) * (w + 1) + (x2 + 1)] - integ[y1 * (w + 1) + (x2 + 1)] -
        integ[(y2 + 1) * (w + 1) + x1] + integ[y1 * (w + 1) + x1];
      const t = sum / area - C;
      out.data[y * w + x] = s[y * w + x] > t ? 255 : 0;
    }
  }
  return out;
}

/** دودویی‌سازی با آستانه مشخص؛ خروجی: متن سیاه روی زمینه سفید. */
function binarize(img, t, invert = false) {
  const out = makeImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) {
    const dark = img.data[i] <= t;
    out.data[i] = (dark !== invert) ? 0 : 255;
  }
  return out;
}

/**
 * تشخیص جهت‌گیری (قطبیت): آیا متن تیره است یا روشن؟
 * میانگین حاشیه‌های تصویر ≈ رنگ پس‌زمینه (متن کمتر به هر چهار لبه می‌رسد).
 */
function estimatePolarity(img) {
  const { width: w, height: h, data: s } = img;
  let sum = 0, n = 0;
  for (let x = 0; x < w; x++) { sum += s[x] + s[(h - 1) * w + x]; n += 2; }
  for (let y = 1; y < h - 1; y++) { sum += s[y * w] + s[y * w + w - 1]; n += 2; }
  const borderMean = sum / n;
  return { textIsDark: borderMean > 128, borderMean };
}

/* ---------------- مورفولوژی (روی تصویر دودویی؛ متن=0) ---------------- */

function erode(img, iterations = 1) {
  let cur = img;
  for (let it = 0; it < iterations; it++) {
    const { width: w, height: h, data: s } = cur;
    const out = makeImage(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let all = true;
        for (let dy = -1; dy <= 1 && all; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h || s[yy * w + xx] !== 0) { all = false; break; }
          }
        }
        out.data[y * w + x] = all ? 0 : 255;
      }
    }
    cur = out;
  }
  return cur;
}

function dilate(img, iterations = 1) {
  let cur = img;
  for (let it = 0; it < iterations; it++) {
    const { width: w, height: h, data: s } = cur;
    const out = makeImage(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let any = false;
        for (let dy = -1; dy <= 1 && !any; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && s[yy * w + xx] === 0) { any = true; break; }
          }
        }
        out.data[y * w + x] = any ? 0 : 255;
      }
    }
    cur = out;
  }
  return cur;
}

/** بازکردن (erode→dilate): حذف ذرات نویز بدون تغییر اندازه شکل‌های بزرگ. */
function morphOpen(img, iterations = 1) {
  return dilate(erode(img, iterations), iterations);
}

/** بستن (dilate→erode): پرکردن شکاف‌ها/سوراخ‌های کوچک داخل کاراکترها. */
function morphClose(img, iterations = 1) {
  return erode(dilate(img, iterations), iterations);
}

/* ---------------- مؤلفه‌های همبند (معادل cv2.connectedComponentsWithStats) ---------------- */

/** برچسب‌گذاری مؤلفه‌های همبند ۸-اتصال روی پیکسل‌های متن (مقدار 0). */
function connectedComponents(img) {
  const { width: w, height: h, data: s } = img;
  const labels = new Int32Array(w * h); // 0 = بدون برچسب
  const stats = []; // [{area, minX, minY, maxX, maxY}]
  let next = 1;
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (s[i] !== 0 || labels[i] !== 0) continue;
    const label = next++;
    stack.push(i);
    labels[i] = label;
    let area = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p - x) / w;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (s[q] === 0 && labels[q] === 0) { labels[q] = label; stack.push(q); }
        }
      }
    }
    stats.push({ label, area, minX, minY, maxX, maxY });
  }
  return { labels, count: next - 1, stats, width: w, height: h };
}

/**
 * ساخت تصویر دودویی فقط با مؤلفه‌های معتبر:
 * حذف ذرات ریز (نویز) و نگه‌داشتن حداکثر maxCount مؤلفه بزرگ.
 */
function filterComponentsMask(img, cc, { minArea = 4, maxCount = 8 } = {}) {
  const keep = new Set();
  const sorted = [...cc.stats].filter((s) => s.area >= minArea).sort((a, b) => b.area - a.area);
  for (const s of sorted.slice(0, maxCount)) keep.add(s.label);
  const out = makeImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) {
    out.data[i] = keep.has(cc.labels[i]) ? 0 : 255;
  }
  return out;
}

/* ---------------- برش، چرخش، اصلاح کجی ---------------- */

/** جعبه مرزی محتوای تصویر (پیکسل‌های متن). */
function boundingBox(img) {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[y * img.width + x] === 0) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

/** برش دور محتوا + حاشیه سفید. */
function cropToContent(img, pad = 8) {
  const bb = boundingBox(img);
  if (!bb) return makeImage(16, 16);
  const w = bb.maxX - bb.minX + 1 + pad * 2;
  const h = bb.maxY - bb.minY + 1 + pad * 2;
  const out = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    const sy = bb.minY - pad + y;
    for (let x = 0; x < w; x++) {
      const sx = bb.minX - pad + x;
      if (sx >= 0 && sy >= 0 && sx < img.width && sy < img.height) {
        out.data[y * w + x] = img.data[sy * img.width + sx];
      }
    }
  }
  return out;
}

/** چرخش دوخطی حول مرکز با پرکردن سفید (برای تصویر خاکستری یا دودویی). */
function rotateBilinear(img, angleDeg, fill = 255) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const { width: w, height: h, data: s } = img;
  const cx = w / 2, cy = h / 2;
  const out = makeImage(w, h, fill);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // نگاشت معکوس: منبع هر پیکسل خروجی
      const dx = x - cx, dy = y - cy;
      const sx = cos * dx + sin * dy + cx;
      const sy = -sin * dx + cos * dy + cy;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const a = s[y0 * w + x0], b = s[y0 * w + x1];
      const c = s[y1 * w + x0], d = s[y1 * w + x1];
      out.data[y * w + x] = Math.round((a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy);
    }
  }
  return out;
}

/** واریانس پروجکشن سطری — هرچه سطرها تیزتر، واریانس بیشتر (معیار تشخیص کجی). */
function rowProjectionVariance(bin) {
  const sums = new Array(bin.height).fill(0);
  for (let y = 0; y < bin.height; y++) {
    let n = 0;
    for (let x = 0; x < bin.width; x++) if (bin.data[y * bin.width + x] === 0) n++;
    sums[y] = n;
  }
  const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
  return sums.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sums.length;
}

/**
 * برآورد زاویه کجی با جستجوی پروجکشن (مشابه روش‌های مبتنی بر Hough/پروجکشن).
 * خروجی: زاویه‌ای که با چرخاندن تصویر به آن، متن صاف می‌شود.
 */
function estimateSkew(bin, { maxAngle = 8, step = 0.5 } = {}) {
  // برای سرعت، روی نسخه کوچک‌شده کار می‌کنیم
  const small = bin.width > 300 ? resizeBilinear(bin, 300 / bin.width) : bin;
  let bestAngle = 0, bestVar = -1;
  for (let a = -maxAngle; a <= maxAngle + 1e-9; a += step) {
    const rotated = a === 0 ? small : rotateBilinear(small, a, 255);
    const v = rowProjectionVariance(rotated);
    if (v > bestVar) { bestVar = v; bestAngle = a; }
  }
  return bestAngle;
}

/* ---------------- قطعه‌بندی کاراکترها (معادل ساده‌شده تقسیم ستونی) ---------------- */

/**
 * پیدا کردن ستون‌های حاوی متن (پروجکشن ستونی). خروجی: آرایه بازه‌های [start, end].
 */
function columnRuns(bin, minGap = 2) {
  const { width: w, height: h, data: s } = bin;
  const proj = new Array(w).fill(0);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) if (s[y * w + x] === 0) proj[x]++;
  }
  const runs = [];
  let start = null;
  for (let x = 0; x < w; x++) {
    if (proj[x] > 0) {
      if (start === null) start = x;
    } else if (start !== null) {
      runs.push({ start, end: x - 1 });
      start = null;
    }
  }
  if (start !== null) runs.push({ start, end: w - 1 });
  // ادغام بازه‌هایی که فاصله خیلی کم دارند (نویز بین کاراکترها)
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= minGap) last.end = r.end;
    else merged.push({ ...r });
  }
  return merged;
}

/** برش عمودی هر بازه ستونی به جعبه واقعی محتوایش. */
function cropColumn(bin, run) {
  const sub = makeImage(run.end - run.start + 1, bin.height);
  for (let y = 0; y < bin.height; y++) {
    for (let x = run.start; x <= run.end; x++) {
      sub.data[y * sub.width + (x - run.start)] = bin.data[y * bin.width + x];
    }
  }
  return cropToContent(sub, 2);
}

/**
 * قطعه‌بندی کاراکترها + بازچینی روی بوم تمیز:
 * هر کاراکتر به ارتفاع یکسان نرمال می‌شود و با فاصله استاندارد کنار هم قرار
 * می‌گیرد — این کار اعوجاج فاصله‌ای را حذف کرده و دقت تِسِرَکت را بالا می‌برد.
 * اگر تعداد قطعه‌ها معقول نباشد، «null» برمی‌گردد (و مسیر بدون قطعه‌بندی استفاده می‌شود).
 */
function segmentAndStitch(bin, { targetHeight = 64, gap = 10, pad = 12, minChars = 2, maxChars = 8 } = {}) {
  const runs = columnRuns(bin);
  if (runs.length < minChars || runs.length > maxChars) return null;
  const chars = runs.map((r) => cropColumn(bin, r)).filter((c) => c.width >= 2 && c.height >= 4);
  if (chars.length < minChars) return null;
  const scaled = chars.map((c) => resizeBilinear(c, targetHeight / c.height));
  const width = scaled.reduce((a, c) => a + c.width, 0) + gap * (scaled.length - 1) + pad * 2;
  const height = targetHeight + pad * 2;
  const out = makeImage(width, height);
  let x = pad;
  for (const c of scaled) {
    for (let y = 0; y < c.height; y++) {
      for (let xx = 0; xx < c.width; xx++) {
        out.data[(y + pad) * width + x + xx] = c.data[y * c.width + xx];
      }
    }
    x += c.width + gap;
  }
  return out;
}

module.exports = {
  makeImage, cloneImage, fromJimp, toJimp, toPngBuffer,
  resizeBilinear, gaussianBlur3, medianBlur3,
  otsuThreshold, adaptiveThreshold, binarize, estimatePolarity,
  erode, dilate, morphOpen, morphClose,
  connectedComponents, filterComponentsMask,
  boundingBox, cropToContent, rotateBilinear, estimateSkew, rowProjectionVariance,
  columnRuns, cropColumn, segmentAndStitch,
};
