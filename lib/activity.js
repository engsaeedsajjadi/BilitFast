// -*- coding: utf-8 -*-
/**
 * lib/activity.js — گزارش فعالیت کاربران.
 *
 * قاعده حاکم بر این فایل: هیچ داده حساسی ثبت نمی‌شود. گذرواژه، مقدار کوکی
 * صفیر ریل، توکن و راز پرداخت هرگز نباید به دیسک بروند. به‌جای اعتماد به
 * فراخوان‌ها، خودِ ماژول ورودی را پالایش می‌کند (scrubMeta) — چون یک لاگِ
 * نشت‌دهنده بدتر از نبودِ لاگ است.
 *
 * از مقدار کوکی فقط «فراداده بی‌خطر» نگه می‌داریم: تعداد و نام‌ها.
 */

const db = require('./db');

const MAX_EVENTS = 5000;

/** کلیدهایی که هرگز نباید ذخیره شوند — تطبیق بر اساس نام، نه مقدار. */
const FORBIDDEN_KEY = /(pass|password|secret|token|cookie|credential|authorization|apikey|api_key|otp|pin)/i;

/** الگوهای مقداری که بوی راز می‌دهند (مثلاً یک کوکی کامل). */
const SECRET_VALUE = /(PHPSESSID|cookname|cookid)\s*=/i;

function scrubMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN_KEY.test(k)) {
      out[k] = '[حذف‌شده]';
      continue;
    }
    if (typeof v === 'string') {
      if (SECRET_VALUE.test(v)) { out[k] = '[حذف‌شده]'; continue; }
      out[k] = v.slice(0, 200);
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.length; // فقط تعداد، نه محتوا
    } else {
      out[k] = '[شیء]';
    }
  }
  return out;
}

/** فراداده بی‌خطر از فهرست کوکی — برای عیب‌یابی بدون نشت مقدار. */
function cookieMeta(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  return {
    cookieCount: list.length,
    cookieNames: list.map((c) => String(c).split('=')[0]).filter(Boolean).slice(0, 20),
    hasSessionCookie: list.some((c) => /^PHPSESSID=/i.test(String(c))),
  };
}

/**
 * ثبت یک رویداد. هرگز throw نمی‌کند — لاگ نباید مسیر اصلی را بشکند.
 * type نمونه: LOGIN، LOGOUT، SEARCH، RESERVATION_STARTED، ...
 */
function log({ userId = null, type, meta = {}, req = null } = {}) {
  try {
    if (!type) return null;
    const rec = {
      user_id: userId ? String(userId) : null,
      type: String(type).slice(0, 64),
      meta: scrubMeta(meta),
      at: Date.now(),
    };
    if (req) {
      try {
        const { getClientIp } = require('./guard');
        rec.ip = getClientIp(req);
      } catch (e) { /* بی‌اهمیت */ }
    }
    const saved = db.insert('activity_log', rec);
    prune();
    return saved;
  } catch (e) {
    return null;
  }
}

/** نگه‌داشتن اندازه لاگ در حد معقول تا db.json بی‌مهار رشد نکند. */
function prune() {
  try {
    const all = db.find('activity_log', () => true);
    if (all.length <= MAX_EVENTS) return;
    all.sort((a, b) => (a.at || 0) - (b.at || 0));
    for (const old of all.slice(0, all.length - MAX_EVENTS)) db.remove('activity_log', old.id);
  } catch (e) { /* بی‌اهمیت */ }
}

function list({ userId = null, limit = 200 } = {}) {
  const all = db.find('activity_log', (e) => (userId ? e.user_id === String(userId) : true));
  return all.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, Math.min(Number(limit) || 200, 1000));
}

module.exports = { log, list, scrubMeta, cookieMeta, MAX_EVENTS };
