// -*- coding: utf-8 -*-
/**
 * lib/db.js — لایه ذخیره‌سازی سبک برای حساب‌های کاربری، اشتراک‌ها، رزروها
 * و تنظیمات اطلاع‌رسانی.
 *
 * طراحی: یک فایل JSON (data/db.json) با کش درون‌حافظه‌ای و نوشتن اتمیک
 * (tmp + rename). برای اجرای محلی (dev-server) و استقرار تک‌نمونه مناسب است.
 *
 * ⚠️ محدودیت‌ها و مسیر تجاری:
 *   - روی محیط‌های سرورلس چند‌نمونه‌ای، هر نمونه فایل خودش را دارد. برای تولید
 *     باید یک بک‌اند مشترک (Vercel KV / Postgres / یک سرویس HTTP) وصل شود؛
 *     تابع‌های این ماژول طوری طراحی شده‌اند که با همان رابط جایگزین شوند.
 *   - روی Vercel فایل‌سیستم برنامه فقط‌خواندنی است؛ اگر متغیر VERCEL دیده شود،
 *     مسیر داده به /tmp منتقل می‌شود (موقتی است — برای دمو/تست؛ نه تولید).
 */

const fs = require('fs');
const path = require('path');

function resolveDataDir() {
  if (process.env.BILITFAST_DATA_DIR) return process.env.BILITFAST_DATA_DIR;
  if (process.env.VERCEL) return '/tmp/bilitfast-data';
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = { users: [], subscriptions: [], bookings: [], captcha_samples: [], cookie_sync: [] };

let cache = null;
let writeQueue = Promise.resolve();

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(DB_FILE)) {
      cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    cache = null;
  }
  if (!cache || typeof cache !== 'object') cache = JSON.parse(JSON.stringify(EMPTY));
  for (const k of Object.keys(EMPTY)) {
    if (!Array.isArray(cache[k])) cache[k] = [];
  }
  return cache;
}

/** نوشتن اتمیک و سریالی‌شده (جلوگیری از خرابی فایل هنگام نوشتن هم‌زمان). */
function persist() {
  const snapshot = JSON.stringify(cache, null, 1);
  writeQueue = writeQueue.then(() => new Promise((resolve) => {
    try {
      ensureDir();
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, snapshot, 'utf8');
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('[db] خطا در ذخیره‌سازی:', e && e.message ? e.message : e);
    }
    resolve();
  }));
  return writeQueue;
}

/** آیا نوشتن روی این استقرار ممکن است؟ (برای پیام‌های واضح به کاربر) */
function isPersistent() {
  try {
    ensureDir();
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/** تولید شناسه یکتای کوتاه. */
function newId(prefix) {
  const rnd = require('crypto').randomBytes(6).toString('hex');
  return prefix + '_' + Date.now().toString(36) + rnd;
}

/* ---------------- عملیات عمومی روی مجموعه‌ها ---------------- */

function col(name) {
  const db = load();
  if (!db[name]) db[name] = [];
  return db[name];
}

function insert(collection, doc) {
  const c = col(collection);
  const rec = { id: newId(collection.slice(0, 3)), created_at: Date.now(), ...doc };
  c.push(rec);
  persist();
  return rec;
}

function update(collection, id, patch) {
  const c = col(collection);
  const rec = c.find((x) => x.id === id);
  if (!rec) return null;
  Object.assign(rec, patch, { updated_at: Date.now() });
  persist();
  return rec;
}

function findById(collection, id) {
  return col(collection).find((x) => x.id === id) || null;
}

function findOne(collection, pred) {
  return col(collection).find(pred) || null;
}

function find(collection, pred) {
  return col(collection).filter(pred);
}

function remove(collection, id) {
  const c = col(collection);
  const i = c.findIndex((x) => x.id === id);
  if (i < 0) return false;
  c.splice(i, 1);
  persist();
  return true;
}

module.exports = {
  insert, update, findById, findOne, find, remove,
  isPersistent, DATA_DIR,
};
