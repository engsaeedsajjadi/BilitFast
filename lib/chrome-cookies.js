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

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) bases.push(path.join(localAppData, 'Google', 'Chrome', 'User Data'));
  } else if (platform === 'darwin') {
    bases.push(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'));
  } else {
    bases.push(path.join(home, '.config', 'google-chrome'));
    bases.push(path.join(home, '.config', 'chromium'));
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
    const ps = "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('" + blobB64 + "'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))";
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
    return Buffer.from(out, 'base64');
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

  if (platform === 'win32') {
    key = windowsKey();
    mode = 'gcm';
  } else if (platform === 'darwin') {
    key = macKey();
    mode = 'cbc';
  } else {
    key = peanutsKey();
    mode = 'cbc';
  }

  if (!key) return [];

  const found = new Map();

  for (const file of files) {
    let db = null;
    try {
      const buf = fs.readFileSync(file);
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
          const value = mode === 'gcm' ? decryptGcm(valueBuf, key) : decryptCbc(valueBuf, key);
          if (value) found.set(String(name), String(name) + '=' + value);
        }
      }
    } catch (e) {
      continue;
    } finally {
      if (db) { try { db.close(); } catch (e) { /* ignore */ } }
    }
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
