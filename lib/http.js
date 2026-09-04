// -*- coding: utf-8 -*-
/**
 * lib/http.js — ابزارهای مشترک HTTP/امنیت برای APIها و سرور توسعه.
 */

const crypto = require('crypto');

function safeJsonParse(text, fallback = {}) {
  if (text === undefined || text === null || text === '') return fallback;
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

function readJsonBody(req, fallback = {}) {
  if (!req) return fallback;
  if (typeof req.body === 'string') return safeJsonParse(req.body, fallback);
  if (req.body && typeof req.body === 'object') return req.body;
  return fallback;
}

function parseCookieHeader(header) {
  const out = {};
  const raw = String(header || '');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const p = String(part || '').trim();
    if (!p) continue;
    const i = p.indexOf('=');
    if (i < 1) continue;
    const key = p.slice(0, i).trim();
    const value = p.slice(i + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

function getRequestCookies(req) {
  const headers = (req && req.headers) || {};
  return parseCookieHeader(headers.cookie || headers.Cookie || '');
}

function serializeCookie(name, value, opts = {}) {
  const parts = [name + '=' + encodeURIComponent(String(value || ''))];
  if (opts.maxAge !== undefined) parts.push('Max-Age=' + Math.max(0, Math.floor(opts.maxAge)));
  parts.push('Path=' + (opts.path || '/'));
  if (opts.sameSite) parts.push('SameSite=' + opts.sameSite);
  if (opts.secure) parts.push('Secure');
  if (opts.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

function isSecureRequest(req) {
  const headers = (req && req.headers) || {};
  const xf = String(headers['x-forwarded-proto'] || headers['X-Forwarded-Proto'] || '').toLowerCase();
  return xf === 'https' || !!(req && req.socket && req.socket.encrypted);
}

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

function isLoopbackIp(ip) {
  const s = String(ip || '').trim().toLowerCase();
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1';
}

function isLocalHostname(hostname) {
  const s = String(hostname || '').trim().toLowerCase();
  return s === 'localhost' || s === '127.0.0.1' || s === '[::1]' || s === '::1';
}

function getRequestHost(req) {
  const headers = (req && req.headers) || {};
  const raw = String(headers.host || headers.Host || '').trim();
  return raw.split(':')[0].trim();
}

function isProductionLike() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production' || !!process.env.VERCEL;
}

function getRequiredEnv(name, { devFallback = null, validate = null } = {}) {
  const raw = process.env[name];
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const value = String(raw).trim();
    if (validate && !validate(value)) {
      throw new Error('مقدار متغیر محیطی ' + name + ' نامعتبر است.');
    }
    return value;
  }
  if (isProductionLike()) {
    throw new Error('متغیر محیطی ' + name + ' در محیط تولید تنظیم نشده است.');
  }
  if (devFallback === null) return '';
  if (validate && !validate(String(devFallback))) {
    throw new Error('fallback توسعه برای ' + name + ' نامعتبر است.');
  }
  return String(devFallback);
}

function securityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; connect-src 'self' https://safirrail.ir https://api.telegram.org https://api.kavenegar.com https://api.zarinpal.com https://sandbox.zarinpal.com https://www.zarinpal.com; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self' https://safirrail.ir https://sandbox.zarinpal.com https://www.zarinpal.com",
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

module.exports = {
  safeJsonParse,
  readJsonBody,
  parseCookieHeader,
  getRequestCookies,
  serializeCookie,
  isSecureRequest,
  sha256Base64Url,
  isLoopbackIp,
  isLocalHostname,
  getRequestHost,
  isProductionLike,
  getRequiredEnv,
  securityHeaders,
};
