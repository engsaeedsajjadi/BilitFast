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
 */
async function ensureCookies(cookies) {
  if (hasSession(cookies)) return { cookies, recovered: false };
  try {
    const keeper = require('./session-keeper');
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
