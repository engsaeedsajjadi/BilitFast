// -*- coding: utf-8 -*-
/**
 * lib/captcha.js — حل کپچا به‌صورت خودکار (نسخه ۲: پیش‌پردازش پیشرفته + تِسِرَکت).
 *
 * ⚠️ نکته صادقانه: هیچ روشی حل ۱۰۰٪ کپچا را تضمین نمی‌کند؛ کپچا دقیقاً برای
 * جلوگیری از اتوماسیون طراحی شده. این ماژول «بهترین تلاش» را به‌شدت بالا می‌برد
 * و همیشه مسیر ورود دستی باز است (معماری قبلی دست نخورده است).
 *
 * نسخه ۲ چه تغییری کرد؟
 *   قبلاً: ۴ واریانت ساده (کنتراست/آستانه ثابت با jimp) × ۲ لیست کاراکتر = ۸ پاس.
 *   اکنون: خط لوله پردازش تصویر به سبک OpenCV (lib/imageops.js):
 *     ۱) بزرگ‌نمایی دوخطی + خاکستری
 *     ۲) آستانه «اوتسو» (خودکار) و آستانه «تطبیقی» (برای نور ناهمگن)
 *     ۳) تشخیص قطبیت (متن تیره/روشن) و یکدست‌سازی به متن سیاه روی زمینه سفید
 *     ۴) میانه‌فیلتر (حذف نویز نمک‌وفلفلی) + مورفولوژی: بازکردن برای حذف ذرات،
 *        بستن برای ترمیم شکستگی خطوط
 *     ۵) مؤلفه‌های همبند: حذف لکه‌های ریز و نگه‌داشتن کاراکترهای اصلی
 *     ۶) اصلاح کجی (برآورد زاویه با پروجکشن سطری + چرخش)
 *     ۷) قطعه‌بندی کاراکترها و بازچینی روی بوس تمیز با فاصله استاندارد
 *   سپس پاس‌های تِسِرَکت هوشمند اجرا می‌شوند:
 *     - اول لیست «فقط رقم» (کپچای صفیر ریل عددی است)، بعد لیست کامل
 *     - خروج زودهنگام وقتی نتیجه با اطمینان بالا به دست آمد (سریع‌تر روی سرورلس)
 *     - امتیازدهی ترکیبی (طول معتبر + اطمینان + رقمی‌بودن) برای انتخاب بهترین
 *
 * این ماژول هیچ وابستگی بومی جدیدی ندارد و روی سرورلس (Vercel) هم اجرا می‌شود.
 */

const path = require('path');
const fs = require('fs');
const { createWorker, PSM } = require('tesseract.js');
const Jimp = require('jimp');
const config = require(path.join(__dirname, '..', 'config.json'));
const ops = require('./imageops');

const CAPTCHA_CFG = (config.captcha || {});
const WHITELIST = CAPTCHA_CFG.whitelist || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DIGITS = '0123456789';
const PSM_MODE = CAPTCHA_CFG.psm || PSM.SINGLE_LINE;
const MIN_CONFIDENCE = CAPTCHA_CFG.min_confidence || 30;
const MAX_LENGTH = CAPTCHA_CFG.max_length || 8;
const MIN_LENGTH = CAPTCHA_CFG.min_length || 3;

