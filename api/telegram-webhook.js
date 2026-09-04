// api/telegram-webhook.js — وب‌هوک ربات تلگرام برای اتصال حساب کاربر
// وقتی کاربر «کد اتصال» (BF-XXXXXX) را برای ربات بفرستد، این هندلر آن را به
// حساب کاربر متصل می‌کند و با sendMessage پاسخ می‌دهد.
const db = require('../lib/db');
const { guardApi } = require('../lib/guard');
const { telegramApi, telegramWebhookSecret, verifyConnectCode } = require('../lib/notify');
const { readJsonBody, isProductionLike } = require('../lib/http');

function header(req, name) {
  const h = (req && req.headers) || {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }
  if (!guardApi(req, res, { name: 'telegram-webhook', limit: 300, windowMs: 60000 })) return;

  try {
    const configured = telegramWebhookSecret();
    const got = String(header(req, 'x-telegram-bot-api-secret-token') || '').trim();
    if (!got || got !== configured) {
      return res.status(isProductionLike() ? 403 : 400).json({ ok: false, error: 'telegram webhook secret mismatch' });
    }
  } catch (e) {
    if (isProductionLike()) {
      return res.status(503).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  }

  const update = readJsonBody(req);
  const msg = update && update.message;
  if (!msg || !msg.chat) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const text = String(msg.text || '').trim();
  const chatId = String(msg.chat.id);

  const reply = async (t) => {
    // پاسخ سریع به تلگرام؛ ارسال پیام بهترین تلاش است (بدون شکست درخواست)
    telegramApi('sendMessage', { chat_id: chatId, text: t }).catch(() => {});
    return res.status(200).json({ ok: true });
  };

  // کد اتصال: BF-XXXXXXXXXXXX
  const m = text.match(/BF-[0-9A-Fa-f]{6,24}/);
  if (m) {
    const code = m[0].toUpperCase();
    const user = db.findOne('users', (u) => String(u.telegram_connect_code || '').toUpperCase() === code);
    if (user) {
      const vr = verifyConnectCode(user, code);
      if (!vr.ok) {
        if (/منقضی/.test(vr.error || '')) {
          db.update('users', user.id, { telegram_connect_code: '', telegram_connect_code_expires_at: 0 });
        }
        return reply('❌ ' + vr.error);
      }
      db.update('users', user.id, {
        telegram_chat_id: chatId,
        telegram_connect_code: '',
        telegram_connect_code_expires_at: 0,
      });
      return reply('✅ حساب بیلیت فست شما (' + user.username + ') به این چت متصل شد.\nاز این پس اطلاعیه‌ها (مثل پیدا شدن ظرفیت) همین‌جا ارسال می‌شود.');
    }
    return reply('❌ کد اتصال معتبر نیست یا قبلاً استفاده شده است. از صفحه «تنظیمات → اطلاع‌رسانی» کد جدید بگیرید.');
  }

  return reply('🚆 برای اتصال حساب بیلیت فست، «کد اتصال» را از صفحه تنظیمات برنامه همین‌جا ارسال کنید.');
};
