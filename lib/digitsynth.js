// -*- coding: utf-8 -*-
/**
 * lib/digitsynth.js — رندر برداری ارقام + اعوجاج شبیه کپچا + نرمال‌سازی.
 *
 * این ماژول دو نقش دارد:
 *  ۱) تولید داده مصنوعی برای آموزش مدل تشخیص رقم (قطعی با RNG بذردار)
 *  ۲) نرمال‌سازی کاراکترهای استخراج‌شده از کپچای واقعی برای استنتاج
 *
 * حروف با خطوط/بیضی برداری تعریف شده‌اند و سپس با موج سینوسی (مشخصه کپچای
 * kcaptcha)، چرخش و تغییر مقیاس اعوجاج داده می‌شوند.
 */

const ops = require('./imageops');
const { mulberry32 } = require('./ml');

const LABELS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/* ---------------- توابع هندسی ---------------- */

function arcPoints(cx, cy, rx, ry, a0deg, a1deg, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0deg + ((a1deg - a0deg) * i) / n) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/** تعریف برداری ارقام در فضای 100×140 — هر رقم فهرستی از پلی‌لاین/حلقه است. */
function digitStrokes(d) {
  switch (d) {
    case '0': return [arcPoints(50, 70, 30, 55, 0, 360, 40)];
    case '1': return [
      [[36, 30], [52, 16]],
      [[52, 16], [52, 124]],
      [[36, 124], [68, 124]],
    ];
    case '2': return [
      arcPoints(50, 36, 26, 22, 180, 380, 26),
      [[75, 42], [27, 104]],
      [[25, 110], [78, 110]],
    ];
    case '3': return [
      arcPoints(47, 37, 24, 22, 160, 440, 26),
      arcPoints(47, 97, 27, 27, 100, 390, 26),
    ];
    case '4': return [
      [[58, 14], [22, 82]],
      [[22, 82], [84, 82]],
      [[64, 34], [64, 126]],
    ];
    case '5': return [
      [[72, 16], [30, 16]],
      [[30, 16], [28, 60]],
      arcPoints(50, 86, 28, 30, 140, 420, 28),
    ];
    case '6': return [
      [[70, 16], [46, 48], [30, 78]],
      arcPoints(50, 96, 26, 28, 0, 360, 32),
    ];
    case '7': return [
      [[24, 20], [78, 20]],
      [[78, 20], [38, 126]],
    ];
    case '8': return [
      arcPoints(50, 42, 23, 25, 0, 360, 32),
      arcPoints(50, 99, 28, 28, 0, 360, 32),
    ];
    case '9': return [
      arcPoints(50, 44, 26, 27, 0, 360, 32),
      [[76, 50], [70, 92], [56, 126]],
    ];
    default: return [];
  }
}

/** لرزش نرم روی نقاط کنترل (اعوجاج شکل پایه). */
function jitterStrokes(strokes, rng, amount = 3) {
  return strokes.map((pts) => pts.map(([x, y]) => [
    x + (rng() * 2 - 1) * amount,
    y + (rng() * 2 - 1) * amount,
  ]));
}

/** رسترکردن پلی‌لاین‌ها با قلم دایره‌ای → تصویر دودویی (متن=0). */
function rasterize(strokes, w = 100, h = 140, radius = 5) {
  const img = ops.makeImage(w, h);
  const stamp = (cx, cy) => {
    const r2 = radius * radius;
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
      for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (x >= 0 && y >= 0 && x < w && y < h) img.data[y * w + x] = 0;
      }
    }
  };
  for (const pts of strokes) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const dist = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(1, Math.ceil(dist));
      for (let s = 0; s <= steps; s++) {
        stamp(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
      }
    }
  }
  return img;
}

/** موج سینوسی دوبعدی — مشخصه اصلی اعوجاج در کپچای kcaptcha. */
function applyWave(img, rng, amp = 4) {
  const a1 = amp * (0.5 + rng());
  const a2 = amp * (0.5 + rng());
  const p1 = rng() * Math.PI * 2, p2 = rng() * Math.PI * 2;
  const f1 = (2 + rng() * 2) * Math.PI / img.height;
  const f2 = (2 + rng() * 2) * Math.PI / img.width;
  const out = ops.makeImage(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sx = x + a1 * Math.sin(f1 * y + p1);
      const sy = y + a2 * Math.sin(f2 * x + p2);
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= img.width - 1 || y0 >= img.height - 1) continue;
      // نمونه‌گیری نزدیک‌ترین همسایه برای حفظ لبه‌های تیز دودویی
      out.data[y * img.width + x] = img.data[y0 * img.width + x0];
    }
  }
  return out;
}

/** رندر یک رقم اعوجاج‌یافته (تصادفی با بذرداری). */
function renderDigit(digit, rng) {
  let strokes = jitterStrokes(digitStrokes(digit), rng, 2.5);
  const radius = 4 + Math.round(rng() * 3);
  let img = rasterize(strokes, 100, 140, radius);
  img = applyWave(img, rng, 2 + rng() * 3.5);
  const angle = (rng() * 2 - 1) * 16;
  if (Math.abs(angle) > 2) img = ops.rotateBilinear(img, angle, 255);
  return img;
}

/* ---------------- نرمال‌سازی کاراکتر (مشترک آموزش/استنتاج) ---------------- */

/**
 * نرمال‌سازی یک مؤلفه دودویی به شبکه استاندارد:
 * برش → تغییر مقیاس با حفظ نسبت در جعبه داخلی → وسط‌چین در بوم size×size.
 * خروجی: آرایه شناور (جوهر = 1) برای ورودی مدل.
 */
function normalizeComponent(bin, { size = 20, inner = 16 } = {}) {
  const bb = ops.boundingBox(bin);
  const vec = new Float64Array(size * size);
  if (!bb) return vec;
  const w = bb.maxX - bb.minX + 1, h = bb.maxY - bb.minY + 1;
  const scale = Math.min(inner / w, inner / h);
  const w2 = Math.max(1, Math.round(w * scale));
  const h2 = Math.max(1, Math.round(h * scale));
  const ox = Math.floor((size - w2) / 2);
  const oy = Math.floor((size - h2) / 2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      // نمونه‌گیری از منبع با نگاشت معکوس
      const sx = Math.min(w - 1, Math.floor((x + 0.5) / scale - 0.5));
      const sy = Math.min(h - 1, Math.floor((y + 0.5) / scale - 0.5));
      const v = bin.data[(bb.minY + sy) * bin.width + (bb.minX + sx)];
      if (v === 0) vec[(oy + y) * size + (ox + x)] = 1;
    }
  }
  return vec;
}

/** ساخت مجموعه آموزش: برای هر رقم، تعداد نمونه اعوجاج‌یافته. */
function generateDataset({ perDigit = 500, seed = 1397 } = {}) {
  const X = [], Y = [];
  for (let d = 0; d < 10; d++) {
    const rng = mulberry32(seed + d * 1009);
    for (let i = 0; i < perDigit; i++) {
      const img = renderDigit(LABELS[d], rng);
      X.push(normalizeComponent(img));
      Y.push(d);
    }
  }
  return { X, Y, labels: LABELS };
}

module.exports = {
  LABELS, digitStrokes, rasterize, applyWave, renderDigit,
  normalizeComponent, generateDataset,
};
