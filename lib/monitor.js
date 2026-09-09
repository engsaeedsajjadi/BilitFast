// lib/monitor.js — پایشگر سمت سرور: جستجوی دوره‌ای قطارها بدون نیاز به
// بازماندن مرورگر. هر پایشگر در بازه‌های زمانی مشخص (پیش‌فرض ۶۰ ثانیه روی
// سرور) جستجو می‌کند؛ به‌محض پیدا شدن ظرفیت، از طریق کانال‌های متصل کاربر
// (تلگرام/بله/ایتا) اطلاع می‌دهد. کوکی نشست از رکورد کاربر (safir_cookies)
// در هر تازه‌سازی خوانده می‌شود تا اگر کاربر کوکی جدید ایمپورت کرد، خودکار
// استفاده شود.
const db = require('./db');
const core = require('./core');
const notify = require('./notify');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const MIN_INTERVAL_MS = 15 * 1000;
const MAX_MONITORS_PER_USER = 10;
const MAX_RESULTS = 20;

// جدول زمان‌بند در حافظه (در Vercel با اسکیل‌به‌صفر تداوم ندارد، اما در
// اجرای همیشه‌روشن — مثل سرور داخل ایران یا VPS — به‌طور مداوم کار می‌کند).
const timers = new Map(); // monitorId -> NodeJS.Timeout
const running = new Map(); // monitorId -> true هنگام اجرای یک تیک

function now() { return Date.now(); }

