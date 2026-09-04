// -*- coding: utf-8 -*-
/**
 * lib/charlearn.js — استخراج کاراکتر کپچا + تطبیق نمونه‌محور (k-NN).
 *
 * دو مسیر استخراج کاراکتر:
 *  ۱) «رنگی» (مسیر اصلی برای کپچای واقعی صفیر ریل): در این کپچا هر کاراکتر
 *     با یک رنگ متمایز رسم شده و خطوط نویز رنگ‌های دیگری دارند. پیکسل‌ها خوشه‌بندی
 *     رنگی می‌شوند؛ هر خوشه = یک رنگ؛ قطعه‌های باریک (خطوط) با آستانه «ضریب پُری»
 *     حذف می‌شوند و قطعه‌های فشرده = کاراکترها.
 *  ۲) «خاکستری» (فال‌بک): خط لوله کلاسیک (اوتسو + مورفولوژی + قطعه‌بندی ستونی).
 *
 * و تطبیق k-NN: هر کاراکتر با نمونه‌های واقعیِ تأییدشده مقایسه می‌شود (معیار
 * مقاوم به چرخش/جابه‌جایی)؛ نمونه نزدیک بر پیش‌بینی مدل مقدم است.
 */

const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');
const ops = require('./imageops');
const { normalizeComponent } = require('./digitsynth');

const VEC_SIZE = 20 * 20; // هم‌اندازه با ورودی مدل

/* ---------------- استخراج بر پایه رنگ ---------------- */

/** آیا پیکسل «جوهر» است؟ رنگیِ اشباع یا تیره (متن/خط) — پس‌زمینه سفید نیست. */
function isInk(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return (mx - mn) > 25 || mx < 140;
}

/**
 * «تحلیل عرض ضربه» (SWT) برای تفکیک خط نویز از کاراکتر.
 * خطوط نویز باریک و کشیده‌اند و جهت ضربه‌شان ثابت است؛ کاراکترها جمع‌شده‌اند
 * و جهت‌های متنوعی دارند. دو قاعده:
 *   ۱) خط راست/تقریباً راست: واریانس جهت بسیار کم + کشیدگی زیاد + عرض کم
 *   ۲) نوار مورب: نسبت نواری (طول مرکزخط/قطر جعبه) ≤ ۰٫۹ و واریانس جهت ≤ ۰٫۵
 * «محافظ همسایه»: اگر قطعه از نظر افقی با قطعهٔ بزرگ‌تری هم‌پوشانی قابل‌توجه
 * دارد و بازهٔ عمودی‌اش درون آن همسایه جا می‌شود، احتمالاً خرده‌ای از یک
 * کاراکتر است (نه خط مستقل) و حذف نمی‌شود.
 */
function isNoiseLine(comp, siblings) {
  const st = comp.swt;
  if (!st) return false;
  if (st.w > 4 || st.len < 9) return false;
  const bw = comp.maxX - comp.minX + 1;
  for (const s of siblings) {
    if (s === comp || !s.swt) continue;
    const xo = Math.min(comp.maxX, s.maxX) - Math.max(comp.minX, s.minX) + 1;
    if (xo < 0.3 * bw) continue;
    const yFit = comp.minY >= s.minY - 3 && comp.maxY <= s.maxY + 3;
    if (yFit && s.area >= comp.area) return false;
  }
  // میلهٔ نازک کاملاً افقی/عمودی: در این کپچا کاراکترها با عرض ≥۶ پیکسل رسم
  // می‌شوند؛ میله‌های ≤۵ پیکسل با کشیدگی زیاد، خطوط نویزاند.
  const axisAligned = st.orient <= 12 || st.orient >= 78;
  if (axisAligned && st.minDim <= 5 && st.aspect >= 3) return true;
  return false;
}

/**
 * قطعه‌بندی کاراکترها بر پایه رنگ.
 * خروجی: آرایه‌ای از بیت‌مپ‌های کاراکتر (مرتب چپ→راست) یا null.
 */
