// -*- coding: utf-8 -*-
/**
 * lib/notify.js — اطلاع‌رسانی تلگرام و پیامک.
 *
 * تلگرام: از Bot API استفاده می‌شود (متغیر محیطی TELEGRAM_BOT_TOKEN).
 *   اتصال کاربر به دو روش:
 *   ۱) کاربر «کد اتصال» خود را برای ربات بفرستد → وب‌هوک آن را دریافت و به
 *      حساب کاربر وصل می‌کند (api/telegram-webhook.js).
 *   ۲) کاربر chat_id خودش را دستی در تنظیمات وارد کند.
 *
 * پیامک: پنل کاوه‌نگار (KAVENEGAR_API_KEY + KAVENEGAR_SENDER). اگر کلید تنظیم
 * نشده باشد، ارسال پیامک به‌صورت مؤدبانه رد می‌شود (بدون خطا در جریان اصلی).
 */

const db = require('./db');

function telegramToken() {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}
function appBaseUrl() {
  return (process.env.APP_BASE_URL || '').replace(/\/$/, '');
}

/* ---------------- تلگرام ---------------- */

async function telegramApi(method, params) {
  const token = telegramToken();
  if (!token) return { ok: false, error: 'ربات تلگرام پیکربندی نشده است (TELEGRAM_BOT_TOKEN).' };
  const url = 'https://api.telegram.org/bot' + token + '/' + method;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
    const data = await resp.json();
    if (!data.ok) return { ok: false, error: (data.description || 'خطای تلگرام') };
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}


/* ---------------- بله ---------------- */

function baleToken() {
  return (process.env.BALE_BOT_TOKEN || '').trim();
}
function baleApiBase() {
  return (process.env.BALE_API_BASE_URL || 'https://tapi.bale.ai').replace(/\/$/, '');
}

async function baleApi(method, params) {
  const token = baleToken();
  if (!token) return { ok: false, error: 'ربات بله پیکربندی نشده است (BALE_BOT_TOKEN).' };
  const url = baleApiBase() + '/bot' + token + '/' + method;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
    const data = await resp.json();
    if (!data.ok) return { ok: false, error: data.description || data.error || 'خطای بله' };
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function sendBaleToChat(chatId, text) {
  if (!chatId) return { ok: false, skipped: 'no_chat_id' };
  if (!baleToken()) return { ok: false, skipped: 'not_configured' };
  return baleApi('sendMessage', { chat_id: String(chatId), text, disable_web_page_preview: true });
}

/* ---------------- ایتا (Eitaayar) ---------------- */

function eitaaToken() {
  return (process.env.EITAA_BOT_TOKEN || '').trim();
}
function eitaaApiBase() {
  return (process.env.EITAA_API_BASE_URL || 'https://eitaayar.ir/api').replace(/\/$/, '');
}

async function eitaaApi(method, params) {
  const token = eitaaToken();
  if (!token) return { ok: false, error: 'توکن ایتایار پیکربندی نشده است (EITAA_BOT_TOKEN).' };
  const url = eitaaApiBase() + '/' + encodeURIComponent(token) + '/' + method;
  try {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) body.append(k, String(v));
    body.append('parse_mode', 'html');
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(),
    });
    const data = await resp.json();
    if (!data.ok) return { ok: false, error: data.description || data.error || 'خطای ایتا' };
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function sendEitaaToChat(chatId, text) {
  if (!chatId) return { ok: false, skipped: 'no_chat_id' };
  if (!eitaaToken()) return { ok: false, skipped: 'not_configured' };
  return eitaaApi('sendMessage', { chat_id: String(chatId), text });
}

function defaultPaymentTemplate() {
  return '🔔 لینک پرداخت بلیت\n\nمسافر: {passenger_name}\nمسیر: {origin} ← {destination}\nتاریخ: {travel_date}\nساعت: {time}\nقطار: {train_number}\nمبلغ: {amount} ریال\n\n💳 لینک پرداخت:\n{payment_url}\n\nلطفاً پرداخت را در مهلت تعیین‌شده انجام دهید.';
}

function renderPaymentMessage(template, booking, paymentUrl) {
  const b = booking || {};
  const values = {
    passenger_name: b.passenger_name || (b.passengers && b.passengers[0] && ((b.passengers[0].first_name || '') + ' ' + (b.passengers[0].last_name || '')).trim()) || '',
    origin: b.origin || '', destination: b.destination || '', travel_date: b.date || '', time: b.time || '',
    train_number: b.train_number || '', amount: b.total_price || b.ticket_price || '', payment_url: paymentUrl || '',
  };
  let out = String(template || defaultPaymentTemplate());
  for (const [k, v] of Object.entries(values)) out = out.split('{' + k + '}').join(String(v));
  return out.slice(0, 4000);
}

