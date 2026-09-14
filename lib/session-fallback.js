// -*- coding: utf-8 -*-
/**
 * lib/session-fallback.js — تور ایمنی برای «کوکی نشست به سرور نرسید».
 *
 * چرا لازم است: کوکی صفیر ریل در sessionStorage مرورگر نگهداری می‌شود (عمدی،
 * چون هر تب باید جدا باشد). ولی این یعنی هر اتفاقی که آن را خالی کند —
 * باز شدن تب تازه، رفرش سخت، بازیابی نشستِ ناتمام — باعث می‌شود payload
 * جستجو/رزرو با cookies خالی به سرور برسد. نتیجه برای کاربر گیج‌کننده است:
 * جستجو موفق گزارش می‌شود ولی «موجودی همه صفر» است، چون سایت به مهمانِ
 * واردنشده ظرفیت نشان نمی‌دهد.
 *
 * راه‌حل: اگر کلاینت کوکی نفرستاد، سرور یک بار خودش تلاش می‌کند نشست را از
 * اعتبارنامهٔ ذخیره‌شدهٔ محلی بسازد. این کار بی‌صداست و هیچ مسیر موفقی را
 * تغییر نمی‌دهد — فقط جای دست خالی، نشست معتبر می‌گذارد.
 */

function hasSession(list) {
  return Array.isArray(list) && list.some((c) => /^PHPSESSID=/i.test(String(c)));
}

/**
 * کوکی‌های ورودی را برمی‌گرداند؛ و اگر نشست نداشت، تلاش می‌کند یکی بسازد.
 * هرگز throw نمی‌کند — در بدترین حالت همان ورودی برمی‌گردد.
 *
 * پارامتر دوم user حیاتی است و نباید حذف شود:
 * وقتی کاربر واردشده داریم، بازیابی *فقط* از اعتبارنامه خودِ همان کاربر انجام
 * می‌شود. پیش از این همیشه سراغ اعتبارنامه محلیِ سراسری می‌رفت؛ یعنی روی یک
 * نصب چندکاربره، کاربری که کوکی نفرستاده بود می‌توانست با نشست صفیرِ شخص
 * دیگری جستجو یا رزرو کند. مسیر محلی فقط وقتی مجاز است که هیچ کاربری در کار
 * نباشد (نصب تک‌کاربره روی دستگاه شخصی).
 */
async function ensureCookies(cookies, user) {
  if (hasSession(cookies)) return { cookies, recovered: false };
  try {
    const keeper = require('./session-keeper');

    if (user && user.id) {
      // مسیر چندکاربره: فقط اعتبارنامه همین کاربر.
      if (!user.safir_credentials) {
        return { cookies: cookies || [], recovered: false };
      }
      const r = await keeper.refreshUserSession(user.id);
      if (r && r.ok && hasSession(r.cookies)) {
        return { cookies: r.cookies, recovered: true };
      }
      return { cookies: cookies || [], recovered: false };
    }

    // مسیر تک‌کاربره محلی: فقط وقتی هیچ حساب کاربری‌ای درگیر نیست.
    if (typeof keeper.isLocalMode !== 'function' || !keeper.isLocalMode()) {
      return { cookies: cookies || [], recovered: false };
    }
    if (typeof keeper.hasLocalCredentials !== 'function' || !keeper.hasLocalCredentials()) {
      return { cookies: cookies || [], recovered: false };
    }
    const r = await keeper.refreshLocalSession();
    if (r && r.ok && hasSession(r.cookies)) {
      return { cookies: r.cookies, recovered: true };
    }
  } catch (e) { /* تور ایمنی هرگز نباید مسیر اصلی را بشکند */ }
  return { cookies: cookies || [], recovered: false };
}

module.exports = { ensureCookies, hasSession };