// تنظیمات نسخه ۲ (همه اختیاری با پیش‌فرض روشن)
const USE_ADVANCED = CAPTCHA_CFG.advanced_preprocess !== false;
const MAX_VARIANTS = CAPTCHA_CFG.max_variants || 5;
const MAX_OCR_PASSES = CAPTCHA_CFG.max_ocr_passes || 10;
const EARLY_EXIT_CONF = CAPTCHA_CFG.early_exit_confidence || 75;
const DO_DESKEW = CAPTCHA_CFG.deskew !== false;
const DO_SEGMENT = CAPTCHA_CFG.segmentation !== false;
// کپچای صفیر ریل (طبق تابع generate() سایت) عددی است؛ پاسخ غیررقمی جریمه
// سنگین می‌گیرد. اگر روزی کپچا حروفی شد، این گزینه را غیرفعال کنید.
const FORCE_DIGITS = CAPTCHA_CFG.force_digits !== false;
// مدل اختصاصی تشخیص رقم (آموزش‌دیده با train/train-digits.js)
const USE_CUSTOM_MODEL = CAPTCHA_CFG.use_custom_model !== false;
const MODEL_PATH = CAPTCHA_CFG.model_path || 'models/captcha-model.json';
const MODEL_MIN_CHAR_CONF = CAPTCHA_CFG.model_min_char_conf || 0.75;
// تطبیق نمونه‌محور (k-NN) با نمونه‌های واقعی تأییدشده — در صورت نزدیکی کافی،
// نمونه واقعی بر پیش‌بینی مدل مقدم است.
const USE_PROTOTYPES = CAPTCHA_CFG.use_prototypes !== false;
const PROTO_MAX_DIST = CAPTCHA_CFG.prototype_max_distance || 0.3;

/**
 * مسیر محلی داده زبان tesseract (eng.traineddata.gz).
 * این فایل از پکیج @tesseract.js-data/eng می‌آید تا نیازی به دانلود از CDN
 * در زمان اجرا نباشد (هم روی سیستم کاربر و هم روی Vercel کار می‌کند).
 */
function resolveLangPath() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int'),
    path.join(__dirname, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'eng.traineddata.gz'))) return p;
  }
  return null;
}

/** گزینه‌های ساخت worker با مسیر محلی داده زبان. */
function workerOptions() {
  const langPath = resolveLangPath();
  const opts = { logger: () => {} };
  if (langPath) {
    opts.langPath = langPath;
    opts.gzip = true;
    opts.cacheMethod = 'none';
    opts.cachePath = require('os').tmpdir();
  }
  return opts;
}

/* =====================================================================
 * خط لوله پیشرفته (نسخه ۲) — معادل ساده‌شده پایپ‌لاین‌های رایج OpenCV
 * ===================================================================== */

/**
 * ساخت واریانت‌های پیشرفته از تصویر کپچا.
 * خروجی: آرایه { name, buffer(PNG) } — در صورت هر خطا، آرایه خالی برمی‌گردد
 * تا مسیر کلاسیک (پایین) همچنان کار کند.
 */
async function advancedVariants(buffer) {
  const variants = [];
  try {
    const base = await Jimp.read(buffer);
    let gray = ops.fromJimp(base);

    // کپچاهای کوچک را برای دقت بهتر بزرگ می‌کنیم
    if (gray.width < 320) {
      gray = ops.resizeBilinear(gray, 320 / gray.width);
    } else if (gray.width < 480) {
      gray = ops.resizeBilinear(gray, 1.5);
    }

    const polarity = ops.estimatePolarity(gray);
    const otsuT = ops.otsuThreshold(gray);

    // --- مسیر ۱: اوتسو + پاک‌سازی مؤلفه‌ای ---
    const cleaned = buildCleanVariant(gray, ops.binarize(gray, otsuT, !polarity.textIsDark));
    if (cleaned) {
      variants.push({ name: 'otsu+cc', buffer: await ops.toPngBuffer(cleaned.img) });
      // --- مسیر ۲: قطعه‌بندی کاراکترها روی همان تصویر تمیز ---
      if (DO_SEGMENT) {
        const stitched = ops.segmentAndStitch(cleaned.img, { maxChars: MAX_LENGTH });
        if (stitched) variants.push({ name: 'segmented', buffer: await ops.toPngBuffer(stitched) });
      }
    }

    // --- مسیر ۳: آستانه تطبیقی (برای زمینه‌های ناهمگن/رنگی) ---
    if (variants.length < MAX_VARIANTS) {
      const blurred = ops.gaussianBlur3(gray);
      const adaptive = ops.adaptiveThreshold(blurred, 15, 10);
      const cleanedA = buildCleanVariant(gray, adaptive);
      if (cleanedA) variants.push({ name: 'adaptive+cc', buffer: await ops.toPngBuffer(cleanedA.img) });
    }

    // --- مسیر ۴: وقتی قطبیت مبهم است، نسخه معکوس را هم امتحان کن ---
    if (polarity.borderMean > 90 && polarity.borderMean < 170 && variants.length < MAX_VARIANTS) {
      const inv = buildCleanVariant(gray, ops.binarize(gray, otsuT, polarity.textIsDark));
      if (inv) variants.push({ name: 'otsu-inv+cc', buffer: await ops.toPngBuffer(inv.img) });
    }

    // --- مسیر ۵: نسخه «نرم» بدون دودویی‌سازی (گاهی برای مدل LSTM بهتر است) ---
    if (variants.length < MAX_VARIANTS) {
      const soft = ops.gaussianBlur3(gray);
      variants.push({ name: 'soft-gray', buffer: await ops.toPngBuffer(soft) });
    }
  } catch (e) {
    // هر خطا → فقط مسیر کلاسیک اجرا می‌شود؛ جریان اصلی هرگز نمی‌شکند.
    console.error('[captcha] پیش‌پردازش پیشرفته ناموفق بود:', e && e.message ? e.message : e);
  }
  return variants.slice(0, MAX_VARIANTS);
}

