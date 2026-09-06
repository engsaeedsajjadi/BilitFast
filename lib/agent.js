// -*- coding: utf-8 -*-
/**
 * lib/agent.js — موتور ارکستراسیون BilitFast (State Machine + Workflow + Observability).
 *
 * این ماژول پیاده‌سازی «عامل سازمانی» است: وضعیت هر فرایند را به‌صورت یک ماشین
 * حالت رسمی مدیریت می‌کند، انتقال‌های نامعتبر را مسدود می‌کند، رویدادهای کسب‌وکار
 * را بدون ثبت اطلاعات حساس (masked) ثبت می‌کند، و خروجی استاندارد
 * (success / waiting / failure / unknown) تولید می‌کند.
 *
 * این ماژول منطق HTTP را خودش نمی‌سازد؛ آن کار بر عهده lib/core.js و lib/reserve.js
 * است. اینجا فقط وضعیت، اعتبارسنجی، رتبه‌بندی و گزارش‌دهی را مدیریت می‌کند.
 */

const crypto = require('crypto');

/* =====================================================================
 * ۱) ماشین حالت رسمی
 * ===================================================================== */

const STATES = {
  INIT: 'INIT',
  REQUEST_PARSED: 'REQUEST_PARSED',
  SEARCH_READY: 'SEARCH_READY',
  SEARCHING: 'SEARCHING',
  RESULTS_FOUND: 'RESULTS_FOUND',
  TRAIN_SELECTED: 'TRAIN_SELECTED',
  RESERVATION_START: 'RESERVATION_START',
  RESERVATION_STATE_READY: 'RESERVATION_STATE_READY',
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  PASSENGER_FORM: 'PASSENGER_FORM',
  PASSENGER_DATA_VALIDATED: 'PASSENGER_DATA_VALIDATED',
  PRICE_VALIDATED: 'PRICE_VALIDATED',
  CONFIRMATION_READY: 'CONFIRMATION_READY',
  PAYMENT_HANDOFF: 'PAYMENT_HANDOFF',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  PAYMENT_RESULT: 'PAYMENT_RESULT',
  BOOKING_VERIFIED: 'BOOKING_VERIFIED',
  COMPLETED: 'COMPLETED',

  // حالت‌های جایگزین / خطا
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  NO_CAPACITY: 'NO_CAPACITY',
  SESSION_INVALID: 'SESSION_INVALID',
  PRICE_CHANGED: 'PRICE_CHANGED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SITE_CHANGED: 'SITE_CHANGED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_UNKNOWN: 'PAYMENT_UNKNOWN',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
};

