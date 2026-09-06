// -*- coding: utf-8 -*-
/**
 * lib/captures.js — حلقه بازخورد یادگیری کپچا.
 *
 * هر کپچایی که سیستم برای حل‌کردن دریافت می‌کند، به‌صورت خودکار اینجا ذخیره
 * می‌شود (تصویر + پیش‌بینی مدل + اطمینان). سپس بر اساس نتیجهٔ ارسال رزرو:
 *
 *   - اگر صفیر ریل کپچا را پذیرفت (passed) → تصویر + متن به‌عنوان
 *     «نمونه برچسب‌خورده تأییدشده» وارد captcha_samples می‌شود؛ یعنی:
 *       ۱) حافظه نمونه‌محور k-NN (loadPrototypes در charlearn) بلافاصله و
 *          بدون بازآموزی از آن استفاده می‌کند؛
 *       ۲) بازآموزی CNN (node train/char-cnn.js) نیز همان‌ها را می‌خواند.
 *   - اگر کپچا رد شد (failed) → تصویر با پیش‌بینی مدل در صف می‌ماند تا کاربر
 *     در «صفحه یادگیری» (learn.html) متن درست را وارد کند و نمونه برچسب‌خورده
 *     شود. (ذخیره تصویرِ شکست‌خورده بدون برچسب به‌تنهایی برای آموزش کافی
 *     نیست؛ پاسخ درست فقط با برچسب دستی یا پذیرش سرور مشخص می‌شود.)
 *
 * همه توابع این ماژول «بهترین تلاش» هستند: هیچ خطایی نباید جریان رزرو را
 * مختل کند.
 */

const db = require('./db');

const MAX_CAPTURES = 200;        // سقف نگهداری کپچاهای در صف
const MAX_SAMPLES = 500;         // هم‌سقف با نمونه‌های یادگیری
const MAX_IMAGE_CHARS = 200000;  // ≈150KB تصویر base64
const TEXT_RE = /^[A-Za-z0-9]{3,8}$/;