/**
 * پاک‌سازی یک تصویر دودویی: میانه‌فیلتر → مورفولوژی → مؤلفه‌های همبند →
 * برش دور محتوا → اصلاح کجی. خروجی: { img } یا null اگر محتوایی نماند.
 */
function buildCleanVariant(graySource, bin) {
  try {
    let cur = ops.medianBlur3(bin);
    cur = ops.morphOpen(cur, 1);   // حذف ذرات نویز
    cur = ops.morphClose(cur, 1);  // ترمیم شکستگی‌های نازک کاراکترها

    const cc = ops.connectedComponents(cur);
    if (cc.count === 0) return null;
    cur = ops.filterComponentsMask(cur, cc, { minArea: 3, maxCount: MAX_LENGTH });
    if (!ops.boundingBox(cur)) return null;

    cur = ops.cropToContent(cur, 10);

    if (DO_DESKEW) {
      const angle = ops.estimateSkew(cur);
      if (Math.abs(angle) >= 0.75) {
        cur = ops.rotateBilinear(cur, angle, 255);
        cur = ops.cropToContent(cur, 10);
      }
    }
    return { img: cur };
  } catch (e) {
    return null;
  }
}

/* =====================================================================
 * پیش‌پردازش کلاسیک (نسخه ۱ — برای سازگاری و فال‌بک نگه داشته شده)
 * ===================================================================== */

async function preprocessVariants(buffer) {
  const base = await Jimp.read(buffer);
  const variants = [];

  const make = (name, fn) => variants.push({ name, buffer: fn(base.clone()) });

  make('norm180', (img) => img.greyscale().contrast(0.7).normalize().scale(3).threshold({ max: 180 }));
  make('inv180', (img) => img.greyscale().invert().contrast(0.7).normalize().scale(3).threshold({ max: 180 }));
  make('norm120', (img) => img.greyscale().contrast(0.7).normalize().scale(3).threshold({ max: 120 }));
  make('norm230', (img) => img.greyscale().contrast(0.7).normalize().scale(3).threshold({ max: 230 }));

  return Promise.all(
    variants.map(async (v) => ({ name: 'classic:' + v.name, buffer: await v.buffer.getBufferAsync(Jimp.MIME_PNG) }))
  );
}

/* =====================================================================
 * مدل اختصاصی تشخیص رقم (MLP کوچک آموزش‌دیده)
 * ===================================================================== */

let _model; // undefined=هنوز بررسی نشده، null=موجود نیست

