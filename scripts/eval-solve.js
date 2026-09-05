// scripts/eval-solve.js — بنچمارک سرتاسری حل کپچا روی نمونه‌های برچسب‌خورده.
//
// معیارها (PHASE 14):
//   Exact Match        — تعداد تصاویری که متن کامل دقیقاً برابر برچسب شد
//   Sequence Accuracy  — دقت در سطح رشته (اینجا هم‌ارز Exact؛ طول ثابت ۵)
//   Character Accuracy — دقت تک‌تک کاراکترها (هم‌موقعیت)
//   Avg Edit Distance  — میانگین فاصله لونشتاین بین خروجی و برچسب
//   Avg Confidence     — میانگین اطمینان گزارش‌شده
//   Avg Time           — میانگین زمان حل هر تصویر (میلی‌ثانیه)
//   مسیرها             — تفکیک نتایج بر اساس منبع حل (prototype / char-model / ...)
//
// نکته مهم: این بنچمارک روی همان ۴۹ نمونه‌ای اجرا می‌شود که بردارهایشان در
// دیتابیس ذخیره شده؛ پس «حالت استاندارد» بیشتر حافظه‌سنجی است تا تعمیم‌پذیری.
// برای اندازه‌گیری صادقانهٔ تعمیم، از اسکریپت scripts/eval-holdout.js استفاده کنید.
//
// اجرا: node scripts/eval-solve.js
// (برای اندازه‌گیری مسیر CNN بدون حافظهٔ نمونه‌ها:
//    BILITFAST_DATA_DIR=$(mktemp -d) node scripts/eval-solve.js)
const fs = require('fs');
const path = require('path');
const captcha = require(path.join(__dirname, '..', 'lib', 'captcha'));

const ROOT = path.join(__dirname, '..');
const dirs = ['samples/real', 'samples/real2', 'samples/real3'];
const labels = Object.assign(
  {},
  JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/labels.json'))),
  JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/labels2.json'))),
  JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/labels3.json')))
);

/** فاصله لونشتاین (حداقل تعداد ویرایش). */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Array(n + 1).fill(0);
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

(async () => {
  let exact = 0, charOk = 0, charAll = 0, total = 0;
  let confSum = 0, timeSum = 0, editSum = 0;
  const byVariant = {};
  const bad = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!/\.png$/i.test(f)) continue;
      total++;
      const buf = fs.readFileSync(path.join(abs, f));
      const label = labels[f];
      let out = '', conf = 0, variant = 'error';
      const t0 = Date.now();
      try {
        const r = await captcha.solveCaptcha(buf, {});
        out = (r && r.text) || '';
        conf = (r && r.confidence) || 0;
        variant = (r && r.variant) || 'none';
      } catch (e) {
        out = 'ERR:' + (e && e.message ? e.message : e);
      }
      const dt = Date.now() - t0;
      timeSum += dt;
      confSum += conf;
      byVariant[variant] = (byVariant[variant] || 0) + 1;

      const same = out === label;
      if (same) exact++;
      editSum += editDistance(out, label);
      for (let i = 0; i < Math.max(out.length, label.length); i++) {
        charAll++;
        if (out[i] === label[i]) charOk++;
      }
      if (!same) bad.push(`${d}/${f}: ${label} → ${out} (${variant}, conf=${conf}, ${dt}ms)`);
    }
  }

  const pct = (x) => (100 * x).toFixed(1) + '%';
  console.log('================ بنچمارک حل کپچا (49 نمونه برچسب‌خورده) ================');
  console.log(`Exact Match        : ${exact}/${total} (${pct(exact / Math.max(1, total))})`);
  console.log(`Sequence Accuracy  : ${exact}/${total} (${pct(exact / Math.max(1, total))})`);
  console.log(`Character Accuracy : ${charOk}/${charAll} (${pct(charOk / Math.max(1, charAll))})`);
  console.log(`Avg Edit Distance  : ${(editSum / Math.max(1, total)).toFixed(3)}`);
  console.log(`Avg Confidence     : ${(confSum / Math.max(1, total)).toFixed(1)}`);
  console.log(`Avg Time           : ${(timeSum / Math.max(1, total)).toFixed(0)}ms`);
  console.log('مسیرها             :', Object.entries(byVariant).map(([k, v]) => `${k}=${v}`).join('  '));
  if (bad.length) {
    console.log('---------------- موارد ناموفق ----------------');
    console.log(bad.join('\n'));
  }
  process.exit(exact === total ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
