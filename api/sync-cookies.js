// api/sync-cookies.js — همگام‌سازی کوکی‌ها از مرورگر (Firefox و Chrome)
// پارامتر اختیاری ?source=firefox|chrome|all (پیش‌فرض: all)
// توجه: این قابلیت فقط در اجرای محلی (دسترسی به فایل‌سیستم کاربر) کار می‌کند.
const { readFirefoxCookies } = require('../lib/cookies');
const { readChromeCookies } = require('../lib/chrome-cookies');
const { guardApi, getClientIp } = require('../lib/guard');
const trace = require('../lib/cookie-trace');

/**
 * این endpoint کوکی واقعی مرورگرِ دستگاهی که سرور رویش اجراست را برمی‌گرداند.
 * روی یک نصب شخصی بی‌خطر است (همان کاربر، همان دستگاه)، ولی روی سرور مشترک
 * فاجعه است: هر کاربری می‌توانست کوکی نشستِ مرورگرِ سرور را تحویل بگیرد.
 * پس دو شرط گذاشته می‌شود: درخواست باید محلی باشد، و در نصب چندکاربره باید
 * کاربر واردشده باشد.
 */
function isLocalRequest(req) {
  const ip = String(getClientIp(req) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

module.exports = async (req, res) => {
  if (!guardApi(req, res, { name: 'sync-cookies', limit: 10, windowMs: 60000 })) return;

  if (!isLocalRequest(req)) {
    res.status(403).json({
      ok: false,
      error: 'خواندن کوکی مرورگر فقط روی اجرای محلی در دسترس است. ' +
        'برای انتقال کوکی از دستگاه خودتان، از افزونه مرورگر استفاده کنید.',
    });
    return;
  }

  /* حتی روی درخواست محلی، اگر نصب چندکاربره باشد باید کاربر مشخص باشد —
   * وگرنه روی سروری که کاربران از طریق پروکسی محلی به آن می‌رسند، این مسیر
   * باز می‌ماند. */
  const body = (typeof req.body === 'string') ? (() => {
    try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
  })() : (req.body || {});
  const { requireUser } = require('../lib/apiauth');
  const auth = requireUser(req, res, body);
  if (!auth.ok) return;

  const source = (req.query && req.query.source) || 'all';
  trace.clear(); // هر بار فشردن دکمه، یک تشخیص تازه
  trace.log('sync', 'شروع همگام‌سازی', { source });
  try {
    const all = [];
    const notes = [];

    if (source === 'all' || source === 'firefox') {
      all.push(...(await readFirefoxCookies()));
    }
    if (source === 'all' || source === 'chrome') {
      try {
        all.push(...(await readChromeCookies()));
      } catch (e) {
        // اگر Chrome در دسترس نبود (مثلاً کلید ویندوز)، فقط یادداشت ثبت می‌کنیم
        // تا Firefox (در صورت وجود) همچنان برگردانده شود.
        notes.push(e && e.message ? e.message : String(e));
      }
    }

    // حذف تکراری‌ها (بر اساس نام کوکی)
    const seen = new Map();
    for (const c of all) {
      const name = c.split('=')[0];
      if (!seen.has(name)) seen.set(name, c);
    }
    const cookies = Array.from(seen.values());

    if (!cookies.length) {
      res.status(200).json({
        ok: false,
        trace: trace.getEntries(),
        error: 'کوکی safirrail.ir یافت نشد. ابتدا در مرورگر (Firefox یا Chrome) وارد سایت صفیر ریل شوید و سپس دوباره همگام‌سازی کنید.' +
          (notes.length ? ' نکته: ' + notes.join(' ') : ''),
      });
      return;
    }

    /* مهم: «چند کوکی پیدا شد» با «نشست منتقل شد» یکی نیست.
     *
     * باگی که رفع شد: اگر کاربر در مرورگر وارد صفیر ریل نشده بود، باز هم
     * کوکی‌های عمومی سایت (مثل _ga یا cookieconsent) پیدا می‌شد و این
     * endpoint با ok:true برمی‌گشت. رابط کاربری پیام «✅ N کوکی همگام‌سازی
     * و ذخیره شد» نشان می‌داد، ولی هیچ نشست فعالی منتقل نشده بود و جستجو
     * همچنان «موجودی صفر» می‌داد. یعنی پیام موفقیت، دروغ بود.
     *
     * حالا بدون PHPSESSID شکست صریح گزارش می‌شود. */
    const hasSession = cookies.some((c) => /^PHPSESSID=/i.test(String(c)));
    trace.log('sync', 'جمع‌بندی', {
      total: cookies.length,
      names: trace.cookieNames(cookies),
      hasSession,
    });
    if (!hasSession) {
      res.status(200).json({
        ok: false,
        noSession: true,
        found: cookies.length,
        trace: trace.getEntries(),
        error: cookies.length + ' کوکی از مرورگر خوانده شد، اما کوکی نشست (ورود) بین آن‌ها نبود. ' +
          'یعنی در همان مرورگر وارد حساب safirrail.ir نشده‌اید یا نشست‌تان منقضی شده است. ' +
          'ابتدا در مرورگر وارد سایت شوید، سپس دوباره این دکمه را بزنید.' +
          (notes.length ? ' نکته: ' + notes.join(' ') : ''),
      });
      return;
    }

    res.status(200).json({
      ok: true, cookies, count: cookies.length,
      hasSession: true,
      notes: notes.length ? notes : undefined,
      trace: trace.getEntries(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
};
