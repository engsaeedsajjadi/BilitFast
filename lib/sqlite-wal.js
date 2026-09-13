// -*- coding: utf-8 -*-
/**
 * lib/sqlite-wal.js — خواندن دیتابیس SQLite همراه با فایل جانبی WAL.
 *
 * چرا لازم است:
 * مرورگرها (فایرفاکس و کروم) دیتابیس کوکی را در حالت WAL باز می‌کنند. در این
 * حالت نوشته‌های تازه ابتدا به فایل جانبی «...-wal» می‌روند و فقط هرازگاهی
 * (checkpoint) داخل فایل اصلی ادغام می‌شوند.
 *
 * نتیجه‌اش دقیقاً همان چیزی است که کاربر می‌دید: درست بعد از ورود به سایت،
 * کوکی نشست هنوز در فایل اصلی نیست. sql.js هم فقط بافری را می‌بیند که ما به
 * آن می‌دهیم و از وجود فایل WAL خبر ندارد. پس برنامه نسخهٔ کهنه را می‌خواند،
 * PHPSESSID تازه را نمی‌بیند و همگام‌سازی خودکار «کوکی یافت نشد» می‌داد —
 * در حالی که کاربر واقعاً در مرورگر وارد شده بود.
 *
 * این ماژول فریم‌های WAL را می‌خواند و روی تصویر فایل اصلی اعمال می‌کند تا
 * وضعیت واقعی و به‌روز به دست بیاید. فایل‌ها فقط خوانده می‌شوند؛ هیچ چیزی در
 * پروفایل مرورگر تغییر نمی‌کند.
 *
 * قالب WAL (مستندات رسمی SQLite):
 *   هدر فایل: ۳۲ بایت — magic(4) format(4) pageSize(4) checkpointSeq(4)
 *              salt1(4) salt2(4) checksum1(4) checksum2(4)
 *   هر فریم:  هدر ۲۴ بایتی — pageNumber(4) dbSizeAfterCommit(4)
 *              salt1(4) salt2(4) checksum1(4) checksum2(4)  + خودِ صفحه
 * فریم‌ها فقط وقتی معتبرند که salt آن‌ها با salt هدر بخواند؛ بقیه بازمانده‌های
 * قدیمی‌اند و باید نادیده گرفته شوند.
 */

const fs = require('fs');

const WAL_HEADER_SIZE = 32;
const FRAME_HEADER_SIZE = 24;
const WAL_MAGIC_BE = 0x377f0683;
const WAL_MAGIC_LE = 0x377f0682;

/**
 * تصویر به‌روز دیتابیس را برمی‌گرداند: فایل اصلی + فریم‌های معتبر WAL.
 * اگر WAL نبود یا خراب بود، همان فایل اصلی برگردانده می‌شود.
 *
 * @param {string} dbPath مسیر فایل اصلی SQLite
 * @returns {Buffer}
 */
function readWithWal(dbPath) {
  const base = fs.readFileSync(dbPath);
  let wal;
  try {
    wal = fs.readFileSync(dbPath + '-wal');
  } catch (e) {
    return base; // WAL وجود ندارد یا خواندنی نیست
  }
  if (!wal || wal.length < WAL_HEADER_SIZE) return base;

  const magic = wal.readUInt32BE(0);
  if (magic !== WAL_MAGIC_BE && magic !== WAL_MAGIC_LE) return base;

  const pageSize = wal.readUInt32BE(8);
  // اندازه صفحه باید توان ۲ و در بازه معتبر SQLite باشد
  if (!pageSize || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
    return base;
  }
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);

  // آخرین نسخهٔ هر صفحه برنده است، پس ترتیبی جلو می‌رویم و بازنویسی می‌کنیم.
  const pages = new Map();
  let maxPage = 0;
  let offset = WAL_HEADER_SIZE;

  while (offset + FRAME_HEADER_SIZE + pageSize <= wal.length) {
    const pageNo = wal.readUInt32BE(offset);
    const fSalt1 = wal.readUInt32BE(offset + 8);
    const fSalt2 = wal.readUInt32BE(offset + 12);

    // فریم متعلق به همین نسل WAL نیست → از اینجا به بعد بازمانده است
    if (fSalt1 !== salt1 || fSalt2 !== salt2) break;
    if (pageNo > 0) {
      const start = offset + FRAME_HEADER_SIZE;
      pages.set(pageNo, wal.subarray(start, start + pageSize));
      if (pageNo > maxPage) maxPage = pageNo;
    }
    offset += FRAME_HEADER_SIZE + pageSize;
  }

  if (!pages.size) return base;

  // بوم خروجی باید هم فایل اصلی و هم صفحات جدید WAL را جا بدهد.
  const neededSize = Math.max(base.length, maxPage * pageSize);
  const out = Buffer.alloc(neededSize);
  base.copy(out, 0);
  for (const [pageNo, data] of pages) {
    data.copy(out, (pageNo - 1) * pageSize);
  }
  return out;
}

/**
 * نسخهٔ امن: اگر هر مشکلی پیش بیاید، به خواندن سادهٔ فایل برمی‌گردد.
 * هدف این است که پشتیبانی از WAL هرگز مسیری را که قبلاً کار می‌کرد نشکند.
 */
function readDatabase(dbPath) {
  try {
    return readWithWal(dbPath);
  } catch (e) {
    return fs.readFileSync(dbPath);
  }
}

module.exports = { readDatabase, readWithWal };
