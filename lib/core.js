// -*- coding: utf-8 -*-
/**
 * هسته منطقی برنامه BilitFast — نسخه serverless (Node.js / Vercel).
 *
 * این ماژول پورت مستقیم منطق برنامه دسکتاپی (BilitFast.py) به Node.js است:
 *   - ساخت داده جستجو  (_build_search_data)
 *   - استخراج قطارها با سِلکتورهای config.json (extract_trains) — با cheerio به‌جای lxml
 *   - ساخت فرم رزرو HTML (perform_reservation)
 *   - ورود به سامانه و انتقال کوکی‌ها
 *
 * چون Vercel محیط serverless (بدون حالت/فایل پایدار و بدون ترد طولانی‌مدت) است:
 *   - هر درخواست «یک تلاش جستجو» انجام می‌دهد (حلقه polling به مرورگر منتقل شده).
 *   - وضعیت (مسیرها، دوره آزمایشی، کوکی‌ها) در localStorage مرورگر نگهداری می‌شود.
 */

const path = require('path');
const cheerio = require('cheerio');
const jalaali = require('jalaali-js');
const departure = require('./departure');
const { safirFetch } = require('./http');

// خواندن تنظیمات و کد شهرها (همان فایل‌های نسخه اصلی)
const config = require(path.join(__dirname, '..', 'config.json'));
const cityCodes = require(path.join(__dirname, '..', 'cities.json'));

/**
 * آیا روی محیط serverless/ابری اجرا می‌شویم؟ فقط برای «راهنمای خطا» استفاده
 * می‌شود: اشاره به مسدود بودن IP دیتاسنتر وقتی معنا دارد که واقعاً آنجا باشیم.
 * روی اجرای محلی چنین پیامی گمراه‌کننده است.
 */
function isCloudEnv() {
  return !!(process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.FUNCTIONS_WORKER_RUNTIME || process.env.K_SERVICE ||
    process.env.DYNO || process.env.RENDER);
}

/** راهنمای متناسب با محیط اجرا برای خطاهای شبکه. */
function networkHint() {
  if (isCloudEnv()) {
    return 'این سرور ابری است و سامانه سفیر ریل معمولاً درخواست‌های IPهای دیتاسنتر/خارج از ایران را مسدود می‌کند. ' +
      'برنامه را روی سیستم خودتان اجرا کنید: npm install و سپس node dev-server.js';
  }
  return 'اتصال اینترنت و دسترسی به سایت سفیر ریل را بررسی کنید. ' +
    'اگر سامانه موقتاً پاسخ نمی‌دهد، برنامه خودش دوباره تلاش می‌کند.';
}

/** جستجوی کد شهر بر اساس نام (معادل نگاه در دیکشنری city_codes پایتون). */
function cityCode(name) {
  return cityCodes[name];
}

/**
 * بارگذاری HTML با cheerio در سریع‌ترین حالت ممکن.
 * پارسر htmlparser2 حدود ۲ تا ۵ برابر سریع‌تر از پارسر پیش‌فرض (parse5) است و
 * برای استخراج جدول نتایج سفیر کاملاً کافی است.
 */
function loadHtml(htmlText) {
  try {
    return cheerio.load(htmlText, {
      xml: false,
      _useHtmlParser2: true,
      decodeEntities: false,
    });
  } catch (e) {
    return cheerio.load(htmlText);
  }
}

/** نگاشت جنسیت به کد عددی (معادل gender_map در _build_search_data). */
const GENDER_MAP = { 'عادی': '3', 'برادران': '2', 'خواهران': '1' };

/** حداکثر تعداد مسافر قابل تعریف. */
const MAX_PASSENGERS = 6;

/**
 * ساخت داده جستجو — پورت مستقیم _build_search_data در BilitFast.py.
 */
function buildSearchData({
  from_code, to_code, departure_date, gender_str, passengers, train_number,
  adult = 1, child = 0, infant = 0, foreigner = 0, return_date = null,
}) {
  if (!return_date) return_date = departure_date;
  return {
    from: String(from_code),
    to: String(to_code),
    pathWay: '1',
    fromd: departure_date,
    tod: return_date,
    sex: GENDER_MAP[gender_str] || '3',
    adult: String(adult),
    shahed: '0',
    child: String(child),
    infant: String(infant),
    forien: String(foreigner),
    passCnt: String(passengers),
    srvc: '',
    departureTrain: train_number || '',
    returnTrain: '',
    groupWay: 'on',
    tmpDate: departure_date,
  };
}

/**
 * تبدیل ارقام فارسی و عربی به لاتین.
 *
 * چرا حیاتی است: در پایتون ۳ الگوی \d به‌صورت پیش‌فرض یونیکد است و «۱۶» را
 * می‌گیرد، ولی در جاوااسکریپت \d فقط ASCII است. پورت مستقیم regex از
 * BilitFast.py باعث می‌شد ظرفیتِ نوشته‌شده با رقم فارسی صفر خوانده شود —
 * یعنی صفحه ۱۶ قطار داشت و برنامه می‌گفت «هیچ قطاری یافت نشد».
 */