async function sendPaymentLinkToUser(user, booking, paymentUrl) {
  const pn = (user && user.payment_notify) || {};
  if (!paymentUrl) return { ok: false, skipped: 'no_payment_url' };
  const telegramOn = pn.enabled ? pn.telegram === true : true; // پیش‌فرض: اگر تلگرام متصل است
  const text = renderPaymentMessage(pn.template, booking, paymentUrl);
  const results = [];
  if (pn.enabled && pn.bale) results.push({ channel: 'bale', ...(await sendBaleToChat(pn.bale_chat_id, text)) });
  if (pn.enabled && pn.eitaa) results.push({ channel: 'eitaa', ...(await sendEitaaToChat(pn.eitaa_chat_id, text)) });
  // تلگرام: اگر حساب به ربات متصل است و کاربر لینک پرداخت را خواسته، ارسال می‌شود.
  if (telegramOn && user && user.telegram_chat_id) {
    results.push({ channel: 'telegram', ...(await telegramApi('sendMessage', { chat_id: user.telegram_chat_id, text, disable_web_page_preview: true })) });
  }
  if (!pn.enabled && !results.length) return { ok: false, skipped: 'disabled' };
  return { ok: results.some((r) => r.ok), results, text };
}

/** ثبت وب‌هوک ربات روی این استقرار (نیاز به APP_BASE_URL دارد). */
async function setupTelegramWebhook() {
  const base = appBaseUrl();
  if (!base) return { ok: false, error: 'آدرس عمومی برنامه (APP_BASE_URL) تنظیم نشده است.' };
  return telegramApi('setWebhook', {
    url: webhookUrl(base, 'telegram'),
    allowed_updates: ['message'],
    secret_token: webhookSecret('telegram'),
  });
}

/* ---------------- امنیت وب‌هوک و کد اتصال (3.13.4) ----------------
 * قبلاً هر کسی می‌توانست به /api/*-webhook درخواست جعلی بفرستد و کد اتصال
 * فقط ۳ بایت (۱۶.۷ میلیون حالت)، بدون انقضا و مشترک بین سه پیام‌رسان بود؛
 * با حدس کد، مهاجم چت خودش را به حساب وصل و لینک‌های پرداخت را دریافت می‌کرد.
 *  - هر کانال یک راز مشتق از کلید اصلی دارد (بدون متغیر محیطی جدید) که در
 *    آدرس وب‌هوک (?k=) و برای تلگرام در secret_token ثبت می‌شود.
 *  - کد اتصال ۶۴ بیتی، مخصوص یک کانال و با انقضای ۱۵ دقیقه است. */
const crypto = require('crypto');
const CONNECT_CODE_TTL_MS = 15 * 60 * 1000;
const CONNECT_CODE_RE = /BF-[0-9A-Fa-f]{16}\b/;

function webhookSecret(channel) {
  const key = require('./secrets').keyFor('webhook', ['BILITFAST_WEBHOOK_SECRET']);
  return crypto.createHmac('sha256', key).update('webhook:' + channel).digest('hex').slice(0, 48);
}

