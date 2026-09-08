// -*- coding: utf-8 -*-
/**
 * lib/db.js — لایه ذخیره‌سازی سبک برای حساب‌های کاربری، اشتراک‌ها، رزروها
 * و تنظیمات اطلاع‌رسانی.
 *
 * طراحی: یک فایل JSON (data/db.json) با کش درون‌حافظه‌ای و نوشتن اتمیک
 * (tmp + rename). برای اجرای محلی (dev-server) و استقرار تک‌نمونه مناسب است.
 *
 * دو حالت اجرا:
 *   ۱) فایل محلی (پیش‌فرض) — برای اجرای تک‌نمونه روی کامپیوتر کاربر یا VM.
 *   ۲) ذخیره‌ساز مشترک (lib/db-remote.js) — اگر متغیرهای KV/Upstash تنظیم
 *      باشند، داده روی Redis مشترک نگه داشته می‌شود تا چند instance سرورلس
 *      حساب/رزرو/کوکی یکسان ببینند.
 *
 * ⚠️ اگر روی Vercel (یا هر محیط چندنمونه‌ای) بدون ذخیره‌ساز مشترک اجرا شود،
 * داده‌ها بین instanceها مشترک نیستند و با هر deploy از بین می‌روند. در این
 * حالت برنامه هشدار صریح می‌دهد (storageWarning) و در حالت سخت‌گیرانه
 * (BILITFAST_ENFORCE_SECURITY=1) اصلاً بالا نمی‌آید.
 */

const fs = require('fs');
const path = require('path');
const remote = require('./db-remote');

function resolveDataDir() {
  if (process.env.BILITFAST_DATA_DIR) return process.env.BILITFAST_DATA_DIR;
  if (process.env.VERCEL) return '/tmp/bilitfast-data';
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = { users: [], subscriptions: [], bookings: [], captcha_samples: [], captcha_captures: [], cookie_sync: [] };

let cache = null;
let writeQueue = Promise.resolve();
let remoteLoaded = false;
let lastRemoteSync = 0;

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function load() {
  if (cache) {
    // تازه‌سازی دوره‌ای از ذخیره‌ساز مشترک (چند instance سرورلس)
    if (remote.isConfigured() && Date.now() - lastRemoteSync > remote.REFRESH_MS) {
      lastRemoteSync = Date.now();
      remote.readAll().then((doc) => {
        if (doc && typeof doc === 'object') {
          for (const k of Object.keys(EMPTY)) {
            if (Array.isArray(doc[k])) cache[k] = doc[k];
          }
        }
      }).catch(() => {});
    }
    return cache;
  }
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
  // نوشتن هم‌زمان روی ذخیره‌ساز مشترک (در صورت پیکربندی)
  if (remote.isConfigured()) {
    remote.writeAll(cache).catch((e) => {
      console.error('[db] نوشتن روی ذخیره‌ساز مشترک ناموفق بود:', e && e.message ? e.message : e);
    });
  }
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

/**
 * وضعیت ذخیره‌سازی برای نمایش به مدیر سیستم و بررسی سلامت استقرار.
 * روی محیط چندنمونه‌ای بدون ذخیره‌ساز مشترک، هشدار صریح تولید می‌کند.
 */
function storageStatus() {
  const serverless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.FUNCTIONS_WORKER_RUNTIME);
  const shared = remote.isConfigured();
  const writable = isPersistent();
  const warnings = [];
  if (serverless && !shared) {
    warnings.push(
      'این استقرار سرورلس است ولی ذخیره‌ساز مشترک تنظیم نشده؛ داده‌ها بین ' +
      'instanceها مشترک نیستند و با هر deploy از بین می‌روند. ' +
      'KV_REST_API_URL/KV_REST_API_TOKEN (یا UPSTASH_*) را تنظیم کنید.',
    );
  }
  if (!writable && !shared) {
    warnings.push('مسیر داده قابل نوشتن نیست و ذخیره‌ساز مشترکی هم تنظیم نشده است.');
  }
  return {
    mode: shared ? 'shared-kv' : (serverless ? 'ephemeral-tmp' : 'local-file'),
    shared, serverless, writable, dataDir: DATA_DIR, warnings,
    reliable: shared || (!serverless && writable),
  };
}

/**
 * در حالت سخت‌گیرانه (تولید)، استقرار ناپایدار باید جلوی بالا آمدن را بگیرد
 * تا داده کاربران بی‌صدا گم نشود.
 */
function assertReliableStorage() {
  const st = storageStatus();
  if (!st.reliable) {
    const msg = 'ذخیره‌سازی پایدار نیست:\n - ' + st.warnings.join('\n - ');
    if (process.env.BILITFAST_ENFORCE_SECURITY === '1' || process.env.NODE_ENV === 'production') {
      throw new Error(msg);
    }
    console.warn('[db] ⚠️ ' + msg);
  }
  return st;
}

module.exports = {
  insert, update, findById, findOne, find, remove,
  isPersistent, DATA_DIR, storageStatus, assertReliableStorage,
  remote,
};