function segmentColoredChars(jimg, target, thin = true) {
  const { width: W, height: H, data } = jimg.bitmap;

  // خوشه‌بندی رنگی حریصانه (آستانه بزرگ‌تر تا آنتی‌الیاس به خوشه حرف بچسبد)
  const centers = [];
  const assign = new Int16Array(W * H).fill(-1);
  const TH = 100 * 100;
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (!isInk(r, g, b)) continue;
    let best = -1, bd = TH;
    for (let c = 0; c < centers.length; c++) {
      const dr = r - centers[c][0], dg = g - centers[c][1], db = b - centers[c][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = c; }
    }
    if (best < 0) { centers.push([r, g, b]); best = centers.length - 1; }
    assign[i] = best;
  }

  // قطعه‌های هر خوشه + حذف خطوط باریک
  let comps = [];
  for (let c = 0; c < centers.length; c++) {
    const bin = ops.makeImage(W, H);
    let count = 0;
    for (let i = 0; i < W * H; i++) {
      if (assign[i] === c) { bin.data[i] = 0; count++; }
    }
    if (count < 8) continue;
    // حذف خطوط نویز با بازسازی مورفولوژیک (شکل کامل حروف حفظ می‌شود)؛
    // در حالت thin=false (برای حروف خیلی ظریف) دست نمی‌زنیم.
    const cleanBin = thin ? ops.removeThinLines(bin, 1) : bin;
    const dil = ops.dilate(cleanBin, 1);
    const cc = ops.connectedComponents(dil);
    for (const s of cc.stats) {
      const bw = s.maxX - s.minX + 1, bh = s.maxY - s.minY + 1;
      let area = 0;
      for (let y = s.minY; y <= s.maxY; y++) {
        for (let x = s.minX; x <= s.maxX; x++) {
          if (cleanBin.data[y * W + x] === 0) area++;
        }
      }
      const fill = area / (bw * bh);
      if (area < 8) continue;      // ذرات نویز
      if (fill < 0.12) continue;   // خطوط باریک نویز (کاراکترها در این اندازه ≥۰.۱۵)
      // بیت‌مپ بریده‌شده خود قطعه (از ماسک تمیزشده بدون خطوط)
      const compBin = ops.makeImage(bw, bh);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          compBin.data[y * bw + x] = cleanBin.data[(s.minY + y) * W + (s.minX + x)];
        }
      }
      comps.push({ minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY, area, fill, bin: compBin });
    }
  }

  // «تحلیل عرض ضربه» (SWT): آمار هر قطعه برای امتیازدهی و انتخاب چیدمان محاسبه
  // می‌شود. حذف پیشاپیش خطوط انجام نمی‌شود چون کاراکترهای نازک (مثل «1») همان
  // شکل خطوط نویز را دارند؛ تفکیک با انتخاب چیدمانِ ردیف متن صورت می‌گیرد.
  for (const p of comps) p.swt = ops.strokeStats(p.bin);

  // ادغام خرده‌های یک کاراکتر که به‌خاطر گرادیان رنگ به خوشه‌های متفاوت رفته‌اند:
  // دو قطعه که جعبه‌هایشان (با ۱ پیکسل تورم) برخورد دارند و هر دو «کوچک‌تر از
  // یک حرف کامل» به نظر می‌رسند، یکی می‌شوند.
  function boxesTouch(a, b) {
    const bwA = a.maxX - a.minX + 1, bwB = b.maxX - b.minX + 1;
    const xOverlap = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) + 1;
    if (xOverlap < 1) return false;
    // خرده‌های یک حرف، بخش عمده عرض کوچک‌تر را هم‌پوشانی می‌کنند؛
    // حروف مجاور فقط لبه‌های باریک‌شان روی هم می‌افتد.
    if (xOverlap / Math.min(bwA, bwB) < 0.5) return false;
    // و نزدیکی عمودی (مثل نقطه و بدنه j)
    const yTouch = !(a.maxY + 2 < b.minY || b.maxY + 2 < a.minY);
    if (!yTouch) return false;
    // ادغام فقط وقتی یکی «خرده» باشد (نه دو کاراکتر/حباب نویز هم‌جوار):
    // خرده = مساحت کم، و از نظر عمودی درون قطعهٔ بزرگ‌تر جا بگیرد (خطوط نویز
    // معمولاً از ردیف کاراکتر بیرون می‌زنند).
    const small = a.area <= b.area ? a : b;
    const big = small === a ? b : a;
    if (small.area > 35) return false;
    if (small.minY < big.minY - 2 || small.maxY > big.maxY + 2) return false;
    return true;
  }
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < comps.length; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        const a = comps[i], b = comps[j];
        if (!boxesTouch(a, b)) continue;
        // ادغام فقط اگر جعبه حاصل هنوز در ابعاد یک کاراکتر باشد
        const minX = Math.min(a.minX, b.minX), minY = Math.min(a.minY, b.minY);
        const maxX = Math.max(a.maxX, b.maxX), maxY = Math.max(a.maxY, b.maxY);
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        if (bw > W * 0.45 || bh > H * 0.95) continue;
        // بیت‌مپ ادغامی
        const nb = ops.makeImage(bw, bh);
        for (const p of [a, b]) {
          for (let y = p.minY; y <= p.maxY; y++) {
            for (let x = p.minX; x <= p.maxX; x++) {
              if (p.bin.data[(y - p.minY) * (p.maxX - p.minX + 1) + (x - p.minX)] === 0) {
                nb.data[(y - minY) * bw + (x - minX)] = 0;
              }
            }
          }
        }
        comps.splice(j, 1); comps.splice(i, 1);
        comps.push({ minX, minY, maxX, maxY, area: a.area + b.area, fill: 0.3, bin: nb });
        merged = true;
        break outer;
      }
    }
  }

  // فیلتر نهایی: قطعه‌های خیلی کوچک (نویز باقی‌مانده) حذف شوند
  comps = comps.filter((p) => {
    const bh = p.maxY - p.minY + 1, bw = p.maxX - p.minX + 1;
    return p.area >= 15 && (bh >= H * 0.3 || bw >= W * 0.2);
  });

  // «تعمیر» تعداد قطعه‌ها تا هدف (اختیاری): حذف نویزی‌ترین یا ادغام هم‌پوشان‌ترین
  if (target) comps = repairCount(comps, target);

  if (comps.length < 3 || comps.length > 8) return null;
  comps.sort((a, b) => (a.minX + a.maxX) - (b.minX + b.maxX));
  return comps.map((p) => p.bin);
}

