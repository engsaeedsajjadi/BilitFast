// -*- coding: utf-8 -*-
/**
 * lib/auth.js — حساب کاربری و نشست.
 *
 * - هش گذرواژه با scrypt (بدون وابستگی خارجی) + نمک تصادفی.
 * - توکن نشست امضاشده (HMAC) با انقضا؛ بدون نیاز به جدول نشست در دیتابیس.
 * - کلید امضا از BILITFAST_LICENSE_KEY گرفته می‌شود.
 */

const crypto = require('crypto');
const db = require('./db');
const { getRequiredEnv } = require('./http');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // ۷ روز
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };

function secretKey() {
  return getRequiredEnv('BILITFAST_LICENSE_KEY', { devFallback: 'bilitfast-license-dev-only-key' });
}

/* ---------------- هش گذرواژه ---------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS).toString('hex');
  return { salt, hash, alg: 'scrypt' };
}

function verifyPassword(password, stored) {
  try {
    const got = crypto.scryptSync(String(password), stored.salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
    const want = Buffer.from(stored.hash, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) {
    return false;
  }
}

/* ---------------- توکن نشست ---------------- */

function signSession(userId) {
  const body = Buffer.from(JSON.stringify({ type: 'session', uid: userId, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!o || o.type !== 'session' || !o.uid) return null;
    if (o.exp && Date.now() > o.exp) return null;
    return o;
  } catch (e) {
    return null;
  }
}

/* ---------------- کاربران ---------------- */

const USERNAME_RE = /^[a-zA-Z0-9_.@-]{3,64}$/;

function validateUsername(username) {
  return USERNAME_RE.test(String(username || '').trim());
}

function registerUser(username, password) {
  const uname = String(username || '').trim().toLowerCase();
  if (!validateUsername(uname)) {
    return { ok: false, error: 'نام کاربری باید ۳ تا ۶۴ کاراکتر (حروف انگلیسی، رقم، نقطه، خط تیره یا _) باشد.' };
  }
  if (String(password || '').length < 6) {
    return { ok: false, error: 'گذرواژه باید حداقل ۶ کاراکتر باشد.' };
  }
  if (db.findOne('users', (u) => u.username === uname)) {
    return { ok: false, error: 'این نام کاربری قبلاً ثبت شده است.' };
  }
  const user = db.insert('users', {
    username: uname,
    pass: hashPassword(password),
    phone: '',
    telegram_chat_id: '',
    telegram_connect_code: '',
    telegram_connect_code_expires_at: 0,
    notify: { telegram: true, sms: false },
    trial: { startDate: null },
  });
  return { ok: true, user, token: signSession(user.id) };
}

function loginUser(username, password) {
  const uname = String(username || '').trim().toLowerCase();
  const user = db.findOne('users', (u) => u.username === uname);
  if (!user || !verifyPassword(password, user.pass)) {
    return { ok: false, error: 'نام کاربری یا گذرواژه نادرست است.' };
  }
  return { ok: true, user, token: signSession(user.id) };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    phone: user.phone || '',
    telegram_connected: !!(user.telegram_chat_id),
    notify: user.notify || { telegram: true, sms: false },
    trial: user.trial || null,
    created_at: user.created_at,
  };
}

/** استخراج کاربر نشست از درخواست (هدر Authorization: Bearer یا بدنه). */
function getSessionUser(req, body) {
  let token = null;
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (h && /^Bearer\s+/i.test(h)) token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token && body && body.sessionToken) token = String(body.sessionToken);
  const s = verifySession(token);
  if (!s) return null;
  const user = db.findById('users', s.uid);
  return user || null;
}

module.exports = {
  hashPassword, verifyPassword,
  signSession, verifySession,
  registerUser, loginUser, publicUser, getSessionUser,
  validateUsername, SESSION_TTL_MS,
};
