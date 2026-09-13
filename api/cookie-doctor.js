// -*- coding: utf-8 -*-
/**
 * api/cookie-doctor.js — «چرا خواندن خودکار کوکی کار نمی‌کند؟»
 *
 * چرا لازم شد: کاربر می‌گفت فقط چسباندن دستی کوکی جواب می‌دهد و بقیه
 * روش‌ها نه. اما «کار نمی‌کند» ده علت مختلف دارد: مرورگر پشتیبانی‌نشده،
 * پروفایل در مسیر غیرمعمول، کاربر در مرورگر وارد نشده، رمزنگاری جدید
 * کروم، یا دسترسی فایل. بدون تشخیص، هر اصلاحی حدس است.
 *
 * این endpoint وضعیت واقعی همین دستگاه را گزارش می‌کند — بدون اینکه هیچ
 * مقدار کوکی یا داده حساسی را برگرداند. فقط «چه چیزی هست و چه چیزی نیست».
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { guardApi, getClientIp } = require('../lib/guard');

function isLocalRequest(req) {
  const ip = String(getClientIp(req) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

/** آیا این مسیر وجود دارد؟ (بدون افشای محتوا) */
function exists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

module.exports = async (req, res) => {
  if (!guardApi(req, res, { name: 'cookie-doctor', limit: 20, windowMs: 60000 })) return;

  // این تشخیص فقط روی اجرای محلی معنا دارد و نباید از اینترنت قابل صدا زدن باشد.
  if (!isLocalRequest(req)) {
    res.status(403).json({
      ok: false,
      error: 'این بررسی فقط روی اجرای محلی در دسترس است.',
    });
    return;
  }

  const report = {
    ok: true,
    platform: os.platform(),
    browsers: [],
    findings: [],
    advice: [],
  };

  /* ---- فایرفاکس ---- */
  try {
    const { findCookiesFiles, readFirefoxCookies } = require('../lib/cookies');
    const files = typeof findCookiesFiles === 'function' ? findCookiesFiles() : [];
    const entry = { name: 'Firefox', profiles: files.length, cookies: 0, session: false };
    if (files.length) {
      // آیا فایل WAL همراهش هست؟ (یعنی مرورگر باز است)
      entry.walPresent = files.some((f) => exists(f + '-wal'));
      try {
        const c = await readFirefoxCookies();
        entry.cookies = c.length;
        entry.session = c.some((x) => /^PHPSESSID=/i.test(String(x)));
      } catch (e) {
        entry.error = (e && e.message) || String(e);
      }
    }
    report.browsers.push(entry);
  } catch (e) {
    report.browsers.push({ name: 'Firefox', error: (e && e.message) || String(e) });
  }

  /* ---- مرورگرهای مبتنی بر کرومیوم ---- */
  try {
    const { getChromeCookiePaths, readChromeCookies } = require('../lib/chrome-cookies');
    const files = typeof getChromeCookiePaths === 'function' ? getChromeCookiePaths() : [];
    const entry = { name: 'Chrome/Edge/Brave', profiles: files.length, cookies: 0, session: false };
    if (files.length) {
      entry.walPresent = files.some((f) => exists(f + '-wal'));
      try {
        const c = await readChromeCookies();
        entry.cookies = c.length;
        entry.session = c.some((x) => /^PHPSESSID=/i.test(String(x)));
      } catch (e) {
        entry.error = (e && e.message) || String(e);
        entry.errorCode = e && e.code;
      }
    }
    report.browsers.push(entry);
  } catch (e) {
    report.browsers.push({ name: 'Chrome/Edge/Brave', error: (e && e.message) || String(e) });
  }

  /* ---- نتیجه‌گیری قابل‌فهم ---- */
  const anyProfile = report.browsers.some((b) => (b.profiles || 0) > 0);
  const anySession = report.browsers.some((b) => b.session);
  const anyCookie = report.browsers.some((b) => (b.cookies || 0) > 0);
  const appBound = report.browsers.some((b) => b.errorCode === 'CHROME_APP_BOUND');

  if (anySession) {
    report.findings.push('کوکی نشست صفیر ریل روی این دستگاه پیدا شد.');
    report.advice.push('همه‌چیز آماده است — دکمه «اتصال به صفیر ریل» باید کار کند.');
  } else if (!anyProfile) {
    report.findings.push('هیچ پروفایل مرورگری روی این دستگاه پیدا نشد.');
    report.advice.push(
      'یعنی برنامه روی دستگاهی اجرا می‌شود که مرورگر شما آنجا نیست ' +
      '(مثلاً سرور یا ماشین مجازی). در این حالت روش افزونه مرورگر یا ' +
      'چسباندن دستی کوکی تنها راه است.');
  } else if (appBound) {
    report.findings.push('کروم/اج نسخه جدید از رمزنگاری App-Bound استفاده می‌کند.');
    report.advice.push(
      'کوکی‌های کروم از بیرون قابل خواندن نیستند. با فایرفاکس وارد ' +
      'safirrail.ir شوید — فایرفاکس این محدودیت را ندارد.');
  } else if (!anyCookie) {
    report.findings.push('پروفایل مرورگر پیدا شد، ولی هیچ کوکی‌ای برای safirrail.ir نداشت.');
    report.advice.push(
      'یعنی در این مرورگرها تا حالا وارد سایت نشده‌اید. در همان فایرفاکس یا ' +
      'کروم وارد safirrail.ir شوید، سپس دوباره تلاش کنید.');
  } else {
    report.findings.push('کوکی صفیر ریل پیدا شد، ولی کوکی نشست (ورود) بینشان نبود.');
    report.advice.push(
      'یعنی سایت را باز کرده‌اید ولی وارد حساب نشده‌اید، یا نشست منقضی شده. ' +
      'در مرورگر وارد حساب صفیر ریل شوید و دوباره تلاش کنید.');
  }

  res.status(200).json(report);
};
