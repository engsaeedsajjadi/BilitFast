// -*- coding: utf-8 -*-
/**
 * lib/reserve.js — جریان کامل رزرو (چندمرحله‌ای) برای سایت صفیر ریل.
 *
 * جریان واقعی سایت به این شکل است:
 *   ۱) انتخاب قطار → ارسال پارامترها به TresV.php (POST)
 *   ۲) نمایش صفحه کپچا (kcaptcha) → کاربر کپچا را حل می‌کند
 *   ۳) ورود اطلاعات مسافران (کد ملی، تاریخ تولد، نام، نام خانوادگی)
 *   ۴) تأیید رزرو → هدایت به صفحه پرداخت (درگاه بانک)
 *
 * این ماژول این جریان را به‌صورت «بدون حالت» (stateless) پیاده می‌کند:
 *   - هر مرحله یک token وضعیت برمی‌گرداند که مرحله بعد دوباره ارسال می‌شود.
 *   - این کار هم روی سرور محلی (dev-server.js) و هم روی Vercel جواب می‌دهد.
 *
 * نکته مهم: چون دسترسی به فرم واقعی (بدون نشست معتبر) ممکن نیست، همه
 * سِلکتورها/نام‌فیلدها از config.json خوانده می‌شوند و علاوه بر آن، خروجی
 * هر مرحله یک «تشخیص» (diagnostics) شامل نام تمام فیلدهای فرم برمی‌گرداند
 * تا بتوان مقادیر را با فرم واقعی هماهنگ کرد.
 */

const path = require('path');
const cheerio = require('cheerio');
const config = require(path.join(__dirname, '..', 'config.json'));
const { buildReserveForm, buildHeaders, toUrlEncoded, cityCode } = require('./core');
const {
  STATES,
  createWorkflow,
  transition,
  tryTransition,
  logEvent,
  isDone,
  markDone,
  parsePrice,
  validatePrice,
} = require('./agent');

const RC = config.reservation || {};

/* =====================================================================
 * کوکی‌جار (Cookie Jar) — مدیریت دستی کوکی‌ها بین مراحل
 * ===================================================================== */

/** تبدیل یک هدر set-cookie به «name=value» (یا null). */
function parseSetCookie(header) {
  if (!header) return null;
  const first = String(header).split(';')[0].trim();
  if (!first || first.indexOf('=') < 0) return null;
  return first;
}

/** ادغام set-cookieهای جدید در جار موجود (حذف کوکی‌های منقضی). */
function mergeCookies(jar, setCookieHeaders) {
  const map = new Map();
  for (const c of jar || []) {
    const eq = c.indexOf('=');
    if (eq > 0) map.set(c.slice(0, eq), c);
  }
  for (const sc of setCookieHeaders || []) {
    const kv = parseSetCookie(sc);
    if (!kv) continue;
    const eq = kv.indexOf('=');
    const name = kv.slice(0, eq);
    const value = kv.slice(eq + 1);
    if (value === '' || /deleted/i.test(value)) map.delete(name);
    else map.set(name, kv);
  }
  return Array.from(map.values());
}

/** ساخت هدر Cookie از جار. */
function cookieHeader(jar) {
  return (jar || []).map((c) => c.split(';')[0]).join('; ');
}

/** استخراج همه set-cookieها از یک پاسخ fetch. */
function responseSetCookies(resp) {
  if (typeof resp.headers.getSetCookie === 'function') {
    return resp.headers.getSetCookie();
  }
  const h = resp.headers.get('set-cookie');
  return h ? [h] : [];
}

/* =====================================================================
 * درخواست HTTP با دنبال‌کردن redirect و نگهداری کوکی‌جار
 * ===================================================================== */

