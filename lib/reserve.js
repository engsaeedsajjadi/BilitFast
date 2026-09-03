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

/**
 * حل یک آدرس (مطلق یا نسبی) نسبت به یک آدرس پایه.
 *
 * - اگر url از قبل مطلق باشد (دارای scheme مثل http/https/data)، همان برمی‌گردد.
 * - اگر نسبی باشد، با base ترکیب می‌شود (مانند new URL در مرورگر).
 * - در صورت نامعتبر بودن، خود url برگردانده می‌شود (fallback امن).
 */
function absoluteUrl(url, base) {
  const u = String(url || '');
  if (!u) return base || '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u; // مطلق (http/https/data/...)
  const b = String(base || '');
  if (!b) return u;
  try {
    return new URL(u, b).toString();
  } catch (e) {
    return u;
  }
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
    timeoutMs = 30000,
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
      resp = await fetch(current, {
        method: curMethod,
        headers: h,
        body: curBody,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = (e && e.message) ? e.message : String(e);
      if (e && e.name === 'AbortError') {
        throw new Error('اتصال به صفیر ریل بیش از ' + Math.round(timeoutMs / 1000) + ' ثانیه طول کشید (timeout).');
      }
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket|TLS|SSL|ETIMEDOUT/i.test(msg)) {
        throw new Error('اتصال به صفیر ریل برقرار نشد (' + msg + '). برنامه را روی سیستم خودتان (IP ایران) اجرا کنید.');
      }
      throw e;
    }
    clearTimeout(timer);

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
 * ماسک کردن ارقام طولانی (کد ملی/موبایل/توکن) در یک رشته متنی.
 */
function maskDigitsInText(v) {
  const s = String(v == null ? '' : v);
  let out = s.replace(/\d{8,}/g, (d) => '***' + d.slice(-3));
  if (out.length > 60) out = out.slice(0, 60) + '…';
  return out;
}

/** فشرده‌سازی متن صفحه (حذف فاصله‌های اضافی). */
function collapseText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** مقدار امن برای diagnostics: فقط برای فیلدهای غیرمخفی و بدون PII. */
function safeFieldValue(f) {
  if (f.type === 'hidden' || f.type === 'password') return undefined;
  if (!f.value) return undefined;
  const v = String(f.value);
  if (/token|session|csrf|auth|sign|pass|secret/i.test(f.effName + ' ' + v)) return undefined;
  return maskDigitsInText(v);
}

/**
 * HTML خام را برای تشخیص، با ماسک‌کردن توکن‌ها/رشته‌های طولانی آماده می‌کند.
 * فقط برای رفع اشکال ساختار فرم؛ مقدار فیلدهای مخفی/توکن حذف می‌شود.
 */
function maskHtmlForDiagnostics(htmlText) {
  let s = String(htmlText || '');
  // حذف مقدار توکن‌های طولانی (base64/hex) و اعداد طولانی
  s = s.replace(/([A-Za-z0-9+/=_-]{40,})/g, '[TOKEN]');
  s = s.replace(/\d{8,}/g, '***');
  // محدود کردن طول برای جلوگیری از لاگ حجیم
  if (s.length > 4000) s = s.slice(0, 4000) + '…';
  return s;
}

/**
 * ماسک سبک‌تر برای محتوای اسکریپت‌های سایت.
 *
 * برخلاف maskHtmlForDiagnostics، ارقام کوتاه (مانند مجموعه‌کاراکتر کپچا
 * مثل «0123456789» که از ۸ رقم بیشتر است) را ماسک نمی‌کند؛ فقط توکن‌های
 * طولانی base64/hex (که ممکن است کلید/سشن باشند) حذف می‌شوند. اسکریپت‌های
 * سایت کدِ خودِ صفیر ریل هستند و PII کاربر را ندارند، پس نمایش کامل‌تر
 * آن‌ها برای مهندسی معکوس جریان کپچا/ارسال فرم ضروری است.
 */
function maskScriptForDiagnostics(s) {
  let out = String(s || '');
  out = out.replace(/([A-Za-z0-9+/=_-]{40,})/g, '[TOKEN]');
  if (out.length > 4000) out = out.slice(0, 4000) + '…';
  return out;
}

/**
 * تجزیه پاسخ HTML یک مرحله از رزرو.
 * خروجی شامل: نوع مرحله (classification)، فرم action، همه فیلدها،
 * آدرس تصویر کپچا، نام فیلد کپچا، و تشخیص کامل (diagnostics) از ساختار DOM
 * — بدون حدس زدن مرحله و بدون ثبت مقدار حساس.
 */
function analyzeHtml(htmlText, baseUrl) {
  const $ = cheerio.load(htmlText);
  const flatText = $('body').text() || '';

  // --- مارکرها + شواهد (کدام مارکرها match شدند) ---
  const markerHits = {
    login: (RC.login_markers || []).filter((m) => flatText.includes(m)),
    payment: (RC.payment_markers || []).filter((m) => flatText.includes(m)),
    success: (RC.success_markers || []).filter((m) => flatText.includes(m)),
    noCapacity: (RC.no_capacity_markers || []).filter((m) => flatText.includes(m)),
    captchaError: (RC.captcha_error_markers || []).filter((m) => flatText.includes(m)),
  };
  const loginRequired = markerHits.login.length > 0;
  const isPayment = markerHits.payment.length > 0;
  const isSuccess = markerHits.success.length > 0;
  const captchaError = markerHits.captchaError.length > 0;
  const noCapacity = markerHits.noCapacity.length > 0;

  // --- همه تصاویر (برای پیدا کردن کپچا) ---
  // نکته: کپچای صفحه رزرو به‌صورت data-URI داخل <img id="captchaImg"> است،
  // نه یک URL مجزا. پس هم data-URI و هم URL تشخیص داده می‌شود.
  const images = [];
  let captchaImgUrl = null;
  let captchaDataUri = null;
  $('img').each((_i, el) => {
    const src = $(el).attr('src') || '';
    const id = ($(el).attr('id') || '').toLowerCase();
    const alt = ($(el).attr('alt') || '').toLowerCase();
    images.push(src);
    if (!captchaImgUrl && !captchaDataUri) {
      const isCaptchaId = /captcha|kaptcha|security/.test(id + ' ' + alt);
      const lower = src.toLowerCase();
      const hit = isCaptchaId || (RC.captcha_img_selectors || []).some((sel) => {
        const token = sel.replace(/^img\[src\*='([^']*)'\]$/, '$1');
        return token && lower.includes(token.toLowerCase());
      });
      if (hit) {
        if (/^data:image/i.test(src)) captchaDataUri = src;
        else captchaImgUrl = src;
      }
    }
  });

  // fallback: کپچا ممکن است در src/href/action به‌صورت URL یا data-URI باشد
  if (!captchaImgUrl && !captchaDataUri) {
    const m = htmlText.match(/(?:src|href|data-src|action)\s*=\s*["']([^"']*(?:kcaptcha|captcha|kaptcha|securitycode)[^"']*)["']/i);
    if (m) {
      if (/^data:image/i.test(m[1])) captchaDataUri = m[1];
      else captchaImgUrl = m[1];
    }
  }
  // ثبت هر ارجاع به کپچا در HTML (برای تشخیص بدون حدس)
  const captchaRefs = (htmlText.match(/(?:kcaptcha|captcha|kaptcha)[^\s"'<>]*/gi) || []).slice(0, 20);

  // --- تجزیه فرم‌ها (شامل input/select/textarea/button) ---
  // نکته مهم: سایت صفیر ریل برخی فیلدها (به‌ویژه فیلدهای مسافر و کپچا) را
  // به‌جای `name` با `id` مشخص می‌کند. بنابراین `id` هم خوانده می‌شود و
  // «نام مؤثر» = name و در صورت خالی بودن = id در نظر گرفته می‌شود.
  const forms = [];
  const allInputs = [];
  $('form').each((_fi, fel) => {
    const action = $(fel).attr('action') || '';
    const method = ($(fel).attr('method') || 'post').toLowerCase();
    const name = $(fel).attr('name') || '';
    const fields = [];
    $(fel).find('input, select, textarea, button').each((_i, el) => {
      const tag = el.tagName.toLowerCase();
      const name = $(el).attr('name') || '';
      const id = $(el).attr('id') || '';
      const type = $(el).attr('type') || (tag === 'button' ? 'button' : 'text');
      const value = $(el).attr('value') || '';
      const placeholder = $(el).attr('placeholder') || '';
      const onclick = $(el).attr('onclick') || '';
      const onchange = $(el).attr('onchange') || '';
      const checked = $(el).attr('checked') !== undefined;
      const effName = name || id; // نام مؤثر برای تطبیق
      // مقدار گزینه انتخاب‌شده برای select (برای ارسال مجدد)
      let selectedValue = '';
      if (tag === 'select') {
        const opt = $(el).find('option[selected]').first();
        if (opt.length) selectedValue = opt.attr('value') || opt.text() || '';
        else {
          const first = $(el).find('option').first();
          selectedValue = first.length ? (first.attr('value') || first.text() || '') : '';
        }
      }
      fields.push({ tag, name, id, effName, type, value, placeholder, onclick, onchange, checked, selectedValue });
      if (tag !== 'button') allInputs.push({ name: effName, id, type });
    });
    forms.push({ action, method, name, fields });
  });

  // --- انتخاب فرم اصلی (فرم رزرو) ---
  // اولویت: فرمی که action آن TresV باشد، بعد name=mainFrm، بعد فرم با بیشترین فیلد.
  let mainForm = null;
  for (const f of forms) {
    if (/tresv/i.test(f.action) && f.fields.length > 0) { mainForm = f; break; }
  }
  if (!mainForm) {
    for (const f of forms) {
      if (/mainfrm/i.test(f.name) && f.fields.length > 0) { mainForm = f; break; }
    }
  }
  if (!mainForm) {
    let best = null;
    for (const f of forms) {
      if (!best || f.fields.length > best.fields.length) best = f;
    }
    mainForm = best;
  }
  if (!mainForm && forms.length) mainForm = forms[0];

  // --- پیدا کردن فیلد کپچا ---
  // در صفیر ریل، ورودی کد کپچا معمولاً `Ksubmit` نام دارد (کنار captchaId/ajResponse).
  const captchaInputNames = (RC.captcha_input_names || []).map((n) => n.toLowerCase());
  let captchaInputName = null;
  if (mainForm) {
    for (const f of mainForm.fields) {
      if (f.type === 'submit' || f.type === 'button' || f.type === 'image' || f.type === 'reset') continue;
      if (f.type === 'hidden' || f.tag === 'select' || f.tag === 'textarea' || f.tag === 'button') continue;
      const eff = f.effName.toLowerCase();
      const fid = f.id.toLowerCase();
      if (matchesHint(f.effName, RC.captcha_input_hints) ||
          matchesHint(f.id, RC.captcha_input_hints) ||
          matchesHint(f.placeholder, RC.captcha_input_hints) ||
          captchaInputNames.includes(eff) ||
          captchaInputNames.includes(fid)) {
        captchaInputName = f.effName;
        break;
      }
    }
  }

  // --- فیلدهای مسافر (ورودی‌های قابل‌پرکردن، بدون کپچا/غذا/رادیو/دکمه) ---
  // نکته مهم: دکمه‌های صفحه (مانند submit/button با نام خالی یا srchC) نباید
  // فیلد مسافر شمرده شوند؛ وگرنه در fallback موقعیتی، مقادیر مسافر (کد ملی و...)
  // به نام آن دکمه‌ها نسبت داده می‌شود و بدنه POST خراب می‌شود.
  const passengerFields = [];
  if (mainForm) {
    for (const f of mainForm.fields) {
      if (f.type === 'hidden' || f.type === 'radio' || f.type === 'checkbox') continue;
      if (f.type === 'submit' || f.type === 'button' || f.type === 'image' || f.type === 'reset') continue;
      if (f.tag === 'select' || f.tag === 'textarea' || f.tag === 'button') continue;
      if (!f.effName) continue; // بدون name و id → قابل ارسال نیست
      if (f.effName === captchaInputName) continue;
      if (matchesHint(f.effName, RC.non_passenger_field_hints) ||
          matchesHint(f.id, RC.non_passenger_field_hints)) continue;
      passengerFields.push(f);
    }
  }

  // --- فیلدهای مخفی (برای ارسال مجدد؛ نام + مقدار واقعی برای submit) ---
  const hiddenFields = {};
  const hiddenFieldNames = [];
  if (mainForm) {
    for (const f of mainForm.fields) {
      if (f.type === 'hidden' && f.effName) {
        hiddenFields[f.effName] = f.value;
        hiddenFieldNames.push(f.effName);
      }
    }
  }

  // --- مقادیر selectها (برای ارسال مجدد؛ از/to/sex/food0) ---
  const selectValues = {};
  if (mainForm) {
    for (const f of mainForm.fields) {
      if (f.tag === 'select' && f.effName) {
        selectValues[f.effName] = f.selectedValue;
      }
    }
  }

  // --- «همه فیلدهای فرم» با مقدار فعلی صفحه (برای ارسال دقیقاً مثل فرم واقعی) ---
  // وقتی فرم مسافر با chkForm() به VerifyTck.php ارسال می‌شود، مرورگر همه فیلدهای
  // دارای name را می‌فرستد (hidden + text + radio/checkbox انتخاب‌شده + select)،
  // نه فقط فیلدهای مخفی. اینجا همان مجموعه را بازسازی می‌کنیم تا بدنه POST با
  // فرم واقعی مطابقت داشته باشد (مثلاً RadioGroup2 که کد ملی/گذرنامه را تعیین می‌کند).
  const formFieldValues = { ...hiddenFields, ...selectValues };
  if (mainForm) {
    for (const f of mainForm.fields) {
      if (!f.effName) continue;
      if (f.tag === 'button') continue;
      if (f.type === 'radio' || f.type === 'checkbox') {
        if (f.checked) formFieldValues[f.effName] = f.value || 'on';
        continue;
      }
      if (f.type === 'hidden' || f.tag === 'select') continue; // قبلاً اضافه شد
      if (f.type === 'submit' || f.type === 'image' || f.type === 'reset') continue;
      // فیلد متنی قابل‌مشاهده (text/password/email/...) → مقدار فعلی
      formFieldValues[f.effName] = f.value || '';
    }
  }

  // --- کنترل‌های قابل‌مشاهده (برای تشخیص intermediate) ---
  let hasVisibleFields = false;
  let hasButtons = false;
  if (mainForm) {
    for (const f of mainForm.fields) {
      if (f.tag === 'button') { hasButtons = true; continue; }
      if (f.type === 'hidden') continue;
      if (f.tag === 'select' || f.tag === 'textarea') { hasVisibleFields = true; continue; }
      if (f.type === 'submit' || f.type === 'button' || f.type === 'image' || f.type === 'reset') { hasButtons = true; continue; }
      hasVisibleFields = true;
    }
  }

  // --- استخراج اسکریپت‌ها، هندلرها و endpointها (برای مهندسی معکوس جریان AJAX) ---
  // صفحه رزرو صفیر ریل با جاوااسکریپت رندر می‌شود: کپچا و فیلدهای مسافر بعد از
  // لود صفحه با AJAX تزریق می‌شوند. توابع اصلی (chkForm/setRadio/calcPrice/
  // makePOSTRequest) در فایل‌های .js خارجی تعریف شده‌اند نه inline — بنابراین
  // آدرس scriptهای خارجی هم ثبت می‌شود تا همان فایل‌ها را fetch کنیم.
  const scripts = [];
  const externalScripts = [];
  $('script').each((_i, el) => {
    const src = ($(el).attr('src') || '').trim();
    if (src) {
      externalScripts.push(src);
      return;
    }
    const txt = ($(el).html() || '').replace(/\s+/g, ' ').trim();
    if (txt) scripts.push(maskScriptForDiagnostics(txt));
  });
  const externalStyles = [];
  $('link[rel="stylesheet"]').each((_i, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (href) externalStyles.push(href);
  });
  // ثبت صریح هر ارجاع به فایل .js در HTML (حتی خارج از تگ script، مثل onclick)
  const jsRefs = Array.from(new Set(
    (htmlText.match(/[\"'=]([^\"'\\s]*(?:\\.js)[^\"'\\s]*)[\"']?/gi) || []).map((s) => s.replace(/^[\"'=]+/, ''))
  )).slice(0, 30);
  const handlers = [];
  if (mainForm) {
    for (const f of mainForm.fields) {
      if (f.onclick || f.onchange) {
        handlers.push({
          tag: f.tag,
          type: f.type,
          name: f.effName,
          id: f.id,
          onclick: (f.onclick || '').slice(0, 300),
          onchange: (f.onchange || '').slice(0, 300),
        });
      }
    }
  }
  const endpoints = Array.from(new Set(
    (htmlText.match(/["'=]([^"'\s]*\.php[^"'\s]*)["']?/gi) || []).map((s) => s.replace(/^["'=]+/, ''))
  )).slice(0, 30);

  // --- پیام‌های خطای سرور (alert در جاوااسکریپت پاسخ) ---
  // وقتی سرور رزرو را رد می‌کند، یک alert قطعی با ریدایرکت می‌گذارد:
  //   alert('101-متاسفانه ارائه سرویس رفت ...');document.location='index.php'
  // نکته مهم: alertهایی که داخل تعریف تابع‌ها هستند (مثل setPayment) پیام خطای
  // واقعی نیستند. فقط alertهایی که بلافاصله با ریدایرکت (document/window.location)
  // دنبال می‌شوند «خطای قطعی سرور» هستند و در serverMessages می‌آیند.
  const serverMessages = [];
  const redirectAlertRe = /alert\s*\(\s*(['"])(.*?)\1\s*\)\s*;\s*(?:document|window)\.location/g;
  let am;
  while ((am = redirectAlertRe.exec(htmlText)) !== null) {
    const msg = String(am[2] || '').trim();
    if (msg) serverMessages.push(msg);
  }
  // همه alertها (فقط برای تشخیص) — جدا از serverMessages نگه داشته می‌شوند تا
  // alertهای داخل تعریف تابع (مثل «عبارت امنیتی صحیح نمیباشد») خطای واقعی شمرده نشوند.
  const allAlerts = [];
  const allAlertRe = /alert\s*\(\s*(['"])(.*?)\1\s*\)/g;
  while ((am = allAlertRe.exec(htmlText)) !== null) {
    const msg = String(am[2] || '').trim();
    if (msg) allAlerts.push(msg);
  }
  // «خطای قطعی سرور» = وجود alert ریدایرکت‌دار (مثل 101/1000). این از هر مارکر
  // پرداخت/موفقیت قوی‌تر است، چون صفحه خطا ممکن است متن «انتقال به درگاه بانکی»
  // را هم داشته باشد ولی در واقع رد شده است.
  const serverError = serverMessages.length > 0;

  // --- استخراج مبلغ کل (در صورت وجود marker در صفحه) ---
  let totalPrice = null;
  const priceMarkers = RC.total_price_markers || [];
  for (const m of priceMarkers) {
    const idx = flatText.indexOf(m);
    if (idx >= 0) {
      const near = flatText.slice(idx, idx + 200);
      const p = parsePrice(near);
      // فقط اعداد معقول به‌عنوان قیمت پذیرفته می‌شوند (بلیت قطار هرگز کمتر از
      // ۱۰۰۰ ریال نیست). بدون این آستانه، اعداد کوچک/نامربوط نزدیک marker
      // (مثل «2» کنار یک برچسب) به‌اشتباه قیمت شمرده می‌شدند.
      if (p !== null && p >= 1000) { totalPrice = p; break; }
    }
  }
  // اگر از marker استخراج نشد، مقدار فیلد ticPrice/totalPrice (در صورت وجود)
  // را مستقیم بخوان — قابل‌اعتمادتر از اسکن متن صفحه است.
  if (totalPrice === null && mainForm) {
    for (const f of mainForm.fields) {
      const eff = (f.effName || '').toLowerCase();
      if (eff === 'ticprice' || eff === 'totalprice') {
        const p = parsePrice(f.value);
        if (p !== null && p >= 1000) { totalPrice = p; break; }
      }
    }
  }

  // --- ساختارهای تشخیصی (بدون مقدار حساس) ---
  const diagForms = forms.map((f) => ({
    action: f.action,
    method: f.method,
    fieldNames: f.fields.map((x) => x.effName),
    inputs: f.fields
      .filter((x) => x.tag !== 'button')
      .map((x) => {
        const v = safeFieldValue(x);
        const base = { name: x.effName, id: x.id, type: x.type };
        return v === undefined ? base : { ...base, value: v };
      }),
    hiddenFieldNames: f.fields.filter((x) => x.type === 'hidden').map((x) => x.effName),
    selectNames: f.fields.filter((x) => x.tag === 'select').map((x) => x.effName),
    buttonNames: f.fields.filter((x) => x.tag === 'button').map((x) => x.effName),
  }));

  const form_signature = {
    formCount: forms.length,
    inputCount: allInputs.length,
    forms: diagForms.map((f) => ({ action: f.action, method: f.method, fieldNames: f.fieldNames })),
  };

  const diag = {
    finalUrl: baseUrl || '',
    formCount: forms.length,
    inputCount: allInputs.length,
    forms: diagForms,
    inputs: allInputs,
    images,
    hiddenFieldNames,
    selectNames: mainForm ? mainForm.fields.filter((x) => x.tag === 'select').map((x) => x.effName) : [],
    selectValues,
    buttonNames: mainForm ? mainForm.fields.filter((x) => x.tag === 'button').map((x) => x.effName) : [],
    significantText: maskDigitsInText(collapseText(flatText).slice(0, 300)),
    markers: markerHits,
    captchaRefs,
    scripts,
    externalScripts,
    externalStyles,
    jsRefs,
    handlers,
    endpoints,
    serverMessages,
    allAlerts,
    rawHtml: maskHtmlForDiagnostics(htmlText),
    form_signature,
  };

  // --- طبقه‌بندی فرم بر اساس شواهد DOM (بدون حدس) ---
  // کپچا ممکن است URL یا data-URI باشد؛ برای طبقه‌بندی هر دو یکسان در نظر گرفته می‌شوند.
  const classification = classifyForm({
    serverError,
    loginRequired,
    isPayment,
    isSuccess,
    noCapacity,
    captchaImgUrl: captchaImgUrl || captchaDataUri,
    captchaInputName,
    passengerFields,
    hasVisibleFields,
    hasButtons,
  });

  return {
    loginRequired,
    isPayment,
    isSuccess,
    captchaError,
    noCapacity,
    serverError,
    captchaImgUrl,
    captchaDataUri,
    captchaInputName,
    mainFormAction: mainForm ? mainForm.action : '',
    mainFormMethod: mainForm ? mainForm.method : 'post',
    hiddenFields,
    selectValues,
    formFieldValues,
    passengerFields,
    totalPrice,
    classification,
    hasVisibleFields,
    hasButtons,
    serverMessages,
    diag,
    rawTextLength: flatText.length,
  };
}

/* =====================================================================
 * طبقه‌بندی فرم بر اساس شواهد واقعی DOM (بدون حدس)
 * ===================================================================== */

const CORE_PASSENGER_KEYS = ['national_code', 'birth_day', 'birth_month', 'birth_year', 'first_name', 'last_name'];

/** آیا مجموعه فیلدها ساختار فرم مسافر را دارند؟ */
function classifyPassenger(passengerFields) {
  const hints = RC.passenger_field_hints || {};
  const keyByHint = {};
  for (const key of [...CORE_PASSENGER_KEYS, 'phone']) {
    for (const h of hints[key] || []) keyByHint[h.toLowerCase()] = key;
  }
  const matched = new Set();
  const evidence = [];
  for (const f of passengerFields) {
    const eff = f.effName || f.name;
    const { base } = splitFieldName(eff);
    const key = findFieldKey(base, eff, f.placeholder, hints, keyByHint);
    if (key) {
      matched.add(key);
      evidence.push(eff + '→' + key);
    }
  }
  const coreMatched = CORE_PASSENGER_KEYS.filter((k) => matched.has(k)).length;
  const confidence = coreMatched / CORE_PASSENGER_KEYS.length;
  // ساختار کلی باید سازگار باشد: حداقل ۴ دسته هویتی از ۶ دسته
  const isPassenger = coreMatched >= 4;
  return { isPassenger, confidence, coreMatched, evidence };
}

/**
 * طبقه‌بندی مرحله بر اساس شواهد DOM.
 * type ∈ { login, success, payment, captcha, passenger, intermediate, unknown }
 */
function classifyForm(a) {
  // «خطای قطعی سرور» (alert + ریدایرکت، مثل 101/1000) از همه مارکرها قوی‌تر است:
  // صفحه خطا ممکن است متن «انتقال به درگاه بانکی» را هم داشته باشد اما در واقع
  // رد شده است. پس اول خطای سرور را بررسی می‌کنیم.
  if (a.serverError) {
    return { type: 'error', confidence: 0.95, evidence: ['server_error_alert'] };
  }
  if (a.loginRequired) {
    return { type: 'login', confidence: 0.95, evidence: ['login_marker_matched'] };
  }
  if (a.isSuccess) {
    return { type: 'success', confidence: 0.95, evidence: ['success_marker_matched'] };
  }
  if (a.isPayment) {
    return { type: 'payment', confidence: 0.9, evidence: ['payment_marker_matched'] };
  }
  if (a.noCapacity) {
    return { type: 'no_capacity', confidence: 0.9, evidence: ['no_capacity_marker_matched'] };
  }

  if (a.captchaImgUrl && a.captchaInputName) {
    return { type: 'captcha', confidence: 0.9, evidence: ['captcha_image_detected', 'captcha_input:' + a.captchaInputName] };
  }
  if (a.captchaImgUrl) {
    return { type: 'captcha', confidence: 0.55, evidence: ['captcha_image_detected', 'captcha_input_not_matched'] };
  }

  const p = classifyPassenger(a.passengerFields || []);
  if (p.isPassenger) {
    return { type: 'passenger', confidence: p.confidence, evidence: p.evidence };
  }

  if (a.hasVisibleFields) {
    return { type: 'intermediate', confidence: 0.5, evidence: ['form_with_unmatched_visible_fields'] };
  }

  return { type: 'unknown', confidence: 0, evidence: ['no_known_pattern'] };
}

/** آیا صفحه نیاز به کپچای AJAX دارد؟ (JS رندر؛ کپچا/مسافر هنوز نیامده‌اند) */
function needsAjaxCaptcha(a) {
  if (!a) return false;
  if (a.captchaDataUri || a.captchaImgUrl) return false; // کپچا از قبل موجود است
  const cls = a.classification && a.classification.type;
  // فقط وقتی که صفحه هنوز کپچا/مسافر/ورود/پرداخت نیست ولی ارجاع به کپچا دارد
  if (cls === 'captcha' || cls === 'passenger' || cls === 'login' || cls === 'payment' || cls === 'success') return false;
  const refs = (a.diag && a.diag.captchaRefs) || [];
  return refs.length > 0;
}

/**
 * تجزیه پاسخ captchaAjax.php.
 *
 * این endpoint یک HTML برنمی‌گرداند، بلکه یک رشته متنی به شکل زیر است:
 *
 *     <captchaId>@<base64 تصویر PNG/JPEG/GIF>
 *     مثال: 152092113@iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAYAAABpYH0B...
 *
 * بخش اول شناسه کپچا (که باید همراه کد حل‌شده ارسال شود) و بخش دوم
 * خود تصویر کپچا به‌صورت base64 است. خروجی یک data-URI آماده نمایش است.
 */
function parseCaptchaAjaxResponse(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const at = s.indexOf('@');
  if (at < 0) return null;
  const captchaId = s.slice(0, at).trim();
  const b64 = s.slice(at + 1).trim();
  if (!captchaId || !b64) return null;
  // بخش دوم باید base64 خالص باشد (بدون تگ/جاوااسکریپت/HTML)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;

  // تشخیص نوع تصویر از امضای باینری (پیش‌فرض PNG)
  let mime = 'image/png';
  try {
    const head = Buffer.from(b64, 'base64');
    if (head.length >= 8) {
      if (head[0] === 0xff && head[1] === 0xd8) mime = 'image/jpeg';
      else if (head[0] === 0x47 && head[1] === 0x49) mime = 'image/gif';
      else if (head[0] === 0x42 && head[1] === 0x4d) mime = 'image/bmp';
    }
  } catch (e) { /* png پیش‌فرض */ }

  return { captchaId, dataUri: 'data:' + mime + ';base64,' + b64 };
}

/**
 * ادغام نتیجه captchaAjax.php (کپچا) در تحلیل صفحه اصلی.
 * فقط کپچا (تصویر + captchaId) را اضافه می‌کند — نه فیلد مسافر؛
 * فیلدهای مسافر (pid0/ruz0/...) در صفحه بعدی (پس از ارسال کپچا) می‌آیند.
 */
function mergeCaptchaAjax(analysis, parsed) {
  if (!parsed) return analysis;
  const merged = { ...analysis };
  merged.captchaDataUri = parsed.dataUri;
  merged.captchaImgUrl = null;
  // captchaId باید به‌عنوان فیلد مخفی همراه فرم ارسال شود.
  // در سایت، captchaNew() مقدار کامل «captchaId@base64» را هم در فیلد مخفی
  // ajaxResponse نگه می‌دارد و همراه فرم ارسال می‌شود؛ برای تطابق کامل با فرم
  // واقعی، همان مقدار را هم بازسازی می‌کنیم (base64 از dataUri استخراج می‌شود).
  const b64 = String(parsed.dataUri || '').split(',')[1] || '';
  merged.hiddenFields = {
    ...(merged.hiddenFields || {}),
    captchaId: parsed.captchaId,
    ajaxResponse: b64 ? (parsed.captchaId + '@' + b64) : (merged.hiddenFields.ajaxResponse || ''),
  };
  // اگر نام ورودی کپچا از DOM تشخیص داده نشد (چون با JS تزریق می‌شود)،
  // از config (Ksubmit) استفاده کن.
  if (!merged.captchaInputName) {
    const names = RC.captcha_input_names || ['Ksubmit'];
    merged.captchaInputName = names[0];
  }
  merged.ajax = {
    captchaId: parsed.captchaId,
    captchaDataUri: '[data-uri]',
  };
  // بازطبقه‌بندی: حالا هم تصویر کپچا و هم نام ورودی موجود است → captcha
  merged.classification = classifyForm({
    serverError: merged.serverError,
    loginRequired: merged.loginRequired,
    isPayment: merged.isPayment,
    isSuccess: merged.isSuccess,
    noCapacity: merged.noCapacity,
    captchaImgUrl: merged.captchaDataUri,
    captchaInputName: merged.captchaInputName,
    passengerFields: merged.passengerFields,
    hasVisibleFields: merged.hasVisibleFields,
    hasButtons: merged.hasButtons,
  });
  return merged;
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
    const eff = f.effName || f.name;
    const { base, index } = splitFieldName(eff);
    const key = findFieldKey(base, eff, f.placeholder, hints, KEY_BY_HINT);
    if (!key) return; // برای fallback موقعیتی باقی می‌ماند

    const passIndex = (index !== null && index !== undefined) ? index : 0;
    const p = (passengers || [])[passIndex] || {};

    let value = '';
    if (key === 'phone') {
      value = (extra && extra.phone) || '';
    } else {
      value = (p && p[key]) || '';
    }

    assignments.push({ name: eff, key, value });
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
      assignments.push({ name: remainingFields[i].effName || remainingFields[i].name, key: flatValues[i].key, value: flatValues[i].value });
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

/**
 * ساخت بدنه POST برای مقداردهی رزرو (معادل goTres() در سایت).
 *
 * goTres() فرم نتایج جستجو (mainFrm) را به TresV-auth.php می‌فرستد. فیلدهای
 * آن فرم (۱۵ فیلد) از config.reserve_init_fields خوانده می‌شود. پارامترهایی
 * که در reserveData نیستند (مانند wagon) با مقدار پیش‌فرض '0' ارسال می‌شوند.
 */
function buildReserveInitBody(reserveData) {
  const body = {};
  const fields = RC.reserve_init_fields || [
    'from', 'to', 'groupWay', 'pathWay', 'fromd', 'tod', 'sex', 'wagon',
    'adult', 'shahed', 'child', 'infant', 'forien', 'passCnt', 'srvc',
  ];
  for (const k of fields) {
    if (reserveData[k] !== undefined && reserveData[k] !== null && reserveData[k] !== '') {
      body[k] = reserveData[k];
    } else {
      body[k] = '0';
    }
  }
  return body;
}

/* =====================================================================
 * شروع رزرو — مرحله ۱ (POST به TresV-auth.php)
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

  // نکته: در سایت واقعی، تابع goTres() در صفحه نتایج جستجو، فرم را با POST
  // به TresV-auth.php می‌فرستد (نه GET به TresV.php). این POST رزرو را به‌درستی
  // مقداردهی می‌کند و صفحه کامل (جدول مسافر + کپچا + قیمت) برمی‌گرداند.
  // GET به TresV.php فقط صفحه ناقص (بدون فیلد مسافر) می‌دهد.
  const initUrl = config.base_url + (config.reserve_init_url || '/etrain/TresV-auth.php');
  const initBody = buildReserveInitBody(reserveData);
  let result;
  try {
    result = await fetchFollowing(initUrl, {
      method: 'POST',
      headers: buildHeaders(),
      body: toUrlEncoded(initBody),
      jar: cookies || [],
    });
  } catch (e) {
    logEvent(workflow, 'NETWORK_ERROR', { category: 'NETWORK_ERROR', message: e.message || String(e) });
    return { ok: false, error: e.message || String(e), workflow_id: workflow.workflow_id };
  }

  const httpStatus = result.resp ? result.resp.status : 0;
  let analysis = analyzeHtml(result.html, result.finalUrl);

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

  // لاگ وضعیت صفحه (پوسته استاتیک) — بلافاصله بعد از GET، قبل از هر AJAX
  logEvent(workflow, 'RESERVATION_STATE_READY', {
    finalUrl: result.finalUrl,
    httpStatus,
    classification: (analysis.classification && analysis.classification.type) || 'unknown',
    formCount: analysis.diag.forms.length,
    inputCount: analysis.diag.inputs.length,
    rawTextLength: analysis.rawTextLength,
    pageText: analysis.diag.significantText || '',
    fieldNames: (analysis.diag.forms[0] && analysis.diag.forms[0].fieldNames) || [],
    inputs: analysis.diag.inputs || [],
    selectNames: analysis.diag.selectNames || [],
    selectValues: analysis.diag.selectValues || {},
    buttonNames: analysis.diag.buttonNames || [],
    hiddenFieldNames: analysis.diag.hiddenFieldNames || [],
    captchaRefs: analysis.diag.captchaRefs || [],
    captchaDataUri: analysis.captchaDataUri ? '[data-uri]' : null,
    images: analysis.diag.images || [],
    handlers: analysis.diag.handlers || [],
    endpoints: analysis.diag.endpoints || [],
    scripts: analysis.diag.scripts || [],
    externalScripts: analysis.diag.externalScripts || [],
    jsRefs: analysis.diag.jsRefs || [],
    mainFormAction: analysis.mainFormAction,
    mainFormMethod: analysis.mainFormMethod,
  });

  // --- AJAX کپچا ---
  // صفحه رزرو با جاوااسکریپت رندر می‌شود: بعد از لود، JS با POST به
  // captchaAjax.php کپچا و فیلدهای مسافر را دریافت و تزریق می‌کند.
  // چون fetch سرور اجرای JS ندارد، این درخواست را خودمان ارسال می‌کنیم.
  let captchaAjaxMeta = null;
  if (needsAjaxCaptcha(analysis)) {
    // در سایت، captchaNew() با بدنه خالی POST به captchaAjax.php می‌زند و کپچا
    // به نشست (PHPSESSID) گره می‌خورد. پس بدنه باید خالی باشد.
    const ajaxUrl = absoluteUrl(config.base_url + (RC.captcha_ajax_url || '/etrain/captchaAjax.php'), result.finalUrl);
    try {
      const ajaxResult = await fetchFollowing(ajaxUrl, {
        method: 'POST',
        headers: buildHeaders(),
        body: '',
        jar: result.jar,
      });
      captchaAjaxMeta = {
        finalUrl: ajaxResult.finalUrl,
        httpStatus: ajaxResult.resp ? ajaxResult.resp.status : 0,
        rawLength: ajaxResult.html.length,
        preview: maskHtmlForDiagnostics(ajaxResult.html).slice(0, 200),
      };
      // پاسخ captchaAjax.php رشته «captchaId@base64PNG» است نه HTML
      const parsed = parseCaptchaAjaxResponse(ajaxResult.html);
      if (parsed) {
        analysis = mergeCaptchaAjax(analysis, parsed);
        captchaAjaxMeta.parsed = { captchaId: parsed.captchaId, hasImage: true };
        logEvent(workflow, 'RESERVATION_AJAX_READY', {
          finalUrl: ajaxResult.finalUrl,
          httpStatus: captchaAjaxMeta.httpStatus,
          classification: (analysis.classification && analysis.classification.type) || 'unknown',
          captchaId: parsed.captchaId,
          captchaDataUri: analysis.captchaDataUri ? '[data-uri]' : null,
          captchaInputName: analysis.captchaInputName,
        });
      } else {
        captchaAjaxMeta.note = 'پاسخ captchaAjax.php در قالب مورد انتظار (captchaId@base64) نبود.';
        logEvent(workflow, 'RESERVATION_AJAX_ERROR', {
          message: captchaAjaxMeta.note,
          preview: captchaAjaxMeta.preview,
        });
      }
    } catch (e) {
      captchaAjaxMeta = { error: e.message || String(e) };
      logEvent(workflow, 'RESERVATION_AJAX_ERROR', { message: captchaAjaxMeta.error });
    }
  }

  const stepResp = buildStepResponse(analysis, state, result, passengers, workflow);
  stepResp.captchaAjax = captchaAjaxMeta;
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

  // ساختن بدنه ارسال: «همه فیلدهای فرم» (با مقدار فعلی صفحه) + کپچا + مسافر.
  // فرم واقعی (chkForm → VerifyTck.php) همه فیلدهای دارای name را می‌فرستد:
  // hidden + text + radio/checkbox انتخاب‌شده + select. پس از formFieldValues
  // (که analyzeHtml از DOM واقعی ساخته) به‌عنوان پایه استفاده می‌کنیم.
  // نکته مهم: پارامترهای جستجو (fromd/tod/departureTrain/returnTrain/groupWay/tmpDate)
  // در این صفحه اصلاً وجود ندارند، پس دوباره ارسال نمی‌شوند؛ سرور تاریخ/مسیر را
  // در نشست (PHPSESSID) نگه می‌دارد. ارسال دوباره departureTrain باعث خطای 101 می‌شد.
  const body = { ...(state.formFieldValues || state.hiddenFields || {}), ...(state.selectValues || {}) };

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

  // هدف ارسال (بر اساس جریان تأییدشده raja.js):
  //   - ارسال کپچا (captcha غیرخالی) → action فرم صفحه کپچا = TresV.php
  //     (صفحه کپچا از TresV-auth.php آمده و فرمش به TresV.php ارسال می‌شود)
  //   - ارسال اطلاعات مسافر (captcha خالی) → VerifyTck.php (هدف سخت‌کد chkForm)
  const isCaptchaSubmit = (captcha !== undefined && captcha !== null && captcha !== '');
  let action;
  if (isCaptchaSubmit) {
    action = state.mainFormAction
      ? absoluteUrl(state.mainFormAction, state.fromUrl)
      : config.base_url + config.reserve_url;
  } else {
    action = config.base_url + (config.reserve_submit_url || '/etrain/VerifyTck.php');
  }
  const method = (state.mainFormMethod || 'post').toLowerCase();

  // اگر فرم با GET ارسال می‌شود، پارامترها را به query-string اضافه کن
  // (در غیر این صورت به‌عنوان body ارسال می‌شوند).
  let fetchBody = null;
  if (method === 'get') {
    const sep = action.includes('?') ? '&' : '?';
    action += sep + toUrlEncoded(body);
  } else {
    fetchBody = toUrlEncoded(body);
  }

  let result;
  try {
    result = await fetchFollowing(action, {
      method: method.toUpperCase(),
      headers: buildHeaders(),
      body: fetchBody,
      jar: state.jar,
    });
  } catch (e) {
    logEvent(workflow, 'NETWORK_ERROR', { category: 'NETWORK_ERROR', message: e.message || String(e) });
    return { ok: false, error: e.message || String(e), workflow_id: workflow.workflow_id };
  }

  const analysis0 = analyzeHtml(result.html, result.finalUrl);

  // اگر پاسخ هنوز «صفحه کپچا» است ولی تصویر ندارد (مثلاً کپچای واردشده اشتباه
  // بوده و سرور دوباره فرم کپچا را بدون تصویر برگردانده)، باید مثل سایت کپچای
  // تازه از captchaAjax.php بگیریم تا کاربر بتواند دوباره تلاش کند.
  let analysis = analysis0;
  let wrongCaptcha = false;
  if (needsAjaxCaptcha(analysis0) && isCaptchaSubmit) {
    wrongCaptcha = true;
    const ajaxUrl = absoluteUrl(config.base_url + (RC.captcha_ajax_url || '/etrain/captchaAjax.php'), result.finalUrl);
    try {
      const ajaxResult = await fetchFollowing(ajaxUrl, {
        method: 'POST',
        headers: buildHeaders(),
        body: '',
        jar: result.jar,
      });
      const parsed = parseCaptchaAjaxResponse(ajaxResult.html);
      if (parsed) {
        analysis = mergeCaptchaAjax(analysis0, parsed);
        result.jar = ajaxResult.jar; // کوکی‌های احتمالی کپچای تازه را نگه می‌داریم
      }
    } catch (e) { /* در صورت خطا، همان تحلیل اولیه می‌ماند */ }
  }
  if (wrongCaptcha) analysis.captchaError = true;

  // ثبت وضعیت مرحله بعد (با نام فیلدها برای رفع اشکال)
  logEvent(workflow, 'RESERVATION_STEP_READY', {
    finalUrl: result.finalUrl,
    httpStatus: result.resp ? result.resp.status : 0,
    classification: (analysis.classification && analysis.classification.type) || 'unknown',
    formCount: analysis.diag.forms.length,
    inputCount: analysis.diag.inputs.length,
    rawTextLength: analysis.rawTextLength,
    pageText: analysis.diag.significantText || '',
    fieldNames: (analysis.diag.forms[0] && analysis.diag.forms[0].fieldNames) || [],
    inputs: analysis.diag.inputs || [],
    selectNames: analysis.diag.selectNames || [],
    selectValues: analysis.diag.selectValues || {},
    buttonNames: analysis.diag.buttonNames || [],
    hiddenFieldNames: analysis.diag.hiddenFieldNames || [],
    captchaRefs: analysis.diag.captchaRefs || [],
    captchaDataUri: analysis.captchaDataUri ? '[data-uri]' : null,
    images: analysis.diag.images || [],
    handlers: analysis.diag.handlers || [],
    endpoints: analysis.diag.endpoints || [],
    scripts: analysis.diag.scripts || [],
    externalScripts: analysis.diag.externalScripts || [],
    jsRefs: analysis.diag.jsRefs || [],
    serverMessages: analysis.serverMessages || [],
  });

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
  // --- تعیین مرحله بر اساس طبقه‌بندی DOM (بدون حدس) ---
  const cls = analysis.classification || { type: 'unknown' };
  let step, message, extra = {};

  switch (cls.type) {
    case 'login':
      if (workflow) tryTransition(workflow, STATES.LOGIN_REQUIRED);
      step = 'login_required';
      message = 'صفحه رزرو نیاز به ورود دارد. کوکی‌های نشست (PHPSESSID) معتبر نیست. در صفحه «ورود» کوکی‌ها را همگام‌سازی کنید.';
      break;
    case 'success':
      if (workflow) { tryTransition(workflow, STATES.PAYMENT_HANDOFF); tryTransition(workflow, STATES.PAYMENT_PENDING); tryTransition(workflow, STATES.PAYMENT_RESULT); }
      step = 'success';
      message = 'رزرو با موفقیت انجام شد.';
      extra.paymentUrl = extractPaymentUrl(analysis, result);
      break;
    case 'payment':
      if (workflow) { tryTransition(workflow, STATES.CONFIRMATION_READY); tryTransition(workflow, STATES.PAYMENT_HANDOFF); }
      step = 'payment';
      message = 'رزرو تأیید شد؛ در حال انتقال به صفحه پرداخت.';
      extra.paymentUrl = extractPaymentUrl(analysis, result);
      break;
    case 'captcha':
      if (workflow) tryTransition(workflow, STATES.CAPTCHA_REQUIRED);
      step = 'captcha';
      message = analysis.captchaError
        ? 'کپچای واردشده اشتباه بود. دوباره تلاش کنید.'
        : 'برای ادامه، کد امنیتی (کپچا) را وارد کنید.';
      // کپچا یا data-URI است (توی HTML) یا یک URL
      extra.captchaImageUrl = analysis.captchaDataUri
        ? analysis.captchaDataUri
        : absoluteUrl(analysis.captchaImgUrl, result.finalUrl);
      extra.captchaDataUri = analysis.captchaDataUri || null;
      extra.captchaInputName = analysis.captchaInputName;
      extra.captchaError = analysis.captchaError;
      break;
    case 'passenger':
      step = 'passenger_form';
      message = 'فرم اطلاعات مسافر دریافت شد. اطلاعات از پیش واردشده به‌صورت خودکار تکمیل می‌شود.';
      extra.passengerFieldNames = (analysis.passengerFields || []).map((f) => f.effName || f.name);
      break;
    case 'no_capacity':
      if (workflow) tryTransition(workflow, STATES.NO_CAPACITY);
      step = 'no_capacity';
      message = 'ظرفیت این قطار تکمیل شده است.';
      break;
    case 'error': {
      if (workflow) tryTransition(workflow, STATES.FAILED);
      step = 'error';
      const errMsg = (analysis.serverMessages && analysis.serverMessages.length)
        ? analysis.serverMessages[0] : 'خطای سامانه';
      if (/^101/.test(errMsg) || /سرویس رفت/.test(errMsg)) {
        message = 'سامانه این رزرو را رد کرد: «' + errMsg + '». ' +
          'این یعنی این قطار/سرویس دیگر قابل رزرو نیست (ظرفیت تکمیل یا سرویس لغو شده). ' +
          'دوباره جستجو کنید و یک قطار دیگر را انتخاب کنید.';
      } else if (/1000/.test(errMsg) || /امکان‌پذیر نمی‌باشد|امکان پذیر نیست/.test(errMsg)) {
        message = 'سامانه این رزرو را رد کرد: «' + errMsg + '». ' +
          'این یعنی سرویس درخواستی دیگر قابل رزرو نیست (ظرفیت تکمیل/سرویس لغو، یا ' +
          'زمان رزرو نگه‌داشته‌شده منقضی شده است). دوباره جستجو کنید و قطار دیگری ' +
          'را انتخاب کنید؛ اگر باز هم تکرار شد، در صفحه «ورود» کوکی نشست را همگام‌سازی کنید.';
      } else {
        message = 'سامانه این رزرو را رد کرد: «' + errMsg + '».';
      }
      extra.serverMessage = errMsg;
      break;
    }
    case 'intermediate':
      step = 'intermediate_step';
      message = 'یک مرحله میانی (غیر از فرم مسافر/کپچا/پرداخت) از سامانه دریافت شد. جزئیات را در «تشخیص» ببینید.';
      break;
    default: {
      step = 'unknown';
      const empty = !analysis.diag.forms.length && !analysis.diag.inputs.length;
      const serverMsg = (analysis.serverMessages && analysis.serverMessages.length)
        ? analysis.serverMessages[0] : null;
      if (empty) {
        if (serverMsg) {
          if (/^101/.test(serverMsg) || /سرویس رفت|امکان‌پذیر نمی‌باشد|امکان پذیر نیست/.test(serverMsg)) {
            message = 'سامانه این رزرو را رد کرد: «' + serverMsg + '». ' +
              'این یعنی این قطار/سرویس دیگر قابل رزرو نیست (ظرفیت تکمیل یا سرویس لغو شده). ' +
              'دوباره جستجو کنید و یک قطار دیگر را انتخاب کنید.';
          } else {
            message = 'سامانه این رزرو را رد کرد: «' + serverMsg + '». ' +
              'دوباره جستجو کنید و قطار دیگری را امتحان کنید، یا در صفحه «ورود» کوکی نشست را همگام‌سازی کنید.';
          }
        } else {
          message = 'سامانه در پاسخ به رزرو، صفحه خالی (بدون فرم/فیلد) برگرداند. ' +
            'این معمولاً یعنی نشست ورود معتبر نیست (در صفحه «ورود» کوکی‌ها را همگام‌سازی کنید) ' +
            'یا پاسخ سامانه با این درخواست سازگار نیست. متن صفحه را در «تشخیص» ببینید.';
        }
      } else if (serverMsg) {
        message = 'سامانه پیام خطا برگرداند: «' + serverMsg + '». جزئیات را در «تشخیص» ببینید.';
      } else {
        message = 'ساختار صفحه با مراحل شناخته‌شده BilitFast مطابقت ندارد.';
      }
      break;
    }
  }

  // --- ساخت stateToken با حالت نهایی workflow ---
  const finalAgentState = workflow ? workflow.state : state.agentState;
  const stateToken = encodeState({
    ...state,
    agentState: finalAgentState,
    hiddenFields: analysis.hiddenFields,
    selectValues: analysis.selectValues,
    formFieldValues: analysis.formFieldValues,
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
    classification: analysis.classification || null,
    diagnostics: analysis.diag,
    flags: {
      loginRequired: analysis.loginRequired,
      isPayment: analysis.isPayment,
      isSuccess: analysis.isSuccess,
      captchaError: analysis.captchaError,
      noCapacity: analysis.noCapacity,
      serverError: analysis.serverError,
      hasCaptchaImage: !!(analysis.captchaImgUrl || analysis.captchaDataUri),
    },
    finalUrl: result.finalUrl,
    httpStatus: result.resp ? result.resp.status : 0,
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
  if (action) return absoluteUrl(action, result.finalUrl);
  return result.finalUrl;
}

/* =====================================================================
 * دریافت کپچای تازه (refresh) — معادل captchaNew() در سایت
 * ===================================================================== */

/**
 * گرفتن یک کپچای جدید از captchaAjax.php با همان کوکی نشست.
 *
 * کپچای صفحه رزرو به نشست (PHPSESSID) گره خورده و با POST خالی به
 * captchaAjax.php تولید می‌شود. این تابع همان کار را انجام می‌دهد و
 * تصویر جدید + captchaId جدید + stateToken به‌روزشده (با captchaId جدید)
 * را برمی‌گرداند تا ارسال نهایی از کپچای درست استفاده کند.
 */
async function refreshCaptcha({ stateToken }) {
  const state = decodeState(stateToken);
  if (!state) return { ok: false, error: 'وضعیت رزرو نامعتبر یا منقضی شده است. دوباره شروع کنید.' };

  const ajaxUrl = config.base_url + (RC.captcha_ajax_url || '/etrain/captchaAjax.php');
  let ajaxResult;
  try {
    ajaxResult = await fetchFollowing(ajaxUrl, {
      method: 'POST',
      headers: buildHeaders(),
      body: '',
      jar: state.jar,
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }

  const parsed = parseCaptchaAjaxResponse(ajaxResult.html);
  if (!parsed) {
    return { ok: false, error: 'پاسخ captchaAjax.php در قالب مورد انتظار (captchaId@base64) نبود.' };
  }

  // به‌روزرسانی state: captchaId جدید + کوکی‌جار جدید
  const newState = {
    ...state,
    jar: ajaxResult.jar,
    hiddenFields: { ...(state.hiddenFields || {}), captchaId: parsed.captchaId },
  };

  return {
    ok: true,
    captchaId: parsed.captchaId,
    captchaImageUrl: parsed.dataUri,
    captchaDataUri: parsed.dataUri,
    stateToken: encodeState(newState),
  };
}

/* =====================================================================
 * دریافت تصویر کپچا به‌صورت base64 (برای نمایش در UI)
 * ===================================================================== */

async function fetchCaptchaImage(captchaImageUrl, stateToken) {
  // اگر کپچا از قبل data-URI باشد (توی HTML جاسازی شده)، مستقیم همان را برگردان
  if (/^data:image/i.test(captchaImageUrl || '')) {
    return { ok: true, dataUri: captchaImageUrl };
  }
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

/** تبدیل data-URI به Buffer (برای کپچای جاسازی‌شده در HTML). */
function dataUriToBuffer(dataUri) {
  const m = /^data:[^;]*;base64,(.*)$/i.exec(dataUri || '');
  if (!m) return null;
  try {
    return Buffer.from(m[1], 'base64');
  } catch (e) {
    return null;
  }
}

async function fetchCaptchaBuffer(captchaImageUrl, stateToken) {
  // کپچای data-URI (جاسازی‌شده) → بدون fetch
  const d = dataUriToBuffer(captchaImageUrl);
  if (d) return d;

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
  absoluteUrl,
  fetchFollowing,
  analyzeHtml,
  classifyForm,
  classifyPassenger,
  needsAjaxCaptcha,
  parseCaptchaAjaxResponse,
  mergeCaptchaAjax,
  buildReserveInitBody,
  mapPassengerFields,
  encodeState,
  decodeState,
  startReservation,
  submitReservation,
  refreshCaptcha,
  fetchCaptchaImage,
  solveCaptchaImage,
};
