// -*- coding: utf-8 -*-
/** lib/ocr/metrics.js — معیارهای ارزیابی استاندارد برای متن/کاراکتر. */

/** فاصله لونشتاین. */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

/** دقت کاراکتری هم‌موقعیت + شمارش‌های درست/غلط برای ماتریس درهم‌ریختگی. */
function charLevel(pairs) {
  let ok = 0, all = 0;
  for (const { pred, gt } of pairs) {
    for (let i = 0; i < Math.max(pred.length, gt.length); i++) {
      all++;
      if (pred[i] !== undefined && pred[i] === gt[i]) ok++;
    }
  }
  return { ok, all, acc: all ? ok / all : 0 };
}

/** CER = میانگین (فاصله ویرایش / طول مرجع). */
function cer(pairs) {
  if (!pairs.length) return 0;
  let sum = 0;
  for (const { pred, gt } of pairs) {
    sum += gt.length ? editDistance(pred, gt) / gt.length : (pred.length ? 1 : 0);
  }
  return sum / pairs.length;
}

/**
 * Precision/Recall/F1 کاراکتری (میکرو):
 * درست = کاراکترهای پیش‌بینی‌شدهٔ هم‌موقعیتِ درست.
 */
function prf(pairs) {
  let tp = 0, fp = 0, fn = 0;
  for (const { pred, gt } of pairs) {
    const n = Math.max(pred.length, gt.length);
    for (let i = 0; i < n; i++) {
      if (i < pred.length && i < gt.length) {
        if (pred[i] === gt[i]) tp++; else { fp++; fn++; }
      } else if (i < pred.length) fp++;
      else fn++;
    }
  }
  const p = tp + fp ? tp / (tp + fp) : 0;
  const r = tp + fn ? tp / (tp + fn) : 0;
  const f1 = p + r ? (2 * p * r) / (p + r) : 0;
  return { precision: p, recall: r, f1, tp, fp, fn };
}

/** ماتریس درهم‌ریختگی کاراکتری: { rows: [gt→{pred→count}] } از روی جفت‌ها. */
function confusionMatrix(pairs, classes) {
  const m = {};
  for (const c of classes) m[c] = {};
  for (const { pred, gt } of pairs) {
    for (let i = 0; i < Math.max(pred.length, gt.length); i++) {
      const g = gt[i] !== undefined ? gt[i] : '∅';
      const p = pred[i] !== undefined ? pred[i] : '∅';
      if (!m[g]) m[g] = {};
      m[g][p] = (m[g][p] || 0) + 1;
    }
  }
  return m;
}

/**
 * مجموعهٔ کامل معیارها برای یک دسته پیش‌بینی.
 * ورودی: rows = [{ pred, gt, confidence, timeMs, failed }]
 */
function fullReport(rows) {
  const pairs = rows.map((r) => ({ pred: r.pred || '', gt: r.gt || '' }));
  const exact = rows.filter((r) => (r.pred || '') === r.gt).length;
  const ch = charLevel(pairs);
  const f = prf(pairs);
  const confs = rows.map((r) => r.confidence || 0);
  const times = rows.map((r) => r.timeMs || 0);
  const failed = rows.filter((r) => r.failed).length;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    n: rows.length,
    exactMatch: exact,
    sequenceAccuracy: rows.length ? exact / rows.length : 0,
    charAccuracy: ch.acc,
    charOk: ch.ok,
    charAll: ch.all,
    precision: f.precision,
    recall: f.recall,
    f1: f.f1,
    cer: cer(pairs),
    avgConfidence: avg(confs),
    avgTimeMs: avg(times),
    failureRate: rows.length ? failed / rows.length : 0,
    pairs,
  };
}

/** قالب‌بندی درصد. */
function pct(x, d = 1) { return (100 * x).toFixed(d) + '%'; }

module.exports = { editDistance, charLevel, cer, prf, confusionMatrix, fullReport, pct };
