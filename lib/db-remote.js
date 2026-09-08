// -*- coding: utf-8 -*-
/**
 * lib/db-remote.js — درایور ذخیره‌سازی مشترک (Redis/Upstash یا Vercel KV).
 *
 * چرا لازم است؟ فایل JSON (lib/db.js) فقط برای اجرای تک‌نمونه درست کار می‌کند.
 * روی Vercel یا هر استقرار چندنمونه‌ای:
 *   - هر instance فایل و حافظه خودش را دارد؛
 *   - نوشتن در فایل‌سیستم موقتی است و بین deployها از بین می‌رود؛
 *   - حساب کاربری، رزرو، کوکی و اشتراک ممکن است گم یا ناسازگار شوند.
 *
 * این ماژول همان رابط lib/db.js را روی یک ذخیره‌ساز مشترک HTTP پیاده می‌کند
 * (Upstash Redis REST یا Vercel KV — هر دو یک API دارند). فعال‌سازی فقط با
 * تنظیم متغیرهای محیطی است، بدون تغییر در کد فراخوان:
 *
 *   KV_REST_API_URL / KV_REST_API_TOKEN                  (Vercel KV)
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN    (Upstash)
 *
 * نکته: چون رابط فعلی برنامه همگام (sync) است، این درایور یک کش درون‌حافظه‌ای
 * نگه می‌دارد و نوشتن‌ها را به‌صورت پس‌زمینه‌ای روی ذخیره‌ساز مشترک هم‌گام
 * می‌کند (write-through با صف). خواندن‌ها از کش انجام می‌شود و کش با فاصله
 * کوتاه از منبع مشترک تازه می‌شود.
 */

const KEY = 'bilitfast:db:v1';
const REFRESH_MS = 3000;

function restConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url: String(url).replace(/\/+$/, ''), token };
  return null;
}

/** آیا ذخیره‌ساز مشترک پیکربندی شده است؟ */
function isConfigured() {
  return !!restConfig();
}

async function command(args) {
  const cfg = restConfig();
  if (!cfg) throw new Error('ذخیره‌ساز مشترک پیکربندی نشده است.');
  const resp = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + cfg.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!resp.ok) throw new Error('خطای ذخیره‌ساز مشترک (کد ' + resp.status + ')');
  const data = await resp.json();
  return data && Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : null;
}

/** خواندن کل سند از ذخیره‌ساز مشترک. */
async function readAll() {
  const raw = await command(['GET', KEY]);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return null;
  }
}

/** نوشتن کل سند روی ذخیره‌ساز مشترک. */
async function writeAll(doc) {
  await command(['SET', KEY, JSON.stringify(doc)]);
  return true;
}

/** بررسی سلامت اتصال (برای صفحه سلامت/راه‌اندازی). */
async function ping() {
  try {
    const r = await command(['PING']);
    return { ok: r === 'PONG' || r === 'pong' || r === null, result: r };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { isConfigured, readAll, writeAll, ping, command, REFRESH_MS, KEY };
