// api/telegram-webhook.js — وب‌هوک ربات تلگرام برای اتصال حساب کاربر
// وقتی کاربر «کد اتصال» (BF-XXXXXX) را برای ربات بفرستد، این هندلر آن را به
// حساب کاربر متصل می‌کند و با sendMessage پاسخ می‌دهد.
const db = require('../lib/db');
const { guardApi } = require('../lib/guard');
const { telegramApi } = require('../lib/notify');

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
  }
  return req.body || {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }
  if (!guardApi(req, res, { name: 'telegram-webhook', limit: 300, windowMs: 60000 })) return;

  const update = readBody(req);
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

  // کد اتصال: BF-XXXXXX
  const m = text.match(/BF-[0-9A-Fa-f]{6}/);
  if (m) {
    const code = m[0].toUpperCase();
    const user = db.findOne('users', (u) => u.telegram_connect_code === code);
    if (user) {
      db.update('users', user.id, { telegram_chat_id: chatId, telegram_connect_code: '' });
      return reply('✅ حساب بیلیت فست شما (' + user.username + ') به این چت متصل شد.\nاز این پس اطلاعیه‌ها (مثل پیدا شدن ظرفیت) همین‌جا ارسال می‌شود.');
    }
    return reply('❌ کد اتصال معتبر نیست یا قبلاً استفاده شده است. از صفحه «تنظیمات → اطلاع‌رسانی» کد جدید بگیرید.');
  }

  return reply('🚆 برای اتصال حساب بیلیت فست، «کد اتصال» را از صفحه تنظیمات برنامه همین‌جا ارسال کنید.');
};