// انتقال‌های مجاز (هر حالت → لیست حالت‌های بعدی مجاز)
const VALID_TRANSITIONS = {
  [STATES.INIT]: [STATES.REQUEST_PARSED],
  [STATES.REQUEST_PARSED]: [STATES.SEARCH_READY, STATES.CANCELLED],
  [STATES.SEARCH_READY]: [STATES.SEARCHING, STATES.CANCELLED],
  [STATES.SEARCHING]: [STATES.RESULTS_FOUND, STATES.NO_CAPACITY, STATES.NETWORK_ERROR, STATES.SESSION_INVALID, STATES.CANCELLED],
  [STATES.RESULTS_FOUND]: [STATES.TRAIN_SELECTED, STATES.NO_CAPACITY],
  [STATES.TRAIN_SELECTED]: [STATES.RESERVATION_START, STATES.CANCELLED],
  [STATES.RESERVATION_START]: [STATES.RESERVATION_STATE_READY, STATES.LOGIN_REQUIRED, STATES.NETWORK_ERROR, STATES.SITE_CHANGED, STATES.CANCELLED],
  [STATES.RESERVATION_STATE_READY]: [STATES.CAPTCHA_REQUIRED, STATES.PASSENGER_FORM, STATES.PAYMENT_HANDOFF, STATES.LOGIN_REQUIRED, STATES.NO_CAPACITY, STATES.SITE_CHANGED],
  [STATES.CAPTCHA_REQUIRED]: [STATES.PASSENGER_FORM, STATES.PAYMENT_HANDOFF, STATES.CANCELLED],
  [STATES.PASSENGER_FORM]: [STATES.PASSENGER_DATA_VALIDATED, STATES.PRICE_CHANGED, STATES.NO_CAPACITY, STATES.SITE_CHANGED, STATES.CANCELLED],
  [STATES.PASSENGER_DATA_VALIDATED]: [STATES.PRICE_VALIDATED, STATES.PRICE_CHANGED, STATES.CANCELLED],
  [STATES.PRICE_VALIDATED]: [STATES.CONFIRMATION_READY, STATES.PRICE_CHANGED, STATES.CANCELLED],
  [STATES.CONFIRMATION_READY]: [STATES.PAYMENT_HANDOFF, STATES.CANCELLED],
  [STATES.PAYMENT_HANDOFF]: [STATES.PAYMENT_PENDING, STATES.PAYMENT_UNKNOWN, STATES.PAYMENT_FAILED],
  [STATES.PAYMENT_PENDING]: [STATES.PAYMENT_RESULT, STATES.PAYMENT_UNKNOWN, STATES.PAYMENT_FAILED, STATES.CANCELLED],
  [STATES.PAYMENT_RESULT]: [STATES.BOOKING_VERIFIED, STATES.PAYMENT_FAILED, STATES.PAYMENT_UNKNOWN],
  [STATES.BOOKING_VERIFIED]: [STATES.COMPLETED, STATES.FAILED],
  [STATES.COMPLETED]: [],

  // حالت‌های جایگزین (بازیابی مجاز از نقاط مشخص)
  [STATES.LOGIN_REQUIRED]: [STATES.RESERVATION_START, STATES.CANCELLED],
  [STATES.NO_CAPACITY]: [STATES.RESULTS_FOUND, STATES.SEARCHING, STATES.CANCELLED],
  [STATES.SESSION_INVALID]: [STATES.SEARCH_READY, STATES.CANCELLED],
  [STATES.PRICE_CHANGED]: [STATES.CONFIRMATION_READY, STATES.CANCELLED],
  [STATES.NETWORK_ERROR]: [STATES.SEARCHING, STATES.RESERVATION_START, STATES.CANCELLED],
  [STATES.SITE_CHANGED]: [STATES.CANCELLED],
  [STATES.PAYMENT_FAILED]: [STATES.PAYMENT_HANDOFF, STATES.CANCELLED],
  [STATES.PAYMENT_UNKNOWN]: [STATES.BOOKING_VERIFIED, STATES.CANCELLED],
  [STATES.CANCELLED]: [],
  [STATES.EXPIRED]: [STATES.CANCELLED],
  [STATES.FAILED]: [STATES.CANCELLED],
};

/* =====================================================================
 * ۲) Workflow (وضعیت + رویدادها + idempotency)
 * ===================================================================== */

function createWorkflow(meta = {}, initialState = null) {
  const initial = initialState || STATES.INIT;
  if (!Object.values(STATES).includes(initial)) {
    throw new Error('حالت اولیه نامعتبر: ' + initial);
  }
  return {
    workflow_id: crypto.randomUUID(),
    state: initial,
    meta,
    created_at: Date.now(),
    updated_at: Date.now(),
    events: [],
    done: {},       // کلیدهای idempotency انجام‌شده
  };
}

/**
 * اعمال انتقال حالت با اعتبارسنجی. در صورت انتقال نامعتبر، خطا پرتاب می‌کند.
 */
function transition(wf, nextState) {
  if (!wf || !wf.state) throw new Error('Workflow نامعتبر است.');
  const allowed = VALID_TRANSITIONS[wf.state] || [];
  if (!allowed.includes(nextState)) {
    const err = new Error('انتقال حالت غیرمجاز: ' + wf.state + ' → ' + nextState);
    err.code = 'INVALID_TRANSITION';
    throw err;
  }
  wf.state = nextState;
  wf.updated_at = Date.now();
  return wf;
}

/** تلاش برای انتقال؛ در صورت نامعتبر بودن، خطا نمی‌دهد و false برمی‌گرداند. */
function tryTransition(wf, nextState) {
  const allowed = VALID_TRANSITIONS[wf.state] || [];
  if (!allowed.includes(nextState)) return false;
  wf.state = nextState;
  wf.updated_at = Date.now();
  return true;
}

/* =====================================================================
 * ۳) Masking اطلاعات حساس (Data Minimization / Observability)
 * ===================================================================== */

const SENSITIVE_KEYS = new Set([
  'cookies', 'cookie', 'raw_cookie', 'cookie_header',
  'card_number', 'card', 'cvv2', 'cvv', 'pin', 'otp', 'dynamic_password',
  'password', 'pass', 'auth_token', 'token_secret', 'session_id',
]);

function maskNationalCode(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 3) return '***';
  return '***' + s.slice(-3);
}

