// -*- coding: utf-8 -*-
/**
 * lib/chrome-cookies.js — خواندن کوکی‌های Google Chrome.
 *
 * کوکی‌های Chrome در فایل SQLite «Cookies» ذخیره و رمزنگاری می‌شوند. روش رمزگشایی
 * بسته به سیستم‌عامل متفاوت است:
 *   - ویندوز : کلید AES-256-GCM که خودش با DPAPI رمز شده (Local State + PowerShell)
 *   - مک     : کلید AES-128-CBC مشتق‌شده از رمز Keychain «Chrome Safe Storage»
 *   - لینوکس : کلید ثابت «peanuts» (AES-128-CBC) — حالتی که keyring تنظیم نشده باشد
 *
 * این کار فقط در اجرای محلی ممکن است (نیاز به دسترسی فایل‌سیستم و ابزارهای سیستم).
 */

const fs = require('fs');
const { readDatabase } = require('./sqlite-wal');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const initSqlJs = require('sql.js');

const COOKIE_DOMAINS = ['safirrail.ir'];

/** یافتن مسیر فایل‌های Cookies مرورگر Chrome (پروفایل Default و Profileها). */
function getChromeCookiePaths() {
  const platform = os.platform();
  const home = os.homedir();
  const bases = [];
  const files = [];

  /* همه مرورگرهای مبتنی بر کرومیوم، نه فقط کروم.
   * چرا: کاربرانی که با Edge یا Brave وارد سایت شده بودند، هیچ‌وقت کوکی‌شان
   * پیدا نمی‌شد و پیام «کوکی یافت نشد» می‌گرفتند بدون اینکه بدانند علت
   * صرفاً پشتیبانی‌نشدن مرورگرشان است. */
  if (platform === 'win32') {
    const lad = process.env.LOCALAPPDATA;
    const rad = process.env.APPDATA;
    if (lad) {
      bases.push(path.join(lad, 'Google', 'Chrome', 'User Data'));
      bases.push(path.join(lad, 'Microsoft', 'Edge', 'User Data'));
      bases.push(path.join(lad, 'BraveSoftware', 'Brave-Browser', 'User Data'));
      bases.push(path.join(lad, 'Chromium', 'User Data'));
      bases.push(path.join(lad, 'Vivaldi', 'User Data'));
    }
    if (rad) bases.push(path.join(rad, 'Opera Software', 'Opera Stable'));
  } else if (platform === 'darwin') {
    const as = path.join(home, 'Library', 'Application Support');
    bases.push(path.join(as, 'Google', 'Chrome'));
    bases.push(path.join(as, 'Microsoft Edge'));
    bases.push(path.join(as, 'BraveSoftware', 'Brave-Browser'));
    bases.push(path.join(as, 'Chromium'));
  } else {
    bases.push(path.join(home, '.config', 'google-chrome'));
    bases.push(path.join(home, '.config', 'chromium'));
    bases.push(path.join(home, '.config', 'microsoft-edge'));
    bases.push(path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'));
    bases.push(path.join(home, 'snap', 'chromium', 'common', 'chromium'));
  }

  for (const base of bases) {
    const candidates = [path.join(base, 'Default', 'Network', 'Cookies'), path.join(base, 'Default', 'Cookies')];
    for (const c of candidates) {
      if (fs.existsSync(c)) files.push(c);
    }
    // پروفایل‌های دیگر (Profile 1, Profile 2, ...)
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Profile|^Guest/i.test(entry.name)) {
          const p1 = path.join(base, entry.name, 'Network', 'Cookies');
          const p2 = path.join(base, entry.name, 'Cookies');
          if (fs.existsSync(p1)) files.push(p1);
          else if (fs.existsSync(p2)) files.push(p2);
        }
      }
    } catch (e) { /* ignore */ }
  }
  return files;
}

/** کلید «peanuts» برای لینوکس (Chrome بدون keyring). */
function peanutsKey() {
  return crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
}

/** کلید مک: رمز «Chrome Safe Storage» از Keychain + PBKDF2. */
function macKey() {
  try {
    const password = execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], { encoding: 'utf8' }).trim();
    if (!password) return null;
    return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  } catch (e) {
    return null;
  }
}