function toLatinDigits(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/**
 * خواندن عدد ظرفیت از متن موجودی، مستقل از زبان ارقام.
 * اگر هیچ رقمی نباشد (مثلاً «تکمیل») صفر برمی‌گرداند — همان رفتار درست.
 */
function parseCapacity(availText) {
  const m = toLatinDigits(availText).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Capacity must have explicit evidence. Missing text/unknown words are NOT 0.
 * Used by actual matching as well as diagnostics, independent of digit locale.
 */
function parseCapacityInfo(availText) {
  const raw = String(availText == null ? '' : availText).trim();
  const normalized = toLatinDigits(raw);
  const digits = normalized.match(/(\d+)/);
  if (digits) return { known: true, capacity: parseInt(digits[1], 10) };
  if (/تکمیل|اتمام\s*ظرفیت|بدون\s*ظرفیت|فاقد\s*ظرفیت|ناموجود|sold\s*out/i.test(normalized)) {
    return { known: true, capacity: 0 };
  }
  return { known: false, capacity: null };
}

/**
 * استخراج قطارها — پورت مستقیم extract_trains در BilitFast.py.
 * سِلکتورهای CSS از config.json خوانده می‌شوند (همان مقادیر نسخه اصلی).
 */
/**
 * 3.13.5: آیا ردیف یک قطار امروز است که ساعت حرکتش گذشته؟ (فقط برای امروز؛
 * تاریخ‌های بعد هرگز با ساعت فعلی فیلتر نمی‌شوند — lib/departure.js)
 */
function rowDeparted($, row, opts) {
  if (!opts || !opts.searchDate) return false;
  const timeText = $(row).find(config.departure_time_selector).first().text().trim();
  const rowDate = config.departure_date_selector
    ? $(row).find(config.departure_date_selector).first().text().trim() : '';
  return departure.hasDeparted({
    timeText, rowDate, searchDate: opts.searchDate, now: opts.now,
    bufferMinutes: config.departed_buffer_minutes || 0,
  });
}

function extractTrains(htmlText, capacityNeeded = 0, specificTrainNumber = null, opts = {}) {
  // بهینه‌سازی: اگر شیء cheerio از قبل ساخته شده باشد (پارس مشترک)، دوباره
  // HTML را پارس نمی‌کنیم. پارس دوباره صفحه نتایج سفیر ده‌ها میلی‌ثانیه
  // برای هر تلاش هزینه دارد.
  const $ = (typeof htmlText === 'function') ? htmlText : loadHtml(htmlText);

  // سِلکتور اصلی از config.json: "tr[name='srvc']"
  let rows = $(config.train_row_selector);

  // فال‌بک: اگر سطری با این سلکتور یافت نشد، سطرهایی که چک‌باکس srvc دارند را پیدا کن
  if (rows.length === 0) {
    rows = $(config.srvc_checkbox_selector).closest('tr');
  }

  const results = [];
  rows.each((_i, row) => {
    try {
      const trainNum = $(row).find(config.train_number_selector).first().text().trim();
      if (specificTrainNumber &&
          toLatinDigits(trainNum).trim() !== toLatinDigits(specificTrainNumber).trim()) return;

      // قطار امروزی که ساعت حرکتش گذشته، حتی با ظرفیت، قابل رزرو نیست.
      if (rowDeparted($, row, opts)) return;

      const timeText = $(row).find(config.departure_time_selector).first().text().trim();
      const capText = $(row).find(config.capacity_selector).first().text().trim();
      const availText = $(row).find(config.availability_selector).first().text().trim();

      const priceEl = $(row).find(config.price_selector).first();
      const priceText = priceEl.length ? priceEl.text().trim() : 'نامشخص';

      const coupeEl = $(row).find(config.coupe_selector).first();
      const coupeText = coupeEl.length ? coupeEl.text().trim() : 'نامشخص';

      const companyEl = $(row).find(config.company_selector).first();
      const companyText = companyEl.length ? companyEl.text().trim() : 'نامشخص';

      const checkbox = $(row).find(config.srvc_checkbox_selector).first();
      const srvc = checkbox.attr('value') || '';

      const capacityInfo = parseCapacityInfo(availText);
      // Never offer a train when the availability cell is unreadable.
      if (capacityInfo.known && capacityInfo.capacity >= capacityNeeded) {
        const totalCapacity = capacityInfo.capacity;
        results.push({
          'شماره قطار': trainNum,
          'ساعت حرکت': timeText,
          'قیمت': priceText,
          'نوع کوپه': coupeText,
          'شرکت': companyText,
          'ظرفیت': totalCapacity,
          'srvc': srvc,
        });
      }
    } catch (e) {
      console.error('خطا در استخراج قطار:', e && e.message ? e.message : e);
    }
  });
  return results;
}

/** ساخت هدر درخواست به سایت سفیر ریل (معادل default_headers در _send_request). */
function buildHeaders(extra = {}) {
  return {
    'User-Agent': config.user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Content-Type': config.content_type || 'application/x-www-form-urlencoded',
    'Accept': config.accept || '*/*',
    'Referer': config.base_url + '/etrain/index.php',
    'Origin': config.base_url,
    ...extra,
  };
}

/** تبدیل object به رشته urlencoded (معادل data= در requests.post). */
function toUrlEncoded(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    params.append(k, String(v));
  }
  return params.toString();
}

/** اتصال کوکی‌ها به هدر Cookie (در صورت وجود). */
function attachCookies(headers, cookies) {
  if (Array.isArray(cookies) && cookies.length) {
    headers['Cookie'] = cookies.map((c) => c.split(';')[0]).join('; ');
  }
  return headers;
}

/** آیا کوکی سشن (PHPSESSID) در لیست کوکی‌ها وجود دارد؟ */
function hasSessionCookie(cookies) {
  if (!Array.isArray(cookies)) return false;
  return cookies.some((c) => /PHPSESSID/i.test(c.split('=')[0]));
}

/**
 * استخراج اطلاعات تشخیصی از HTML جستجو (برای اشکال‌زدایی):
 * تعداد کل ردیف‌ها و مقادیر موجودی همه قطارها.
 */
function extractDiagnostics(htmlText, specificTrainNumber = null, capacityNeeded = 0, opts = {}) {
  const $ = (typeof htmlText === 'function') ? htmlText : loadHtml(htmlText);
  let rows = $(config.train_row_selector);
  if (rows.length === 0) rows = $(config.srvc_checkbox_selector).closest('tr');
  const target = specificTrainNumber ? toLatinDigits(specificTrainNumber).trim() : '';
  const diag = {
    totalRows: rows.length, matchingRows: 0, unknownTrainNumberRows: 0,
    knownRows: 0, unknownRows: 0, zeroRows: 0, nonzeroRows: 0,
    sufficientRows: 0, departedRows: 0, trains: [],
  };
  rows.each((_i, row) => {
    try {
      const num = $(row).find(config.train_number_selector).first().text().trim();
      const avail = $(row).find(config.availability_selector).first().text().trim();
      const capacityInfo = parseCapacityInfo(avail);
      if (target && !num) diag.unknownTrainNumberRows++;
      const matching = !target || toLatinDigits(num).trim() === target;
      diag.trains.push({ num, avail, capacity: capacityInfo.capacity,
        capacityKnown: capacityInfo.known, matching });
      if (!matching) return;
      // Departed trains are neither available nor "full"; count them apart.
      if (rowDeparted($, row, opts)) { diag.departedRows++; return; }
      diag.matchingRows++;
      if (!capacityInfo.known) diag.unknownRows++;
      else {
        diag.knownRows++;
        if (capacityInfo.capacity === 0) diag.zeroRows++;
        else diag.nonzeroRows++;
        if (capacityInfo.capacity >= capacityNeeded) diag.sufficientRows++;
      }
    } catch (e) {
      // Treat parser errors as uncertain inventory, never as a verified zero.
      diag.matchingRows++;
      diag.unknownRows++;
    }
  });
  return diag;
}

/**
 * Distinguish a genuine search response from a login/CAPTCHA/WAF page that
 * happens to use HTTP 200. Unknown HTML must never be treated as no seats.
 * No CAPTCHA interaction or token handling is performed here.
 */
function inspectSearchPage(htmlText, finalUrl, $) {
  const url = String(finalUrl || '');
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch (_) {
      return { reason: 'unexpected_search_page', error: 'نشانی پاسخ جستجو معتبر نیست.' };
    }
    const expected = new URL(config.base_url);
    if (parsed.origin !== expected.origin) {
      return { reason: 'unexpected_search_page', error: 'پاسخ جستجو به دامنه دیگری هدایت شده است.' };
    }
    if (/\/(?:fa\/)?(?:UserAut|Login(?:\/process)?)\.php(?:$|\/)/i.test(parsed.pathname) ||
        /\/login(?:\/|\.php|$)/i.test(parsed.pathname)) {
      return { reason: 'session_required', sessionInvalid: true, error: 'نشست ورود سفیر ریل منقضی یا نامعتبر است.' };
    }
    if (/captcha|challenge/i.test(parsed.pathname)) {
      return { reason: 'captcha_required', captchaRequired: true, error: 'تأیید انسانی در صفحه رسمی سفیر ریل لازم است.' };
    }
    // 200 following a redirect to an arbitrary, unrelated route is not proof
    // of a successful search. A genuine response must have search markers.
  }
  const inputPassword = $('input[type="password"]').length > 0;
  const loginForm = $('form').toArray().some(el =>
    /(?:login\/process|UserAut(?:\.php)?|\/login(?:\/|\.php|$))/i.test($(el).attr('action') || '') ||
    $(el).find('input[name="pass"],input[name="password"]').length > 0);
  if (inputPassword || loginForm) {
    return { reason: 'session_required', sessionInvalid: true, error: 'صفحه ورود به جای نتیجه جستجو برگشته است؛ نشست حساب را تازه کنید.' };
  }
  const challenge = $('[class*="arcaptcha"], [id*="arcaptcha"], .g-recaptcha, [data-sitekey], iframe[src*="captcha"], iframe[src*="challenge"], input[name="captcha_code"], input[name="security_code"]').length > 0;
  const captchaText = /(?:تأیید (?:انسانی|ربات)|من ربات نیستم|کد امنیتی|captcha required|verify you are human|access denied|checking your browser)/i.test(htmlText);
  if (challenge || captchaText) {
    return { reason: 'captcha_required', captchaRequired: true, error: 'صفحه جستجو تأیید انسانی درخواست کرده است؛ در مرورگر رسمی تأیید کنید.' };
  }
  const rows = $(config.train_row_selector).length || $(config.srvc_checkbox_selector).closest('tr').length;
  // Site-defined explicit no-results/capacity response is a valid empty page.
  // Purely empty/unknown/blocked HTML is NOT valid evidence of no capacity.
  const explicitEmpty = /اطلاعاتی وجود ندارد|قطاری یافت نشد|قطاری موجود نیست|ظرفیت تکمیل|اتمام ظرفیت|موجودی کافی نیست/.test(htmlText);
  if (rows || explicitEmpty) return { reason: 'search_results', rows, explicitEmpty };
  return { reason: 'unexpected_search_page', error: 'ساختار نتیجه جستجو ناشناخته است؛ نشست یا تغییرات سایت را بررسی کنید.' };
}