function maskPhone(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 3) return '***';
  return '***' + s.slice(-3);
}

function maskValue(key, value) {
  if (value === undefined || value === null) return value;
  const k = String(key).toLowerCase();
  if (SENSITIVE_KEYS.has(k)) return '[REDACTED]';
  if (/national|meli|codemeli|pid/.test(k)) return maskNationalCode(value);
  if (/phone|mobile|tel/.test(k)) return maskPhone(value);
  if (/captcha|securitycode|kaptcha/.test(k)) return '***';
  return value;
}

/** بازگشتی mask کردن آبجکت/آرایه (حذف کلیدهای حساس، ماسک کردن PII). */
function maskSensitive(obj) {
  if (Array.isArray(obj)) return obj.map((x) => maskSensitive(x));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) continue; // حذف کامل
      if (v && typeof v === 'object') out[k] = maskSensitive(v);
      else out[k] = maskValue(k, v);
    }
    return out;
  }
  return obj;
}

/* =====================================================================
 * ۴) ثبت رویداد کسب‌وکار (بدون ثبت Secret)
 * ===================================================================== */

function logEvent(wf, event, data = {}) {
  const entry = {
    event,
    state: wf.state,
    ts: Date.now(),
    data: maskSensitive(data),
  };
  wf.events.push(entry);
  // در محیط serverless، console کافی است؛ از ذخیره فایل خودداری می‌شود.
  try {
    console.log('[agent:' + wf.workflow_id + '] ' + event + ' ' + JSON.stringify(entry.data));
  } catch (e) { /* ignore */ }
  return entry;
}

/* =====================================================================
 * ۵) Idempotency (محافظت عملیات حساس)
 * ===================================================================== */

function isDone(wf, key) {
  return !!wf.done[key];
}

function markDone(wf, key) {
  wf.done[key] = Date.now();
  return wf;
}

/* =====================================================================
 * ۶) اعتبارسنجی قیمت
 * ===================================================================== */

/**
 * تبدیل رشته قیمت فارسی به عدد. نمونه‌ها: "15,200,000" ، "۷٬۶۰۰٬۰۰۰" ، "29,900,000".
 */