// کش نمونه‌های واقعی (با انقضای کوتاه تا نمونه‌های تازه دیده شوند)
let _protoCache = { ts: 0, protos: [] };
function loadPrototypesCached() {
  if (!USE_PROTOTYPES) return [];
  const now = Date.now();
  if (now - _protoCache.ts > 30000) {
    try {
      const { loadPrototypes } = require('./charlearn');
      _protoCache = { ts: now, protos: loadPrototypes() };
    } catch (e) {
      _protoCache = { ts: now, protos: [] };
    }
  }
  return _protoCache.protos;
}

// مدل الفبایی آموزش‌دیده روی کاراکترهای واقعی سایت (train/char-model.js)
let _charModel; // undefined=بررسی‌نشده، null=موجود نیست
function loadCharModel() {
  if (_charModel !== undefined) return _charModel;
  _charModel = null;
  try {
    const modelPath = path.join(__dirname, '..', CAPTCHA_CFG.char_model_path || 'models/char-model.json');
    if (fs.existsSync(modelPath)) {
      const json = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
      if (json && json.classes && json.layers) {
        const { MLP } = require('./ml');
        _charModel = { model: MLP.fromJSON(json), classes: json.classes };
      }
    }
  } catch (e) { _charModel = null; }
  return _charModel;
}

/**
 * حل کپچا با مدل الفباییِ آموزش‌دیده روی فونت واقعی سایت.
 * خروجی: { text, confidence, minConf, chars } یا null.
 */
async function solveWithCharModel(buffer) {
  const cm = loadCharModel();
  if (!cm) return null;
  const { extractComponents } = require('./charlearn');
  const base = await Jimp.read(buffer);
  const comps = extractComponents(base, (MIN_LENGTH === MAX_LENGTH) ? MIN_LENGTH : undefined);
  if (!comps || comps.length < MIN_LENGTH || comps.length > MAX_LENGTH) return null;

  const { normalizeComponent } = require('./digitsynth');
  let text = '';
  let confSum = 0;
  let minConf = 1;
  const chars = [];
  for (const comp of comps) {
    const vec = normalizeComponent(comp, { size: 20, inner: 16 });
    const { label, probs } = cm.model.predict(vec);
    const digit = cm.classes[label];
    if (!digit) return null;
    text += digit;
    confSum += probs[label];
    if (probs[label] < minConf) minConf = probs[label];
    chars.push({ digit, conf: Math.round(probs[label] * 100), source: 'char-model' });
  }
  return { text, confidence: Math.round((confSum / comps.length) * 100), minConf, chars };
}

/** بارگذاری تنبل مدل؛ فایل وزن‌ها در ریپو کامیت شده است. */
function loadModel() {
  if (_model !== undefined) return _model;
  _model = null;
  if (!USE_CUSTOM_MODEL) return _model;
  try {
    const modelPath = path.join(__dirname, '..', MODEL_PATH);
    if (fs.existsSync(modelPath)) {
      const { MLP } = require('./ml');
      _model = MLP.fromJSON(JSON.parse(fs.readFileSync(modelPath, 'utf8')));
    }
  } catch (e) {
    console.error('[captcha] بارگذاری مدل اختصاصی ناموفق بود:', e && e.message ? e.message : e);
    _model = null;
  }
  return _model;
}

/**
 * حل کپچا با مدل اختصاصی: پیش‌پردازش → استخراج کاراکترها → طبقه‌بندی هر
 * کاراکتر با مدل. خروجی: { text, confidence, minConf, chars } یا null.
 */