/** کلید ویندوز: خواندن encrypted_key از Local State و بازکردن با DPAPI (PowerShell). */
function windowsKey() {
  try {
    const localStatePath = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Local State');
    const ls = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
    const encKeyB64 = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
    if (!encKeyB64) return null;
    const encKey = Buffer.from(encKeyB64, 'base64');
    if (encKey.slice(0, 5).toString('ascii') !== 'DPAPI') return null;
    const blobB64 = encKey.slice(5).toString('base64');

    // نکته: قبل از استفاده از ProtectedData باید اسمبلی System.Security لود شود،
    // وگرنه خطای «Unable to find type [System.Security.Cryptography.ProtectedData]» می‌دهد.
    const ps =
      "Add-Type -AssemblyName System.Security; " +
      "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect(" +
      "[Convert]::FromBase64String('" + blobB64 + "'), $null, " +
      "[System.Security.Cryptography.DataProtectionScope]::CurrentUser))";

    // try powershell.exe (Windows PowerShell) — سپس pwsh (PowerShell Core)
    let out = null;
    try {
      out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e1) {
      try {
        out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (e2) {
        return null;
      }
    }
    if (!out) return null;
    const key = Buffer.from(out, 'base64');
    if (key.length !== 32) return null; // کلید AES-256 باید ۳۲ بایت باشد
    return key;
  } catch (e) {
    return null;
  }
}

/** رمزگشایی AES-128-CBC (لینوکس peanuts و مک). */
function decryptCbc(valueBuf, key) {
  try {
    if (valueBuf.length < 3 + 16) return null;
    const prefix = valueBuf.slice(0, 3).toString('ascii');
    if (prefix !== 'v10' && prefix !== 'v11') return null;
    const iv = valueBuf.slice(3, 19);
    const ciphertext = valueBuf.slice(19);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  } catch (e) {
    return null;
  }
}

/** رمزگشایی AES-256-GCM (ویندوز). */
function decryptGcm(valueBuf, key) {
  try {
    if (valueBuf.length < 3 + 12 + 16) return null;
    const prefix = valueBuf.slice(0, 3).toString('ascii');
    /* v20 = App-Bound Encryption که از کروم ۱۲۷ روی ویندوز معرفی شد.
     * کلید آن به خودِ فرایند کروم گره خورده و با DPAPI کاربر باز نمی‌شود،
     * پس از بیرون قابل رمزگشایی نیست. این را جداگانه علامت می‌زنیم تا
     * به‌جای «کوکی یافت نشد»، علت واقعی به کاربر گفته شود. */
    if (prefix === 'v20') {
      const e = new Error('APP_BOUND');
      e.code = 'APP_BOUND';
      throw e;
    }
    if (prefix !== 'v10' && prefix !== 'v11') return null;
    const nonce = valueBuf.slice(3, 15);
    const tag = valueBuf.slice(-16);
    const ciphertext = valueBuf.slice(15, -16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  } catch (e) {
    return null;
  }
}

/**
 * خواندن کوکی‌های Chrome برای دامنه‌های صفیر ریل.
 * خروجی: آرایه‌ای از رشته‌های «name=value».
 */
async function readChromeCookies() {
  const SQL = await initSqlJs();
  const files = getChromeCookiePaths();
  if (!files.length) return [];

  const platform = os.platform();
  let key = null;
  let mode = 'cbc'; // cbc | gcm
  let keyError = null;

  if (platform === 'win32') {
    key = windowsKey();
    mode = 'gcm';
    if (!key) keyError = 'نمی‌توان کلید رمزگشایی Chrome را از DPAPI ویندوز به دست آورد. مطمئن شوید Chrome بسته است و PowerShell در دسترس است.';
  } else if (platform === 'darwin') {
    key = macKey();
    mode = 'cbc';
    if (!key) keyError = 'نمی‌توان رمز «Chrome Safe Storage» را از Keychain خواند.';
  } else {
    key = peanutsKey();
    mode = 'cbc';
  }

  if (!key) {
    const err = new Error(keyError || 'کلید رمزگشایی Chrome در دسترس نیست.');
    err.code = 'CHROME_KEY_UNAVAILABLE';
    throw err;
  }

  const found = new Map();
  let appBound = 0;

  for (const file of files) {
    let db = null;
    try {
      // با WAL خوانده می‌شود (کروم هم از WAL استفاده می‌کند).
      const buf = readDatabase(file);
      db = new SQL.Database(buf);
      const res = db.exec('SELECT name, encrypted_value, host_key FROM cookies');
      if (res.length && res[0].values) {
        for (const row of res[0].values) {
          const name = row[0];
          const encValue = row[1]; // Uint8Array
          const hostKey = row[2];
          if (name == null || encValue == null || hostKey == null) continue;
          if (!COOKIE_DOMAINS.some((d) => String(hostKey).toLowerCase().includes(d))) continue;
          const valueBuf = Buffer.from(encValue);
          let value = null;
          try {
            value = mode === 'gcm' ? decryptGcm(valueBuf, key) : decryptCbc(valueBuf, key);
          } catch (err) {
            if (err && err.code === 'APP_BOUND') { appBound++; continue; }
            throw err;
          }
          if (value) found.set(String(name), String(name) + '=' + value);
        }
      }
    } catch (e) {
      continue;
    } finally {
      if (db) { try { db.close(); } catch (e) { /* ignore */ } }
    }
  }

  if (!found.size && appBound > 0) {
    const e = new Error(
      'کروم/اج نسخه جدید کوکی‌ها را با «App-Bound Encryption» رمز می‌کند و ' +
      'خواندن آن‌ها از بیرون مرورگر ممکن نیست. راه‌حل: از فایرفاکس استفاده کنید ' +
      'یا از روش افزونه مرورگر.');
    e.code = 'CHROME_APP_BOUND';
    throw e;
  }
  return Array.from(found.values());
}

module.exports = {
  readChromeCookies,
  getChromeCookiePaths,
  peanutsKey,
  decryptCbc,
  decryptGcm,
};