function listUserMonitors(userId) {
  return db
    .find('server_monitors', (m) => m.user_id === userId)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

function activeUserMonitors(userId) {
  return listUserMonitors(userId).filter((m) => m.active);
}

function monitorKey(fields) {
  return [fields.from_city, fields.to_city, fields.date, fields.train_number || '', fields.gender || '']
    .join('|');
}

function startMonitor(user, { fields, passengers, prefs, intervalMs }) {
  const f = fields || {};
  if (!f.from_city || !f.to_city || !f.date) {
    return { ok: false, error: 'مبدا، مقصد و تاریخ لازم است.' };
  }
  const active = activeUserMonitors(user.id);
  if (active.length >= MAX_MONITORS_PER_USER) {
    return { ok: false, error: 'حداکثر ' + MAX_MONITORS_PER_USER + ' پایشگر همزمان مجاز است.' };
  }
  const key = monitorKey(f);
  const dup = active.find((m) => monitorKey(m.fields) === key);
  if (dup) {
    return { ok: false, error: 'همین مسیر از قبل روی سرور در حال پایش است.', monitor_id: dup.id };
  }

  const rec = db.insert('server_monitors', {
    user_id: user.id,
    username: user.username || '',
    fields: {
      from_city: String(f.from_city).slice(0, 60),
      to_city: String(f.to_city).slice(0, 60),
      date: String(f.date).slice(0, 20),
      train_number: String(f.train_number || '').slice(0, 30),
      gender: String(f.gender || 'عادی').slice(0, 20),
    },
    passengers: Array.isArray(passengers) ? passengers.slice(0, 10) : [{ quota_type: 'بزرگسال' }],
    prefs: prefs && typeof prefs === 'object' ? prefs : {},
    interval_ms: Math.max(MIN_INTERVAL_MS, parseInt(intervalMs, 10) || DEFAULT_INTERVAL_MS),
    active: true,
    results: [],
    tick_count: 0,
    last_tick_at: 0,
    last_ok_at: 0,
    last_error: '',
    created_at: now(),
  });
  schedule(rec.id, 2000); // اولین تیک ۲ ثانیه بعد
  return { ok: true, monitor_id: rec.id };
}

function stopMonitor(user, monitorId) {
  const rec = db.findById('server_monitors', monitorId);
  if (!rec || rec.user_id !== user.id) return { ok: false, error: 'پایشگر پیدا نشد.' };
  db.update('server_monitors', rec.id, { active: false, stopped_at: now() });
  const t = timers.get(rec.id);
  if (t) { clearTimeout(t); timers.delete(rec.id); }
  running.delete(rec.id);
  return { ok: true };
}

function stopAllForUser(userId) {
  for (const m of activeUserMonitors(userId)) {
    db.update('server_monitors', m.id, { active: false, stopped_at: now() });
    const t = timers.get(m.id);
    if (t) { clearTimeout(t); timers.delete(m.id); }
    running.delete(m.id);
  }
  return { ok: true };
}

function schedule(monitorId, delay) {
  const existing = timers.get(monitorId);
  if (existing) clearTimeout(existing);
  timers.set(monitorId, setTimeout(() => { tick(monitorId).catch(() => {}); }, delay));
}

async function tick(monitorId) {
  timers.delete(monitorId);
  const rec = db.findById('server_monitors', monitorId);
  if (!rec || !rec.active) return;
  if (running.has(monitorId)) { schedule(monitorId, rec.interval_ms); return; }
  running.set(monitorId, true);

  try {
    const user = db.findById('users', rec.user_id);
    const cookies = (user && Array.isArray(user.safir_cookies)) ? user.safir_cookies : [];
    let r;
    try {
      r = await core.searchOnce({
        fields: rec.fields,
        passengers: rec.passengers,
        cookies,
      });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }

    const patch = { tick_count: (rec.tick_count || 0) + 1, last_tick_at: now() };
    if (r && r.fatal) {
      // خطای دائمی (مثل بلاک IP سرور) — پایش سمت سرور بی‌فایده است؛ متوقف کن و اطلاع بده.
      patch.active = false;
      patch.last_error = r.error || 'خطای دائمی اتصال';
      patch.stopped_at = now();
      db.update('server_monitors', monitorId, patch);
      await safeNotify(user,
        '⛔ پایشگر سمت سرور متوقف شد: این سرور به سامانه صفیر ریل دسترسی ندارد. ' +
        core.networkHint());
      return;
    }
    if (r && r.ok) {
      patch.last_ok_at = now();
      patch.last_error = '';
      let trains = Array.isArray(r.trains) ? r.trains : [];
      // اعمال فیلترهای هوشمند (در صورت وجود)
      if (Object.keys(rec.prefs || {}).length && trains.length) {
        try {
          const { filterAndRankTrains } = require('./agent');
          const fr = filterAndRankTrains(trains, rec.prefs);
          trains = (fr && fr.ranked) || trains;
        } catch (e) { /* فیلتر اختیاری است */ }
      }
      if (trains.length) {
        const results = (rec.results || []).slice(0, MAX_RESULTS - 1);
        results.unshift({ at: now(), count: trains.length, sample: summarizeTrains(trains) });
        patch.results = results;
        await safeNotify(user, formatFoundMessage(rec, trains));
      }
    } else if (r && r.captchaRequired) {
      patch.last_error = 'کپچا لازم است؛ کوکی نشست باید در مرورگر حل شود.';
    } else if (r && r.error) {
      patch.last_error = String(r.error).slice(0, 300);
    }
    db.update('server_monitors', monitorId, patch);
    schedule(monitorId, rec.interval_ms);
  } finally {
    running.delete(monitorId);
  }
}

function summarizeTrains(trains) {
  return trains.slice(0, 5).map((t) => ({
    number: t['شماره قطار'] || t.train_number || '',
    time: t['ساعت حرکت'] || t['ساعت'] || '',
    price: t['قیمت'] || '',
    capacity: t['ظرفیت'] || '',
  }));
}

function formatFoundMessage(rec, trains) {
  const lines = [];
  lines.push('🚆 بیلیت فست: ظرفیت پیدا شد!');
  lines.push('مسیر: ' + rec.fields.from_city + ' ← ' + rec.fields.to_city);
  lines.push('تاریخ: ' + rec.fields.date + (rec.fields.train_number ? ' — قطار ' + rec.fields.train_number : ''));
  lines.push('تعداد قطارهای دارای ظرفیت: ' + trains.length);
  const top = summarizeTrains(trains).slice(0, 3);
  for (const t of top) {
    lines.push('• قطار ' + (t.number || '—') + ' ساعت ' + (t.time || '—') +
      (t.capacity ? ' (ظرفیت: ' + t.capacity + ')' : ''));
  }
  lines.push('برای رزرو سریع، برنامه را در مرورگر باز کنید.');
  return lines.join('\n');
}

async function safeNotify(user, text) {
  if (!user) return;
  try {
    if (user.telegram_chat_id) {
      await notify.telegramApi('sendMessage', { chat_id: user.telegram_chat_id, text, disable_web_page_preview: true });
    }
    const pn = user.payment_notify || {};
    if (pn.bale && pn.bale_chat_id) await notify.sendBaleToChat(pn.bale_chat_id, text);
    if (pn.eitaa && pn.eitaa_chat_id) await notify.sendEitaaToChat(pn.eitaa_chat_id, text);
  } catch (e) { /* بهترین تلاش */ }
}

/** خلاصه متنی وضعیت پایشگرهای کاربر (برای پاسخ در ربات). */
function userMonitorSummary(userId) {
  const list = listUserMonitors(userId);
  const active = list.filter((m) => m.active);
  if (!list.length) return 'هیچ پایشگر سمت سروری برای حساب شما ثبت نشده است.';
  const lines = [];
  lines.push('پایشگرهای فعال: ' + active.length + ' از ' + list.length);
  for (const m of active.slice(0, 10)) {
    const last = m.last_tick_at ? new Date(m.last_tick_at).toLocaleString('fa-IR') : 'هنوز اجرا نشده';
    lines.push('• ' + m.fields.from_city + ' ← ' + m.fields.to_city + ' — ' + m.fields.date +
      (m.fields.train_number ? ' (قطار ' + m.fields.train_number + ')' : '') +
      ' | تیک‌ها: ' + m.tick_count + ' | آخرین: ' + last +
      (m.last_error ? ' | ⚠️ ' + m.last_error : ''));
  }
  return lines.join('\n');
}

/**
 * آیا این محیط برای پایش تایمری مناسب است؟
 *
 * تایمرهای درون‌پردازشی فقط روی یک سرور دائمی (dev-server، VM، exe دسکتاپ)
 * قابل اتکا هستند. روی سرورلس: اجرای پس از پاسخ تضمین نمی‌شود، instance هر
 * لحظه می‌تواند خاموش شود و تایمرها بین instanceها مشترک نیستند.
 */
function isServerless() {
  return !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.FUNCTIONS_WORKER_RUNTIME);
}

