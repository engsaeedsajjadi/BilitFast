// -*- coding: utf-8 -*-
/**
 * lib/ocr/logging.js — لاگ استنتاج برای محیط تست.
 *
 * هر استنتاج: نسخهٔ پایپ‌لاین، نسخهٔ مدل، پیکربندی پیش‌پردازش، تعداد قطعه‌ها،
 * اطمینان هر کاراکتر، اطمینان توالی، تأخیر، نتیجه و دلیل شکست.
 * ذخیره در بافر حلقه‌ای + در صورت تعیین BILITFAST_OCR_LOG در فایل JSONL.
 */

const fs = require('fs');
const path = require('path');
const { PIPELINE_VERSION } = require('./config');

const RING_MAX = 200;
const _ring = [];

function logInference(entry) {
  const rec = {
    ts: new Date().toISOString(),
    pipelineVersion: entry.pipelineVersion || PIPELINE_VERSION,
    modelVersion: entry.modelVersion || null,
    preprocess: entry.preprocess || null,      // پیکربندی پیش‌پردازش
    polarity: entry.polarity || null,          // تصمیم قطبیت + اطمینان
    segCount: entry.segCount ?? null,          // تعداد قطعه‌ها
    charConfs: entry.charConfs || [],          // اطمینان هر کاراکتر
    seqConf: entry.seqConf ?? null,            // اطمینان توالی
    latencyMs: entry.latencyMs ?? null,        // تأخیر
    text: entry.text ?? null,                  // نتیجهٔ نهایی
    ok: entry.ok ?? null,
    failureReason: entry.failureReason || null,
    extra: entry.extra || null,
  };
  _ring.push(rec);
  if (_ring.length > RING_MAX) _ring.shift();
  const logFile = process.env.BILITFAST_OCR_LOG;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify(rec) + '\n');
    } catch (e) { /* لاگ نباید جریان را بشکند */ }
  }
  return rec;
}

function getInferenceLog() { return _ring.slice(); }
function clearInferenceLog() { _ring.length = 0; }

module.exports = { logInference, getInferenceLog, clearInferenceLog };
