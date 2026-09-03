// api/notify.js — تنظیمات و ارسال اطلاع‌رسانی
// اکشن‌ها:
//   send          → ارسال اطلاعیه (مثلاً «ظرفیت پیدا شد») به کانال‌های کاربر
//   connect-code  → ساخت کد اتصال تلگرام (کاربر آن را برای ربات می‌فرستد)
//   setup-webhook → ثبت وب‌هوک ربات روی این استقرار (نیازمند دسترسی مدیریت)
const { getSessionUser } = require('../lib/auth');
const { guardApi } = require('../lib/guard');
const notify = require('../lib/notify');
const db = require('../lib/db');

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
  if (!guardApi(req, res, { name: 'notify', limit: 60, windowMs: 60000 })) return;

  const body = readBody(req);
  const action = body.action || 'send';
  const user = getSessionUser(req, body);
  if (!user) {
    return res.status(200).json({ ok: false, loggedIn: false, error: 'ابتدا وارد حساب خود شوید.' });
  }

  try {
    if (action === 'send') {
      const type = body.type || 'info';
      let text = String(body.text || '').slice(0, 500);
      if (!text) {
        if (type === 'capacity_found') {
          const b = body.data || {};
          text = '🚆 بیلیت فست: ظرفیت پیدا شد!\n' +
            'مسیر: ' + (b.from || '؟') + ' ← ' + (b.to || '؟') + ' — ' + (b.date || '') + '\n' +
            (b.trains_count ? b.trains_count + ' قطار با ظرفیت کافی یافت شد.' : '') +
            '\nبرای رزرو، صفحه جستجو را باز کنید.';
        } else {
          text = '🚆 بیلیت فست: اطلاعیه جدید';
        }
      }
      const r = await notify.notifyUser(user, text);
      return res.status(200).json({ ok: true, delivered: r.ok, results: r.results });
    }

    if (action === 'connect-code') {
      if (!notify.telegramToken()) {
        return res.status(200).json({ ok: false, error: 'ربات تلگرام روی این استقرار پیکربندی نشده است (TELEGRAM_BOT_TOKEN).' });
      }
      const code = notify.makeConnectCode(user);
      return res.status(200).json({
        ok: true,
        code,
        hint: 'این کد را در چت با ربات تلگرام ما ارسال کنید تا حساب شما متصل شود.',
      });
    }

    if (action === 'setup-webhook') {
      const r = await notify.setupTelegramWebhook();
      return res.status(r.ok ? 200 : 400).json(r);
    }

    return res.status(400).json({ ok: false, error: 'اکشن ناشناخته: ' + action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
