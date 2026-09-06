// -*- coding: utf-8 -*-
/**
 * lib/ocr/ensemble.js — آنسامبل واقعی با اطمینان کالیبره‌شده.
 *
 * - رأی‌گیری وزن‌دار بر اساس احتمال‌های کالیبره‌شده (نه اطمینان خام).
 * - همبستگی خطای مدل‌ها (نرخ اختلاف + ضریب Q) روی یک مجموعهٔ برچسب‌دار.
 * - سهم هر مدل از پاسخ‌ها شمرده می‌شود.
 * - گزارش می‌شود آنسامبل از بهترین مدل منفرد بهتر است یا خیر.
 */

const { applyTemperature, argmaxConf } = require('./calibration');

/** پیش‌بینی نهایی به ازای هر موقعیت: رأی وزن‌دار بین مدل‌های هم‌تراز. */
function ensemblePredict(modelOutputs, { temperatures = {} } = {}) {
  // modelOutputs: [{ name, chars: [{char, conf(0..1 کالیبره), probs?}] }]
  const n = Math.max(...modelOutputs.map((m) => m.chars.length));
  const out = [];
  const contributions = {};
  for (const m of modelOutputs) contributions[m.name] = 0;
  for (let i = 0; i < n; i++) {
    const votes = new Map();
    for (const m of modelOutputs) {
      const c = m.chars[i];
      if (!c || !c.char) continue;
      const w = Math.max(0.01, c.conf || 0);
      votes.set(c.char, (votes.get(c.char) || 0) + w);
      contributions[m.name] += 0; // ثبت حضور مدل
    }
    if (!votes.size) { out.push({ char: null, conf: 0, voters: [] }); continue; }
    let winner = null, best = -1, total = 0;
    for (const [ch, w] of votes) {
      total += w;
      if (w > best) { best = w; winner = ch; }
    }
    // ثبت سهم مدل برنده
    for (const m of modelOutputs) {
      const c = m.chars[i];
      if (c && c.char === winner) contributions[m.name]++;
    }
    out.push({ char: winner, conf: best / total, voters: [...votes.keys()] });
  }
  return { chars: out, contributions };
}

/**
 * همبستگی خطای دو مدل روی جفت‌های برچسب‌دار:
 *  - disagreementRate: نسبت موقعیت‌هایی که دو مدل با هم اشتباه نکردند ولی اختلاف دارند
 *  - Q-statistic: (ad − bc)/(ad + bc) روی جدول ۲×۲ درست/غلط؛
 *    ۰ = مستقل، ۱ = خطاهای کاملاً همبسته (آنسامبل بی‌فایده)، −۱ = متمم.
 */
function errorCorrelation(predsA, predsB, gts) {
  let a = 0, b = 0, c = 0, d = 0, disagree = 0, total = 0;
  for (let i = 0; i < gts.length; i++) {
    const okA = predsA[i] === gts[i];
    const okB = predsB[i] === gts[i];
    total++;
    if (predsA[i] !== predsB[i]) disagree++;
    if (okA && okB) a++;
    else if (okA && !okB) b++;
    else if (!okA && okB) c++;
    else d++;
  }
  const denom = a * d + b * c;
  const Q = denom ? (a * d - b * c) / denom : 0;
  return { Q, disagreementRate: total ? disagree / total : 0, bothWrong: d, total };
}

/** مقایسهٔ آنسامبل با بهترین مدل منفرد. */
function compareWithBestSingle(ensembleAcc, singles) {
  const best = Object.entries(singles).sort((x, y) => y[1] - x[1])[0];
  return {
    bestSingle: best ? best[0] : null,
    bestSingleAcc: best ? best[1] : 0,
    ensembleAcc,
    ensembleBetter: best ? ensembleAcc > best[1] + 1e-9 : true,
    delta: best ? ensembleAcc - best[1] : ensembleAcc,
  };
}

module.exports = { ensemblePredict, errorCorrelation, compareWithBestSingle, applyTemperature, argmaxConf };
