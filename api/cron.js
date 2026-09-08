// api/cron.js — نقطه ورود Cron Job واقعی برای پایش سمت سرور.
//
// چرا؟ تایمرهای درون‌پردازشی (lib/monitor.js) فقط روی سرور دائمی قابل اتکا
// هستند. روی سرورلس (Vercel/Lambda) اجرای پس از پاسخ تضمین نمی‌شود و
// instance هر لحظه می‌تواند خاموش شود. راه درست، فراخوانی دوره‌ای از یک
// زمان‌بند بیرونی است:
//
//   • Vercel Cron  → در vercel.json مسیر /api/cron هر دقیقه صدا زده می‌شود
//   • cron-job.org یا systemd timer → GET/POST به همین آدرس
//
// امنیت: بدون راز درست، درخواست رد می‌شود تا کسی نتواند با فراخوانی مکرر
// به سایت صفیر فشار بیاورد.
//   Authorization: Bearer <BILITFAST_CRON_SECRET>
//   یا هدر x-cron-secret، یا ?secret= در کوئری
//   (Vercel Cron هدر x-vercel-cron را می‌فرستد و پذیرفته می‌شود.)

const crypto = require('crypto');
const monitor = require('../lib/monitor');

function timingEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function authorized(req) {
  const secret = process.env.BILITFAST_CRON_SECRET;
  if (!secret) return false;
  // فراخوانی رسمی زمان‌بند Vercel
  if (req.headers && req.headers['x-vercel-cron']) return true;

  const auth = String((req.headers && req.headers.authorization) || '');
  const bearer = auth.replace(/^Bearer\s+/i, '');
  if (timingEqual(bearer, secret)) return true;
  if (timingEqual((req.headers && req.headers['x-cron-secret']) || '', secret)) return true;
  try {
    const url = new URL(req.url, 'http://localhost');
    if (timingEqual(url.searchParams.get('secret') || '', secret)) return true;
  } catch (e) { /* ignore */ }
  return false;
}

module.exports = async (req, res) => {
  if (!process.env.BILITFAST_CRON_SECRET) {
    res.status(503).json({
      ok: false,
      error: 'زمان‌بند پیکربندی نشده است. متغیر BILITFAST_CRON_SECRET را تنظیم کنید.',
    });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: 'دسترسی غیرمجاز به زمان‌بند.' });
    return;
  }

  try {
    const limit = 20;
    const result = await monitor.runDueMonitors(limit);
    res.status(200).json({
      ok: true,
      ...result,
      capability: monitor.capability(),
      at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