async function fetchFollowing(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    jar = [],
    maxRedirects = 10,
  } = opts;

  let current = url;
  let currentJar = jar;
  let curMethod = method;
  let curBody = body;
  let lastResp = null;
  let htmlText = '';

  for (let i = 0; i <= maxRedirects; i++) {
    const h = { ...headers };
    if (currentJar.length) h['Cookie'] = cookieHeader(currentJar);

    let resp;
    try {
      resp = await fetch(current, { method: curMethod, headers: h, body: curBody, redirect: 'manual' });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket|TLS|SSL|ETIMEDOUT/i.test(msg)) {
        throw new Error('اتصال به صفیر ریل برقرار نشد (' + msg + '). برنامه را روی سیستم خودتان (IP ایران) اجرا کنید.');
      }
      throw e;
    }

    currentJar = mergeCookies(currentJar, responseSetCookies(resp));
    lastResp = resp;

    const status = resp.status;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const loc = resp.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).toString();
      if ([301, 302, 303].includes(status) && curMethod === 'POST') {
        curMethod = 'GET'; // مرورگر POST را بعد از 302/303 به GET تبدیل می‌کند
        curBody = null;
      }
      continue;
    }
    break;
  }

  htmlText = lastResp ? await lastResp.text() : '';
  return { resp: lastResp, jar: currentJar, finalUrl: current, html: htmlText };
}

/* =====================================================================
 * تجزیه فرم HTML — استخراج action، فیلدها، کپچا و مسافرها
 * ===================================================================== */

function normalizeName(raw) {
  return String(raw || '').toLowerCase();
}

/** آیا نام فیلد به یکی از سرنخ‌ها شبیه است؟ */
function matchesHint(name, hints) {
  const n = normalizeName(name);
  return (hints || []).some((h) => n.includes(h.toLowerCase()));
}

/**
 * تجزیه پاسخ HTML یک مرحله از رزرو.
 * خروجی شامل: نوع مرحله، فرم action، همه فیلدها (hidden + visible)،
 * آدرس تصویر کپچا، نام فیلد کپچا، و تشخیص (لیست نام همه فیلدها).
 */
function analyzeHtml(htmlText, baseUrl) {
  const $ = cheerio.load(htmlText);
  const diag = {
    forms: [],
    inputs: [],
    images: [],
  };

  const flatText = $('body').text() || '';

  // --- تشخیص ورود مورد نیاز ---
  const loginRequired = (RC.login_markers || []).some((m) => flatText.includes(m));
  const isPayment = (RC.payment_markers || []).some((m) => flatText.includes(m));
  const isSuccess = (RC.success_markers || []).some((m) => flatText.includes(m));
  const captchaError = (RC.captcha_error_markers || []).some((m) => flatText.includes(m));
  const noCapacity = (RC.no_capacity_markers || []).some((m) => flatText.includes(m));

  // --- همه تصاویر (برای پیدا کردن کپچا) ---
  let captchaImgUrl = null;
  $('img').each((_i, el) => {
    const src = $(el).attr('src') || '';
    diag.images.push(src);
    if (!captchaImgUrl) {
      const lower = src.toLowerCase();
      const hit = (RC.captcha_img_selectors || []).some((sel) => {
        // تبدیل سلکتور ساده به جستجوی زیررشته‌ای در src
        const token = sel.replace(/^img\[src\*='([^']*)'\]$/, '$1');
        return token && lower.includes(token.toLowerCase());
      });
      if (hit) captchaImgUrl = src;
    }
  });

  // --- تجزیه فرم‌ها ---
  const forms = [];
  $('form').each((_fi, fel) => {
    const action = $(fel).attr('action') || '';
    const method = ($(fel).attr('method') || 'post').toLowerCase();
    const fields = [];
    $(fel).find('input, select, textarea').each((_i, el) => {
      const tag = el.tagName.toLowerCase();
      const name = $(el).attr('name') || '';
      const type = $(el).attr('type') || 'text';
      const value = $(el).attr('value') || '';
      const placeholder = $(el).attr('placeholder') || '';
      fields.push({ tag, name, type, value, placeholder });
      diag.inputs.push({ name, type });
    });
    forms.push({ action, method, fields });
  });
  diag.forms = forms.map((f) => ({ action: f.action, method: f.method, fieldNames: f.fields.map((x) => x.name) }));

  // --- انتخاب فرم اصلی (اولین فرم دارای فیلد) ---
  let mainForm = null;
  for (const f of forms) {
    if (f.fields.length > 0) { mainForm = f; break; }
  }
  if (!mainForm && forms.length) mainForm = forms[0];

  // --- پیدا کردن فیلد کپچا (input متنی که نامش به کپچا می‌خورد) ---
  let captchaInputName = null;
  if (mainForm) {
    for (const f of mainForm.fields) {
      if (f.type !== 'hidden' && f.tag !== 'select' && f.tag !== 'textarea') {
        if (matchesHint(f.name, RC.captcha_input_hints) || matchesHint(f.placeholder, RC.captcha_input_hints)) {
          captchaInputName = f.name;
          break;
        }
      }
    }
    // فال‌بک: اگر تصویر کپچا هست ولی فیلد آن با سرنخ پیدا نشد، اولین input متنی را کپچا بگیر
    if (!captchaInputName && captchaImgUrl) {
      const firstText = mainForm.fields.find((f) => f.type !== 'hidden' && f.tag !== 'select' && f.tag !== 'textarea');
      if (firstText) captchaInputName = firstText.name;
    }
  }

  // --- فیلدهای مسافر (متنی غیر مخفی، بدون کپچا) ---
  const passengerFields = [];
  if (mainForm) {
    for (const f of mainForm.fields) {
      if (f.type === 'hidden' || f.tag === 'select' || f.tag === 'textarea') continue;
      if (f.name === captchaInputName) continue;
      passengerFields.push(f);
    }
  }

  // --- فیلدهای مخفی (برای ارسال مجدد) ---
  const hiddenFields = {};
  if (mainForm) {
    for (const f of mainForm.fields) {
      if (f.type === 'hidden' && f.name) hiddenFields[f.name] = f.value;
    }
  }

  // --- استخراج مبلغ کل (در صورت وجود marker در صفحه) ---
  let totalPrice = null;
  const priceMarkers = RC.total_price_markers || [];
  for (const m of priceMarkers) {
    const idx = flatText.indexOf(m);
    if (idx >= 0) {
      // جستجوی نزدیک‌ترین عدد بعد از marker
      const near = flatText.slice(idx, idx + 200);
      totalPrice = parsePrice(near);
      if (totalPrice !== null) break;
    }
  }

  return {
    loginRequired,
    isPayment,
    isSuccess,
    captchaError,
    noCapacity,
    captchaImgUrl,
    captchaInputName,
    mainFormAction: mainForm ? mainForm.action : '',
    mainFormMethod: mainForm ? mainForm.method : 'post',
    hiddenFields,
    passengerFields,
    totalPrice,
    diag,
    rawTextLength: flatText.length,
  };
}