function parsePrice(text) {
  if (text === undefined || text === null) return null;
  let s = String(text);
  // تبدیل ارقام فارسی/عربی به لاتین
  s = s
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  // تبدیل جداکننده هزارگان عربی (٬ = U+066C) و ممیز اعشار (٫ = U+066B)
  s = s.replace(/٬/g, ',').replace(/٫/g, '.');
  const m = s.match(/\d[\d,]*/);
  if (!m) return null;
  const n = parseInt(m[0].replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

/**
 * اعتبارسنجی قیمت: ticket + services باید برابر total باشد (با تلورانس).
 * خروجی: { ok, expected, actual, diff, message }
 */
function validatePrice({ ticket = 0, services = 0, total = null, tolerance = 0 }) {
  const expected = Number(ticket) + Number(services);
  if (total === null || total === undefined) {
    return { ok: true, expected, actual: null, diff: null, verified: false, message: 'مبلغ کل از صفحه استخراج نشد.' };
  }
  const actual = Number(total);
  const diff = actual - expected;
  const ok = Math.abs(diff) <= tolerance;
  return {
    ok,
    expected,
    actual,
    diff,
    verified: true,
    message: ok
      ? 'مبلغ با مبلغ مورد انتظار سازگار است.'
      : 'مبلغ بلیت هنگام رزرو با مبلغ مرحله جست‌وجو متفاوت شده است.',
  };
}

/* =====================================================================
 * ۷) موتور تصمیم‌گیری (فیلتر + رتبه‌بندی قطارها)
 * ===================================================================== */

// نگاشت کلیدهای قطار به فیلدهای منطقی
const TRAIN_FIELD_MAP = {
  train_number: 'شماره قطار',
  departure_time: 'ساعت حرکت',
  price: 'قیمت',
  train_type: 'نوع کوپه',
  capacity: 'ظرفیت',
  company: 'شرکت',
};

function toMinutes(timeStr) {
  const s = String(timeStr || '').trim();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * فیلتر سخت + رتبه‌بندی نرم قطارها بر اساس ترجیحات کاربر.
 * ورودی: trains (آرایه قطارها) و prefs (ترجیحات از ورودی استاندارد).
 * خروجی: { kept, dropped, ranked, reason }
 */
function filterAndRankTrains(trains, prefs = {}) {
  const p = prefs || {};
  const kept = [];
  const dropped = [];

  for (const t of trains) {
    const price = parsePrice(t['قیمت']);
    const capacity = t['ظرفیت'];
    const capNum = capacity === '20+' ? 20 : parseInt(capacity, 10);

    // --- فیلترهای سخت ---
    if (p.departure_after) {
      const tMin = toMinutes(t['ساعت حرکت']);
      const afterMin = toMinutes(p.departure_after);
      if (tMin === null || afterMin === null || tMin < afterMin) {
        dropped.push({ train: t, reason: 'departure_after' });
        continue;
      }
    }
    if (p.departure_before) {
      const tMin = toMinutes(t['ساعت حرکت']);
      const beforeMin = toMinutes(p.departure_before);
      if (tMin === null || beforeMin === null || tMin > beforeMin) {
        dropped.push({ train: t, reason: 'departure_before' });
        continue;
      }
    }
    if (p.max_price !== null && p.max_price !== undefined && price !== null && price > p.max_price) {
      dropped.push({ train: t, reason: 'max_price' });
      continue;
    }
    if (p.min_price !== null && p.min_price !== undefined && price !== null && price < p.min_price) {
      dropped.push({ train: t, reason: 'min_price' });
      continue;
    }
    if (p.minimum_capacity !== null && p.minimum_capacity !== undefined && capNum < p.minimum_capacity) {
      dropped.push({ train: t, reason: 'minimum_capacity' });
      continue;
    }
    if (p.train_type && t['نوع کوپه'] && !String(t['نوع کوپه']).includes(p.train_type)) {
      dropped.push({ train: t, reason: 'train_type' });
      continue;
    }
    if (p.company && t['شرکت'] && !String(t['شرکت']).includes(p.company)) {
      dropped.push({ train: t, reason: 'company' });
      continue;
    }

    kept.push({ train: t, price, capacity: capNum, timeMin: toMinutes(t['ساعت حرکت']) });
  }

  // --- رتبه‌بندی نرم ---
  const ranked = [...kept];
  ranked.sort((a, b) => {
    // ترجیح صریح ارزان‌ترین
    if (p.cheapest) {
      const d = (a.price || 0) - (b.price || 0);
      if (d !== 0) return d;
    }
    // ترجیح صریح زودترین
    if (p.earliest) {
      const d = (a.timeMin || 0) - (b.timeMin || 0);
      if (d !== 0) return d;
    }
    // اولویت پیش‌فرض: ظرفیت کافی → زمان زودتر → قیمت کمتر
    const dTime = (a.timeMin || 0) - (b.timeMin || 0);
    if (dTime !== 0) return dTime;
    return (a.price || 0) - (b.price || 0);
  });

  return {
    kept: kept.map((x) => x.train),
    dropped,
    ranked: ranked.map((x) => x.train),
    droppedCount: dropped.length,
    keptCount: kept.length,
  };
}

/* =====================================================================
 * ۸) خروجی استاندارد
 * ===================================================================== */

function buildSuccess(wf, booking, price, payment) {
  return {
    status: 'success',
    workflow_id: wf.workflow_id,
    booking: booking || {},
    passengers: (booking && booking.passengers) || 0,
    price: price || { ticket: 0, services: 0, total: 0, currency: 'IRR' },
    payment: payment || { status: 'success' },
  };
}

function buildWaiting(wf, state, message) {
  return {
    status: 'waiting_for_user',
    workflow_id: wf.workflow_id,
    state: state || wf.state,
    message: message || 'برای ادامه این مرحله نیاز به اقدام شما وجود دارد.',
  };
}

function buildFailure(wf, state, category, message) {
  return {
    status: 'failed',
    workflow_id: wf.workflow_id,
    state: state || wf.state,
    error: { category: category || 'UNKNOWN', message: message || 'خطا' },
  };
}

function buildUnknown(wf, state, message) {
  return {
    status: 'unknown',
    workflow_id: wf.workflow_id,
    state: state || 'TRANSACTION_UNKNOWN',
    message: message || 'وضعیت عملیات قابل تأیید نیست؛ از اجرای مجدد عملیات مالی خودداری شد.',
  };
}

/* ===================================================================== */

module.exports = {
  STATES,
  VALID_TRANSITIONS,
  createWorkflow,
  transition,
  tryTransition,
  maskSensitive,
  maskValue,
  logEvent,
  isDone,
  markDone,
  parsePrice,
  validatePrice,
  filterAndRankTrains,
  buildSuccess,
  buildWaiting,
  buildFailure,
  buildUnknown,
};
