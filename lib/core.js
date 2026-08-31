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

// خواندن تنظیمات و کد شهرها (همان فایل‌های نسخه اصلی)
const config = require(path.join(__dirname, '..', 'config.json'));
const cityCodes = require(path.join(__dirname, '..', 'cities.json'));

/** جستجوی کد شهر بر اساس نام (معادل نگاه در دیکشنری city_codes پایتون). */
function cityCode(name) {
  return cityCodes[name];
}

/** نگاشت جنسیت به کد عددی (معادل gender_map در _build_search_data). */
const GENDER_MAP = { 'عادی': '3', 'برادران': '2', 'خواهران': '1' };

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
 * استخراج قطارها — پورت مستقیم extract_trains در BilitFast.py.
 * سِلکتورهای CSS از config.json خوانده می‌شوند (همان مقادیر نسخه اصلی).
 */
function extractTrains(htmlText, capacityNeeded = 0, specificTrainNumber = null) {
  const $ = cheerio.load(htmlText);
  const rows = $(config.train_row_selector); // "tr[name='srvc']"
  const results = [];
  rows.each((_i, row) => {
    try {
      const trainNum = $(row).find(config.train_number_selector).first().text().trim();
      if (specificTrainNumber && trainNum !== specificTrainNumber) return;

      const timeText = $(row).find(config.departure_time_selector).first().text().trim();
      const capText = $(row).find(config.capacity_selector).first().text().trim();
      const availText = $(row).find(config.availability_selector).first().text().trim();

      const priceEl = $(row).find(config.price_selector).first();
      const priceText = priceEl.length ? priceEl.text().trim() : 'نامشخص';

      const coupeEl = $(row).find(config.coupe_selector).first();
      const coupeText = coupeEl.length ? coupeEl.text().trim() : 'نامشخص';

      const checkbox = $(row).find(config.srvc_checkbox_selector).first();
      const srvc = checkbox.attr('value') || '';

      const m = availText.match(/(\d+)/);
      const totalCapacity = m ? parseInt(m[1], 10) : 0;

      if (totalCapacity >= capacityNeeded) {
        results.push({
          'شماره قطار': trainNum,
          'ساعت حرکت': timeText,
          'قیمت': priceText,
          'نوع کوپه': coupeText,
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

/** ساخت هدر درخواست به سایت صفیر ریل (معادل default_headers در _send_request). */
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
    return { ok: false, error: 'ورودی‌ها ناقص است' };
  }

  // اعتبارسنجی تاریخ شمسی (معادل strptime در start_search نسخه اصلی)
  const dateMatch = dateStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!dateMatch) {
    return { ok: false, error: 'فرمت تاریخ اشتباه است.' };
  }
  const [jy, jm, jd] = [parseInt(dateMatch[1], 10), parseInt(dateMatch[2], 10), parseInt(dateMatch[3], 10)];
  if (!jalaali.isValidJalaaliDate(jy, jm, jd)) {
    return { ok: false, error: 'فرمت تاریخ اشتباه است.' };
  }

  // شمارش مسافران بر اساس نوع سهمیه (معادل start_search در نسخه اصلی)
  let adult = 0, child = 0, infant = 0, foreigner = 0;
  for (const p of passengers || []) {
    const qt = p.quota_type || 'بزرگسال';
    if (qt === 'بزرگسال') adult += 1;
    else if (qt === 'خردسال') child += 1;
    else if (qt === 'کودک') infant += 1;
    else if (qt === 'اتباع') foreigner += 1;
  }
  const total = adult + child + infant + foreigner;
  if (total <= 0) {
    return { ok: false, error: 'ورودی‌ها ناقص است' };
  }

  const searchData = buildSearchData({
    from_code, to_code, departure_date: dateStr, gender_str: genderStr,
    passengers: total, train_number: trainNumber,
    adult, child, infant, foreigner,
  });

  const fullUrl = config.base_url + config.search_url;
  const headers = attachCookies(buildHeaders(), cookies);

  let resp;
  try {
    resp = await fetch(fullUrl, {
      method: 'POST',
      headers,
      body: toUrlEncoded(searchData),
    });
  } catch (e) {
    return { ok: false, error: 'خطا در دریافت پاسخ جستجو: ' + (e.message || e) };
  }

  if (!resp.ok) {
    return { ok: false, error: 'خطا در دریافت پاسخ جستجو (کد ' + resp.status + ')' };
  }

  const htmlText = await resp.text();
  const capacityNeeded = adult + child + infant + foreigner;
  const trains = extractTrains(htmlText, capacityNeeded, searchData.departureTrain || null);

  return { ok: true, trains, searchData };
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

  let adult = 0, child = 0, infant = 0, foreigner = 0;
  for (const p of passengers || []) {
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

  const action = config.base_url + config.reserve_url;
  let formHtml = '<html><head><meta charset="UTF-8"></head><body onload="document.forms[0].submit();">';
  formHtml += '<form action="' + action + '" method="POST">';
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

/** ورود به سامانه صفیر ریل (معادل login در نسخه وب Flask). */
async function login(username, password) {
  const loginUrl = config.base_url + (config.login_url || '/fa/UserAut.php');
  const params = new URLSearchParams();
  params.append(config.login_user_field || 'user', username);
  params.append(config.login_pass_field || 'pass', password);
  if (config.login_action) params.append('Action', config.login_action);
  const extra = config.login_extra_data || {};
  for (const [k, v] of Object.entries(extra)) params.append(k, String(v));

  let resp;
  try {
    resp = await fetch(loginUrl, {
      method: 'POST',
      headers: buildHeaders(),
      body: params.toString(),
      redirect: 'manual',
    });
  } catch (e) {
    return { ok: false, error: 'خطا در ارتباط با سامانه: ' + (e.message || e) };
  }

  const text = await resp.text();
  const cookies = extractCookies(resp);
  const marker = config.login_success_marker;
  const success = marker ? text.includes(marker) : cookies.length > 0;

  return { ok: success, cookies, message: success ? 'ورود موفقیت‌آمیز بود.' : 'ورود ناموفق بود (شناسه یا گذرواژه اشتباه، یا فیلدهای فرم نادرست).' };
}

module.exports = {
  config,
  cityCodes,
  cityCode,
  buildSearchData,
  extractTrains,
  searchOnce,
  buildReserveForm,
  login,
};
