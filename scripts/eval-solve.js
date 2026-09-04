// scripts/eval-solve.js — ارزیابی سرتاسری حل کپچا روی نمونه‌های برچسب‌خورده:
// متن تولیدی با برچسب مقایسه می‌شود (دقت رشتهٔ کامل + دقت کاراکتری).
// اجرا: node scripts/eval-solve.js
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

(async () => {
  let exact = 0, charOk = 0, charAll = 0, total = 0;
  const bad = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!/\.png$/i.test(f)) continue;
      total++;
      const buf = fs.readFileSync(path.join(abs, f));
      const label = labels[f];
      let out = '';
      try {
        const r = await captcha.solveCaptcha(buf, {});
        out = (r && r.text) || '';
      } catch (e) {
        out = 'ERR:' + (e && e.message ? e.message : e);
      }
      const same = out === label;
      if (same) exact++;
      for (let i = 0; i < Math.max(out.length, label.length); i++) {
        charAll++;
        if (out[i] === label[i]) charOk++;
      }
      if (!same) bad.push(`${d}/${f}: ${label} → ${out}`);
    }
  }
  console.log(`دقیق: ${exact}/${total} — کاراکتری: ${(100 * charOk / Math.max(1, charAll)).toFixed(1)}%`);
  if (bad.length) console.log(bad.join('\n'));
  process.exit(exact === total ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