/**
 * رساندن تعداد قطعه‌ها به هدف:
 * - اگر بیشتر: حذف قطعه‌ای که کم‌ترین «شباهت به کاراکتر» را دارد (مساحت کوچک‌تر).
 * - اگر کمتر: ادغام جفتی که بیش‌ترین هم‌پوشانی نسبی افقی را دارد (خرده‌های یک حرف).
 */
function repairCount(comps, target) {
  function relOverlap(a, b) {
    const bwA = a.maxX - a.minX + 1, bwB = b.maxX - b.minX + 1;
    const xo = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) + 1;
    if (xo < 1) return 0;
    return xo / Math.min(bwA, bwB);
  }
  const yTouch = (a, b) => !(a.maxY + 2 < b.minY || b.maxY + 2 < a.minY);

  // امتیاز «کاراکتر بودن» بر پایه آمار عرض ضربه (SWT): کاراکتر جمع‌شده، پُر
  // و با جهت‌های متنوع است؛ خط نویز نواریِ کم‌پُری با جهت یکدست است.
  function charLikeness(p) {
    const st = p.swt || ops.strokeStats(p.bin);
    let score = 0;
    score += Math.min(1, p.area / 60);
    score += Math.min(1, p.fill / 0.25);
    score += st.dirVar * 1.5;
    score += Math.min(1, Math.max(0, st.ribbon - 0.8) / 0.6) * 1.2;
    score -= Math.max(0, 0.5 - st.dirVar) * 1.5;  // جریمهٔ یکدستی جهت
    return score;
  }

  /**
   * انتخاب زیرمجموعهٔ targetتایی با بهترین چیدمان: کاراکترهای یک ردیف فاصله‌های
   * تقریباً برابر دارند. برای هر ترکیب ممکن، امتیاز = نظم فاصله‌ها + میانگین
   * امتیاز کاراکتر بودن + پوشش عرض ردیف. بهترین ترکیب برگردانده می‌شود.
   */
  function chooseByLayout(all, k) {
    const n = all.length;
    if (k < 2 || k >= n || n > 13) return null;
    let minX0 = Infinity, maxX0 = -Infinity;
    for (const p of all) { minX0 = Math.min(minX0, p.minX); maxX0 = Math.max(maxX0, p.maxX); }
    const totalSpan = Math.max(1, maxX0 - minX0);
    let best = null, bestScore = -Infinity;
    const chosen = [];
    function rec(start) {
      if (chosen.length === k) {
        const set = chosen.map((i) => all[i])
          .sort((a, b) => (a.minX + a.maxX) - (b.minX + b.maxX));
        const centers = set.map((c) => (c.minX + c.maxX) / 2);
        const gaps = [];
        for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1]);
        const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
        const variance = gaps.reduce((s, g) => s + (g - mean) * (g - mean), 0) / gaps.length;
        const regularity = 1 / (1 + Math.sqrt(variance) / Math.max(8, mean));
        const lik = set.reduce((s, c) => s + charLikeness(c), 0) / set.length;
        const span = set[set.length - 1].maxX - set[0].minX;
        const score = regularity * 2.5 + lik * 0.6 + Math.min(1, span / (totalSpan * 0.9));
        if (score > bestScore) { bestScore = score; best = set; }
        return;
      }
      for (let i = start; i < n; i++) { chosen.push(i); rec(i + 1); chosen.pop(); }
    }
    rec(0);
    return best;
  }

  let guard = 20;
  while (comps.length !== target && guard-- > 0) {
    if (comps.length > target) {
      // اولویت ۱: حذف قطعهٔ بسیار کوچک (قاعدهٔ قدیمی و امن).
      let mi = 0;
      for (let i = 1; i < comps.length; i++) if (comps[i].area < comps[mi].area) mi = i;
      const areas = comps.map((p) => p.area).sort((a, b) => a - b);
      const median = areas[Math.floor(areas.length / 2)];
      if (comps[mi].area < 0.5 * median) { comps.splice(mi, 1); continue; }
      // اولویت ۲: انتخاب زیرمجموعهٔ targetتایی با بهترین «چیدمان» — کاراکترها
      // روی یک ردیف با فاصله‌های تقریباً منظم قرار دارند؛ خطوط نویز این نظم
      // را به‌هم می‌زنند. جستجوی کامل روی ترکیب‌ها (تعدادشان کم است).
      // محافظ: فقط وقتی مجاز است که «شواهد نویز» وجود داشته باشد — یا اضافی
      // قابل‌توجه، یا وجود قطعهٔ آشکارا خط‌گونه، یا امتیاز یک قطعه به‌وضوح
      // پایین‌تر از بقیه باشد — تا برچسب اشتباه، کاراکتر واقعی را حذف نکند.
      const liks = comps.map((p) => ({ p, s: charLikeness(p) })).sort((a, b) => a.s - b.s);
      let dropAllowed = comps.length - target >= 2;
      if (!dropAllowed && liks.length >= 2) {
        const weakest = liks[0];
        const gap = weakest.s < 0.91 * liks[1].s;
        const med = liks[Math.floor(liks.length / 2)].s;
        const belowMedian = weakest.s < 0.8 * med;
        const st = weakest.p.swt || ops.strokeStats(weakest.p.bin);
        const lineLike = st.dirVar <= 0.3 || st.minDim <= 4 || st.ribbon <= 0.6;
        dropAllowed = gap || belowMedian || (weakest.s < 1.8 && lineLike);
      }
      if (dropAllowed) {
        const picked = chooseByLayout(comps, target);
        if (picked) { comps = picked; break; }
      }
      break;
    } else {
      // کمتر از هدف: ادغام تعداد را باز هم کم می‌کند و هرگز به هدف نمی‌رساند؛
      // پس کاری نمی‌کنیم (فال‌بک‌های بعدی تلاش می‌کنند).
      break;
    }
  }
  return comps;
}

