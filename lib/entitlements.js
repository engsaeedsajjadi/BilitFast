// Production license grants: user-bound, expiring, one-time activation codes.
// This implementation uses the existing single-process store. A scaled-out
// deployment MUST move redemption and issuance into a transactional database.
'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const accounts = require('./accounts');

const MAX_DAYS = 90;
const DEFAULT_DAYS = 14;
function hashCode(code) {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}
function issueCode(userId, validDays = DEFAULT_DAYS) {
  const user = db.findById('users', userId);
  if (!user || !accounts.accountStatus(user).ok) {
    return { ok: false, error: 'حساب فعال یافت نشد.' };
  }
  const days = Number(validDays);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
    return { ok: false, error: 'اعتبار کد باید بین ۱ تا ۹۰ روز باشد.' };
  }
  const code = 'BF-' + crypto.randomBytes(24).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  const record = db.insert('license_codes', {
    user_id: userId,
    code_hash: hashCode(code),
    expires_at: expiresAt,
    redeemed_at: null,
    revoked_at: null,
  });
  return { ok: true, code, expiresAt, userId, recordId: record.id };
}
function redeemCode(userId, input) {
  const user = db.findById('users', userId);
  if (!user || !accounts.accountStatus(user).ok) return { ok: false, error: 'حساب فعال یافت نشد.' };
  const code = String(input || '').trim().toUpperCase();
  if (!/^BF-[A-F0-9]{48}$/.test(code)) return { ok: false, error: 'کد فعال‌سازی نامعتبر یا مصرف‌شده است.' };
  const hash = hashCode(code);
  const matches = db.find('license_codes', rec => rec.user_id === userId && rec.code_hash === hash);
  const record = matches.find(rec => !rec.redeemed_at && !rec.revoked_at &&
    Date.parse(rec.expires_at) > Date.now());
  if (!record) return { ok: false, error: 'کد فعال‌سازی نامعتبر، منقضی یا مصرف‌شده است.' };
  // At the current single-process scale these mutations cannot interleave.
  // Do not re-use this sequence in multi-instance production without a DB transaction.
  db.update('license_codes', record.id, { redeemed_at: new Date().toISOString() });
  db.update('users', userId, { license_activated: true, license_activated_at: new Date().toISOString() });
  return { ok: true, userId };
}
function revokeUser(userId) {
  const user = db.findById('users', userId);
  if (!user) return { ok: false, error: 'کاربر یافت نشد.' };
  db.update('users', userId, { license_activated: false, license_revoked_at: new Date().toISOString() });
  for (const record of db.find('license_codes', r => r.user_id === userId && !r.redeemed_at && !r.revoked_at)) {
    db.update('license_codes', record.id, { revoked_at: new Date().toISOString() });
  }
  return { ok: true };
}
module.exports = { issueCode, redeemCode, revokeUser };
