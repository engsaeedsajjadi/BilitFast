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
    }
  } else if (platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles');
  } else {
    // لینوکس و بقیه
    base = path.join(os.homedir(), '.mozilla', 'firefox');
  }

  if (base) bases.push(base);

  // پوشه «flatpak» یا snap در لینوکس (اختیاری)
  if (platform === 'linux') {
    bases.push(path.join(os.homedir(), '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'));
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
  const files = findCookiesFiles();
  const found = new Map();

  for (const file of files) {
    let db = null;
    try {
      const buf = fs.readFileSync(file);
      db = new SQL.Database(buf);
      const res = db.exec('SELECT name, value, host FROM moz_cookies');
      if (res.length && res[0].values) {
        for (const row of res[0].values) {
          const name = row[0];
          const value = row[1];
          const host = row[2];
          if (name == null || value == null) continue;
          if (COOKIE_DOMAINS.some((d) => host && host.toLowerCase().includes(d))) {
            found.set(name, name + '=' + value);
          }
        }
      }
    } catch (e) {
      // پایگاه‌داده قفل شده یا نامعتبر — از آن رد می‌شویم
      continue;
    } finally {
      if (db) { try { db.close(); } catch (e) { /* ignore */ } }
    }
  }

  return Array.from(found.values());
}

module.exports = {
  readFirefoxCookies,
  findCookiesFiles,
  getFirefoxProfileBases,
};
