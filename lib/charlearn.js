// -*- coding: utf-8 -*-
/**
 * lib/charlearn.js — تطبیق نمونه‌محور (k-NN) برای کپچا.
 *
 * ایده: حلقه یادگیری، هر کپچایی را که سرور صفیر ریل حل‌شدنش را تأیید کرد
 * (دستی یا خودکار) ذخیره می‌کند. در این ماژول، همان لحظه، کاراکترهای آن
 * کپچا به بردارهای نرمال‌شده تبدیل و ذخیره می‌شوند. موقع تشخیص، هر کاراکتر
 * علاوه بر مدل، با این «نمونه‌های واقعی تأییدشده» مقایسه می‌شود (فاصله
 * کسینوسی)؛ اگر نمونه‌ای بسیار نزدیک باشد، چون برچسبش توسط خود سایت تأیید
 * شده، بر پیش‌بینی مدل مقدم است.
 *
 * نتیجه: سیستم بدون بازآموزی و فقط با استفادهٔ عادی، به فونت/اعوجاج واقعی
 * کپچای سایت تطبیق پیدا می‌کند.
 */

const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');
const ops = require('./imageops');
const { normalizeComponent } = require('./digitsynth');

const VEC_SIZE = 20 * 20; // هم‌اندازه با ورودی مدل

/**
 * استخراج بردار کاراکترها از تصویر کپچا (همان خط لولهٔ استنتاج مدل).
 * فقط وقتی برمی‌گردد که تعداد قطعه‌ها دقیقاً برابر طول برچسب باشد
 * (وگرنه قابل اعتماد نیست و نمونه ذخیره نمی‌شود).
 */
async function extractCharVectors(buffer, label) {
  const digits = String(label || '');
  if (!/^\d{3,8}$/.test(digits)) return null;

  const base = await Jimp.read(buffer);
  let gray = ops.fromJimp(base);
  if (gray.width < 320) gray = ops.resizeBilinear(gray, 320 / gray.width);

  const polarity = ops.estimatePolarity(gray);
  let bin = ops.binarize(gray, ops.otsuThreshold(gray), !polarity.textIsDark);
  bin = ops.medianBlur3(bin);
  bin = ops.morphOpen(bin, 1);
  bin = ops.morphClose(bin, 1);

  const cc = ops.connectedComponents(bin);
  if (cc.count === 0) return null;
  bin = ops.filterComponentsMask(bin, cc, { minArea: 3, maxCount: 8 });

  const runs = ops.columnRuns(bin);
  if (runs.length !== digits.length) return null;

  const vecs = [];
  for (let i = 0; i < runs.length; i++) {
    const comp = ops.cropColumn(bin, runs[i]);
    const vec = normalizeComponent(comp, { size: 20, inner: 16 });
    if (vec.length !== VEC_SIZE) return null;
    // نمونه‌های خالی (بدون جوهر) اعتبار ندارند
    let ink = 0;
    for (let k = 0; k < vec.length; k++) if (vec[k] > 0) ink++;
    if (ink < 8) return null;
    vecs.push({ digit: digits[i], v: Array.from(vec) });
  }
  return vecs;
}

/** فاصله کسینوسی بین دو بردار (۰ = یکسان، تا ۱ برای بردارهای باینری). */
function cosineDist(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const GRID = 20; // اندازه بردار نرمال‌شده (20×20)

/** IoU دو بیت‌مپ (پیکسل‌های جوهر). */
function iouFlat(a, b) {
  let inter = 0, union = 0;
  for (let k = 0; k < a.length; k++) {
    const A = a[k] > 0 ? 1 : 0, B = b[k] > 0 ? 1 : 0;
    if (A && B) inter++;
    if (A || B) union++;
  }
  return union ? inter / union : 0;
}

/** IoU پس از جابه‌جایی b به اندازه (dx,dy). */
function shiftIoU(a, b, dx, dy) {
  let inter = 0, union = 0;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const sx = x - dx, sy = y - dy;
      const A = a[y * GRID + x] > 0 ? 1 : 0;
      const B = (sx >= 0 && sy >= 0 && sx < GRID && sy < GRID && b[sy * GRID + sx] > 0) ? 1 : 0;
      if (A && B) inter++;
      if (A || B) union++;
    }
  }
  return union ? inter / union : 0;
}

/** چرخش بیت‌مپ حول مرکز (نمونه‌گیری نزدیک‌ترین همسایه). */
function rotateGrid(v, ang) {
  const rad = (ang * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const out = new Float64Array(GRID * GRID);
  const cx = GRID / 2, cy = GRID / 2;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = c * dx + s * dy + cx, sy = -s * dx + c * dy + cy;
      const rx = Math.round(sx), ry = Math.round(sy);
      if (rx >= 0 && ry >= 0 && rx < GRID && ry < GRID) out[y * GRID + x] = v[ry * GRID + rx];
    }
  }
  return out;
}

/**
 * فاصله «مقاوم» بین دو بردار کاراکتر: کمینه (1 − IoU) روی چند زاویه چرخش و
 * جابه‌جایی. برای کپچای واقعی سایت که فونت ثابت دارد، رقم‌های هم‌خوان بسیار
 * نزدیک (نزدیک صفر) و رقم‌های متفاوت دور می‌مانند.
 */
function robustDist(a, b) {
  let best = 1;
  const angles = [-8, 0, 8];
  const shifts = [-2, -1, 0, 1, 2];
  for (const ang of angles) {
    const rb = ang === 0 ? b : rotateGrid(b, ang);
    for (const dy of shifts) {
      for (const dx of shifts) {
        const d = 1 - shiftIoU(a, rb, dx, dy);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/**
 * نزدیک‌ترین نمونه به بردار ورودی با معیار مقاوم.
 * فقط وقتی نمونه پذیرفته می‌شود که به‌قدر کافی نزدیک باشد (آستانه پیش‌فرض
 * در تنظیمات)؛ در غیر این صورت پیش‌بینی مدل استفاده می‌شود. این رفتار محافظه‌کارانه
 * باعث می‌شود نمونه‌های نامرتبط هرگز باعث تشخیص اشتباه نشوند.
 */
function matchPrototype(vec, prototypes, maxDist = 0.3) {
  let best = null;
  for (const p of prototypes || []) {
    if (!p || !Array.isArray(p.v)) continue;
    const d = robustDist(vec, p.v);
    if (!best || d < best.dist) best = { digit: p.digit, dist: d };
  }
  if (best && best.dist <= maxDist) return best;
  return null;
}

/** مسیر فایل دیتابیس (همان منطق lib/db). */
function dbFilePath() {
  const dir = process.env.BILITFAST_DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(dir, 'db.json');
}

/**
 * بارگذاری همه نمونه‌های ذخیره‌شده (فقط‌خواندنی؛ برای استنتاج).
 * هر خطا → آرایه خالی (هرگز نباید مسیر اصلی حل کپچا را بشکند).
 */
function loadPrototypes() {
  try {
    const dbj = JSON.parse(fs.readFileSync(dbFilePath(), 'utf8'));
    const out = [];
    for (const s of (dbj.captcha_samples || [])) {
      if (!Array.isArray(s.char_vectors)) continue;
      for (const cv of s.char_vectors) {
        if (cv && /^[0-9]$/.test(cv.digit) && Array.isArray(cv.v) && cv.v.length === VEC_SIZE) {
          out.push({ digit: cv.digit, v: cv.v });
        }
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

module.exports = { extractCharVectors, cosineDist, robustDist, matchPrototype, loadPrototypes, dbFilePath, VEC_SIZE };