/** تفکیک آدرس نسبی به مطلق. */
function absoluteUrl(base, rel) {
  if (!rel) return '';
  try {
    return new URL(rel, base).toString();
  } catch (e) {
    return rel;
  }
}

/* =====================================================================
 * نگاشت داده مسافر به فیلدهای فرم
 * ===================================================================== */

/**
 * ساختن name→value برای فیلدهای مسافر.
 *
 * سایت صفیر ریل فیلدهای مسافر را با پسوند index می‌سازد:
 *   pid0, ruz0, mah0, sal0, fn0, ln0  ← مسافر ۰
 *   pid1, ruz1, mah1, sal1, fn1, ln1  ← مسافر ۱
 *   phone  ← شماره همراه (مشترک)
 *
 * استراتژی:
 *   ۱) نام فیلد را به (base, index) تجزیه کن (مثلاً pid0 → base=pid, index=0).
 *   ۲) base را بر اساس سرنخ‌های config به یک «کلید» (کد ملی/روز/ماه/سال/نام/...) نگاشت کن.
 *   ۳) مقدار را از مسافر با همان index برداشت کن.
 *   ۴) فیلدهایی که تطبیق نشدند را موقعیتی پر کن (fallback).
 */
function mapPassengerFields(passengerFields, passengers, extra) {
  const FIELD_ORDER = ['national_code', 'birth_day', 'birth_month', 'birth_year', 'first_name', 'last_name'];
  const hints = RC.passenger_field_hints || {};

  const assignments = [];
  const usedFields = new Set();

  // جدول سرنخ → کلید (برای جستجوی سریع)
  const KEY_BY_HINT = {};
  for (const key of [...FIELD_ORDER, 'phone']) {
    for (const h of hints[key] || []) {
      KEY_BY_HINT[h.toLowerCase()] = key;
    }
  }

  passengerFields.forEach((f, fi) => {
    const { base, index } = splitFieldName(f.name);
    const key = findFieldKey(base, f.name, f.placeholder, hints, KEY_BY_HINT);
    if (!key) return; // برای fallback موقعیتی باقی می‌ماند

    const passIndex = (index !== null && index !== undefined) ? index : 0;
    const p = (passengers || [])[passIndex] || {};

    let value = '';
    if (key === 'phone') {
      value = (extra && extra.phone) || '';
    } else {
      value = (p && p[key]) || '';
    }

    assignments.push({ name: f.name, key, value });
    usedFields.add(fi);
  });

  // fallback موقعیتی: فیلدهایی که با سرنخ تطبیق نشدند
  const remainingFields = passengerFields.filter((_f, i) => !usedFields.has(i));
  if (remainingFields.length > 0) {
    const flatValues = [];
    for (const p of passengers || []) {
      for (const key of FIELD_ORDER) {
        flatValues.push({ key, value: (p && p[key]) || '' });
      }
    }
    const n = Math.min(remainingFields.length, flatValues.length);
    for (let i = 0; i < n; i++) {
      assignments.push({ name: remainingFields[i].name, key: flatValues[i].key, value: flatValues[i].value });
    }
  }

  return assignments;
}