/** ثبت یک تلاش کپچا. خروجی: شناسه رکورد یا null. هرگز خطا نمی‌دهد. */
function recordCapture({ image, text, confidence, variant }) {
  try {
    if (!image || typeof image !== 'string') return null;
    if (!/^data:image\//i.test(image) || image.length > MAX_IMAGE_CHARS) return null;
    const rec = db.insert('captcha_captures', {
      image,
      text: text || null,
      confidence: confidence == null ? null : confidence,
      variant: variant || null,
      outcome: 'pending', // pending | failed — نمونه‌های پذیرفته‌شده حذف و به نمونه‌ها می‌روند
    });
    trimCaptures();
    return rec.id;
  } catch (e) {
    return null;
  }
}

/** خلوت‌کردن صف: اول «در انتظار»های قدیمی حذف می‌شوند، صف شکست‌خورده‌ها حفظ می‌شود. */
function trimCaptures() {
  const all = db.find('captcha_captures', () => true);
  if (all.length <= MAX_CAPTURES) return;
  let excess = all.length - MAX_CAPTURES;
  const pending = all
    .filter((c) => c.outcome !== 'failed')
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  for (const c of pending) {
    if (excess <= 0) break;
    db.remove('captcha_captures', c.id);
    excess--;
  }
  if (excess > 0) {
    const failed = all
      .filter((c) => c.outcome === 'failed')
      .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    for (const c of failed) {
      if (excess <= 0) break;
      db.remove('captcha_captures', c.id);
      excess--;
    }
  }
}

/** استخراج بردار کاراکترها برای ورود به حافظه نمونه‌محور (بهترین تلاش). */
async function extractVectors(imageDataUri, text) {
  try {
    const b64 = String(imageDataUri || '').split(',')[1];
    if (!b64 || !TEXT_RE.test(text || '')) return null;
    const { extractCharVectors } = require('./charlearn');
    const vecs = await extractCharVectors(Buffer.from(b64, 'base64'), text);
    return Array.isArray(vecs) && vecs.length === text.length ? vecs : null;
  } catch (e) {
    return null;
  }
}

/** افزودن نمونه برچسب‌خورده به captcha_samples (با جلوگیری از تکراری). */
async function addLabeledSample(image, text, source) {
  const t = String(text || '').trim();
  if (!TEXT_RE.test(t)) return false;
  const dup = db.findOne('captcha_samples', (s) => s.text === t && s.image === image);
  if (dup) return false;
  const charVectors = await extractVectors(image, t);
  db.insert('captcha_samples', { image, text: t, source, char_vectors: charVectors });

  // هم‌سقف‌نگه‌داشتن تعداد نمونه‌ها با سقف یادگیری
  const all = db.find('captcha_samples', (s) => !!s.image);
  if (all.length > MAX_SAMPLES) {
    const sorted = all.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    for (const old of sorted.slice(0, all.length - MAX_SAMPLES)) db.remove('captcha_samples', old.id);
  }
  return true;
}

/**
 * ثبت نتیجه ارسال کپچا — از api/reserve.js بعد از پاسخ submit فراخوانی می‌شود.
 * passed → نمونه تأییدشده می‌شود؛ failed → در صف برچسب‌گذاری دستی می‌ماند.
 */
async function markOutcomeBySubmit({ captureId, text, result }) {
  try {
    if (!result || result.ok === false) return null; // خطای شبکه/سرور → قابل انتساب نیست
    const outcome = result.step === 'captcha' ? 'failed' : 'passed';

    let rec = captureId ? db.findById('captcha_captures', captureId) : null;
    if (!rec && text) {
      // مسیر پشتیبان: جدیدترین کپچای ثبت‌شده با همان متن پیش‌بینی‌شده
      rec = db.find('captcha_captures', (c) => c.text === text)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0] || null;
    }
    if (!rec) return null;

    if (outcome === 'passed') {
      if (rec.text) await addLabeledSample(rec.image, rec.text, 'auto-confirm');
      db.remove('captcha_captures', rec.id);
      return rec.id;
    }
    if (rec.outcome !== 'failed') db.update('captcha_captures', rec.id, { outcome: 'failed' });
    return rec.id;
  } catch (e) {
    return null;
  }
}

/** برچسب‌گذاری دستی یک کپچای شکست‌خورده (صفحه یادگیری). */
async function labelCapture(id, text) {
  const rec = db.findById('captcha_captures', id);
  if (!rec) return { ok: false, error: 'نمونه پیدا نشد.' };
  const t = String(text || '').trim();
  if (!TEXT_RE.test(t)) return { ok: false, error: 'متن معتبر نیست (۳ تا ۸ حرف/رقم انگلیسی).' };
  await addLabeledSample(rec.image, t, 'manual-corrected');
  db.remove('captcha_captures', id);
  return { ok: true };
}

/** فهرست کپچاهای در صف (جدیدترین اول) برای صفحه یادگیری. */
function listCaptures(limit = 30) {
  return db.find('captcha_captures', () => true)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      text: c.text || null,
      confidence: c.confidence == null ? null : c.confidence,
      outcome: c.outcome || 'pending',
      created_at: c.created_at || 0,
      image: c.image,
    }));
}

/** آمار صف و نمونه‌های یادگرفته‌شده. */
function stats() {
  const caps = db.find('captcha_captures', () => true);
  const samples = db.find('captcha_samples', () => true);
  return {
    queue: caps.length,
    failed: caps.filter((c) => c.outcome === 'failed').length,
    samples: samples.length,
    bySource: samples.reduce((acc, s) => {
      const k = s.source || 'manual';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
  };
}

module.exports = {
  recordCapture,
  markOutcomeBySubmit,
  labelCapture,
  listCaptures,
  addLabeledSample,
  stats,
};
