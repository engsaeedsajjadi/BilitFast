// -*- coding: utf-8 -*-
/**
 * lib/synthgen.js — تولیدکنندهٔ استاندارد کپچای مصنوعی برای آزمایشگاه.
 *
 * پارامترهای کنترل‌شده: فونت، اندازه، فاصله (منفی = هم‌پوشانی)، چرخش،
 * اعوجاج موجی، نویز، کنتراست، بلور، هم‌پوشانی، زمینهٔ روشن/تیره، شکستگی استروک.
 * خروجی هر نمونه: تصویر خاکستری + برچسب + جعبه‌های مرجع کاراکترها.
 * تولید کاملاً بذردار است؛ مجموعه‌های آموزش و تست با بذرهای مستقل ساخته
 * می‌شوند تا هیچ هم‌پوشانی نداشته باشند.
 */

const ops = require('./imageops');
const { glyphRows, CHARSET } = require('./synthfont');
const { mulberry32 } = require('./ml');

const DEFAULTS = {
  font: 'plain',        // plain | bold | serif
  fontSize: 5,          // مقیاس هر پیکسل فونت
  spacing: 3,           // فاصلهٔ بین کاراکترها (منفی = هم‌پوشانی/چسبیدگی)
  spacingJitter: 1,     // نوسان فاصله (فاصلهٔ متغیر)
  rotation: 8,          // حداکثر چرخش هر کاراکتر (درجه)
  wave: 1.2,            // دامنهٔ اعوجاج موجی هر کاراکتر
  noise: 0.004,         // چگالی نویز نمک‌وفلفلی
  contrast: 1,          // ۱ = کامل؛ کمتر = کنتراست پایین
  blur: 0,              // تعداد گذر بلور گاوسی
  overlap: 0,           // احتمال هم‌پوشانی اضافی یک جفت (۰..۱)
  fragment: 0,          // احتمال شکستگی استروک در هر کاراکتر
  bgDark: false,        // زمینهٔ تیره (قطبیت معکوس)
  bgNoiseLines: 0,      // تعداد خطوط نویز زمینه
  padX: 8, padY: 6,     // حاشیهٔ بوم
  fontSizeJitter: 0,    // نوسان اندازه (کاراکترهای کوچک/بزرگ)
};

/** رندر یک گلیف به بیت‌مپ بزرگ‌مقیاس (متن=0/زمینه=255). */
function renderGlyph(ch, scale, font = 'plain') {
  const rows = glyphRows(ch, font);
  const w = 5 * scale, h = 7 * scale;
  const img = ops.makeImage(w, h);
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 5; x++) {
      if (!rows[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          img.data[(y * scale + dy) * w + (x * scale + dx)] = 0;
        }
      }
    }
  }
  return img;
}

/** اعوجاج موجی ملایم روی بیت‌مپ یک کاراکتر (جعبهٔ مرجع را خراب نمی‌کند). */
function waveChar(img, rng, amp) {
  if (amp <= 0.05) return img;
  const out = ops.makeImage(img.width, img.height);
  const p1 = rng() * Math.PI * 2, p2 = rng() * Math.PI * 2;
  const f1 = (1.5 + rng()) * Math.PI / Math.max(4, img.height);
  const f2 = (1.5 + rng()) * Math.PI / Math.max(4, img.width);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sx = x + amp * Math.sin(f1 * y + p1);
      const sy = y + amp * Math.sin(f2 * x + p2);
      const x0 = Math.round(sx), y0 = Math.round(sy);
      if (x0 < 0 || y0 < 0 || x0 >= img.width || y0 >= img.height) continue;
      out.data[y * img.width + x] = img.data[y0 * img.width + x0];
    }
  }
  return out;
}

/** شکستگی استروک: حذف تصادفی چند پیکسل جوهر (کاراکتر تکه‌تکه). */
function fragmentChar(img, rng, level) {
  if (level <= 0) return img;
  const ink = [];
  for (let i = 0; i < img.data.length; i++) if (img.data[i] === 0) ink.push(i);
  const k = Math.floor(ink.length * 0.06 * level);
  for (let i = 0; i < k; i++) {
    const idx = ink[Math.floor(rng() * ink.length)];
    img.data[idx] = 255;
  }
  return img;
}

/** بازگردانی به دودویی تمیز بعد از تبدیل‌های هندسی (لبه‌های خاکستری → جوهر/زمینه). */
function snapBinary(img) {
  const out = ops.makeImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) out.data[i] = img.data[i] < 128 ? 0 : 255;
  return out;
}

/**
 * رندر یک متن کامل.
 * خروجی: { img, boxes:[{char,minX,minY,maxX,maxY}], width, height }
 */
