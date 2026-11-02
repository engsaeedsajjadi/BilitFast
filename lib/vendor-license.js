// Offline, device-bound, vendor-signed perpetual license codes (Ed25519).
// Ship ONLY the PUBLIC key; the private key lives on the seller's machine.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const CODE_PREFIX = 'BF1';

function publicKeyPath() {
  return process.env.BILITFAST_VENDOR_PUBLIC_KEY_PATH || path.join(__dirname, '..', 'config', 'license-public.pem');
}
function verifyOfflineCode(input, deviceId, options = {}) {
  const code = String(input || '').trim();
  if (code.length > 4096 || !/^BF1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(code)) {
    return { ok: false, error: 'ساختار کد فعال‌سازی معتبر نیست.' };
  }
  const [, data, sig] = code.split('.');
  let payload;
  try {
    const pem = fs.readFileSync(publicKeyPath(), 'utf8');
    const valid = crypto.verify(null, Buffer.from(data, 'ascii'),
      crypto.createPublicKey(pem), Buffer.from(sig, 'base64url'));
    if (!valid) return { ok: false, error: 'امضای کد فعال‌سازی معتبر نیست.' };
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, error: 'کلید عمومی فروشنده تنظیم نشده یا کد نامعتبر است.' };
  }
  if (!payload || payload.v !== 1 || payload.product !== 'bilitfast' ||
      payload.kind !== 'perpetual' || typeof payload.deviceId !== 'string' ||
      !/^[0-9a-f]{32}$/.test(payload.deviceId) || !/^[0-9a-f-]{36}$/.test(payload.licenseId || '')) {
    return { ok: false, error: 'نوع مجوز معتبر نیست.' };
  }
  if (payload.deviceId !== String(deviceId || '')) {
    return { ok: false, error: 'این کد برای دستگاه دیگری صادر شده است.' };
  }
  if (!Number.isSafeInteger(payload.issuedAt) || payload.issuedAt > Date.now() + 300000) {
    return { ok: false, error: 'تاریخ صدور کد معتبر نیست.' };
  }
  if (!options.alreadyRedeemed && (!Number.isSafeInteger(payload.redeemBy) || Date.now() > payload.redeemBy)) {
    return { ok: false, error: 'فرصت واردکردن این کد به پایان رسیده است؛ از فروشنده کد جدید بگیرید.' };
  }
  return { ok: true, payload };
}

function createOfflineCode(privateKeyPem, deviceId, options = {}) {
  if (!/^[0-9a-f]{32}$/.test(String(deviceId || ''))) throw new Error('Invalid 32-character device ID');
  const days = Number(options.redeemDays ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Invalid redemption days (1..365)');
  const payload = {
    v: 1, product: 'bilitfast', kind: 'perpetual', deviceId,
    licenseId: crypto.randomUUID(), issuedAt: Date.now(),
    redeemBy: Date.now() + days * 86400000,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(data, 'ascii'), privateKeyPem).toString('base64url');
  return { code: CODE_PREFIX + '.' + data + '.' + signature, payload };
}
/** Seller-approved one-time binding for legacy v1 installations.
 * An environment variable alone can never authorize re-binding a copied v1
 * installation. The vendor must sign installation ID + target host hash.
 */
function createMigrationCode(privateKeyPem, deviceId, machineHash, options = {}) {
  if (!/^[0-9a-f]{32}$/.test(String(deviceId || ''))) throw new Error('Invalid installation ID');
  if (!/^[0-9a-f]{64}$/.test(String(machineHash || ''))) throw new Error('Invalid machine hash');
  const days = Number(options.redeemDays ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('Invalid migration window (1..30 days)');
  const payload = {
    v: 1, product: 'bilitfast', kind: 'binding-migration', deviceId, machineHash,
    migrationId: crypto.randomUUID(), issuedAt: Date.now(),
    redeemBy: Date.now() + days * 86400000,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(data, 'ascii'), privateKeyPem).toString('base64url');
  return { code: 'BFM1.' + data + '.' + sig, payload };
}
function verifyMigrationCode(input, deviceId, machineHash) {
  const code = String(input || '').trim();
  if (code.length > 4096 || !/^BFM1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(code))
    return {ok:false,error:'کد تایید مهاجرت معتبر نیست.'};
  const [,data,sig] = code.split('.');
  let payload;
  try {
    const key = crypto.createPublicKey(fs.readFileSync(publicKeyPath(), 'utf8'));
    if (!crypto.verify(null,Buffer.from(data,'ascii'),key,Buffer.from(sig,'base64url')))
      return {ok:false,error:'امضای مهاجرت فروشنده معتبر نیست.'};
    payload = JSON.parse(Buffer.from(data,'base64url').toString('utf8'));
  } catch (_) {return {ok:false,error:'کلید عمومی فروشنده یا کد مهاجرت نامعتبر است.'};}
  if (!payload || payload.v !== 1 || payload.product !== 'bilitfast' ||
      payload.kind !== 'binding-migration' || payload.deviceId !== deviceId ||
      payload.machineHash !== machineHash ||
      !/^[a-f0-9-]{36}$/.test(payload.migrationId || '') ||
      !Number.isSafeInteger(payload.issuedAt) || payload.issuedAt > Date.now()+300000 ||
      !Number.isSafeInteger(payload.redeemBy) || Date.now() > payload.redeemBy ||
      payload.redeemBy - payload.issuedAt > 30*86400000+300000) {
    return {ok:false,error:'این تایید مهاجرت برای نصب/میزبان دیگری است یا منقضی شده.'};
  }
  return {ok:true,payload};
}
module.exports = { verifyOfflineCode, createOfflineCode, publicKeyPath, createMigrationCode, verifyMigrationCode };
