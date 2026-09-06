// -*- coding: utf-8 -*-
/**
 * lib/ocr/split.js — تفکیک دیتاست بر اساس «هویت تصویر» با بذر ثابت.
 *
 * هیچ تصویری که در آموزش باشد وارد تست/کالیبراسیون نمی‌شود؛ تفکیک روی
 * خود تصاویر است نه برش‌های آن‌ها و با بذر ثابت کاملاً بازتولیدپذیر است.
 */

const { mulberry32 } = require('../ml');

/**
 * تفکیک فهرست شناسه‌ها به train/val/cal/test.
 * ورودی: ids آرایه شناسه، opts { seed, ratios: {train,val,cal,test}, minPerSplit }
 * خروجی: { train, val, cal, test, seed, ratios } (آرایه‌های شناسه، بدون هم‌پوشانی)
 */
function splitByIdentity(ids, { seed = 1397, ratios = { train: 0.5, val: 0.15, cal: 0.15, test: 0.2 } } = {}) {
  const sum = ratios.train + ratios.val + ratios.cal + ratios.test;
  if (Math.abs(sum - 1) > 1e-6) throw new Error('مجموع نسبت‌های تفکیک باید ۱ باشد');
  const arr = [...ids];
  const rng = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const n = arr.length;
  let nTest = Math.round(n * ratios.test);
  let nCal = Math.round(n * ratios.cal);
  let nVal = Math.round(n * ratios.val);
  // تضمین حداقل یک نمونه در بخش‌هایی که سهمشان مثبت است (وقتی داده کافی هست)
  if (n >= 4) {
    if (ratios.test > 0) nTest = Math.max(1, nTest);
    if (ratios.cal > 0) nCal = Math.max(1, nCal);
    if (ratios.val > 0) nVal = Math.max(1, nVal);
    if (nTest + nCal + nVal >= n) { nVal = Math.max(1, Math.floor(n * 0.1)); nCal = Math.max(1, Math.floor(n * 0.1)); nTest = Math.max(1, n - nCal - nVal - 1); }
  }
  const test = arr.slice(0, nTest);
  const cal = arr.slice(nTest, nTest + nCal);
  const val = arr.slice(nTest + nCal, nTest + nCal + nVal);
  const train = arr.slice(nTest + nCal + nVal);
  return { train, val, cal, test, seed, ratios, n: ids.length };
}

/** بررسی عدم هم‌پوشانی بخش‌ها — اگر هم‌پوشانی بود استثنا می‌اندازد. */
function assertNoLeakage(split) {
  const seen = new Map();
  for (const part of ['train', 'val', 'cal', 'test']) {
    for (const id of split[part]) {
      if (seen.has(id)) {
        throw new Error(`نشت داده: «${id}» هم در ${seen.get(id)} است و هم در ${part}`);
      }
      seen.set(id, part);
    }
  }
  return true;
}

module.exports = { splitByIdentity, assertNoLeakage };
