// scripts/eval-segmentation.js — ارزیابی قطعه‌بندی روی نمونه‌های برچسب‌خورده:
// چند تصویر دقیقاً «تعداد برچسب» قطعه تولید می‌کنند.
// اجرا: node scripts/eval-segmentation.js
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const cl = require(path.join(__dirname, '..', 'lib', 'charlearn'));

const ROOT = path.join(__dirname, '..');
const dirs = ['samples/real', 'samples/real2', 'samples/real3'];
const labels = Object.assign(
  {},
  JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/labels.json'))),
  JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/labels2.json'))),
  JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/labels3.json')))
);

(async () => {
  let ok = 0, total = 0;
  const bad = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!/\.png$/i.test(f)) continue;
      total++;
      const jimg = await Jimp.read(path.join(abs, f));
      const comps = cl.extractComponents(jimg, 5);
      const n = comps ? comps.length : 0;
      if (n === 5) ok++;
      else bad.push(`${d}/${f}(${labels[f]})=${n}`);
    }
  }
  console.log(`قطعه‌بندی ۵تایی: ${ok}/${total}`);
  if (bad.length) console.log('ناموفق‌ها:', bad.join('  '));
  process.exit(ok === total ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