/** وضعیت قابلیت اتکای پایش سمت سرور (برای نمایش صادقانه به کاربر). */
function capability() {
  const serverless = isServerless();
  const cron = !!process.env.BILITFAST_CRON_SECRET;
  return {
    supported: !serverless || cron,
    mode: serverless ? (cron ? 'cron' : 'unsupported') : 'timer',
    serverless,
    cronConfigured: cron,
    reason: serverless
      ? (cron
        ? 'پایش با Cron Job خارجی انجام می‌شود (هر فراخوانی یک دور جستجو).'
        : 'روی استقرار سرورلس، تایمر داخلی قابل اتکا نیست. برای پایش سمت سرور ' +
          'یا برنامه را روی سرور دائمی/کامپیوتر خودتان اجرا کنید، یا Cron Job ' +
          'تنظیم کرده و BILITFAST_CRON_SECRET را ست کنید.')
      : 'سرور دائمی: تایمر داخلی قابل اتکاست.',
  };
}

/**
 * یک دور پایش برای همه پایشگرهای سررسیدشده — برای فراخوانی از Cron Job
 * واقعی (Vercel Cron / cron-job.org / systemd timer). این تابع بدون تکیه بر
 * تایمر درون‌پردازشی کار می‌کند و برای محیط سرورلس مناسب است.
 */
async function runDueMonitors(limit = 20) {
  const nowMs = Date.now();
  let due = [];
  try {
    due = db.find('server_monitors', (m) => {
      if (!m || !m.active) return false;
      const last = m.last_check_ms || 0;
      return nowMs - last >= (m.interval_ms || DEFAULT_INTERVAL_MS);
    }).slice(0, limit);
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
  let processed = 0;
  for (const m of due) {
    try {
      db.update('server_monitors', m.id, { last_check_ms: Date.now() });
      await tick(m.id);
      processed++;
    } catch (e) { /* پایشگر بعدی */ }
  }
  return { ok: true, processed, due: due.length };
}

/** راه‌اندازی مجدد پایشگرهای فعال پس از بالا آمدن سرور. */
function resumeAll() {
  // روی سرورلس، تایمر راه نمی‌اندازیم؛ کار به Cron سپرده می‌شود.
  if (isServerless()) return 0;
  try {
    const active = db.find('server_monitors', (m) => m.active);
    for (const m of active) {
      if (!timers.has(m.id)) schedule(m.id, 3000 + Math.random() * 4000);
    }
    return active.length;
  } catch (e) {
    return 0;
  }
}

module.exports = {
  startMonitor, stopMonitor, stopAllForUser,
  listUserMonitors, activeUserMonitors, resumeAll, userMonitorSummary,
  capability, isServerless, runDueMonitors,
  MAX_MONITORS_PER_USER, DEFAULT_INTERVAL_MS,
};