async function solveWithModel(buffer) {
  const model = loadModel();
  if (!model) return null;
  try {
    const { LABELS, normalizeComponent } = require('./digitsynth');
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
    bin = ops.filterComponentsMask(bin, cc, { minArea: 3, maxCount: MAX_LENGTH });

    const runs = ops.columnRuns(bin);
    if (runs.length < MIN_LENGTH || runs.length > MAX_LENGTH) return null;

    const protos = loadPrototypesCached();
    const { matchPrototype } = require('./charlearn');

    let text = '';
    let confSum = 0;
    let minConf = 1;
    const chars = [];
    for (const run of runs) {
      const comp = ops.cropColumn(bin, run);
      const vec = normalizeComponent(comp, { size: 20, inner: 16 });
      const { label, probs } = model.predict(vec);
      let digit = LABELS[label];
      let conf = probs[label];
      let source = 'model';
      // تطبیق با نمونه‌های واقعی تأییدشده: اگر نمونه‌ای بسیار نزدیک باشد،
      // برچسبش توسط خود سایت تأیید شده و بر پیش‌بینی مدل مقدم است.
      const pm = protos.length ? matchPrototype(vec, protos, PROTO_MAX_DIST) : null;
      if (pm) {
        digit = pm.digit;
        conf = Math.max(conf, Math.min(0.99, 1 - pm.dist));
        source = 'prototype';
      }
      text += digit;
      confSum += conf;
      if (conf < minConf) minConf = conf;
      chars.push({ digit, conf: Math.round(conf * 100), source });
    }
    return {
      text,
      confidence: Math.round((confSum / runs.length) * 100),
      minConf,
      chars,
    };
  } catch (e) {
    return null;
  }
}

/* =====================================================================
 * OCR و انتخاب بهترین نتیجه
 * ===================================================================== */

/**
 * اجرای تِسِرَکت روی یک واریانت با لیست کاراکتر و حالت چیدمان مشخص.
 */
async function recognize(buffer, worker, whitelist, psm) {
  const ownsWorker = !worker;
  let w = worker;
  try {
    if (!w) w = await createWorker('eng', 1, workerOptions());
    await w.setParameters({
      tessedit_char_whitelist: whitelist || WHITELIST,
      tessedit_pageseg_mode: psm || PSM_MODE,
    });
    const { data } = await w.recognize(buffer);
    const raw = (data && data.text) || '';
    const text = raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const confidence = (data && typeof data.confidence === 'number') ? data.confidence : 0;
    return { text, confidence, raw };
  } finally {
    if (ownsWorker && w) await w.terminate();
  }
}

/** امتیازدهی نتیجه برای انتخاب بهترین (طول معتبر > اطمینان > رقمی‌بودن). */
function scoreResult(r, forceDigits = FORCE_DIGITS) {
  const lenOk = r.text.length >= MIN_LENGTH && r.text.length <= MAX_LENGTH;
  const allDigits = /^\d+$/.test(r.text);
  let score = r.confidence;
  score += lenOk ? 15 : -40;
  if (lenOk && allDigits) score += 6;
  if (lenOk && r.text.length >= 4 && r.text.length <= 6) score += 4;
  // کپچای صفیر ریل عددی است: پاسخ حاوی حروف تقریباً همیشه توهم تِسِرَکت است
  if (forceDigits && !allDigits) score -= 30;
  return score;
}

/**
 * حل کپچا از روی Buffer تصویر (رابط عمومی — بدون تغییر امضا).
 * خروجی: { ok, text, confidence, variant, whitelist, minConfidence, lengthOk,
 *           confident, passesRun, raw?, error? }
 */
