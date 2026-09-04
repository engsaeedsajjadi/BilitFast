// تست‌های خط لوله پیش‌پردازش کپچا (نسخه ۲) — تست‌های قطعی روی تصاویر مصنوعی،
// بدون نیاز به اینترنت. (رفتار نهایی روی کپچای واقعی در محیط واقعی بررسی می‌شود.)
// اجرا: node test/captcha.test.js

const Jimp = require('jimp');
const ops = require('../lib/imageops');
const { advancedVariants, scoreResult, buildModelCandidateResult } = require('../lib/captcha');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

/* ---------- سازنده‌های تصویر مصنوعی ---------- */

/** تصویر جیمپ با مستطیل سیاه (RGB). */
async function makeJimp(w, h, white = true) {
  return new Promise((resolve) => {
    new Jimp(w, h, white ? 0xffffffff : 0x000000ff, (err, img) => resolve(img));
  });
}
function jRect(img, x, y, w, h, white = false) {
  const c = white ? 0xffffffff : 0x000000ff;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx >= 0 && yy >= 0 && xx < img.bitmap.width && yy < img.bitmap.height) {
        img.setPixelColor(c, xx, yy);
      }
    }
  }
}

/** مستطیل روی تصویر خاکستریِ کتابخانه (0=سیاه). */
function gRect(gray, x, y, w, h, v = 0) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx >= 0 && yy >= 0 && xx < gray.width && yy < gray.height) {
        gray.data[yy * gray.width + xx] = v;
      }
    }
  }
}

