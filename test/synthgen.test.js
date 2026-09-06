// -*- coding: utf-8 -*-
// تست‌های تولیدکنندهٔ دیتاست مصنوعی: قطعی‌بودن با بذر، استقلال آموزش/تست،
// کنترل پارامترها و پوشش حالت‌های دشوار.
// اجرا: node test/synthgen.test.js

const synth = require('../lib/synthgen');
const ops = require('../lib/imageops');
const { mulberry32 } = require('../lib/ml');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

{
  // فونت: همهٔ گلیف‌های کاراکترست تعریف شده‌اند
  test('فونت: ۶۲ گلیف (ارقام + حروف بزرگ/کوچک)', synth.CHARSET.length === 62);
  let allGlyphs = true;
  for (const ch of synth.CHARSET) {
    try { synth.renderGlyph(ch, 3, 'plain'); } catch (e) { allGlyphs = false; }
  }
  test('فونت: همه گلیف‌ها رندر می‌شوند', allGlyphs);
  const bold = synth.renderGlyph('A', 4, 'bold');
  const plain = synth.renderGlyph('A', 4, 'plain');
  let inkBold = 0, inkPlain = 0;
  for (const v of bold.data) if (v === 0) inkBold++;
  for (const v of plain.data) if (v === 0) inkPlain++;
  test('فونت: بولد جوهر بیشتری دارد', inkBold > inkPlain);

  // قطعیت با بذر
  const a = synth.renderText('AB12', { noise: 0.02 }, mulberry32(7));
  const b = synth.renderText('AB12', { noise: 0.02 }, mulberry32(7));
  let same = a.img.data.length === b.img.data.length;
  for (let i = 0; same && i < a.img.data.length; i++) if (a.img.data[i] !== b.img.data[i]) same = false;
  test('بذر یکسان → تصویر یکسان', same);
  const c = synth.renderText('AB12', { noise: 0.02 }, mulberry32(8));
  let diff = false;
  for (let i = 0; i < a.img.data.length && !diff; i++) if (a.img.data[i] !== c.img.data[i]) diff = true;
  test('بذر متفاوت → تصویر متفاوت', diff);

  // برچسب و جعبه‌های مرجع
  const r = synth.renderText('XY123', {}, mulberry32(3));
  test('جعبه‌های مرجع به تعداد کاراکترها', r.boxes.length === 5);
  test('جعبه‌ها مرتب چپ‌به‌راست', r.boxes.every((bb, i) => i === 0 || bb.minX > r.boxes[i - 1].minX));
  const sortedChars = r.boxes.map((bb) => bb.char).join('');
  test('کاراکتر جعبه‌ها با برچسب می‌خواند', sortedChars === 'XY123');

  // کنترل پارامتر: اندازه فونت
  const small = synth.renderText('H', { fontSize: 3 }, mulberry32(1));
  const big = synth.renderText('H', { fontSize: 7 }, mulberry32(1));
  const inkOf = (img) => { let n = 0; for (const v of img.data) if (v === 0) n++; return n; };
  test('اندازه فونت: بزرگ‌تر → جوهر بیشتر', inkOf(big.img) > inkOf(small.img) * 2);

  // زمینه تیره/روشن
  const dark = synth.renderText('H', { bgDark: true }, mulberry32(1));
  const light = synth.renderText('H', { bgDark: false }, mulberry32(1));
  test('زمینه تیره: گوشه‌ها تیره‌اند', dark.img.data[0] === 0);
  test('زمینه روشن: گوشه‌ها روشن‌اند', light.img.data[0] === 255);

  // هم‌پوشانی: فاصله منفی → جعبه‌ها هم‌پوشانی دارند
  const overlapped = synth.renderText('HH', { spacing: -6, rotation: 0, wave: 0 }, mulberry32(1));
  const ov = overlapped.boxes[0].maxX >= overlapped.boxes[1].minX;
  test('فاصله منفی → هم‌پوشانی جعبه‌ها', ov);

  // نویز: پیکسل‌های تصویر نویزی نسبت به نسخه تمیز (همان بذر) تغییر می‌کنند
  const noisy = synth.renderText('H', { noise: 0.1 }, mulberry32(1));
  const clean = synth.renderText('H', { noise: 0 }, mulberry32(1));
  let noiseDiff = 0;
  for (let i = 0; i < noisy.img.data.length; i++) {
    if (noisy.img.data[i] !== clean.img.data[i]) noiseDiff++;
  }
  test('نویز نمک‌وفلفلی اعمال می‌شود', noiseDiff > 10);
  const clean2 = synth.renderText('H', { noise: 0 }, mulberry32(1));
  let cleanDiff = 0;
  for (let i = 0; i < clean.img.data.length; i++) {
    if (clean.img.data[i] !== clean2.img.data[i]) cleanDiff++;
  }
  test('بدون نویز تصویر قطعی و تمیز است', cleanDiff === 0);

  // کنتراست پایین: اختلاف جوهر/زمینه کم می‌شود
  const lowC = synth.renderText('H', { contrast: 0.3, noise: 0 }, mulberry32(1));
  const spread = (img) => { let lo = 255, hi = 0; for (const v of img.data) { if (v < lo) lo = v; if (v > hi) hi = v; } return hi - lo; };
  const cleanC = synth.renderText('H', { noise: 0 }, mulberry32(1));
  test('کنتراست پایین بازه را کم می‌کند', spread(lowC.img) < spread(cleanC.img));

  // شکستگی استروک
  const frag = synth.renderText('88', { fragment: 1, noise: 0 }, mulberry32(1));
  test('شکستگی استروک تصویر را تغییر می‌دهد',
    JSON.stringify(Array.from(frag.img.data.slice(0, 400))) !== JSON.stringify(Array.from(cleanC.img.data.slice(0, 400))) || frag.img.width !== cleanC.img.width);

  // استقلال آموزش/تست
  const ds = synth.generateDataset({ trainCount: 20, testCount: 10, seed: 42 });
  test('دیتاست: تعداد درست', ds.train.length === 20 && ds.test.length === 10);
  test('دیتاست: بذرهای مستقل', ds.seeds.train !== ds.seeds.test);
  const t1 = synth.generateDataset({ trainCount: 20, testCount: 10, seed: 42 });
  const t2 = synth.generateDataset({ trainCount: 20, testCount: 10, seed: 42 });
  test('دیتاست: بازتولیدپذیر با بذر ثابت',
    ds.train.length === t1.train.length &&
    JSON.stringify(t1.train.map((s) => s.text)) === JSON.stringify(t2.train.map((s) => s.text)));
  const inkOfS = (s) => s.img.data.reduce((a, v) => a + (v < 128 ? 1 : 0), 0);
  test('دیتاست: همه نمونه‌ها جوهر دارند', ds.train.every((s) => inkOfS(s) > 20));
  test('دیتاست: طول برچسب پیش‌فرض ۵', ds.train.every((s) => s.text.length === 5));

  // پریست‌های دشواری
  test('پریست‌ها تعریف شده‌اند', synth.DIFFICULTY.easy && synth.DIFFICULTY.medium && synth.DIFFICULTY.hard);
  test('دشواری سخت شامل هم‌پوشانی و شکستگی است',
    synth.DIFFICULTY.hard.overlap > 0 && synth.DIFFICULTY.hard.fragment > 0);
}

if (failures) { console.log(failures + ' تست ناموفق'); process.exit(1); }
console.log('\nهمه تست‌ها پاس شدند');
