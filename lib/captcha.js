// -*- coding: utf-8 -*-
/**
 * lib/captcha.js — حل کپچا به‌صورت خودکار (OCR) برای سایت صفیر ریل.
 *
 * ⚠️ نکته مهم:
 *   - کپچا (kcaptcha) برای جلوگیری از بات‌ها طراحی شده است. OCR روی متن اعوجاجی
 *     فقط «بهترین تلاش» است و موفقیت آن تضمینی نیست.
 *   - این ماژول یک مسیر خودکار فراهم می‌کند، اما در کنار آن همیشه امکان ورود
 *     دستی کپچا توسط کاربر (Human-in-the-loop) باقی می‌ماند.
 *   - از این قابلیت فقط برای رزرو بلیت خودتان و مطابق شرایط استفاده سایت استفاده کنید.
 *
 * فرایند:
 *   ۱) پیش‌پردازش تصویر (خاکستری، افزایش کنتراست، آستانه‌گذاری، حذف نویز، بزرگ‌نمایی)
 *   ۲) OCR با tesseract.js (whitelist الفبایی-عددی، حالت تک‌خط)
 *   ۳) پاک‌سازی خروجی (فقط حروف/ارقام)
 *   ۴) بازگرداندن متن + میزان اطمینان (confidence)
 */

const path = require('path');
const fs = require('fs');
const { createWorker, PSM } = require('tesseract.js');
const Jimp = require('jimp');
const config = require(path.join(__dirname, '..', 'config.json'));

const CAPTCHA_CFG = (config.captcha || {});
const WHITELIST = CAPTCHA_CFG.whitelist || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
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

/**
 * پیش‌پردازش تصویر برای بهبود OCR.
 * ورودی: Buffer تصویر (png/jpg/gif). خروجی: Buffer PNG پردازش‌شده.
 */
async function preprocess(buffer) {
  const image = await Jimp.read(buffer);
  image
    .greyscale()            // خاکستری
    .contrast(1.0)          // افزایش کنتراست
    .normalize()            // کشیدن هیستوگرام (کشش کنتراست)
    .scale(3)               // بزرگ‌نمایی ۳ برابر (کمک به OCR)
    .threshold({ max: 180 }) // آستانه‌گذاری برای حذف نویز پس‌زمینه
    ;
  return image.getBufferAsync(Jimp.MIME_PNG);
}

/**
 * OCR روی تصویر پردازش‌شده و پاک‌سازی نتیجه.
 */
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

async function recognize(buffer, worker) {
  const ownsWorker = !worker;
  let w = worker;
  try {
    if (!w) w = await createWorker('eng', 1, workerOptions());
    await w.setParameters({
      tessedit_char_whitelist: WHITELIST,
      tessedit_pageseg_mode: PSM_MODE,
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
 * خروجی: { ok, text, confidence, error? }
 * در صورت نامطمئن بودن (کمتر از آستانه) یا طول نامعتبر، ok=false برمی‌گرداند.
 */
async function solveCaptcha(buffer, options = {}) {
  const minConf = options.minConfidence !== undefined ? options.minConfidence : MIN_CONFIDENCE;
  try {
    const processed = await preprocess(buffer);

    // چند تلاش OCR با آستانه‌های پیش‌پردازش متفاوت برای مقاومت بیشتر
    const results = [];
    const r1 = await recognize(processed);
    results.push(r1);

    // تلاش دوم: تصویر معکوس (اگر پس‌زمینه روشن و متن تیره باشد)
    const inv = await Jimp.read(buffer);
    inv.greyscale().invert().contrast(1.0).normalize().scale(3).threshold({ max: 180 });
    const r2 = await recognize(await inv.getBufferAsync(Jimp.MIME_PNG));
    results.push(r2);

    // انتخاب بهترین نتیجه
    let best = results[0];
    for (const r of results) {
      if (r.text.length >= MIN_LENGTH && r.text.length <= MAX_LENGTH && r.confidence > best.confidence) {
        best = r;
      }
    }

    // فقط وقتی «مطمئن» است ok=true برمی‌گردد: طول متن باید معتبر باشد
    // و اطمینان OCR به آستانه (min_confidence) برسد. بدون این شرط، OCR
    // متن زباله‌ای هم برمی‌گرداند و ارسال خودکار کپچای اشتباه انجام می‌شود.
    const lengthOk = best.text.length >= MIN_LENGTH && best.text.length <= MAX_LENGTH;
    const confident = best.confidence >= minConf;
    const ok = lengthOk && confident;
    return {
      ok,
      text: best.text,
      confidence: Math.round(best.confidence),
      raw: best.raw,
      minConfidence: minConf,
      lengthOk,
      confident,
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

module.exports = { solveCaptcha, preprocess, recognize };
