// api/eitaa-webhook.js — وب‌هوک ربات ایتا برای اتصال خودکار Chat ID.
// کاربر کد اتصال BF-XXXXXX را برای ربات ایتا می‌فرستد؛ این هندلر آن را به
// حساب کاربر متصل می‌کند و پاسخ می‌دهد.
const { guardApi } = require('../lib/guard');
const notify = require('../lib/notify');

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
  if (!guardApi(req, res, { name: 'eitaa-webhook', limit: 300, windowMs: 60000 })) return;

  const update = readBody(req);
  // ساختار به‌روزرسانی ایتا مشابه تلگرام است
  const msg = update && update.message;
  const chatId = msg && (msg.chat && msg.chat.id);
  const text = String((msg && msg.text) || '').trim();

  const reply = (t) => {
    if (chatId) notify.eitaaApi('sendMessage', { chat_id: String(chatId), text }).catch(() => {});
  };

  if (!chatId) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  if (/^\/start/i.test(text) || !/BF-[0-9A-Fa-f]{6}/.test(text)) {
    reply('به ربات بیلیت فست خوش آمدید. برای اتصال حساب، «کد اتصال ایتا» را از صفحه تنظیمات برنامه همین‌جا ارسال کنید (شبیه BF-A1B2C3).');
    return res.status(200).json({ ok: true });
  }

  const r = notify.connectEitaaChat(chatId, text);
  if (r.ok) {
    reply('✅ حساب بیلیت فست (' + r.username + ') به این چت ایتا متصل شد. از این پس لینک پرداخت و اطلاعیه‌ها همین‌جا ارسال می‌شود.');
  } else if (r.type === 'invalid_code') {
    reply('❌ کد اتصال معتبر نیست یا قبلاً استفاده شده است. از صفحه تنظیمات کد تازه بگیرید.');
  } else {
    reply('کد اتصال پیدا نشد. کدی شبیه BF-XXXXXX را از صفحه تنظیمات بفرستید.');
  }
  return res.status(200).json({ ok: true });
};
