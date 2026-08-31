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
 * استراتژی: ابتدا تطبیق بر اساس سرنخ نام فیلد (از config)، و در صورت
 * نبودِ تطبیق، انتساب موقعیتی (ترتیب فیلدها = ترتیب داده مسافر).
 */
function mapPassengerFields(passengerFields, passengers) {
  const FIELD_ORDER = ['national_code', 'birth_day', 'birth_month', 'birth_year', 'first_name', 'last_name'];
  const hints = RC.passenger_field_hints || {};

  // فهرست مسطح داده‌ها (به ترتیب مسافر، سپس فیلد)
  const flatValues = [];
  for (const p of passengers || []) {
    for (const key of FIELD_ORDER) {
      flatValues.push({ key, value: (p && p[key]) || '' });
    }
  }

  const assignments = []; // { name, key, value }
  const usedFields = new Set();
  const usedValues = new Set();

  // گذر ۱: تطبیق بر اساس سرنخ نام/placeholder فیلد
  for (let vi = 0; vi < flatValues.length; vi++) {
    const v = flatValues[vi];
    const hintList = hints[v.key] || [];
    if (!hintList.length) continue;
    for (let i = 0; i < passengerFields.length; i++) {
      const f = passengerFields[i];
      if (usedFields.has(i)) continue;
      if (matchesHint(f.name, hintList) || matchesHint(f.placeholder, hintList)) {
        assignments.push({ name: f.name, key: v.key, value: v.value });
        usedFields.add(i);
        usedValues.add(vi);
        break;
      }
    }
  }

  // گذر ۲: انتساب موقعیتی برای باقی‌مانده (ترتیب فیلد = ترتیب داده)
  const remainingFields = passengerFields.filter((_f, i) => !usedFields.has(i));
  const remainingValues = flatValues.filter((_v, i) => !usedValues.has(i));
  const n = Math.min(remainingFields.length, remainingValues.length);
  for (let i = 0; i < n; i++) {
    assignments.push({ name: remainingFields[i].name, key: remainingValues[i].key, value: remainingValues[i].value });
  }

  return assignments;
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
    return { ok: false, error: e.message || String(e) };
  }

  const analysis = analyzeHtml(result.html, result.finalUrl);

  const state = {
    reserveData,
    jar: result.jar,
    fromUrl: result.finalUrl,
    step: 'start',
  };

  const stepResp = buildStepResponse(analysis, state, result, passengers);
  stepResp.formHtml = formHtml; // fallback برای دانلود دستی
  return stepResp;
}

/* =====================================================================
 * ارسال مرحله (کپچا + اطلاعات مسافر)
 * ===================================================================== */

async function submitReservation({ stateToken, captcha, passengers }) {
  const state = decodeState(stateToken);
  if (!state) return { ok: false, error: 'وضعیت رزرو نامعتبر یا منقضی شده است. دوباره شروع کنید.' };

  // ساختن بدنه ارسال: فیلدهای مخفی + کپچا + اطلاعات مسافر
  const body = { ...(state.hiddenFields || {}) };

  if (captcha !== undefined && captcha !== null && captcha !== '') {
    if (state.captchaInputName) body[state.captchaInputName] = captcha;
  }

  // اطلاعات مسافر (اتوفیل)
  const passList = passengers || state.passengers || [];
  const assignments = mapPassengerFields(state.passengerFields || [], passList);
  for (const a of assignments) {
    body[a.name] = a.value;
  }

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
    return { ok: false, error: e.message || String(e) };
  }

  const analysis = analyzeHtml(result.html, result.finalUrl);

  const newState = {
    ...state,
    jar: result.jar,
    fromUrl: result.finalUrl,
    step: state.step === 'start' ? 'submit' : state.step,
    lastCaptcha: captcha,
  };

  return buildStepResponse(analysis, newState, result, passList);
}

/* =====================================================================
 * ساخت پاسخ مرحله
 * ===================================================================== */

function buildStepResponse(analysis, state, result, passengers) {
  const stateToken = encodeState({
    ...state,
    hiddenFields: analysis.hiddenFields,
    captchaInputName: analysis.captchaInputName,
    mainFormAction: analysis.mainFormAction,
    mainFormMethod: analysis.mainFormMethod,
    passengerFields: analysis.passengerFields,
    passengers,
  });

  const base = {
    ok: true,
    stateToken,
    diagnostics: analysis.diag,
    finalUrl: result.finalUrl,
  };

  // ترتیب اولویت تشخیص مرحله
  if (analysis.loginRequired) {
    return {
      ...base,
      step: 'login_required',
      message: 'صفحه رزرو نیاز به ورود دارد. کوکی‌های نشست (PHPSESSID) معتبر نیست. در صفحه «ورود» کوکی‌ها را همگام‌سازی کنید.',
    };
  }

  if (analysis.isSuccess) {
    return {
      ...base,
      step: 'success',
      message: 'رزرو با موفقیت انجام شد.',
      paymentUrl: extractPaymentUrl(analysis, result),
    };
  }

  if (analysis.isPayment) {
    return {
      ...base,
      step: 'payment',
      message: 'رزرو تأیید شد؛ در حال انتقال به صفحه پرداخت.',
      paymentUrl: extractPaymentUrl(analysis, result),
    };
  }

  if (analysis.noCapacity) {
    return {
      ...base,
      step: 'no_capacity',
      message: 'ظرفیت این قطار تکمیل شده است.',
    };
  }

  if (analysis.captchaImgUrl || analysis.captchaInputName) {
    return {
      ...base,
      step: 'captcha',
      message: analysis.captchaError
        ? 'کپچای واردشده اشتباه بود. دوباره تلاش کنید.'
        : 'برای ادامه، کد امنیتی (کپچا) را وارد کنید.',
      captchaImageUrl: absoluteUrl(result.finalUrl, analysis.captchaImgUrl),
      captchaInputName: analysis.captchaInputName,
      captchaError: analysis.captchaError,
    };
  }

  // هیچ کپچا/پرداخت/موفقیتی نبود → فرم اطلاعات مسافر (یا مرحله ناشناخته)
  return {
    ...base,
    step: 'passenger_form',
    message: 'فرم اطلاعات مسافر دریافت شد. اطلاعات از پیش واردشده به‌صورت خودکار تکمیل می‌شود.',
    passengerFieldNames: (analysis.passengerFields || []).map((f) => f.name),
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
};