/**
 * یک تلاش جستجو — معادل _send_search_request + استخراج در Worker.do_one_attempt.
 * ورودی: fields (مبدا/مقصد/تاریخ/جنسیت/شماره قطار) و passengers (لیست مسافران).
 */
async function searchOnce({ fields, passengers, cookies }) {
  const from_code = cityCode(fields.from_city);
  const to_code = cityCode(fields.to_city);
  const dateStr = (fields.date || '').trim();
  const genderStr = fields.gender || 'عادی';
  const trainNumber = (fields.train_number || '').trim();

  if (!from_code || !to_code || !dateStr) {
    return { ok: false, fatal: true, reason: 'invalid_input', error: 'ورودی‌ها ناقص است' };
  }

  // مبدا و مقصد یکسان جستجوی بی‌نتیجه است (و معمولاً نشانه پرشدن خودکار اشتباه
  // فرم توسط مرورگر)؛ قبل از هر درخواستی رد می‌شود.
  if (from_code === to_code) {
    return { ok: false, fatal: true, reason: 'invalid_input', error: 'مبدا و مقصد نمی‌توانند یکسان باشند. لطفاً شهرها را بررسی کنید.' };
  }

  // اعتبارسنجی تاریخ شمسی (معادل strptime در start_search نسخه اصلی)
  const dateMatch = dateStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!dateMatch) {
    return { ok: false, fatal: true, reason: 'invalid_input', error: 'فرمت تاریخ اشتباه است.' };
  }
  const [jy, jm, jd] = [parseInt(dateMatch[1], 10), parseInt(dateMatch[2], 10), parseInt(dateMatch[3], 10)];
  if (!jalaali.isValidJalaaliDate(jy, jm, jd)) {
    return { ok: false, fatal: true, reason: 'invalid_input', error: 'فرمت تاریخ اشتباه است.' };
  }

  // شمارش مسافران بر اساس نوع سهمیه (معادل start_search در نسخه اصلی)
  const passList = Array.isArray(passengers) ? passengers : [];
  if (passList.length > MAX_PASSENGERS) {
    return { ok: false, fatal: true, reason: 'invalid_input', error: 'حداکثر ' + MAX_PASSENGERS + ' مسافر مجاز است.' };
  }
  let adult = 0, child = 0, infant = 0, foreigner = 0;
  for (const p of passList) {
    const qt = p.quota_type || 'بزرگسال';
    if (qt === 'بزرگسال') adult += 1;
    else if (qt === 'خردسال') child += 1;
    else if (qt === 'کودک') infant += 1;
    else if (qt === 'اتباع') foreigner += 1;
  }
  const total = adult + child + infant + foreigner;
  if (total <= 0) {
    return { ok: false, fatal: true, reason: 'invalid_input', error: 'ورودی‌ها ناقص است' };
  }

  const searchData = buildSearchData({
    from_code, to_code, departure_date: dateStr, gender_str: genderStr,
    passengers: total, train_number: trainNumber,
    adult, child, infant, foreigner,
  });

  // نکته: سامانه سفیر ریل پارامترهای جستجو را از GET می‌خواند (فرم جستجوی سایت
  // با GET کار می‌کند). ارسال POST باعث می‌شود پارامترها دریافت نشوند و نتیجه خالی
  // برگردد. بنابراین درخواست جستجو با GET ارسال می‌شود.
  const fullUrl = config.base_url + config.search_url + '?' + toUrlEncoded(searchData);
  const headers = attachCookies(buildHeaders(), cookies);

  // اندازه‌گیری زمان واقعی رفت‌وبرگشت — به کاربر نشان می‌دهیم که درخواست‌ها
  // واقعاً به سفیر می‌روند و پاسخ می‌گیرند.
  const tStart = Date.now();
  let resp;
  try {
    // تایم‌اوت: تلاشی که بیش از ۲۵ ثانیه طول بکشد رها می‌شود تا حلقه جستجو
    // پشت یک درخواست گیرکرده معطل نماند.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 25000);
    try {
      resp = await safirFetch(fullUrl, { method: 'GET', headers, signal: controller.signal });
    } finally {
      clearTimeout(abortTimer);
    }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (e && e.name === 'AbortError') {
      return { ok: false, transient: true, netError: true, error: 'پاسخ سفیر ریل بیش از ۲۵ ثانیه طول کشید؛ این تلاش رها شد و تلاش بعدی انجام می‌شود.', timing: { totalMs: Date.now() - tStart } };
    }
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket|TLS|SSL|ETIMEDOUT|EAI_AGAIN|EPIPE|network/i.test(msg)) {
      // مهم: یک خطای شبکه به‌تنهایی «دائمی» نیست. سامانه سفیر ریل مرتباً
      // قطعی کوتاه، ری‌ست اتصال و تایم‌اوت می‌دهد — مخصوصاً در ساعات شلوغ.
      // اگر حلقه با اولین خطا متوقف شود، کاربر ظرفیت را از دست می‌دهد.
      // بنابراین اینجا فقط «خطای گذرا» گزارش می‌شود و تصمیم توقف بر عهده
      // لایه بالاتر است که خطاهای پیاپی را می‌شمارد.
      return {
        ok: false,
        transient: true,
        netError: true,
        error: 'اتصال به سامانه سفیر ریل برقرار نشد (' + msg + '). تلاش دوباره ادامه دارد.',
        hint: networkHint(),
        timing: { totalMs: Date.now() - tStart },
      };
    }
    return { ok: false, error: 'خطا در دریافت پاسخ جستجو: ' + msg };
  }

  const ttfbMs = Date.now() - tStart;

  if (!resp.ok) {
    return {
      ok: false,
      httpStatus: resp.status,
      transient: [408, 425, 429, 500, 502, 503, 504].includes(resp.status),
      sessionInvalid: resp.status === 401,
      error: 'خطا در دریافت پاسخ جستجو (کد ' + resp.status + ')',
      timing: { httpStatus: resp.status, totalMs: ttfbMs },
    };
  }

  const htmlText = await resp.text();
  const downloadMs = Date.now() - tStart;
  const bytes = Buffer.byteLength(htmlText, 'utf8');

  // «رسید» درخواست: مدرکی که به کاربر نشان می‌دهد درخواست واقعاً رفته و پاسخ آمده.
  const receipt = {
    httpStatus: resp.status,
    bytes,
    ttfbMs,
    totalMs: downloadMs,
    at: new Date().toISOString(),
    url: config.base_url + config.search_url,
    method: 'GET',
    // چند نویسه اول پاسخ به‌عنوان اثر انگشت (بدون افشای محتوای حساس)
    server: resp.headers.get('server') || null,
    contentEncoding: resp.headers.get('content-encoding') || 'none',
  };

  // Always inspect a 200 response before calling an empty parser result
  // "no capacity"; login forms and bot challenges may themselves be 200.
  const $doc = loadHtml(htmlText);
  const inspection = inspectSearchPage(htmlText, resp.url, $doc);
  if (inspection.reason !== 'search_results') {
    return { ok: false, reason: inspection.reason,
      sessionInvalid: !!inspection.sessionInvalid,
      captchaRequired: !!inspection.captchaRequired,
      error: inspection.error, receipt };
  }
  if (inspection.explicitEmpty && inspection.rows === 0) {
    return { ok: true, trains: [], searchData, receipt, availabilityStatus: 'no_match',
      note: 'صفحه رسمی برای این درخواست نتیجه‌ای نمایش نداد؛ این پاسخ به‌تنهایی به معنی تکمیل ظرفیت نیست. جستجو ادامه دارد.' };
  }

  const capacityNeeded = adult + child + infant + foreigner;
  const departureOpts = { searchDate: dateStr };
  const trains = extractTrains($doc, capacityNeeded, searchData.departureTrain || null, departureOpts);
  const diag = extractDiagnostics($doc, searchData.departureTrain || null, capacityNeeded, departureOpts);
  receipt.parseMs = Date.now() - tStart - downloadMs;
  receipt.rowsParsed = diag.totalRows;
  const sessionOk = hasSessionCookie(cookies);

  let note = null;
  let availabilityStatus = 'found';
  if (trains.length === 0 && diag.departedRows > 0 && diag.matchingRows === 0) {
    // Every matching train today has already left; nothing here is bookable.
    availabilityStatus = 'no_match';
    note = trainNumber
      ? 'ساعت حرکت قطار شماره ' + trainNumber + ' امروز گذشته است و قابل رزرو نیست.'
      : 'ساعت حرکت همه ' + diag.departedRows + ' قطار امروز گذشته است؛ قطار قابل رزروی برای امروز باقی نمانده.';
  } else if (trains.length === 0) {
    // A row is not evidence of zero seats. Count the selected train separately;
    // other trains' inventory must not be attributed to the requested train.
    if (trainNumber && diag.matchingRows === 0) {
      availabilityStatus = diag.unknownTrainNumberRows ? 'availability_unverified' : 'no_match';
      note = diag.totalRows + ' ردیف قطار در پاسخ دیده شد، اما ' +
        (diag.unknownTrainNumberRows ? 'شماره برخی ردیف‌ها خوانا نیست و وجود قطار ' : 'قطار شماره ') +
        trainNumber + ' در نتایج این تلاش تأیید نشد. جستجو ادامه دارد.';
    } else if (diag.unknownRows > 0) {
      availabilityStatus = 'availability_unverified';
      note = 'از ' + diag.matchingRows + ' ردیف مربوط به جستجوی شما، ظرفیت ' +
        diag.unknownRows + ' ردیف قابل خواندن نیست؛ نمی‌توان آن‌ها را صفر یا تکمیل فرض کرد. جستجو ادامه دارد.';
    } else if (diag.matchingRows > 0 && diag.knownRows === diag.matchingRows) {
      availabilityStatus = 'no_capacity';
      if (diag.zeroRows === diag.matchingRows) {
        note = 'در پاسخ همین تلاش، ظرفیت ثبت‌شده ' + diag.matchingRows +
          ' ردیف مرتبط صفر یا تکمیل است. این نتیجه، موجودی قطعی آینده را نشان نمی‌دهد؛ جستجو ادامه دارد.';
      } else {
        note = 'در پاسخ همین تلاش، ' + diag.nonzeroRows +
          ' ردیف ظرفیت غیرصفر دارند، اما ظرفیت هیچ ردیف مرتبطی برای ' +
          total + ' مسافر کافی نیست. جستجو ادامه دارد.';
      }
    } else {
      // Explicit empty-result marker was checked before this point.
      availabilityStatus = 'no_match';
      note = 'در پاسخ این تلاش، قطاری برای شرایط جستجوی شما نمایش داده نشد. جستجو ادامه دارد.';
    }
    if (!sessionOk) {
      note += ' کوکی PHPSESSID همراه درخواست نبود؛ وضعیت ورود از این پاسخ قابل تأیید نیست.';
    }
  }

  return { ok: true, trains, searchData, note, availabilityStatus, diag, sessionOk, receipt };
}

