// api/learn.js — حلقه یادگیری مدل کپچا.
//
// وقتی کاربر (دستی یا با OCR) کپچایی را حل می‌کند و سرورِ صفیر ریل آن را
// می‌پذیرد (یعنی رزرو از مرحله کپچا عبور می‌کند)، کلاینت تصویر + متن همان
// کپچا را اینجا می‌فرستد. این‌ها نمونه‌های «برچسب‌خورده واقعی» هستند که با
// train/retrain.js برای بازآموزی مدل استفاده می‌شوند.
//
// نیازی به ورود نیست (یادگیری مهم‌تر از حساب است) اما در صورت وجود، ثبت می‌شود.

const db = require('../lib/db');
const { guardApi } = require('../lib/guard');
const { getSessionUser } = require('../lib/auth');

const MAX_SAMPLES = 500;      // سقف نگهداری نمونه (مدل با چند صد نمونه هم بهتر می‌شود)
const MAX_IMAGE_CHARS = 200000; // ≈150KB تصویر base64

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
  }
  return req.body || {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'learn', limit: 20, windowMs: 60000 })) return;

  const body = readBody(req);
  const action = body.action || 'captcha-sample';

  try {
    if (action === 'captcha-sample') {
      const image = String(body.image || '');
      const text = String(body.text || '').trim();
      const source = body.source === 'ocr' ? 'ocr' : 'manual';

      if (!/^data:image\//i.test(image) || image.length > MAX_IMAGE_CHARS) {
        return res.status(400).json({ ok: false, error: 'تصویر کپچا معتبر نیست.' });
      }
      if (!/^[A-Za-z0-9]{3,8}$/.test(text)) {
        return res.status(400).json({ ok: false, error: 'متن کپچا معتبر نیست.' });
      }

      // جلوگیری از ثبت تکراری (مثلاً وقتی همان کپچا قبلاً از مسیر خودکارِ
      // markOutcomeBySubmit به‌عنوان نمونه تأییدشده ثبت شده است).
      const dup = db.findOne('captcha_samples', (s) => s.text === text && s.image === image);
      if (dup) return res.status(200).json({ ok: true, duplicate: true, chars_learned: 0 });

      // استخراج بردار کاراکترها برای تطبیق نمونه‌محور (k-NN) — بهترین تلاش؛
      // اگر استخراج ممکن نبود، نمونه همچنان برای بازآموزی ذخیره می‌شود.
      let charVectors = null;
      try {
        const b64 = image.split(',')[1];
        if (b64) {
          const { extractCharVectors } = require('../lib/charlearn');
          charVectors = await extractCharVectors(Buffer.from(b64, 'base64'), text);
        }
      } catch (e) { charVectors = null; }

      const user = getSessionUser(req, body);
      db.insert('captcha_samples', {
        image, text, source,
        user_id: user ? user.id : null,
        char_vectors: charVectors,
      });

      // محدودنگه‌داشتن تعداد نمونه‌ها (حذف قدیمی‌ترین‌ها)
      const all = db.find('captcha_samples', () => true);
      if (all.length > MAX_SAMPLES) {
        const sorted = [...all].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        for (const old of sorted.slice(0, all.length - MAX_SAMPLES)) db.remove('captcha_samples', old.id);
      }

      return res.status(200).json({ ok: true, chars_learned: charVectors ? charVectors.length : 0 });
    }

    if (action === 'stats') {
      const { stats: captureStats } = require('../lib/captures');
      const cs = captureStats();
      const all = db.find('captcha_samples', () => true);
      const bySource = { manual: 0, ocr: 0 };
      for (const s of all) bySource[s.source === 'ocr' ? 'ocr' : 'manual']++;
      return res.status(200).json({ ok: true, count: all.length, bySource, captures: cs });
    }

    if (action === 'captures') {
      const { listCaptures } = require('../lib/captures');
      const limit = Math.min(Math.max(parseInt(body.limit, 10) || 30, 1), 100);
      return res.status(200).json({ ok: true, captures: listCaptures(limit) });
    }

    if (action === 'label-capture') {
      const { labelCapture } = require('../lib/captures');
      const out = await labelCapture(String(body.id || ''), body.text);
      return res.status(out.ok ? 200 : 400).json(out);
    }

    if (action === 'delete-capture') {
      const ok = db.remove('captcha_captures', String(body.id || ''));
      return res.status(ok ? 200 : 404).json({ ok });
    }

    return res.status(400).json({ ok: false, error: 'اکشن ناشناخته: ' + action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
