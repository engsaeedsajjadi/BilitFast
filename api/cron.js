// api/cron.js — نقطه ورود Cron Job واقعی برای پایش سمت سرور.
//
// چرا؟ تایمرهای درون‌پردازشی (lib/monitor.js) وقتی قابل اتکا هستند که
// پروسه دائماً روشن بماند. اگر برنامه را گاهی می‌بندید یا می‌خواهید پایش
// مستقل از باز بودن پنجره انجام شود، یک زمان‌بند بیرونی این مسیر را صدا
// می‌زند:
//
//   • Task Scheduler ویندوز → یک تسک دوره‌ای که این آدرس را صدا می‌زند
//   • systemd timer یا cron در لینوکس/مک
//   • سرویس‌هایی مثل cron-job.org (اگر برنامه از بیرون در دسترس باشد)
//
// امنیت: بدون راز درست، درخواست رد می‌شود تا کسی نتواند با فراخوانی مکرر
// به سایت صفیر فشار بیاورد.
//   Authorization: Bearer <BILITFAST_CRON_SECRET>
//   یا هدر x-cron-secret، یا ?secret= در کوئری

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

  /* نکته امنیتی: قبلاً وجود هدر x-vercel-cron به‌تنهایی مجوز کامل می‌داد،
   * چون فرض بر این بود که فقط لبه Vercel می‌تواند آن را بگذارد. حالا که
   * برنامه روی سرور خودمان اجرا می‌شود، چنین لبه‌ای وجود ندارد و هر کسی
   * می‌تواند آن هدر را جعل کند. پس حذف شد و تنها راه، دانستن راز است. */

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
