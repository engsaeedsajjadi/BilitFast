// Desktop-only license state. The browser cannot supply the install marker:
// trusted Electron parent transmits it to the forked loopback server at launch.
'use strict';
const db = require('./db');
const { verifyInstallMarker } = require('./install-marker');
const { verifyOfflineCode } = require('./vendor-license');
const TRIAL_DAYS = 3;
const TRIAL_MS = TRIAL_DAYS * 86400000;
const CLOCK_TOLERANCE_MS = 5 * 60000;
function isDesktopMode() { return process.env.BILITFAST_DESKTOP === '1'; }
function install() {
  if (!isDesktopMode()) return null;
  const token = String(process.env.BILITFAST_DESKTOP_INSTALL_SIGNATURE || '');
  const id = String(process.env.BILITFAST_DESKTOP_DEVICE_ID || '');
  const marker = verifyInstallMarker(token);
  if (!marker || marker.deviceId !== id || !/^[0-9a-f]{32}$/.test(id)) return null;
  const start = Date.parse(marker.installDate);
  if (!Number.isFinite(start) || start > Date.now() + CLOCK_TOLERANCE_MS) return null;
  return marker;
}
function status(now = Date.now()) {
  const marker = install();
  if (!marker) {
    const reason = String(process.env.BILITFAST_DESKTOP_INSTALL_ERROR || 'install_unavailable');
    const messages = {
      marker_key_unavailable: 'ثبت نصب قدیمی موجود است، اما کلید امضای آن در پوشه‌های شناخته‌شده پیدا نشد. اطلاعات نصب پاک نشده است؛ برای بازیابی مجاز به راهنمای تعمیر توسعه‌دهنده مراجعه کنید.',
      device_changed: 'شناسه سخت‌افزاری با ثبت نصب قبلی تطابق ندارد. برای انتقال مجوز با فروشنده تماس بگیرید.',
      signature_mismatch: 'امضای ثبت نصب قبلی با کلید فعلی مطابقت ندارد. تاریخ نصب را تغییر ندهید؛ بازیابی نیازمند تأیید است.',
      incomplete_registry: 'رکورد نصب قبلی ناقص است. اطلاعات را پاک نکنید و برای بازیابی با پشتیبانی تماس بگیرید.',
    };
    return { state: 'install_invalid', allowed: false,
      message: messages[reason] || 'ثبت نصب دستگاه معتبر نیست. برای بازیابی با پشتیبانی تماس بگیرید.',
      reason: Object.hasOwn(messages, reason) ? reason : 'install_unavailable', source: 'desktop' };
  }
  const clock = db.findOne('desktop_license_clock', x => x.deviceId === marker.deviceId);
  if (clock && now + CLOCK_TOLERANCE_MS < clock.lastSeen) {
    return { state: 'clock_invalid', allowed: false,
      message: 'ساعت دستگاه نسبت به اجرای قبلی عقب رفته است. ساعت را اصلاح کنید.',
      source: 'desktop', deviceId: marker.deviceId };
  }
  // Keep the highest observed clock to detect rollback. Not tamper-proof
  // against the owner editing their local storage — an online license service
  // is required for stronger anti-tamper guarantees.
  if (!clock) db.insert('desktop_license_clock', { deviceId: marker.deviceId, lastSeen: now });
  else if (now > clock.lastSeen + 60000) db.update('desktop_license_clock', clock.id, { lastSeen: now });
  const entitlement = db.findOne('desktop_entitlements', x => x.deviceId === marker.deviceId);
  if (entitlement && entitlement.signedCode) {
    const checked = verifyOfflineCode(entitlement.signedCode, marker.deviceId, { alreadyRedeemed: true });
    if (checked.ok) return {
      state: 'activated', allowed: true, message: 'لایسنس دائمی این دستگاه فعال است.',
      deviceId: marker.deviceId, activatedAt: entitlement.activatedAt,
      source: 'desktop', trialDays: TRIAL_DAYS,
    };
  }
  const start = Date.parse(marker.installDate);
  const expiresAt = start + TRIAL_MS;
  const remainingMs = Math.max(0, expiresAt - now);
  const active = now < expiresAt;
  return {
    state: active ? 'active' : 'expired', allowed: active,
    message: active ? 'دوره آزمایشی ۳ روزه فعال است.' : 'دوره آزمایشی ۳ روزه به پایان رسیده است.',
    source: 'desktop', deviceId: marker.deviceId, trialDays: TRIAL_DAYS,
    startedAt: new Date(start).toISOString(), expiresAt: new Date(expiresAt).toISOString(), remainingMs,
  };
}
function redeem(code) {
  const marker = install();
  if (!marker) return { ok: false, error: 'نصب دستگاه معتبر نیست.' };
  const existing = db.findOne('desktop_entitlements', x => x.deviceId === marker.deviceId);
  if (existing && status().state === 'activated') {
    return { ok: true, message: 'مجوز دائمی قبلاً فعال شده است.', state: 'activated' };
  }
  const checked = verifyOfflineCode(code, marker.deviceId);
  if (!checked.ok) return checked;
  const patch = { signedCode: String(code).trim(), activatedAt: new Date().toISOString() };
  if (existing) db.update('desktop_entitlements', existing.id, patch);
  else db.insert('desktop_entitlements', { deviceId: marker.deviceId, ...patch });
  return { ok: true, message: 'لایسنس دائمی برای این دستگاه فعال شد.', state: 'activated' };
}
module.exports = { isDesktopMode, install, status, redeem, TRIAL_DAYS, TRIAL_MS };
