// api/telegram-webhook.js — وب‌هوک ربات تلگرام برای اتصال حساب کاربر
// وقتی کاربر «کد اتصال» (BF-XXXXXX) را برای ربات بفرستد، این هندلر آن را به
// حساب کاربر متصل می‌کند و با sendMessage پاسخ می‌دهد.
const db = require('../lib/db');
const { guardApi } = require('../lib/guard');
const monitor = require('../lib/monitor');
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

  // فرمان‌های کنترلی ربات (کاربر باید قبلاً حسابش را با کد اتصال وصل کرده باشد)
  const linkedUser = db.findOne('users', (u) => String(u.telegram_chat_id || '') === chatId);
  const cmd = text.split(/\s+/)[0].replace(/@.*$/, '').toLowerCase();
  if (linkedUser && (cmd === '/stop' || cmd === '/status' || cmd === '/results' || cmd === '/help' || cmd === '/start')) {
    if (cmd === '/stop') {
      monitor.stopAllForUser(linkedUser.id);
      return reply('⏹ همه پایشگرهای سمت سرور حساب شما متوقف شدند. پایش درون مرورگر همچنان فعال می‌ماند.');
    }
    if (cmd === '/status' || cmd === '/results') {
      return reply('📊 وضعیت پایشگرهای شما:\n' + monitor.userMonitorSummary(linkedUser.id));
    }
    if (cmd === '/help') {
      return reply('فرمان‌ها:\n/status — وضعیت پایشگرها\n/stop — توقف همه پایشگرهای سرور\nبرای اتصال حساب، کد BF-XXXXXX را از صفحه تنظیمات بفرستید.');
    }
    // /start: اگر فقط همین است و حساب وصل است، راهنما بده
    return reply('به ربات بیلیت فست خوش آمدید.\n/status — وضعیت پایشگرها\n/stop — توقف پایشگرهای سرور\nبرای اتصال، کد اتصال BF-XXXXXX را بفرستید.');
  }

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
