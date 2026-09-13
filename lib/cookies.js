// -*- coding: utf-8 -*-
/**
 * lib/cookies.js — همگام‌سازی کوکی‌های Firefox با برنامه.
 *
 * معادل browser_cookie3.firefox(domain_name="safirrail.ir") در نسخه دسکتاپی.
 * کوکی‌های Firefox به‌صورت plaintext در فایل cookies.sqlite پروفایل کاربر ذخیره
 * می‌شوند؛ این ماژول آن‌ها را می‌خواند و کوکی‌های دامنه صفیر ریل را برمی‌گرداند.
 *
 * چون این کار نیاز به دسترسی فایل‌سیستم سیستم کاربر دارد، فقط در اجرای محلی
 * (dev-server.js) کار می‌کند، نه روی Vercel.
 */

const fs = require('fs');
const { readDatabase } = require('./sqlite-wal');
const trace = require('./cookie-trace');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');

// دامنه‌هایی که باید کوکی‌شان خوانده شود
const COOKIE_DOMAINS = ['safirrail.ir'];

/** مسیر پایه پروفایل‌های Firefox بر اساس سیستم‌عامل. */
function getFirefoxProfileBases() {
  const platform = os.platform();
  const bases = [];
  let base = null;

  if (platform === 'win32') {
    // e.g. C:\Users\<user>\AppData\Roaming\Mozilla\Firefox\Profiles
    if (process.env.APPDATA) {
      base = path.join(process.env.APPDATA, 'Mozilla', 'Firefox', 'Profiles');
      // نسخه‌های پرتابل/توسعه‌دهنده گاهی زیر LOCALAPPDATA هستند
      bases.push(path.join(process.env.APPDATA, 'Waterfox', 'Profiles'));
    }
  } else if (platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles');
  } else {
    // لینوکس و بقیه
    base = path.join(os.homedir(), '.mozilla', 'firefox');
  }

  if (base) bases.push(base);

  // بسته‌بندی‌های flatpak و snap در لینوکس
  if (platform === 'linux') {
    bases.push(path.join(os.homedir(), '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'));
    bases.push(path.join(os.homedir(), 'snap', 'firefox', 'common', '.mozilla', 'firefox'));
  }

  return bases;
}

/** یافتن همه فایل‌های cookies.sqlite در پروفایل‌های Firefox. */
function findCookiesFiles() {
  const files = [];
  const bases = getFirefoxProfileBases();
  for (const base of bases) {
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cookiesFile = path.join(base, entry.name, 'cookies.sqlite');
      if (fs.existsSync(cookiesFile)) {
        files.push(cookiesFile);
      }
    }
  }
  return files;
}

/**
 * خواندن کوکی‌های Firefox برای دامنه‌های صفیر ریل.
 * خروجی: آرایه‌ای از رشته‌های «name=value».
 */
async function readFirefoxCookies() {
  const SQL = await initSqlJs();
  const bases = getFirefoxProfileBases();
  trace.log('firefox', 'جستجوی پروفایل‌ها', {
    bases: bases.map(trace.safePath),
  });
  const files = findCookiesFiles();
  trace.log('firefox', 'فایل‌های کوکی پیدا شد', {
    count: files.length,
    files: files.map(trace.safePath),
  });
  if (!files.length) {
    trace.log('firefox', 'نتیجه', {
      ok: false,
      reason: 'هیچ پروفایل فایرفاکسی روی این دستگاه نیست',
    });
    return [];
  }
  const found = new Map();

  for (const file of files) {
    let db = null;
    try {
      const fsMod = require('fs');
      const hasWal = fsMod.existsSync(file + '-wal');
      let sizes = {};
      try {
        sizes.db = fsMod.statSync(file).size;
        if (hasWal) sizes.wal = fsMod.statSync(file + '-wal').size;
      } catch (e) { /* اندازه مهم نیست */ }
      trace.log('firefox', 'باز کردن فایل', {
        file: trace.safePath(file), hasWal, ...sizes,
      });
      // با WAL خوانده می‌شود: وقتی فایرفاکس باز است، کوکی تازه هنوز در
      // فایل اصلی نیست و فقط در ...-wal قرار دارد.
      const buf = readDatabase(file);
      db = new SQL.Database(buf);
      const res = db.exec('SELECT name, value, host FROM moz_cookies');
      const totalRows = (res.length && res[0].values) ? res[0].values.length : 0;
      let domainHits = 0;
      trace.log('firefox', 'خواندن جدول کوکی', { file: trace.safePath(file), totalRows });
      if (res.length && res[0].values) {
        for (const row of res[0].values) {
          const name = row[0];
          const value = row[1];
          const host = row[2];
          if (name == null || value == null) continue;
          if (COOKIE_DOMAINS.some((d) => host && host.toLowerCase().includes(d))) {
            domainHits++;
            found.set(name, name + '=' + value);
          }
        }
      }
      trace.log('firefox', 'کوکی‌های دامنه صفیر ریل', {
        file: trace.safePath(file), matched: domainHits,
      });
    } catch (e) {
      // پایگاه‌داده قفل شده یا نامعتبر — از آن رد می‌شویم
      trace.logError('firefox', 'خطا در خواندن فایل', e);
      continue;
    } finally {
      if (db) { try { db.close(); } catch (e) { /* ignore */ } }
    }
  }

  const out = Array.from(found.values());
  const names = trace.cookieNames(out);
  trace.log('firefox', 'نتیجه', {
    ok: out.length > 0,
    count: out.length,
    names,
    hasSession: names.some((n) => /^PHPSESSID$/i.test(n)),
  });
  return out;
}

module.exports = {
  readFirefoxCookies,
  findCookiesFiles,
  getFirefoxProfileBases,
};