/**
 * ساخت فرم رزرو — پورت مستقیم perform_reservation در BilitFast.py.
 * به‌جای بازکردن Firefox، رشته HTML فرم برگردانده می‌شود تا برای دانلود ارائه شود.
 */
function buildReserveForm({ fields, passengers, train }) {
  const from_code = cityCode(fields.from_city);
  const to_code = cityCode(fields.to_city);
  const dateStr = (fields.date || '').trim();
  const genderStr = fields.gender || 'عادی';
  const trainNumber = train['شماره قطار'];
  const srvcValue = train['srvc'];

  if (!from_code || !to_code || !dateStr || !trainNumber || !srvcValue) {
    return { ok: false, error: 'اطلاعات رزرو ناقص است (srvc خالی یا داده ناقص).' };
  }

  const passList = Array.isArray(passengers) ? passengers : [];
  if (passList.length > MAX_PASSENGERS) {
    return { ok: false, error: 'حداکثر ' + MAX_PASSENGERS + ' مسافر مجاز است.' };
  }

  let adult = 0, child = 0, infant = 0, foreigner = 0;
  for (const p of passList) {
    const qt = p.quota_type || 'بزرگسال';
    if (qt === 'بزرگسال') adult += 1;
    else if (qt === 'خردسال') child += 1;
    else if (qt === 'کودک') infant += 1;
    else if (qt === 'اتباع') foreigner += 1;
  }
  const total = adult + child + infant + foreigner;

  const reserveData = buildSearchData({
    from_code, to_code, departure_date: dateStr, gender_str: genderStr,
    passengers: total, train_number: trainNumber,
    adult, child, infant, foreigner,
  });
  reserveData['srvc'] = srvcValue;

  // نکته: سامانه سفیر ریل پارامترهای رزرو را از query-string می‌خواند (مانند
  // searchWagn.php). بنابراین فرم دانلودی نیز با GET ساخته می‌شود تا وقتی
  // کاربر آن را در مرورگر باز می‌کند، پارامترها واقعاً دریافت شوند.
  const action = config.base_url + config.reserve_url;
  let formHtml = '<html><head><meta charset="UTF-8"></head><body onload="document.forms[0].submit();">';
  formHtml += '<form action="' + action + '" method="GET">';
  for (const [key, value] of Object.entries(reserveData)) {
    const escaped = typeof value === 'string' ? value.replace(/"/g, '&quot;') : value;
    formHtml += '<input type="hidden" name="' + key + '" value="' + escaped + '"/>';
  }
  formHtml += '</form></body></html>';

  return { ok: true, formHtml, reserveData };
}

/** استخراج کوکی‌ها از هدر set-cookie پاسخ. */
function extractCookies(resp) {
  let setCookies = [];
  if (typeof resp.headers.getSetCookie === 'function') {
    setCookies = resp.headers.getSetCookie();
  } else {
    const h = resp.headers.get('set-cookie');
    if (h) setCookies = [h];
  }
  const out = [];
  for (const sc of setCookies) {
    const parts = sc.split(';');
    if (parts[0] && parts[0].trim()) out.push(parts[0].trim());
  }
  return out;
}

/**
 * آیا این کوکی‌ها واقعاً یک نشستِ *وارد شده* هستند؟
 *
 * وجود PHPSESSID هیچ چیزی را ثابت نمی‌کند: سایت به هر بازدیدکننده‌ای، حتی
 * مهمانِ وارد نشده، یک PHPSESSID می‌دهد. تا امروز برنامه فقط وجود این کوکی
 * را چک می‌کرد و به کاربر می‌گفت «متصل شدید» — بعد در لحظه رزرو با خطای
 * «نیاز به ورود» شکست می‌خورد. این تابع با یک درخواست واقعی به سایت،
 * وضعیت را قطعی می‌کند.
 *
 * @returns {Promise<{valid:boolean, reason?:string}>}
 */
async function verifySession(cookies, options = {}) {
  if (!hasSessionCookie(cookies)) {
    return { valid: false, reason: 'no_session_cookie' };
  }
  const headers = attachCookies(buildHeaders(), cookies);
  // Strict allowlist: callers cannot turn a verification probe into SSRF.
  // GET /etrain/TresV-auth.php is NOT a valid login probe: the booking
  // workflow initializes that route with POST and form fields. A GET often
  // serves an unrelated login form, even when the general account is active.
  // Probe a read-only reservation-area URL instead, and require an explicit
  // authenticated marker before calling the reservation session verified.
  const loginPath = options.loginPath === '/etrain/index.php'
    ? '/etrain/index.php' : (config.login_form_url || '/fa/UserAut.php');
  const strict = !!options.requirePositiveEvidence;
  const url = config.base_url + loginPath;
  let resp;
  try {
    resp = await safirFetch(url, { method: 'GET', headers, redirect: 'manual' });
  } catch (e) {
    return { valid: false, reason: 'network', error: (e && e.message) || String(e) };
  }
  let text = '';
  try { text = await resp.text(); } catch (e) { text = ''; }
  if (resp.status === 401 || resp.status === 403) {
    return { valid: false, reason: 'not_logged_in' };
  }
  if (resp.status < 200 || resp.status >= 400) {
    return { valid: false, reason: 'verification_unavailable' };
  }

  if (resp.status >= 300 && resp.status < 400) {
    // A redirect *to the login form* is not proof of authentication.
    const destination = typeof resp.headers?.get === 'function' ? (resp.headers.get('location') || '') : '';
    if (/(?:UserAut|TresV-auth|Login\/process)\.php/i.test(destination)) {
      return { valid: false, reason: 'not_logged_in' };
    }
    // A redirect is only a positive indicator for legacy /fa checks. For a
    // read-only reservation probe, a redirect by itself proves nothing.
    return strict ? { valid: false, reason: 'verification_inconclusive' } : { valid: true };
  }

  /* تشخیص «وارد شده‌ای یا نه».
   *
   * دام مهم: نسخه قبلی با دیدن کلمه «گذرواژه» یا رشته «UserAut.php» در هر
   * جای صفحه، نشست را نامعتبر اعلام می‌کرد. ولی صفحهٔ کاربرِ *واردشده* هم
   * تقریباً همیشه این‌ها را دارد — لینک «خروج» به UserAut.php می‌رود و منوی
   * حساب گزینهٔ «تغییر گذرواژه» دارد. نتیجه این بود که نشست کاملاً سالم
   * «منقضی» تشخیص داده می‌شد و هر چهار روش انتقال کوکی پشت‌سرهم رد می‌شدند.
   *
   * حالا فقط به نشانه‌های ساختاری تکیه می‌کنیم:
   *   - نشانهٔ ورود لازم: یک فیلد گذرواژهٔ واقعی (<input type=password>) یا
   *     فرمی که به endpoint ورود POST می‌کند.
   *   - نشانهٔ واردبودن: لینک خروج، که فقط به کاربر واردشده نشان داده می‌شود.
   * اگر هر دو دیده شد، «واردبودن» مقدم است (صفحهٔ حساب با فرم تغییر گذرواژه).
   */
  const hasPasswordField =
    /<input[^>]+type=["']?password["']?/i.test(text) ||
    /<input[^>]+name=["']?pass(word)?["']?[^>]*>/i.test(text);
  const postsToLogin = /<form[^>]+action=["'][^"']*(Login\/process|UserAut)[^"']*["']/i.test(text);
  const loginFormShown = hasPasswordField || postsToLogin;

  const loggedInMark =
    /logout|signout|sign_out|خروج\s*از\s*حساب|LogOut\.php/i.test(text) ||
    /UserAut\.php\?[^"']*logout/i.test(text);

  if (loggedInMark && !postsToLogin) return { valid: true };
  if (loginFormShown) return { valid: false, reason: 'not_logged_in' };
  // The public reservation landing page can render normally for guests as
  // well as authenticated users. A generic 200 is NOT proof of login.
  return strict ? { valid: false, reason: 'verification_inconclusive' } : { valid: true };
}

/**
 * ورود به سامانه سفیر ریل.
 *
 * جریان واقعی (بر اساس DOM سایت):
 *   ۱) GET فرم ورود → دریافت کوکی نشست (PHPSESSID) + فیلدهای مخفی فرم
 *      (مانند SiteIdValue) و دکمه submit (مانند sublogin).
 *   ۲) POST به endpoint ورود (fa/Login/process.php) با user/pass + همان
 *      فیلدهای استخراج‌شده + کوکی نشست.
 *
 * این روش هیچ مقدار ثابتی را حدس نمی‌زند: SiteIdValue/sublogin و هر فیلد
 * مخفی دیگری مستقیماً از خود فرم خوانده می‌شود.
 */
async function login(username, password) {
  const base = config.base_url;
  const formUrl = base + (config.login_form_url || '/fa/UserAut.php');
  const processUrl = base + (config.login_process_url || '/fa/Login/process.php');

  // ۱) دریافت فرم ورود
  let formResp;
  try {
    formResp = await safirFetch(formUrl, { method: 'GET', headers: buildHeaders(), redirect: 'manual' });
  } catch (e) {
    return { ok: false, error: 'خطا در ارتباط با سامانه: ' + (e.message || e) };
  }
  const formHtml = await formResp.text();
  const cookies = extractCookies(formResp);

  // ۲) استخراج فیلدهای مخفی و دکمه submit از فرم ورود (بدون حدس)
  const $ = cheerio.load(formHtml);
  const extra = {};
  $('form').first().find('input').each((_i, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    const n = $(el).attr('name');
    const v = $(el).attr('value') || '';
    if (n && (type === 'hidden' || type === 'submit')) extra[n] = v;
  });

  // ۳) ساخت بدنه: user/pass + فیلدهای استخراجی (SiteIdValue, sublogin و...)
  const params = new URLSearchParams();
  params.append(config.login_user_field || 'user', username);
  params.append(config.login_pass_field || 'pass', password);
  for (const [k, v] of Object.entries(extra)) {
    if (k !== (config.login_user_field || 'user') && k !== (config.login_pass_field || 'pass')) {
      params.append(k, v);
    }
  }

  // ۴) POST به endpoint ورود با کوکی نشست
  const headers = buildHeaders();
  if (cookies.length) headers['Cookie'] = cookies.map((c) => c.split(';')[0]).join('; ');
  let resp;
  try {
    resp = await safirFetch(processUrl, {
      method: 'POST',
      headers,
      body: params.toString(),
      redirect: 'manual',
    });
  } catch (e) {
    return { ok: false, error: 'خطا در ارتباط با سامانه: ' + (e.message || e) };
  }

  // ۵) ادغام کوکی‌ها (نام تکراری = آخرین برنده)
  const map = new Map();
  for (const c of cookies) map.set(c.split('=')[0], c);
  for (const c of extractCookies(resp)) map.set(c.split('=')[0], c);
  const finalCookies = Array.from(map.values());

  // ۶) تشخیص موفقیت
  const text = await resp.text();
  const marker = config.login_success_marker;
  let success;
  if (marker) {
    success = text.includes(marker);
  } else {
    /* همان دام verifySession: صفحهٔ کاربرِ واردشده هم «گذرواژه» (تغییر
     * گذرواژه) و «UserAut» (لینک خروج) دارد. اگر با این کلمات قضاوت کنیم،
     * ورودِ موفق را ناموفق می‌خوانیم و ورود خودکار هیچ‌وقت جواب نمی‌دهد.
     * پس فقط فرمِ ورودِ واقعی را نشانهٔ شکست می‌گیریم. */
    const passwordField =
      /<input[^>]+type=["']?password["']?/i.test(text) ||
      /<input[^>]+name=["']?pass(word)?["']?[^>]*>/i.test(text);
    const loginForm = /<form[^>]+action=["'][^"']*(Login\/process|UserAut)[^"']*["']/i.test(text);
    const stillLogin = passwordField || loginForm;
    success = (resp.status >= 300 && resp.status < 400) || !stillLogin;
  }

  if (!success) {
    // تشخیص مانع کپچا در فرم ورود: اگر صفحه خطا به کپچا/کد امنیتی اشاره دارد،
    // ورود خودکار از سمت سرور ممکن نیست و باید از روش انتقال کوکی استفاده شود.
    if (/captcha|کپچا|کد امنیتی|kcaptcha|kaptcha|securitycode/i.test(text)) {
      return {
        ok: false,
        captchaRequired: true,
        cookies: finalCookies,
        message: 'صفحه ورود سفیر ریل کد امنیتی (کپچا) می‌خواهد و ورود خودکار از سرور ممکن نیست. ' +
          'راه‌حل: خودتان در مرورگر وارد safirrail.ir شوید و کوکی‌ها را به برنامه منتقل کنید — ' +
          'روی دسکتاپ با افزونه، و روی موبایل با «دریافت کوکی ذخیره‌شده از حساب» در صفحه حساب ' +
          '(بعد از اینکه یک‌بار روی دسکتاپ کوکی در حسابتان ذخیره شده باشد).',
      };
    }
  }

  return {
    ok: success,
    cookies: finalCookies,
    message: success ? 'ورود موفقیت‌آمیز بود.' : 'ورود ناموفق بود (شناسه یا گذرواژه اشتباه، یا فیلدهای فرم نادرست).',
  };
}

module.exports = {
  config,
  cityCodes,
  cityCode,
  loadHtml,
  buildSearchData,
  extractTrains,
  toLatinDigits,
  parseCapacity,
  parseCapacityInfo,
  extractDiagnostics,
  hasSessionCookie,
  verifySession,
  searchOnce,
  inspectSearchPage,
  isCloudEnv,
  networkHint,
  buildReserveForm,
  buildHeaders,
  toUrlEncoded,
  attachCookies,
  extractCookies,
  login,
};
