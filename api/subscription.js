// api/subscription.js — خرید/تأیید/وضعیت اشتراک (درگاه زرین‌پال)
// اکشن‌ها:
//   plans  → لیست طرح‌ها + وضعیت درگاه
//   create → ساخت خرید و دریافت آدرس درگاه (نیازمند نشست)
//   verify → تأیید پرداخت بعد از بازگشت از درگاه (با Authority/Status)
//   status → وضعیت اشتراک کاربرِ واردشده
const { getSessionUser } = require('../lib/auth');
const sub = require('../lib/subscription');
const { guardApi } = require('../lib/guard');
const { readJsonBody } = require('../lib/http');

function buildCallbackUrl(req) {
  const base = process.env.APP_BASE_URL ||
    ((req.headers && req.headers['x-forwarded-proto']) || 'http') + '://' + (req.headers && req.headers.host || 'localhost');
  return String(base).replace(/\/$/, '') + '/api/subscription?action=verify_return';
}

module.exports = async (req, res) => {
  const isPost = req.method === 'POST';
  const body = isPost ? readJsonBody(req) : {};
  const action = body.action || (req.query && req.query.action) || 'status';

  if (!guardApi(req, res, { name: 'subscription', limit: 60, windowMs: 60000 })) return;

  try {
    if (action === 'plans') {
      return res.status(200).json({
        ok: true,
        configured: sub.paymentConfigured(),
        sandbox: sub.isSandbox(),
        plans: sub.plans(),
      });
    }

    if (action === 'create') {
      if (!isPost) return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
      const user = getSessionUser(req, body);
      if (!user) return res.status(200).json({ ok: false, error: 'برای خرید اشتراک ابتدا وارد حساب خود شوید.' });
      const r = await sub.createCheckout(user, body.plan, buildCallbackUrl(req));
      return res.status(r.ok ? 200 : 400).json(r);
    }

    // بازگشت از درگاه (زرین‌پال با query می‌آید) — صفحه نتیجه را نشان می‌دهیم
    if (action === 'verify_return') {
      const authority = (req.query && req.query.Authority) || '';
      const status = (req.query && req.query.Status) || '';
      let html;
      if (status !== 'OK') {
        html = resultPage(false, 'پرداخت لغو شد یا ناموفق بود. اگر مبلغی کسر شده باشد، معمولاً تا ۷۲ ساعت خودکار برگشت می‌خورد.');
        return res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8' }).send(html);
      }
      const r = await sub.verifyCheckout(authority, null, null);
      html = r.ok
        ? resultPage(true, 'پرداخت با موفقیت انجام شد و اشتراک شما فعال شد. (کد پیگیری: ' + (r.ref_id || '—') + ')')
        : resultPage(false, r.error || 'تأیید پرداخت ناموفق بود.');
      return res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8' }).send(html);
    }

    // تأیید دستی از سمت کلاینت (مثلاً اگر تب بازگشت بسته شد)
    if (action === 'verify') {
      const r = await sub.verifyCheckout(body.authority, body.amount || null, body.subscription_id || null);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    if (action === 'status') {
      const user = getSessionUser(req, body);
      if (!user) return res.status(200).json({ ok: false, loggedIn: false, error: 'ابتدا وارد شوید.' });
      return res.status(200).json({ ok: true, loggedIn: true, subscription: sub.subscriptionStatus(user) });
    }

    return res.status(400).json({ ok: false, error: 'اکشن ناشناخته: ' + action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};

function resultPage(ok, message) {
  return '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>نتیجه پرداخت — Bilit Fast</title>' +
    '<style>body{font-family:Tahoma,Vazirmatn,sans-serif;background:#f4f6f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}' +
    '.card{background:#fff;border-radius:12px;padding:32px;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}' +
    '.icon{font-size:44px}.btn{display:inline-block;margin-top:18px;background:#2563eb;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px}</style></head>' +
    '<body><div class="card"><div class="icon">' + (ok ? '✅' : '❌') + '</div>' +
    '<h3>' + (ok ? 'پرداخت موفق' : 'پرداخت ناموفق') + '</h3><p>' + message + '</p>' +
    '<a class="btn" href="/trial.html">بازگشت به برنامه</a></div></body></html>';
}
