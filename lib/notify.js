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

/** ثبت وب‌هوک ربات روی این استقرار (نیاز به APP_BASE_URL دارد). */
async function setupTelegramWebhook() {
  const base = appBaseUrl();
  if (!base) return { ok: false, error: 'آدرس عمومی برنامه (APP_BASE_URL) تنظیم نشده است.' };
  return telegramApi('setWebhook', { url: base + '/api/telegram-webhook', allowed_updates: ['message'] });
}

/** ساخت کد اتصال یک‌بارمصرف برای کاربر. */
function makeConnectCode(user) {
  const code = 'BF-' + require('crypto').randomBytes(3).toString('hex').toUpperCase();
  db.update('users', user.id, { telegram_connect_code: code });
  return code;
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

module.exports = {
  telegramToken, appBaseUrl, telegramApi, setupTelegramWebhook,
  makeConnectCode, sendTelegramToUser,
  kavenegarConfigured, sendSms, notifyUser,
};
