// lib/install-marker.js — نشانه نصب ضد‌دستکاری (نسخه دسکتاپ/ویندوز).
//
// در نسخه exe، اولین باری که برنامه روی یک کامپیوتر اجرا می‌شود، تاریخ نصب و
// شناسه دستگاه در رجیستری ویندوز (HKCU\Software\BilitFast) نوشته می‌شود و یک
// توکن امضاشده (HMAC-SHA256) همراه آن ذخیره می‌شود. هدف:
//   ۱) برنامه بداند «واقعاً» چه زمانی روی این دستگاه نصب شده (نه تاریخ امروزِ
//      هر بار اجرا)؛
//   ۲) با نصب مجدد/پاک‌کردن پوشه برنامه، دوره آزمایشی از نو شروع نشود؛
//   ۳) رکورد قابل دستکاری دستی نباشد (امضا با کلید مشترک بررسی می‌شود).
//
// کلید: متغیر محیطی BILITFAST_INSTALL_KEY؛ در توسعه از کلید پیش‌فرض استفاده
// می‌شود. در بسته‌بندی نهایی بهتر است کلید واقعی هنگام build تزریق شود.

const crypto = require('crypto');
const secrets = require('./secrets');

function markerKey() {
  return secrets.installKey();
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function canonical(payload) {
  return [payload.installDate || '', payload.deviceId || '', payload.appVersion || ''].join('|');
}

/** ساخت توکن امضاشده از رکورد نصب. */
function signInstallMarker(payload) {
  const body = b64url(JSON.stringify({
    installDate: String(payload.installDate || ''),
    deviceId: String(payload.deviceId || ''),
    appVersion: String(payload.appVersion || ''),
    iat: Date.now(),
  }));
  const sig = crypto.createHmac('sha256', markerKey()).update(body).digest('base64url');
  return body + '.' + sig;
}

/** اعتبارسنجی توکن؛ بدنه معتبر را برمی‌گرداند یا null. */
function verifyInstallMarker(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', markerKey()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || !p.installDate || !p.deviceId) return null;
    const d = new Date(p.installDate);
    if (isNaN(d.getTime())) return null;
    return p;
  } catch (e) {
    return null;
  }
}

module.exports = { signInstallMarker, verifyInstallMarker, canonical };