/* ---------------- استخراج خاکستری (فال‌بک) ---------------- */

function grayscaleChars(jimg) {
  let gray = ops.fromJimp(jimg);
  if (gray.width < 320) gray = ops.resizeBilinear(gray, 320 / gray.width);
  const polarity = ops.estimatePolarity(gray);
  let bin = ops.binarize(gray, ops.otsuThreshold(gray), !polarity.textIsDark);
  bin = ops.medianBlur3(bin);
  bin = ops.morphOpen(bin, 1);
  bin = ops.morphClose(bin, 1);
  bin = ops.removeThinLines(bin, 1); // حذف خطوط نویز با بازسازی مورفولوژیک
  const cc = ops.connectedComponents(bin);
  if (cc.count === 0) return null;
  bin = ops.filterComponentsMask(bin, cc, { minArea: 3, maxCount: 8 });
  const runs = ops.columnRuns(bin);
  if (!runs.length) return null;
  return runs.map((run) => ops.cropColumn(bin, run));
}

/** استخراج کاراکترها: هر دو حالت «با/بدون حذف خطوط» امتحان می‌شود و
 * سازگارترین با هدف برگردانده می‌شود؛ در نهایت فال‌بک خاکستری. */
function extractComponents(jimg, target) {
  for (const thin of [true, false]) {
    const c = segmentColoredChars(jimg, target, thin);
    if (c && (!target || c.length === target)) return c;
  }
  return grayscaleChars(jimg);
}