/** تجزیه نام فیلد به base و index (pid0 → {base:'pid', index:0}). */
function splitFieldName(name) {
  const n = normalizeName(name);
  const re = new RegExp(RC.field_index_regex || '^([a-zA-Z_]+?)(\\d+)$');
  const m = n.match(re);
  if (m) return { base: m[1], index: parseInt(m[2], 10) };
  return { base: n, index: null };
}

/** پیدا کردن کلید داده بر اساس base/name/placeholder. */
function findFieldKey(base, name, placeholder, hints, keyByHint) {
  // ۱) تطبیق دقیق base با سرنخ
  if (keyByHint[base] !== undefined) return keyByHint[base];
  // ۲) تطبیق زیررشته‌ای base
  for (const [h, key] of Object.entries(keyByHint)) {
    if (base.includes(h)) return key;
  }
  // ۳) تطبیق زیررشته‌ای نام/placeholder کامل
  const np = normalizeName(name) + ' ' + normalizeName(placeholder);
  for (const [h, key] of Object.entries(keyByHint)) {
    if (np.includes(h)) return key;
  }
  return null;
}

/* =====================================================================
 * توکن وضعیت (stateless)
 * ===================================================================== */

function encodeState(state) {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}
function decodeState(token) {
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

/* =====================================================================
 * شروع رزرو — مرحله ۱ (POST به TresV.php)
 * ===================================================================== */

async function startReservation({ fields, passengers, train, cookies }) {
  const built = buildReserveForm({ fields, passengers, train });
  if (!built.ok) return built;
  const reserveData = built.reserveData;
  const formHtml = built.formHtml;

  // --- ارکستراسیون: ایجاد workflow و ثبت رویداد شروع ---
  // (رزرو از حالت TRAIN_SELECTED آغاز می‌شود؛ جستجو قبلاً در core.js انجام شده است)
  const workflow = createWorkflow({
    from_city: (fields && fields.from_city) || '',
    to_city: (fields && fields.to_city) || '',
    date: (fields && fields.date) || '',
    train_number: train && train['شماره قطار'],
    srvc: train && train['srvc'],
    passenger_count: (passengers || []).length,
  }, STATES.TRAIN_SELECTED);
  transition(workflow, STATES.RESERVATION_START);
  logEvent(workflow, 'RESERVATION_STARTED', {
    train_number: train && train['شماره قطار'],
    passenger_count: (passengers || []).length,
  });

  const action = config.base_url + config.reserve_url;
  let result;
  try {
    result = await fetchFollowing(action, {
      method: 'POST',
      headers: buildHeaders(),
      body: toUrlEncoded(reserveData),
      jar: cookies || [],
    });
  } catch (e) {
    logEvent(workflow, 'NETWORK_ERROR', { category: 'NETWORK_ERROR', message: e.message || String(e) });
    return { ok: false, error: e.message || String(e), workflow_id: workflow.workflow_id };
  }

  const analysis = analyzeHtml(result.html, result.finalUrl);

  // خلاصه رزرو (برای نمایش/تأیید نهایی و خروجی استاندارد)
  const booking = {
    origin: (fields && fields.from_city) || '',
    destination: (fields && fields.to_city) || '',
    date: (fields && fields.date) || '',
    time: train && train['ساعت حرکت'],
    company: train && train['شرکت'],
    train_number: train && train['شماره قطار'],
    train_type: train && train['نوع کوپه'],
    passengers: (passengers || []).length,
    ticket_price: parsePrice(train && train['قیمت']) || 0,
  };

  const state = {
    reserveData,
    jar: result.jar,
    fromUrl: result.finalUrl,
    step: 'start',
    workflow_id: workflow.workflow_id,
    agentState: workflow.state,
    expectedPrice: booking.ticket_price, // قیمت از نتیجه جستجو (برای اعتبارسنجی بعدی)
    servicePrice: 0,
    booking,
  };

  // انتقال حالت بر اساس تحلیل صفحه
  if (analysis.loginRequired) {
    tryTransition(workflow, STATES.LOGIN_REQUIRED);
  } else {
    transition(workflow, STATES.RESERVATION_STATE_READY);
  }
  state.agentState = workflow.state;
  logEvent(workflow, 'RESERVATION_STATE_READY', {
    finalUrl: result.finalUrl,
    formCount: analysis.diag.forms.length,
    inputCount: analysis.diag.inputs.length,
  });

  const stepResp = buildStepResponse(analysis, state, result, passengers, workflow);
  stepResp.formHtml = formHtml; // fallback برای دانلود دستی
  stepResp.workflow_id = workflow.workflow_id;
  return stepResp;
}

/* =====================================================================
 * ارسال مرحله (کپچا + اطلاعات مسافر)
 * ===================================================================== */

async function submitReservation({ stateToken, captcha, passengers, phone }) {
  const state = decodeState(stateToken);
  if (!state) return { ok: false, error: 'وضعیت رزرو نامعتبر یا منقضی شده است. دوباره شروع کنید.' };

  // --- ارکستراسیون: بازسازی workflow از state (یا ایجاد جدید) ---
  const workflow = {
    workflow_id: state.workflow_id || ('wf_' + Date.now()),
    state: state.agentState || STATES.RESERVATION_STATE_READY,
    events: [],
    done: state.done || {},
    meta: {},
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  // --- Idempotency: جلوگیری از ارسال تکراری همان مرحله به صفحه پرداخت ---
  if (state.agentState === STATES.PAYMENT_HANDOFF || state.agentState === STATES.PAYMENT_PENDING) {
    return {
      ok: false,
      error: 'عملیات رزرو قبلاً به مرحله پرداخت رسیده است؛ از ارسال مجدد خودداری شد.',
      step: 'idempotency_blocked',
      workflow_id: workflow.workflow_id,
    };
  }

  // ساختن بدنه ارسال: فیلدهای مخفی + کپچا + اطلاعات مسافر
  const body = { ...(state.hiddenFields || {}) };

  if (captcha !== undefined && captcha !== null && captcha !== '') {
    if (state.captchaInputName) body[state.captchaInputName] = captcha;
  }

  // اطلاعات مسافر (اتوفیل) + شماره همراه
  const passList = passengers || state.passengers || [];
  const assignments = mapPassengerFields(state.passengerFields || [], passList, { phone });
  for (const a of assignments) {
    body[a.name] = a.value;
  }

  // --- ثبت رویداد (بدون ثبت کپچا/کد ملی خام) ---
  tryTransition(workflow, STATES.PASSENGER_FORM);
  tryTransition(workflow, STATES.PASSENGER_DATA_VALIDATED);
  logEvent(workflow, 'PASSENGER_DATA_SUBMITTED', {
    passenger_count: passList.length,
    field_count: assignments.length,
  });

  const action = absoluteUrl(state.mainFormAction || '', state.fromUrl || config.base_url + config.reserve_url);
  const method = state.mainFormMethod || 'post';

  let result;
  try {
    result = await fetchFollowing(action, {
      method: method.toUpperCase(),
      headers: buildHeaders(),
      body: method === 'get' ? null : toUrlEncoded(body),
      jar: state.jar,
    });
  } catch (e) {
    logEvent(workflow, 'NETWORK_ERROR', { category: 'NETWORK_ERROR', message: e.message || String(e) });
    return { ok: false, error: e.message || String(e), workflow_id: workflow.workflow_id };
  }

  const analysis = analyzeHtml(result.html, result.finalUrl);

  // --- اعتبارسنجی قیمت (در صورت استخراج مبلغ کل از صفحه) ---
  let priceCheck = null;
  if (analysis.totalPrice !== null && analysis.totalPrice !== undefined) {
    priceCheck = validatePrice({
      ticket: state.expectedPrice || 0,
      services: state.servicePrice || 0,
      total: analysis.totalPrice,
      tolerance: RC.price_tolerance || 0,
    });
    if (priceCheck.ok) {
      tryTransition(workflow, STATES.PRICE_VALIDATED);
    } else {
      tryTransition(workflow, STATES.PRICE_CHANGED);
      logEvent(workflow, 'PRICE_CHANGED', {
        expected: priceCheck.expected,
        actual: priceCheck.actual,
        diff: priceCheck.diff,
      });
    }
  }

  const newState = {
    ...state,
    jar: result.jar,
    fromUrl: result.finalUrl,
    step: state.step === 'start' ? 'submit' : state.step,
    lastCaptcha: captcha,
    workflow_id: workflow.workflow_id,
    agentState: workflow.state,
    done: workflow.done,
    expectedPrice: state.expectedPrice,
    servicePrice: state.servicePrice,
  };

  const stepResp = buildStepResponse(analysis, newState, result, passList, workflow);
  stepResp.priceCheck = priceCheck;
  stepResp.workflow_id = workflow.workflow_id;

  // ثبت رویداد پرداخت در صورت رسیدن به درگاه
  if (stepResp.step === 'payment' || stepResp.step === 'success') {
    logEvent(workflow, 'PAYMENT_HANDOFF', { paymentUrl: stepResp.paymentUrl ? '[URL]' : '' });
  }
  return stepResp;
}

/* =====================================================================
 * ساخت پاسخ مرحله
 * ===================================================================== */

function buildStepResponse(analysis, state, result, passengers, workflow) {
  // --- ابتدا تعیین مرحله و اعمال انتقال‌ها (تا stateToken با حالت نهایی ساخته شود) ---
  let step, message, extra = {};

  if (analysis.loginRequired) {
    if (workflow) tryTransition(workflow, STATES.LOGIN_REQUIRED);
    step = 'login_required';
    message = 'صفحه رزرو نیاز به ورود دارد. کوکی‌های نشست (PHPSESSID) معتبر نیست. در صفحه «ورود» کوکی‌ها را همگام‌سازی کنید.';
  } else if (analysis.isSuccess) {
    if (workflow) { tryTransition(workflow, STATES.PAYMENT_HANDOFF); tryTransition(workflow, STATES.PAYMENT_PENDING); tryTransition(workflow, STATES.PAYMENT_RESULT); }
    step = 'success';
    message = 'رزرو با موفقیت انجام شد.';
    extra.paymentUrl = extractPaymentUrl(analysis, result);
  } else if (analysis.isPayment) {
    if (workflow) { tryTransition(workflow, STATES.CONFIRMATION_READY); tryTransition(workflow, STATES.PAYMENT_HANDOFF); }
    step = 'payment';
    message = 'رزرو تأیید شد؛ در حال انتقال به صفحه پرداخت.';
    extra.paymentUrl = extractPaymentUrl(analysis, result);
  } else if (analysis.noCapacity) {
    if (workflow) tryTransition(workflow, STATES.NO_CAPACITY);
    step = 'no_capacity';
    message = 'ظرفیت این قطار تکمیل شده است.';
  } else if (analysis.captchaImgUrl || analysis.captchaInputName) {
    if (workflow) tryTransition(workflow, STATES.CAPTCHA_REQUIRED);
    step = 'captcha';
    message = analysis.captchaError
      ? 'کپچای واردشده اشتباه بود. دوباره تلاش کنید.'
      : 'برای ادامه، کد امنیتی (کپچا) را وارد کنید.';
    extra.captchaImageUrl = absoluteUrl(result.finalUrl, analysis.captchaImgUrl);
    extra.captchaInputName = analysis.captchaInputName;
    extra.captchaError = analysis.captchaError;
  } else {
    step = 'passenger_form';
    message = 'فرم اطلاعات مسافر دریافت شد. اطلاعات از پیش واردشده به‌صورت خودکار تکمیل می‌شود.';
    extra.passengerFieldNames = (analysis.passengerFields || []).map((f) => f.name);
  }

  // --- ساخت stateToken با حالت نهایی workflow ---
  const finalAgentState = workflow ? workflow.state : state.agentState;
  const stateToken = encodeState({
    ...state,
    agentState: finalAgentState,
    hiddenFields: analysis.hiddenFields,
    captchaInputName: analysis.captchaInputName,
    mainFormAction: analysis.mainFormAction,
    mainFormMethod: analysis.mainFormMethod,
    passengerFields: analysis.passengerFields,
    passengers,
  });

  return {
    ok: true,
    stateToken,
    step,
    message,
    diagnostics: analysis.diag,
    finalUrl: result.finalUrl,
    workflow_id: state.workflow_id || (workflow && workflow.workflow_id),
    agentState: finalAgentState,
    totalPrice: analysis.totalPrice,
    expectedPrice: state.expectedPrice,
    booking: state.booking || null,
    ...extra,
  };
}

/** استخراج URL پرداخت/درگاه (لینک فرم یا redirect). */
function extractPaymentUrl(analysis, result) {
  // اگر صفحه حاوی فرم پرداخت با action باشد، آن را برگردان
  const action = analysis.mainFormAction;
  if (action) return absoluteUrl(result.finalUrl, action);
  return result.finalUrl;
}

/* =====================================================================
 * دریافت تصویر کپچا به‌صورت base64 (برای نمایش در UI)
 * ===================================================================== */

async function fetchCaptchaImage(captchaImageUrl, stateToken) {
  const state = decodeState(stateToken);
  const jar = state ? state.jar : [];
  try {
    const resp = await fetch(captchaImageUrl, {
      headers: { ...buildHeaders(), Cookie: cookieHeader(jar) },
    });
    if (!resp.ok) return { ok: false, error: 'دریافت تصویر کپچا ناموفق بود (کد ' + resp.status + ')' };
    const buf = Buffer.from(await resp.arrayBuffer());
    const mime = resp.headers.get('content-type') || 'image/png';
    return { ok: true, dataUri: 'data:' + mime + ';base64,' + buf.toString('base64') };
  } catch (e) {
    return { ok: false, error: 'خطا در دریافت تصویر کپچا: ' + (e.message || e) };
  }
}

/* =====================================================================
 * حل خودکار کپچا (OCR) — دریافت تصویر + OCR + بازگرداندن متن
 * ===================================================================== */

async function fetchCaptchaBuffer(captchaImageUrl, stateToken) {
  const state = decodeState(stateToken);
  const jar = state ? state.jar : [];
  const resp = await fetch(captchaImageUrl, {
    headers: { ...buildHeaders(), Cookie: cookieHeader(jar) },
  });
  if (!resp.ok) throw new Error('دریافت تصویر کپچا ناموفق بود (کد ' + resp.status + ')');
  return Buffer.from(await resp.arrayBuffer());
}

async function solveCaptchaImage({ captchaImageUrl, stateToken }) {
  const { solveCaptcha } = require('./captcha');
  try {
    const buf = await fetchCaptchaBuffer(captchaImageUrl, stateToken);
    const result = await solveCaptcha(buf);
    return result;
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

module.exports = {
  parseSetCookie,
  mergeCookies,
  cookieHeader,
  responseSetCookies,
  fetchFollowing,
  analyzeHtml,
  mapPassengerFields,
  encodeState,
  decodeState,
  startReservation,
  submitReservation,
  fetchCaptchaImage,
  solveCaptchaImage,
};
