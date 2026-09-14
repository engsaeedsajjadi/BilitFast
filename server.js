// -*- coding: utf-8 -*-
/**
 * server.js — نقطه ورود تولید (Production).
 *
 * چرا جدا از dev-server.js؟
 * dev-server.js برای کار روی لپ‌تاپ نوشته شده: سخت‌گیری امنیتی را اختیاری
 * می‌گذارد تا توسعه‌دهنده بدون تنظیم کلید هم بتواند اجرا کند. این دقیقاً همان
 * چیزی است که در تولید نباید باشد. به‌جای شاخه‌بندی «اگر تولید بود» در سراسر
 * آن فایل — که راحت فراموش می‌شود — این فایل پیش از هر چیز شرایط تولید را
 * اعمال می‌کند و بعد همان سرور را بالا می‌آورد.
 *
 * کاری که اینجا انجام می‌شود و در dev انجام نمی‌شود:
 *   ۱. NODE_ENV=production و اجبار امنیتی (fail-closed روی کلیدها).
 *   ۲. اجبار حالت چندکاربره: روی سرور عمومی، «بدون ورود هم کار کند» یعنی
 *      هر کسی به موتور رزرو دسترسی دارد.
 *   ۳. بررسی پیش‌پرواز: اگر کلید یا ذخیره‌ساز پایدار نباشد، اصلاً بالا نمی‌آید.
 *   ۴. خاموشی تمیز (SIGTERM) تا کانتینر بدون قطع درخواستِ در جریان بسته شود.
 *   ۵. گزارش خطای مدیریت‌نشده بدون افشای جزئیات به کاربر.
 *
 * اجرا:  NODE_ENV=production node server.js
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.BILITFAST_ENFORCE_SECURITY = process.env.BILITFAST_ENFORCE_SECURITY || '1';
// روی سرور، ورود همیشه اجباری است مگر اینکه مدیر صریحاً خلافش را بخواهد.
if (process.env.BILITFAST_MULTIUSER === undefined) process.env.BILITFAST_MULTIUSER = '1';

const path = require('path');
const fs = require('fs');

/* ---------- بارگذاری .env (قبل از هر ماژولی که به کلید نیاز دارد) ---------- */
(function loadDotEnv() {
  for (const f of ['.env', '.env.local']) {
    const p = path.join(__dirname, f);
    if (!fs.existsSync(p)) continue;
    try {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        if (process.env[m[1]] !== undefined) continue;
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch (e) { /* نبود فایل .env خطا نیست؛ متغیرها ممکن است از محیط بیایند */ }
  }
})();

/* ---------- بررسی پیش‌پرواز ---------- */
function preflight() {
  const problems = [];

  try {
    require('./lib/secrets').assertSecureConfig();
  } catch (e) {
    problems.push('کلیدهای رمزنگاری: ' + (e && e.message ? e.message : String(e)));
  }

  try {
    require('./lib/db').assertReliableStorage();
  } catch (e) {
    problems.push('ذخیره‌سازی: ' + (e && e.message ? e.message : String(e)));
  }

  // هشدار (نه خطا): نبود ادمین یعنی هیچ‌کس نمی‌تواند کاربر تستی بسازد.
  const warnings = [];
  try {
    const accounts = require('./lib/accounts');
    if (!accounts.hasAdmin()) {
      warnings.push(
        'هیچ کاربر ادمینی وجود ندارد. یک بار POST /api/admin-users با ' +
        'action=bootstrap بزنید تا نخستین مدیر ساخته شود.'
      );
    }
  } catch (e) { /* نباید بالا آمدن را متوقف کند */ }

  if (problems.length) {
    console.error('\n✖ BilitFast در حالت تولید بالا نیامد:\n');
    for (const p of problems) console.error('  - ' + p);
    console.error('\nراهنما: docs/DEPLOYMENT.md\n');
    process.exit(1);
  }
  for (const w of warnings) console.warn('⚠ ' + w);
}

preflight();

/* ---------- بالا آوردن سرور ---------- */
// dev-server.js همان مسیریاب و هدرهای امنیتی را دارد؛ دوباره‌نویسی نمی‌کنیم.
const server = require('./dev-server.js');

console.log('BilitFast production — NODE_ENV=' + process.env.NODE_ENV +
  ' — چندکاربره=' + process.env.BILITFAST_MULTIUSER);

/* ---------- خاموشی تمیز ---------- */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('دریافت ' + signal + ' — در حال بستن تمیز سرور...');
  try {
    require('./lib/session-keeper').stop();
  } catch (e) { /* بی‌اهمیت */ }
  const done = () => process.exit(0);
  if (server && typeof server.close === 'function') {
    server.close(done);
    // اگر اتصالی آویزان ماند، بیش از ۱۰ ثانیه معطل نشویم.
    setTimeout(done, 10000).unref();
  } else {
    done();
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ---------- خطاهای مدیریت‌نشده ---------- */
process.on('unhandledRejection', (err) => {
  console.error('promise رد‌شده بدون مدیریت:', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('استثنای مدیریت‌نشده:', err && err.stack ? err.stack : err);
  shutdown('uncaughtException');
});
