// -*- coding: utf-8 -*-
/**
 * lib/ocr/failure-analysis.js — دسته‌بندی نمونه‌های اشتباه.
 *
 * دسته‌ها:
 *  - segmentation-failure : تعداد/جعبهٔ قطعه‌ها با مرجع نمی‌خواند
 *  - polarity-failure     : با قطبیت معکوس، متن درست می‌شد
 *  - preprocessing-failure: بدون پیش‌پردازش (یا مسیر جایگزین) درست می‌شد
 *  - recognition-failure  : قطعه‌بندی درست ولی کاراکتر اشتباه تشخیص داده شد
 *  - low-confidence       : اطمینان توالی زیر آستانه (ردِ درست یا پذیرش کم‌اطمینان)
 *  - sequence-mismatch    : طول خروجی با مرجع متفاوت است
 *  - unknown              : قابل انتساب به هیچ‌کدام نبود
 */

const CATEGORIES = [
  'segmentation-failure', 'polarity-failure', 'preprocessing-failure',
  'recognition-failure', 'low-confidence', 'sequence-mismatch', 'unknown',
];

/**
 * دسته‌بندی یک نتیجهٔ ناموفق.
 * ورودی: row = {
 *   pred, gt, seqConf, threshold,
 *   segOk (تعداد قطعه درست بود؟), segIoU (میانگین IoU جعبه‌ها، اختیاری),
 *   invertedCorrect (با قطبیت معکوس درست می‌شد؟),
 *   rawCorrect (بدون پیش‌پردازش درست می‌شد؟),
 *   charCorrectMask (آرایهٔ درستی کاراکترها، اختیاری)
 * }
 */
function classifyFailure(row) {
  if (row.pred === row.gt) return null; // اصلاً شکست نیست
  if (row.segOk === false) return 'segmentation-failure';
  if (typeof row.segIoU === 'number' && row.segIoU < 0.5) return 'segmentation-failure';
  if (row.invertedCorrect) return 'polarity-failure';
  if (row.rawCorrect) return 'preprocessing-failure';
  const p = row.pred || '', g = row.gt || '';
  if (!p) {
    // خروجی خالی: یا موتور به‌درستی پاسخ بی‌ارزش را رد کرده، یا اطمینان پایین
    // مانع تحویل پاسخ شده است.
    return (typeof row.seqConf === 'number' && typeof row.threshold === 'number' && row.seqConf < row.threshold)
      ? 'low-confidence' : 'sequence-mismatch';
  }
  if (p.length !== g.length) return 'sequence-mismatch';
  // هم‌اندازه ولی نادرست: ریشهٔ خطا «تشخیص» است حتی اگر آستانه آن را رد کرده باشد.
  return 'recognition-failure';
}

/** گزارش تجمیعی: تعداد و درصد هر دسته. */
function failureReport(rows) {
  const failed = rows.filter((r) => r.pred !== r.gt);
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const examples = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  for (const r of failed) {
    const cat = classifyFailure(r) || 'unknown';
    counts[cat]++;
    if (examples[cat].length < 5) examples[cat].push({ gt: r.gt, pred: r.pred, id: r.id || null });
  }
  const total = failed.length || 1;
  const summary = CATEGORIES.map((c) => ({
    category: c,
    count: counts[c],
    pct: counts[c] / total,
    examples: examples[c],
  }));
  return { failed: failed.length, total: rows.length, categories: summary };
}

module.exports = { classifyFailure, failureReport, CATEGORIES };