function renderText(text, opts = {}, rng = mulberry32(1)) {
  const o = { ...DEFAULTS, ...opts };
  // ارتفاع بوم بر اساس بزرگ‌ترین مقیاس ممکن
  const maxScale = o.fontSize + (o.fontSizeJitter ? 1 : 0);
  const H = 7 * maxScale + o.padY * 2 + 6;
  const glyphs = [];
  let totalW = o.padX * 2;
  for (const ch of text) {
    const scale = Math.max(2, o.fontSize + (o.fontSizeJitter ? Math.floor(rng() * 3) - 1 : 0));
    let g = renderGlyph(ch, scale, o.font);
    g = waveChar(g, rng, o.wave * (0.5 + rng()));
    g = fragmentChar(g, rng, o.fragment ? rng() < o.fragment ? 1.5 : 0 : 0);
    const ang = (rng() * 2 - 1) * o.rotation;
    if (Math.abs(ang) > 1.5) {
      g = ops.rotateBilinear(g, ang, 255);
      g = snapBinary(g); // چرخش لبه‌های خاکستری می‌سازد؛ بدون بازگردانی، استروک‌ها
      // در آستانه‌گذاری نهایی می‌شکنند (رفتار غیرواقعی نسبت به رندر واقعی کپچا)
    }
    glyphs.push(g);
    const gap = o.spacing + Math.round((rng() * 2 - 1) * o.spacingJitter);
    totalW += g.width + Math.max(-Math.floor(g.width * 0.5), gap);
  }
  const img = ops.makeImage(Math.max(24, totalW), H, o.bgDark ? 0 : 255);
  const inkVal = o.bgDark ? 255 : 0;
  const bgVal = o.bgDark ? 0 : 255;
  let x = o.padX;
  const boxes = [];
  glyphs.forEach((g, gi) => {
    const yOff = o.padY + Math.floor((7 * maxScale - g.height) / 2) + Math.floor((rng() * 2 - 1) * 2);
    // هم‌پوشانی تصادفی اضافی
    if (o.overlap > 0 && gi > 0 && rng() < o.overlap) x -= Math.floor(g.width * 0.35);
    for (let y = 0; y < g.height; y++) {
      for (let xx = 0; xx < g.width; xx++) {
        const px = x + xx, py = yOff + y;
        if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
        if (g.data[y * g.width + xx] === 0) img.data[py * img.width + px] = inkVal;
      }
    }
    // جعبهٔ مرجع از خود پیکسل‌های جوهر نوشته‌شده (دقیق)
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = Math.max(0, yOff); y < Math.min(img.height, yOff + g.height); y++) {
      for (let xx = Math.max(0, x); xx < Math.min(img.width, x + g.width); xx++) {
        if (img.data[y * img.width + xx] === inkVal) {
          if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX >= 0) boxes.push({ char: text[gi], minX, minY, maxX, maxY });
    const gap = o.spacing + Math.round((rng() * 2 - 1) * o.spacingJitter);
    x += g.width + Math.max(-Math.floor(g.width * 0.5), gap);
  });

  // خطوط نویز زمینه
  for (let li = 0; li < o.bgNoiseLines; li++) {
    const x0 = Math.floor(rng() * img.width), y0 = Math.floor(rng() * img.height);
    const len = 8 + Math.floor(rng() * 18);
    const ang = rng() * Math.PI;
    for (let s = 0; s < len; s++) {
      const px = Math.round(x0 + s * Math.cos(ang)), py = Math.round(y0 + s * Math.sin(ang));
      if (px >= 0 && py >= 0 && px < img.width && py < img.height) img.data[py * img.width + px] = inkVal;
    }
  }

  // بلور، کنتراست، نویز
  let out = img;
  for (let b = 0; b < o.blur; b++) out = ops.gaussianBlur3(out);
  if (o.contrast < 1) {
    const mid = bgVal;
    const c = Math.max(0, o.contrast);
    const tmp = ops.makeImage(out.width, out.height);
    for (let i = 0; i < out.data.length; i++) {
      const v = mid + (out.data[i] - mid) * c;
      tmp.data[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
    out = tmp;
  }
  if (o.noise > 0) {
    for (let i = 0; i < out.data.length; i++) {
      if (rng() < o.noise) out.data[i] = out.data[i] === bgVal ? inkVal : bgVal;
    }
  }
  return { img: out, boxes, width: out.width, height: out.height };
}

/** نمونهٔ تصادفی با طول و کاراکترست مشخص. */
function randomSample(rng, { charset = CHARSET, minLen = 5, maxLen = 5, ...opts } = {}) {
  const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
  let text = '';
  for (let i = 0; i < len; i++) text += charset[Math.floor(rng() * charset.length)];
  const r = renderText(text, opts, rng);
  return { text, ...r };
}

/**
 * تولید دیتاست کامل (بذردار). آموزش/تست با بذرهای مستقل → بدون هم‌پوشانی.
 * خروجی: { train: [...], test: [...], seeds }
 */
function generateDataset({
  trainCount = 300, testCount = 100, seed = 1397,
  charset = CHARSET, opts = {}, testOpts = null,
} = {}) {
  const rngT = mulberry32(seed);
  const rngE = mulberry32(seed + 1010101); // بذر مستقل تست
  const train = [];
  for (let i = 0; i < trainCount; i++) train.push(randomSample(rngT, { charset, ...opts }));
  const test = [];
  const effTestOpts = testOpts || opts;
  for (let i = 0; i < testCount; i++) test.push(randomSample(rngE, { charset, ...effTestOpts }));
  return { train, test, seeds: { train: seed, test: seed + 1010101 } };
}

/** پریست‌های دشواری استاندارد. */
const DIFFICULTY = {
  easy: { spacing: 3, rotation: 4, wave: 0.5, noise: 0, contrast: 1, blur: 0, overlap: 0 },
  medium: { spacing: 1, rotation: 9, wave: 1.2, noise: 0.005, contrast: 0.85, blur: 0, overlap: 0.1 },
  hard: { spacing: -1, rotation: 14, wave: 2, noise: 0.02, contrast: 0.65, blur: 1, overlap: 0.35, fragment: 0.15, bgNoiseLines: 1 },
};

module.exports = { DEFAULTS, DIFFICULTY, renderGlyph, renderText, randomSample, generateDataset, CHARSET };
