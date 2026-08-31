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
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
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
      const body = await readBody(req);
      const expressReq = { method: req.method, body, query: Object.fromEntries(url.searchParams) };
      const expressRes = {
        status(c) { this._status = c; return this; },
        json(j) { this._json = j; return this; },
      };
      await handler(expressReq, expressRes);
      const status = expressRes._status || 200;
      const payload = expressRes._json !== undefined ? JSON.stringify(expressRes._json) : '';
      send(res, status, payload, { 'Content-Type': 'application/json; charset=utf-8' });
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