async function solveCaptcha(buffer, options = {}) {
  const minConf = options.minConfidence !== undefined ? options.minConfidence : MIN_CONFIDENCE;
  // امکان بازنویسی حالت رقمی/الفبایی در هر فراخوانی (مثلاً برای تست)
  const fd = options.forceDigits !== undefined ? !!options.forceDigits : FORCE_DIGITS;

  // ۰) مسیر سریع:
  // - اگر کپچای سایت فقط رقم باشد (force_digits): مدل اختصاصی رقمی.
  // - در حالت الفبایی (واقعیت فعلی سایت): تطبیق کامل با نمونه‌های واقعی.
  let modelCandidate = null;
  if (fd) {
    try {
      const mr = await solveWithModel(buffer);
      if (mr) {
        const lenOk = mr.text.length >= MIN_LENGTH && mr.text.length <= MAX_LENGTH;
        if (lenOk && mr.minConf >= MODEL_MIN_CHAR_CONF) {
          return {
            ok: mr.confidence >= minConf,
            text: mr.text,
            confidence: mr.confidence,
            raw: null,
            variant: 'custom-model',
            whitelist: 'digits',
            minConfidence: minConf,
            lengthOk: lenOk,
            confident: mr.confidence >= minConf,
            passesRun: 0,
            chars: mr.chars,
          };
        }
        if (lenOk) modelCandidate = mr; // برای رقابت با نتایج تِسِرَکت نگه می‌داریم
      }
    } catch (e) { /* مسیر تِسِرَکت ادامه می‌یابد */ }
  } else if (USE_PROTOTYPES) {
    try {
      const pr = await solveWithPrototypes(buffer);
      if (pr) {
        const lenOk = pr.text.length >= MIN_LENGTH && pr.text.length <= MAX_LENGTH;
        if (lenOk && pr.minConf >= MODEL_MIN_CHAR_CONF) {
          return {
            ok: pr.confidence >= minConf,
            text: pr.text,
            confidence: pr.confidence,
            raw: null,
            variant: 'prototype',
            whitelist: 'mixed',
            minConfidence: minConf,
            lengthOk: lenOk,
            confident: pr.confidence >= minConf,
            passesRun: 0,
            chars: pr.chars,
          };
        }
        if (lenOk) modelCandidate = { text: pr.text, confidence: pr.confidence, raw: null, variant: 'prototype', whitelist: 'mixed' };
      }
      // مدل الفبایی آموزش‌دیده روی فونت واقعی سایت
      const cmr = await solveWithCharModel(buffer);
      if (cmr) {
        const lenOk = cmr.text.length >= MIN_LENGTH && cmr.text.length <= MAX_LENGTH;
        if (lenOk && cmr.minConf >= MODEL_MIN_CHAR_CONF) {
          return {
            ok: cmr.confidence >= minConf,
            text: cmr.text,
            confidence: cmr.confidence,
            raw: null,
            variant: 'char-model',
            whitelist: 'mixed',
            minConfidence: minConf,
            lengthOk: lenOk,
            confident: cmr.confidence >= minConf,
            passesRun: 0,
            chars: cmr.chars,
          };
        }
        if (lenOk && !modelCandidate) modelCandidate = { text: cmr.text, confidence: cmr.confidence, raw: null, variant: 'char-model', whitelist: 'mixed' };
      }
    } catch (e) { /* مسیر تِسِرَکت ادامه می‌یابد */ }
  }

  let worker = null;
  try {
    // ۱) ساخت واریانت‌ها: پیشرفته اول، کلاسیک به‌عنوان فال‌بک
    let variants = [];
    if (USE_ADVANCED) variants = await advancedVariants(buffer);
    if (variants.length < 2) {
      variants = variants.concat(await preprocessVariants(buffer));
    } else {
      // کلاسیک‌ها فقط اگر ظرفیت پاس باقی ماند اضافه می‌شوند (کران زمانی سرورلس)
      variants = variants.concat(await preprocessVariants(buffer));
    }

    worker = await createWorker('eng', 1, workerOptions());

    // ۲) برنامه‌ریزی پاس‌ها: اول «فقط رقم» (کپچای صفیر ریل عددی است) روی همه
    // واریانت‌ها، سپس حالت «تک‌کلمه» (PSM 8) برای واریانت‌های برتر؛ در نهایت
    // اگر کپچا غیررقمی شده باشد، پاس‌های حروف‌دار اجرا می‌شوند.
    const passes = [];
    for (const v of variants) passes.push({ v, whitelist: DIGITS, wlName: 'digits', psm: PSM_MODE });
    for (const v of variants.slice(0, 2)) passes.push({ v, whitelist: DIGITS, wlName: 'digits', psm: PSM.SINGLE_WORD });
    if (!fd) {
      for (const v of variants.slice(0, 2)) passes.push({ v, whitelist: WHITELIST, wlName: 'alnum', psm: PSM_MODE });
    }

    // ۳) اجرا با خروج زودهنگام و انتخاب بهترین
    const results = [];
    if (modelCandidate) {
      // نتیجه مدل به‌عنوان نامزد وارد رقابت می‌شود (اعتماد به رقمی‌بودن کامل)
      const r = {
        text: modelCandidate.text,
        confidence: modelCandidate.confidence,
        raw: null,
        variant: 'custom-model',
        whitelist: 'digits',
      };
      r.score = scoreResult(r, fd);
      results.push(r);
    }
    let best = results[0] || null;
    let passesRun = 0;
    for (const p of passes) {
      if (passesRun >= MAX_OCR_PASSES) break;
      const r = await recognize(p.v.buffer, worker, p.whitelist, p.psm);
      r.variant = p.v.name;
      r.whitelist = p.wlName;
      r.score = scoreResult(r, fd);
      results.push(r);
      passesRun++;
      if (!best || r.score > best.score) best = r;

      // خروج زودهنگام: نتیجه رقمی، با طول معتبر و اطمینان بالا
      if (
        best.text.length >= MIN_LENGTH && best.text.length <= MAX_LENGTH &&
        /^\d+$/.test(best.text) && best.confidence >= EARLY_EXIT_CONF
      ) {
        break;
      }
    }

    if (!best) {
      return { ok: false, error: 'هیچ نتیجه‌ای از تِسِرَکت گرفته نشد.', passesRun };
    }

    const lengthOk = best.text.length >= MIN_LENGTH && best.text.length <= MAX_LENGTH;
    const confident = best.confidence >= minConf;
    const ok = lengthOk && confident;

    return {
      ok,
      text: best.text,
      confidence: Math.round(best.confidence),
      raw: best.raw,
      variant: best.variant,
      whitelist: best.whitelist,
      minConfidence: minConf,
      lengthOk,
      confident,
      passesRun,
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  } finally {
    if (worker) await worker.terminate();
  }
}

/** پیش‌پردازش ساده (برای سازگاری و تست) — اولین واریانت پیشرفته/کلاسیک. */
async function preprocess(buffer) {
  const adv = USE_ADVANCED ? await advancedVariants(buffer) : [];
  if (adv.length) return adv[0].buffer;
  const variants = await preprocessVariants(buffer);
  return variants[0] ? variants[0].buffer : buffer;
}

/**
 * حل کپچا فقط با نمونه‌های واقعی تأییدشده (حالت الفبایی).
 * همه کاراکترها باید با نمونه‌های ذخیره‌شده تطبیق یابند؛ در غیر این صورت
 * null برمی‌گردد و مسیر تِسِرَکت ادامه می‌یابد.
 */
async function solveWithPrototypes(buffer) {
  const protos = loadPrototypesCached();
  if (!protos.length) return null;
  const { matchPrototype, extractComponents } = require('./charlearn');

  const base = await Jimp.read(buffer);
  const comps = extractComponents(base, (MIN_LENGTH === MAX_LENGTH) ? MIN_LENGTH : undefined);
  if (!comps || comps.length < MIN_LENGTH || comps.length > MAX_LENGTH) return null;

  const { normalizeComponent } = require('./digitsynth');
  let text = '';
  let confSum = 0;
  let minConf = 1;
  const chars = [];
  for (const comp of comps) {
    const vec = normalizeComponent(comp, { size: 20, inner: 16 });
    const m = matchPrototype(vec, protos, PROTO_MAX_DIST);
    if (!m) return null; // همه کاراکترها باید از نمونه‌های واقعی تطبیق یابند
    const c = Math.min(0.99, 1 - m.dist);
    text += m.digit;
    confSum += c;
    if (c < minConf) minConf = c;
    chars.push({ digit: m.digit, conf: Math.round(c * 100), source: 'prototype' });
  }
  return { text, confidence: Math.round((confSum / comps.length) * 100), minConf, chars };
}

module.exports = {
  solveCaptcha, preprocess, recognize, preprocessVariants,
  advancedVariants, buildCleanVariant, scoreResult,
  solveWithModel, solveWithPrototypes, solveWithCharModel, loadModel,
};