(async () => {
  /* ---------------- اوتسو ---------------- */
  const bimodal = ops.makeImage(100, 100);
  for (let i = 0; i < bimodal.data.length; i++) bimodal.data[i] = i % 2 === 0 ? 40 : 210;
  const t = ops.otsuThreshold(bimodal);
  // در هیستوگرام دومُدی، آستانه اوتسو روی مرز مُد اول می‌نشیند؛ معیار صحت این است
  // که دودویی‌سازی با آن، دو کلاس را «کاملاً» از هم جدا کند.
  const sep = ops.binarize(bimodal, t, false);
  let correct = 0;
  for (let i = 0; i < sep.data.length; i++) {
    const wantDark = bimodal.data[i] === 40;
    if ((sep.data[i] === 0) === wantDark) correct++;
  }
  test('اوتسو: آستانه دو کلاس را کاملاً جدا می‌کند (100٪)', correct === sep.data.length && t >= 40 && t < 210);

  /* ---------------- قطبیت ---------------- */
  const light = await makeJimp(120, 60, true);
  jRect(light, 50, 20, 20, 25); // متن تیره روی زمینه روشن
  const pLight = ops.estimatePolarity(ops.fromJimp(light));
  test('قطبیت: متن تیره روی زمینه روشن', pLight.textIsDark === true);

  const dark = await makeJimp(120, 60, false);
  jRect(dark, 50, 20, 20, 25, true); // متن روشن روی زمینه تیره
  const pDark = ops.estimatePolarity(ops.fromJimp(dark));
  test('قطبیت: متن روشن روی زمینه تیره', pDark.textIsDark === false);

  /* ---------------- دودویی‌سازی ---------------- */
  const bin = ops.binarize(ops.fromJimp(light), 128, false);
  test('دودویی‌سازی: پیکسل متن=0 و زمینه=255', bin.data[30 * 120 + 55] === 0 && bin.data[0] === 255);

  /* ---------------- مورفولوژی ---------------- */
  const noisy = ops.makeImage(50, 50);
  noisy.data[25 * 50 + 10] = 0;            // ذره تک‌پیکسلی (نویز)
  gRect(noisy, 30, 20, 8, 8);              // شکل بزرگ
  const opened = ops.morphOpen(noisy, 1);
  test('بازکردن: ذره تک‌پیکسلی حذف می‌شود', opened.data[25 * 50 + 10] === 255);
  test('بازکردن: شکل بزرگ حفظ می‌شود', opened.data[22 * 50 + 32] === 0);

  const gappy = ops.makeImage(60, 20);
  for (let x = 10; x < 50; x++) {
    if (x === 30) continue;                // شکاف ۱ پیکسلی
    gappy.data[10 * 60 + x] = 0;
  }
  const closed = ops.morphClose(gappy, 1);
  test('بستن: شکاف ۱ پیکسلی پر می‌شود', closed.data[10 * 60 + 30] === 0);

  /* ---------------- مؤلفه‌های همبند ---------------- */
  const ccImg = ops.makeImage(100, 60);
  gRect(ccImg, 10, 20, 12, 20);
  gRect(ccImg, 45, 20, 12, 20);
  gRect(ccImg, 80, 20, 12, 20);
  ccImg.data[5 * 100 + 5] = 0;             // ذره نویز ریز
  const cc = ops.connectedComponents(ccImg);
  test('مؤلفه‌های همبند: ۳ شکل + ۱ ذره = ۴ مؤلفه', cc.count === 4);
  const filtered = ops.filterComponentsMask(ccImg, cc, { minArea: 4, maxCount: 8 });
  test('فیلتر مؤلفه‌ها: ذره ریز حذف و شکل‌ها می‌مانند', (() => {
    let fg = 0;
    for (let i = 0; i < filtered.data.length; i++) if (filtered.data[i] === 0) fg++;
    return filtered.data[5 * 100 + 5] === 255 && fg >= 3 * (12 * 20 - 5);
  })());

  /* ---------------- برش دور محتوا ---------------- */
  const cropSrc = ops.makeImage(200, 100);
  gRect(cropSrc, 90, 40, 20, 15);
  const cropped = ops.cropToContent(cropSrc, 5);
  test('برش دور محتوا: ابعاد ≈ اندازه شکل + حاشیه', cropped.width === 30 && cropped.height === 25);

  /* ---------------- اصلاح کجی (دسکیو) ---------------- */
  const bar = ops.makeImage(240, 80);
  for (let x = 30; x < 210; x++) {
    for (let y = 36; y < 44; y++) bar.data[y * 240 + x] = 0;
  }
  const tilted = ops.rotateBilinear(bar, 5, 255);
  const est = ops.estimateSkew(tilted, { maxAngle: 8, step: 0.5 });
  test('دسکیو: زاویه +5 درجه با خطای کمتر از ۱٫۵ درجه جبران می‌شود', Math.abs(est + 5) <= 1.5);

  /* ---------------- قطعه‌بندی ---------------- */
  const segImg = ops.makeImage(150, 60);
  gRect(segImg, 10, 15, 15, 30);
  gRect(segImg, 60, 15, 15, 30);
  gRect(segImg, 110, 15, 15, 30);
  const stitched = ops.segmentAndStitch(segImg, { targetHeight: 64, gap: 10, pad: 12 });
  test('قطعه‌بندی: ۳ کاراکتر جدا تشخیص داده و بازچینی می‌شوند', !!stitched && stitched.height === 64 + 24);
  const oneBar = ops.makeImage(80, 40);
  gRect(oneBar, 10, 15, 60, 10);
  test('قطعه‌بندی: تک‌قطعه → null (مسیر بدون قطعه‌بندی)', ops.segmentAndStitch(oneBar) === null);

  /* ---------------- واریانت‌های پیشرفته روی تصویر مصنوعی ---------------- */
  const fake = await makeJimp(200, 70, true);
  jRect(fake, 20, 15, 18, 40);
  jRect(fake, 70, 15, 18, 40);
  jRect(fake, 120, 15, 18, 40);
  const buf = await fake.getBufferAsync(Jimp.MIME_PNG);
  const variants = await advancedVariants(buf);
  test('واریانت‌های پیشرفته: حداقل ۲ واریانت تولید می‌شود', variants.length >= 2);
  test('واریانت‌ها بافر PNG معتبر و نام دارند', variants.every((v) => Buffer.isBuffer(v.buffer) && v.buffer.length > 50 && v.name));

  /* ---------------- امتیازدهی انتخاب نتیجه ---------------- */
  const good = { text: '12345', confidence: 88 };
  const bad = { text: 'AB', confidence: 88 };
  test('امتیازدهی: نتیجه رقمی با طول معتبر امتیاز بالاتری می‌گیرد', scoreResult(good) > scoreResult(bad));

  /* ---------------- حفظ provenance نامزد مدل ---------------- */
  const protoCandidate = buildModelCandidateResult({
    text: 'A1b2C',
    confidence: 93,
    variant: 'char-model',
    whitelist: 'mixed',
    engine: 'cnn',
    chars: [{ digit: 'A', conf: 99, source: 'char-cnn' }],
  }, false);
  test('نامزد مدل: variant واقعی حفظ می‌شود', !!protoCandidate && protoCandidate.variant === 'char-model');
  test('نامزد مدل: whitelist واقعی حفظ می‌شود', !!protoCandidate && protoCandidate.whitelist === 'mixed');
  test('نامزد مدل: engine و chars برای telemetry حفظ می‌شوند', !!protoCandidate && protoCandidate.engine === 'cnn' && protoCandidate.chars.length === 1);

  console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('خطای غیرمنتظره در تست:', e);
  process.exit(1);
});