/* ---------------- بردارها و تطبیق ---------------- */

/**
 * استخراج بردار کاراکترها از تصویر کپچا.
 * فقط وقتی برمی‌گردد که تعداد قطعه‌ها دقیقاً برابر طول برچسب باشد.
 */
async function extractCharVectors(buffer, label) {
  const text = String(label || '');
  // برچسب می‌تواند رقم یا حرف باشد (کپچای واقعی صفیر ریل الفبا+ارقام است)
  if (!/^[A-Za-z0-9]{3,8}$/.test(text)) return null;

  const jimg = await Jimp.read(buffer);
  const comps = extractComponents(jimg, text.length);
  if (!comps || comps.length !== text.length) return null;

  const vecs = [];
  for (let i = 0; i < comps.length; i++) {
    const vec = normalizeComponent(comps[i], { size: 20, inner: 16 });
    if (vec.length !== VEC_SIZE) return null;
    let ink = 0;
    for (let k = 0; k < vec.length; k++) if (vec[k] > 0) ink++;
    if (ink < 8) return null; // نمونه خالی اعتبار ندارد
    vecs.push({ digit: text[i], v: Array.from(vec) });
  }
  return vecs;
}

/* ---------------- معیار فاصله مقاوم ---------------- */

const GRID = 20;

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

/** فاصله مقاوم: کمینه (1 − IoU) روی چرخش ±۸° و جابه‌جایی ±۲ پیکسل. */
function robustDist(a, b) {
  let best = 1;
  for (const ang of [-8, 0, 8]) {
    const rb = ang === 0 ? b : rotateGrid(b, ang);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = 1 - shiftIoU(a, rb, dx, dy);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

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

/* ---------------- بارگذاری نمونه‌ها ---------------- */

function dbFilePath() {
  const dir = process.env.BILITFAST_DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(dir, 'db.json');
}

function loadPrototypes() {
  try {
    const dbj = JSON.parse(fs.readFileSync(dbFilePath(), 'utf8'));
    const out = [];
    for (const s of (dbj.captcha_samples || [])) {
      if (!Array.isArray(s.char_vectors)) continue;
      for (const cv of s.char_vectors) {
        if (cv && /^[A-Za-z0-9]$/.test(cv.digit) && Array.isArray(cv.v) && cv.v.length === VEC_SIZE) {
          out.push({ digit: cv.digit, v: cv.v });
        }
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

/** تبدیل‌های هندسی روی بردار ۲۰×۲۰ (برای افزون‌سازی داده آموزش). */
function transformVec(v, { dx = 0, dy = 0, ang = 0, scale = 1 } = {}) {
  const S = 20;
  const rad = (ang * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const out = new Float64Array(S * S);
  const cx = S / 2, cy = S / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let px = (x - cx) / scale, py = (y - cy) / scale;
      const rx = c * px + s * py + cx - dx;
      const ry = -s * px + c * py + cy - dy;
      const x0 = Math.floor(rx), y0 = Math.floor(ry);
      if (x0 < 0 || y0 < 0 || x0 >= S - 1 || y0 >= S - 1) continue;
      const fx = rx - x0, fy = ry - y0;
      const a = v[y0 * S + x0], b = v[y0 * S + x0 + 1];
      const cc = v[(y0 + 1) * S + x0], d = v[(y0 + 1) * S + x0 + 1];
      out[y * S + x] = (a + (b - a) * fx) + ((cc + (d - cc) * fx) - (a + (b - a) * fx)) * fy;
    }
  }
  return out;
}

module.exports = {
  isInk, segmentColoredChars, grayscaleChars, extractComponents,
  extractCharVectors, robustDist, matchPrototype, loadPrototypes, dbFilePath,
  VEC_SIZE, transformVec,
};
