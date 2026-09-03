// -*- coding: utf-8 -*-
/**
 * lib/captcha.js — حل کپچا به‌صورت خودکار (OCR) برای سایت صفیر ریل.
 *
 * ⚠️ نکته مهم و صادقانه:
 *   - هیچ روش OCR خودکاری «۱۰۰٪ تضمینی» نیست؛ کپچا دقیقاً برای جلوگیری از
 *     اتوماسیون طراحی شده است. این ماژول فقط «بهترین تلاش» را تا حد ممکن بالا
 *     می‌برد و همیشه امکان ورود دستی (Human-in-the-loop) باقی می‌ماند.
 *   - از این قابلیت فقط برای رزرو بلیت خودتان و مطابق شرایط استفاده سایت استفاده کنید.
 *
 * بهبودهای انجام‌شده نسبت به نسخه اول:
 *   ۱) پاس «فقط رقم» (whitelist=0123456789) چون کپچای صفیر ریل (طبق تابع
 *      generate() سایت) عددی است؛ محدودکردن whitelist به رقم دقت OCR را به‌شدت بالا می‌برد.
 *   ۲) چند واریانت پیش‌پردازش (آستانه‌های مختلف + معکوس) چون کپچا ممکن است
 *      متن روشن روی زمینه تیره یا بالعکس باشد.
 *   ۳) استفاده مجدد از یک worker tesseract برای همه پاس‌ها (سریع‌تر).
 *   ۴) انتخاب بهترین نتیجه بر اساس طول معتبر + بیشترین confidence.
 */

const path = require('path');
const fs = require('fs');
const { createWorker, PSM } = require('tesseract.js');
const Jimp = require('jimp');
const config = require(path.join(__dirname, '..', 'config.json'));

const CAPTCHA_CFG = (config.captcha || {});
const WHITELIST = CAPTCHA_CFG.whitelist || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DIGITS = '0123456789';
const PSM_MODE = CAPTCHA_CFG.psm || PSM.SINGLE_LINE;
const MIN_CONFIDENCE = CAPTCHA_CFG.min_confidence || 30;
const MAX_LENGTH = CAPTCHA_CFG.max_length || 8;
const MIN_LENGTH = CAPTCHA_CFG.min_length || 3;

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

/**
 * چند واریانت پیش‌پردازش تصویر.
 *
 * کپچاهای تصویری ممکن است متن تیره روی زمینه روشن، متن روشن روی زمینه تیره،
 * یا دارای نویز باشند. به‌جای یک پیش‌پردازش ثابت، چند واریانت تولید می‌کنیم
 * و OCR روی همه اجرا می‌شود تا بهترین نتیجه انتخاب شود.
 */
async function preprocessVariants(buffer) {
  const base = await Jimp.read(buffer);
  const variants = [];

  const make = (name, fn) => variants.push({ name, buffer: fn(base.clone()) });

  // واریانت ۱: استاندارد (خاکستری → کنتراست → نرمال‌سازی → بزرگ‌نمایی → آستانه 180)
  make('norm180', (img) => img.greyscale().contrast(0.7).normalize().scale(3).threshold({ max: 180 }));

  // واریانت ۲: معکوس (متن روشن روی زمینه تیره)
  make('inv180', (img) => img.greyscale().invert().contrast(0.7).normalize().scale(3).threshold({ max: 180 }));

  // واریانت ۳: آستانه سخت‌تر (حذف نویز بیشتر)
  make('norm120', (img) => img.greyscale().contrast(0.7).normalize().scale(3).threshold({ max: 120 }));

  // واریانت ۴: آستانه نرم‌تر (برای متن کم‌رنگ)
  make('norm230', (img) => img.greyscale().contrast(0.7).normalize().scale(3).threshold({ max: 230 }));

  return Promise.all(
    variants.map(async (v) => ({ name: v.name, buffer: await v.buffer.getBufferAsync(Jimp.MIME_PNG) }))
  );
}

/**
 * OCR روی یک تصویر پردازش‌شده با whitelist مشخص.
 * خروجی: { text, confidence, raw }
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

/**
 * حل کپچا از روی Buffer تصویر.
 * خروجی: { ok, text, confidence, variant, whitelist, error? }
 * در صورت نامطمئن بودن (کمتر از آستانه) یا طول نامعتبر، ok=false برمی‌گرداند.
 */
async function solveCaptcha(buffer, options = {}) {
  const minConf = options.minConfidence !== undefined ? options.minConfidence : MIN_CONFIDENCE;
  let worker = null;
  try {
    worker = await createWorker('eng', 1, workerOptions());
    const variants = await preprocessVariants(buffer);
    const whitelists = [DIGITS, WHITELIST];
    const results = [];

    for (const v of variants) {
      for (const wl of whitelists) {
        const r = await recognize(v.buffer, worker, wl, PSM_MODE);
        r.variant = v.name;
        r.whitelist = (wl === DIGITS) ? 'digits' : 'alnum';
        results.push(r);
      }
    }

    // انتخاب بهترین نتیجه: فقط طول معتبر، سپس بیشترین confidence
    let best = null;
    for (const r of results) {
      const lenOk = r.text.length >= MIN_LENGTH && r.text.length <= MAX_LENGTH;
      r.lengthOk = lenOk;
      if (!lenOk) continue;
      if (!best || r.confidence > best.confidence) best = r;
    }
    if (!best) {
      // هیچ نتیجه‌ای با طول معتبر نیست → بهترین از نظر confidence (برای گزارش)
      best = results.reduce((a, b) => (b.confidence > a.confidence ? b : a), results[0]);
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
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  } finally {
    if (worker) await worker.terminate();
  }
}

/** پیش‌پردازش ساده (برای سازگاری و تست) — همان واریانت اول. */
async function preprocess(buffer) {
  const variants = await preprocessVariants(buffer);
  return variants[0] ? variants[0].buffer : buffer;
}

module.exports = { solveCaptcha, preprocess, recognize, preprocessVariants };
