// dev-server.js — سرور توسعه محلی برای تست پروژه بدون Vercel CLI
// فایل‌های استاتیک را از public/ سرو می‌کند و /api/* را به توابع api/ هدایت می‌کند.
// اجرا: node dev-server.js   (پورت 3000)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const API_DIR = path.join(ROOT, 'api');
const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // ۵ مگابایت (تصاویر کپچا به‌صورت data-URI ارسال می‌شوند)

// بارگذاری .env (برای متغیرهای لایسنس/رمزنگاری). متغیرهای موجود در محیط
// اولویت دارند و بازنویسی نمی‌شوند.
(function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      if (process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* ignore */ }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // مسیرهای API
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice('/api/'.length) || 'index';
    const fnPath = path.join(API_DIR, name + '.js');
    if (!fs.existsSync(fnPath)) {
      send(res, 404, JSON.stringify({ ok: false, error: 'Not Found' }), { 'Content-Type': 'application/json' });
      return;
    }
    try {
      const handler = require(fnPath);
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        if (e && e.message === 'BODY_TOO_LARGE') {
          send(res, 413, JSON.stringify({ ok: false, error: 'حجم درخواست بیش از حد مجاز است.' }), { 'Content-Type': 'application/json' });
          return;
        }
        throw e;
      }
      const expressReq = { method: req.method, body, query: Object.fromEntries(url.searchParams), headers: req.headers, socket: req.socket };
      const expressRes = {
        status(c) { this._status = c; return this; },
        json(j) { this._json = j; return this; },
        set(k, v) {
          this._headers = Object.assign(this._headers || {}, typeof k === 'string' ? { [k]: v } : k);
          return this;
        },
        send(s) { this._send = s; return this; },
      };
      await handler(expressReq, expressRes);
      const status = expressRes._status || 200;
      const extraHeaders = expressRes._headers || {};
      if (expressRes._send !== undefined) {
        send(res, status, expressRes._send, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders });
      } else {
        const payload = expressRes._json !== undefined ? JSON.stringify(expressRes._json) : '';
        send(res, status, payload, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
      }
    } catch (e) {
      send(res, 500, JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }), { 'Content-Type': 'application/json' });
    }
    return;
  }

  // فایل‌های استاتیک از public/
  let filePath = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!path.extname(filePath)) filePath += '.html'; // cleanUrls
  if (!filePath.startsWith(PUBLIC) || !fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC, 'index.html'); // fallback
  }
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  send(res, 200, fs.readFileSync(filePath), { 'Content-Type': MIME[ext] || 'application/octet-stream' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('BilitFast dev server: http://0.0.0.0:' + PORT);
});
