// train/import-labeled.js — واردکردن کپچاهای برچسب‌خورده به‌عنوان نمونه‌های یادگیری.
//
// کاربرد: وقتی چند تصویر کپچای واقعی + متن دقیقشان را دارید، این اسکریپت
// بردار کاراکترها را استخراج و در دیتابیس ذخیره می‌کند تا لایه «تطبیق نمونه‌محور»
// بلافاصله از آن‌ها استفاده کند (بدون نیاز به بازآموزی).
//
// اجرا:
//   node train/import-labeled.js [پوشه تصاویر] [فایل برچسب‌ها]
//   پیش‌فرض: samples/real و samples/labels.json
//
// نکته: اگر تعداد قطعه‌های استخراج‌شده با طول برچسب نخواند، آن تصویر به‌صورت
// بی‌صدا رد می‌شود (نمونه نامعتبر وارد نمی‌شود).

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { extractCharVectors } = require('../lib/charlearn');

async function main() {
  const dirArg = process.argv[2] || path.join(__dirname, '..', 'samples', 'real');
  const labelsPath = process.argv[3] || path.join(__dirname, '..', 'samples', 'labels.json');
  const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));

  let imported = 0, skipped = 0;
  for (const [file, text] of Object.entries(labels)) {
    const p = path.join(dirArg, file);
    if (!fs.existsSync(p)) { console.log('⊘', file, '— فایل یافت نشد'); skipped++; continue; }
    try {
      const vecs = await extractCharVectors(fs.readFileSync(p), text);
      if (!vecs) { console.log('⊘', file, '— تعداد قطعه‌ها با برچسب «' + text + '» نخواند'); skipped++; continue; }
      db.insert('captcha_samples', { text, source: 'labeled-import', char_vectors: vecs });
      imported++;
      console.log('✓', file, '→', text, '(' + vecs.length + ' کاراکتر)');
    } catch (e) {
      console.log('⊘', file, '—', e && e.message ? e.message : e);
      skipped++;
    }
  }
  console.log('\nوارد شد: ' + imported + ' | رد شد: ' + skipped);
  console.log('از این پس solveCaptcha این نمونه‌ها را در تطبیق استفاده می‌کند.');
}

main().catch((e) => { console.error(e); process.exit(1); });
