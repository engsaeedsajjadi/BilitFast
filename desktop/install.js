// desktop/install.js — ثبت/خواندن نشانه نصب در رجیستری ویندوز (نسخه exe).
//
// در اولین اجرای نسخه دسکتاپ روی هر کامپیوتر:
//   - شناسه دستگاه از روی MachineGuid ویندوز + شماره سریال دیسک + نام ماشین
//     ساخته می‌شود (برای اینکه کپی برنامه به سیستم دیگری، نصب تازه محسوب شود)؛
//   - تاریخ نصب (ISO) همراه شناسه دستگاه در رجیستری زیر
//     HKCU\Software\BilitFast نوشته می‌شود؛
//   - یک امضای HMAC (از lib/install-marker) هم ذخیره می‌شود تا کاربر نتواند
//     تاریخ را دستی به عقب/جلو ببرد.
// اجراهای بعدی همان رکورد خوانده می‌شود و تاریخ نصب تغییر نمی‌کند.
//
// این فایل فقط روی ویندوز معنا دارد و فقط از پوسته دسکتاپ (desktop/main.js)
// با محیط BILITFAST_DESKTOP=1 صدا زده می‌شود؛ در توسعه وب اجرا نمی‌شود.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

// در نسخه بسته‌بندی‌شده، کد سرور در resources/app قرار دارد (نه کنار فایل‌های asar).
const ROOT = process.env.BILITFAST_ROOT || path.join(__dirname, '..');
const { signInstallMarker, verifyInstallMarker } = require(path.join(ROOT, 'lib', 'install-marker'));
const APP_VERSION = (function () {
  try { return require(path.join(ROOT, 'package.json')).version || '1.0.0'; }
  catch (e) { return '1.0.0'; }
})();

const REG_PATH = 'HKCU\\Software\\BilitFast';

function reg(args) {
  return execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
}

function regQuery(fullPath, name) {
  try {
    const out = reg(['query', fullPath, '/v', name]);
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = out.match(new RegExp(esc + '\\s+REG_[A-Z_]+\\s+(.+)', 'i'));
    return m ? m[1].trim() : null;
  } catch (e) {
    return null;
  }
}

function regAdd(name, value) {
  reg(['add', REG_PATH, '/v', name, '/t', 'REG_SZ', '/d', String(value), '/f']);
}

function machineGuid() {
  return regQuery('HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'MachineGuid') ||
    regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Cryptography', 'MachineGuid') || '';
}

function volumeSerial() {
  try {
    const out = execFileSync('cmd.exe', ['/c', 'vol', 'C:'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})/);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

/** شناسه پایدار دستگاه (هش؛ اطلاعات خام هرگز ذخیره/ارسال نمی‌شود). */
function computeDeviceId() {
  const raw = [machineGuid(), volumeSerial(), os.hostname(), os.platform()].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * رکورد نصب را می‌خواند یا در اولین اجرا می‌سازد.
 * خروجی: { ok, created, installDate, deviceId, appVersion, signature }
 */
function ensureInstallMarker() {
  if (os.platform() !== 'win32') {
    return { ok: false, reason: 'not-windows' };
  }
  try {
    const deviceId = computeDeviceId();
    const existingSig = regQuery(REG_PATH, 'InstallSignature');
    const existing = verifyInstallMarker(existingSig || '');

    // رکورد سالم و متعلق به همین دستگاه → تاریخ نصب اصلی حفظ می‌شود.
    if (existing && existing.deviceId === deviceId) {
      return {
        ok: true, created: false,
        installDate: existing.installDate,
        deviceId: existing.deviceId,
        appVersion: existing.appVersion || APP_VERSION,
        signature: existingSig,
      };
    }

    // یا رکوردی نیست، یا امضا خراب/جعل شده، یا متعلق به دستگاه دیگری است
    // (مثلاً پوشه برنامه از سیستم دیگری کپی شده) → نصب تازه، امروز.
    const payload = {
      installDate: new Date().toISOString(),
      deviceId,
      appVersion: APP_VERSION,
    };
    const signature = signInstallMarker(payload);
    regAdd('InstallDate', payload.installDate);
    regAdd('DeviceId', deviceId);
    regAdd('AppVersion', APP_VERSION);
    regAdd('InstallSignature', signature);

    return { ok: true, created: true, ...payload, signature };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensureInstallMarker, computeDeviceId };
