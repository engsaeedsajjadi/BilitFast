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
const crypto = require('crypto');
const path = require('path');
const remote = require('./db-remote');

function resolveDataDir() {
  if (process.env.BILITFAST_DATA_DIR) return process.env.BILITFAST_DATA_DIR;
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = { users: [], subscriptions: [], bookings: [], captcha_samples: [], captcha_captures: [], cookie_sync: [], license_codes: [] };
const ENCRYPTED_FORMAT = 'bilitfast-db-gcm-v1';
function encryptionRequired() {
  return process.env.BILITFAST_SELF_HOSTED === '1' &&
    process.env.BILITFAST_SINGLE_USER !== '0';
}
function sealDocument(doc) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', require('./secrets').stateKey(), iv);
  cipher.setAAD(Buffer.from(ENCRYPTED_FORMAT));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final()]);
  return JSON.stringify({format: ENCRYPTED_FORMAT, iv:iv.toString('base64'),
    ciphertext: encrypted.toString('base64'), tag:cipher.getAuthTag().toString('base64')});
}
function openDocument(doc) {
  if (!doc || doc.format !== ENCRYPTED_FORMAT || !doc.iv || !doc.tag || !doc.ciphertext) {
    throw new Error('رکورد دیتابیس رمزنگاری‌شده معتبر نیست. از پشتیبان بازیابی کنید.');
  }
  const dec = crypto.createDecipheriv('aes-256-gcm', require('./secrets').stateKey(), Buffer.from(doc.iv,'base64'));
  dec.setAAD(Buffer.from(ENCRYPTED_FORMAT));
  dec.setAuthTag(Buffer.from(doc.tag,'base64'));
  return JSON.parse(Buffer.concat([dec.update(Buffer.from(doc.ciphertext,'base64')),dec.final()]).toString('utf8'));
}


let cache = null;
let writeQueue = Promise.resolve();
let remoteLoaded = false;
let lastRemoteSync = 0;

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function load() {
  if (cache) {
    if (remote.isConfigured() && !encryptionRequired() && Date.now() - lastRemoteSync > remote.REFRESH_MS) {
      lastRemoteSync = Date.now();
      remote.readAll().then((doc) => {
        if (doc && typeof doc === 'object') {
          for (const k of Object.keys(EMPTY)) if (Array.isArray(doc[k])) cache[k]=doc[k];
        }
      }).catch(() => {});
    }
    return cache;
  }
  let legacyPlaintext = false;
  let sourceExists = false;
  try {
    if (fs.existsSync(DB_FILE)) {
      sourceExists = true;
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (raw && raw.format === ENCRYPTED_FORMAT) cache = openDocument(raw);
      else if (encryptionRequired()) { cache=raw; legacyPlaintext=true; }
      else cache=raw;
    }
  } catch (e) {
    // Never replace unreadable customer data with an empty database.
    throw new Error('دیتابیس خوانده نشد یا کلید رمزنگاری نادرست است. فایل را حذف نکنید؛ پشتیبان را بازیابی کنید: '+e.message);
  }
  if (sourceExists && (!cache || typeof cache !== 'object' || Array.isArray(cache))) {
    throw new Error('ساختار دیتابیس نامعتبر است؛ از پشتیبان بازیابی کنید.');
  }
  if (!cache) cache = JSON.parse(JSON.stringify(EMPTY));
  for (const k of Object.keys(EMPTY)) if (!Array.isArray(cache[k])) cache[k] = [];
  if (legacyPlaintext) persist(); // Atomic, verified migration on first production read.
  return cache;
}

/** نوشتن اتمیک و سریالی‌شده (جلوگیری از خرابی فایل هنگام نوشتن هم‌زمان). */
function persist() {
  // The single-server JSON store must not claim success before data reaches
  // disk. Synchronous rename is intentional; callers depend on read-after-write.
  // A failed write propagates to the API instead of silently acknowledging it.
  const snapshot = encryptionRequired()
    ? sealDocument(cache) : JSON.stringify(cache, null, 1);
  ensureDir();
  const tmp = DB_FILE + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, snapshot, { encoding:'utf8', flag:'w', mode:0o600 });
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error('ذخیره داده روی دیسک انجام نشد: ' + (e && e.message || e));
  }
  if (remote.isConfigured()) {
    // For self-hosted single-owner deployments, local disk is authoritative.
    // Remote writes are still best-effort; multi-instance mode is not supported.
    remote.writeAll(cache).catch((e) => {
      console.error('[db] sync to remote store failed:', e.message);
    });
  }
  return Promise.resolve();
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
  try { persist(); } catch (e) { c.pop(); throw e; }
  return rec;
}

function update(collection, id, patch) {
  const c = col(collection);
  const rec = c.find((x) => x.id === id);
  if (!rec) return null;
  const backup = { ...rec };
  Object.assign(rec, patch, { updated_at: Date.now() });
  try { persist(); } catch (e) { Object.keys(rec).forEach(k => delete rec[k]); Object.assign(rec, backup); throw e; }
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
  const deleted = c.splice(i, 1)[0];
  try { persist(); } catch (e) { c.splice(i, 0, deleted); throw e; }
  return true;
}

/**
 * وضعیت ذخیره‌سازی برای نمایش به مدیر سیستم و بررسی سلامت استقرار.
 * روی محیط چندنمونه‌ای بدون ذخیره‌ساز مشترک، هشدار صریح تولید می‌کند.
 */
function storageStatus() {
  const serverless = !!(process.env.AWS_LAMBDA_FUNCTION_NAME ||
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
  if (encryptionRequired() && st.shared) {
    throw new Error('نصب تک‌کاربره به ذخیره‌سازی محلی با رمزنگاری متکی است؛ ذخیره‌ساز مشترک KV فعال نباشد.');
  }
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