function webhookUrl(base, channel) {
  return String(base).replace(/\/$/, '') + '/api/' + channel + '-webhook?k=' + webhookSecret(channel);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** آیا درخواست وب‌هوک واقعاً از سرور پیام‌رسانی است که ما ثبتش کرده‌ایم؟ */
function verifyWebhook(req, channel) {
  let want;
  try { want = webhookSecret(channel); } catch (e) { return false; }
  const headers = (req && req.headers) || {};
  const header = headers['x-telegram-bot-api-secret-token'];
  const query = (req && req.query && req.query.k) || '';
  return safeEqual(header, want) || safeEqual(query, want);
}

/** ساخت کد اتصال یک‌بارمصرف، مخصوص یک کانال و با انقضا. */
function makeConnectCode(user, channel = 'telegram') {
  const code = 'BF-' + crypto.randomBytes(8).toString('hex').toUpperCase();
  db.update('users', user.id, {
    telegram_connect_code: code,
    connect_code_channel: channel,
    connect_code_exp: Date.now() + CONNECT_CODE_TTL_MS,
  });
  return code;
}

/** یافتن و مصرف کد اتصال معتبر برای این کانال؛ کد در هر حالت باطل می‌شود. */
function consumeConnectCode(text, channel) {
  const m = String(text || '').match(CONNECT_CODE_RE);
  if (!m) return { ok: false, type: 'no_code' };
  const code = m[0].toUpperCase();
  const user = db.findOne('users', (u) => u.telegram_connect_code === code);
  if (!user) return { ok: false, type: 'invalid_code' };
  const valid = (user.connect_code_channel || 'telegram') === channel &&
    Number(user.connect_code_exp) > Date.now();
  db.update('users', user.id, { telegram_connect_code: '', connect_code_channel: '', connect_code_exp: 0 });
  if (!valid) return { ok: false, type: 'invalid_code' };
  return { ok: true, user };
}

/* ---------------- بله (Webhook و تنظیم) ---------------- */

async function setupBaleWebhook(baseUrl) {
  const base = (baseUrl || appBaseUrl()).replace(/\/$/, '');
  if (!base) return { ok: false, error: 'آدرس عمومی برنامه (APP_BASE_URL) تنظیم نشده است.' };
  return baleApi('setWebhook', { url: webhookUrl(base, 'bale') });
}

/* ---------------- ایتا (Webhook و تنظیم) ---------------- */

async function setupEitaaWebhook(baseUrl) {
  const base = (baseUrl || appBaseUrl()).replace(/\/$/, '');
  if (!base) return { ok: false, error: 'آدرس عمومی برنامه (APP_BASE_URL) تنظیم نشده است.' };
  return eitaaApi('setWebhook', { url: webhookUrl(base, 'eitaa') });
}

/** اتصال حساب کاربر به چت ایتا بر اساس کد اتصال BF-…. */
function connectEitaaChat(chatId, text) {
  const c = consumeConnectCode(text, 'eitaa');
  if (!c.ok) return c;
  const user = c.user;
  const pn = Object.assign({}, user.payment_notify || {}, { enabled: true, eitaa: true, eitaa_chat_id: String(chatId) });
  db.update('users', user.id, { eitaa_chat_id: String(chatId), payment_notify: pn });
  return { ok: true, username: user.username, chatId: String(chatId) };
}

/** ارسال پیام تلگرام به کاربر (در صورت اتصال). */
async function sendTelegramToUser(user, text) {
  if (!user || !user.telegram_chat_id) return { ok: false, skipped: 'no_chat_id' };
  if (!telegramToken()) return { ok: false, skipped: 'not_configured' };
  return telegramApi('sendMessage', { chat_id: user.telegram_chat_id, text, disable_web_page_preview: true });
}

/* ---------------- پیامک (کاوه‌نگار) ---------------- */

function kavenegarConfigured() {
  return !!(process.env.KAVENEGAR_API_KEY || '').trim();
}

async function sendSms(receptor, message) {
  const key = (process.env.KAVENEGAR_API_KEY || '').trim();
  const sender = (process.env.KAVENEGAR_SENDER || '').trim();
  if (!key) return { ok: false, skipped: 'not_configured' };
  if (!/^09\d{9}$/.test(String(receptor || ''))) return { ok: false, skipped: 'bad_receptor' };
  const url = 'https://api.kavenegar.com/v1/' + key + '/sms/send.json';
  const params = new URLSearchParams();
  params.append('receptor', receptor);
  params.append('message', message);
  if (sender) params.append('sender', sender);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await resp.json();
    if (data && data.return && data.return.status === 200) return { ok: true };
    return { ok: false, error: (data && data.return && data.return.message) || 'خطای پنل پیامک' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/* ---------------- فن‌اوت به کانال‌های کاربر ---------------- */

/** ارسال یک اطلاعیه به همه کانال‌های فعال کاربر. هیچ‌وقت خطا پرتاب نمی‌کند. */
async function notifyUser(user, text, { types = ['telegram', 'sms'] } = {}) {
  const results = [];
  const notify = (user && user.notify) || {};
  try {
    if (types.includes('telegram') && notify.telegram !== false) {
      results.push({ channel: 'telegram', ...(await sendTelegramToUser(user, text)) });
    }
    if (types.includes('sms') && notify.sms && user && user.phone) {
      results.push({ channel: 'sms', ...(await sendSms(user.phone, text)) });
    }
  } catch (e) {
    results.push({ channel: 'error', ok: false, error: e && e.message ? e.message : String(e) });
  }
  return { ok: results.some((r) => r.ok), results };
}

/** اتصال حساب کاربر به چت بله بر اساس کد اتصال BF-…. */
function connectBaleChat(chatId, text) {
  const c = consumeConnectCode(text, 'bale');
  if (!c.ok) return c;
  const user = c.user;
  const pn = Object.assign({}, user.payment_notify || {}, { enabled: true, bale: true, bale_chat_id: String(chatId) });
  db.update('users', user.id, { bale_chat_id: String(chatId), payment_notify: pn });
  return { ok: true, username: user.username, chatId: String(chatId) };
}

module.exports = {
  telegramToken, appBaseUrl, telegramApi, setupTelegramWebhook, setupBaleWebhook, connectBaleChat,
  setupEitaaWebhook, connectEitaaChat,
  baleToken, baleApi, sendBaleToChat, eitaaToken, eitaaApi, sendEitaaToChat,
  defaultPaymentTemplate, renderPaymentMessage, sendPaymentLinkToUser,
  makeConnectCode, consumeConnectCode, verifyWebhook, webhookSecret, webhookUrl, CONNECT_CODE_RE,
  sendTelegramToUser,
  kavenegarConfigured, sendSms, notifyUser,
};
