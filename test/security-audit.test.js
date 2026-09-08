// -*- coding: utf-8 -*-
/**
 * test/security-audit.test.js — تست‌های رگرسیون برای یافته‌های ممیزی امنیتی.
 * هر تست دقیقاً یکی از آسیب‌پذیری‌های گزارش‌شده را بازتولید و رفعش را تأیید می‌کند.
 */
process.env.BILITFAST_DATA_DIR = '/tmp/bf-secaudit-' + process.pid;

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

/** اجرای کد در یک پروسه جدا با متغیرهای محیطی دلخواه. */
function runIsolated(env, code) {
  try {
    return { out: execFileSync(process.execPath, ['-e', code],
      { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { err: String((e.stderr || '') + (e.stdout || '')) };
  }
}

(async function run() {
  /* ============ یافته ۱: کلید پیش‌فرض قابل حدس برای نشست ============ */
  const noKeys = {
    NODE_ENV: 'production', BILITFAST_SESSION_KEY: '', BILITFAST_LICENSE_KEY: '',
    BILITFAST_MASTER_KEY: '', BILITFAST_TOKEN_KEY: '', BILITFAST_ENFORCE_SECURITY: '',
  };
  let r = runIsolated(noKeys, "require('" + ROOT + "/lib/auth.js').signSession('u1')");
  test('تولید بدون کلید نشست → سرویس fail-closed می‌شود', !!r.err && /کلید امنیتی/.test(r.err));

  const withKeys = {
    NODE_ENV: 'production',
    BILITFAST_SESSION_KEY: 'a'.repeat(64),
    BILITFAST_LICENSE_KEY: 'b'.repeat(64),
    BILITFAST_TOKEN_KEY: 'c'.repeat(64),
  };
  r = runIsolated(withKeys,
    "const a=require('" + ROOT + "/lib/auth.js');console.log(a.verifySession(a.signSession('u1'))?'OK':'BAD')");
  test('با کلید تنظیم‌شده، نشست درست کار می‌کند', r.out === 'OK');

  // جعل نشست با کلید پیش‌فرضِ لو‌رفتهٔ نسخه قبلی
  r = runIsolated(withKeys, `
    const crypto=require('crypto');
    const body=Buffer.from(JSON.stringify({type:'session',uid:'victim',iat:Date.now(),exp:Date.now()+9e6})).toString('base64url');
    const sig=crypto.createHmac('sha256','bilitfast-license-dev-only-key').update(body).digest('base64url');
    console.log(require('${ROOT}/lib/auth.js').verifySession(body+'.'+sig)?'ACCEPTED':'REJECTED');`);
  test('جعل نشست با کلید پیش‌فرض قدیمی رد می‌شود', r.out === 'REJECTED');

  r = runIsolated(withKeys,
    "const s=require('" + ROOT + "/lib/secrets.js');console.log(s.sessionKey().toString('hex')!==s.licenseKey().toString('hex')?'DIFF':'SAME')");
  test('کلید نشست از کلید لایسنس جداست', r.out === 'DIFF');

  r = runIsolated({ ...noKeys, BILITFAST_MASTER_KEY: 'one-master-secret-value-123456' },
    "const s=require('" + ROOT + "/lib/secrets.js');const k=[s.sessionKey(),s.licenseKey(),s.stateKey()].map(b=>b.toString('hex'));console.log(new Set(k).size===3?'ALLDIFF':'COLLIDE')");
  test('از یک کلید ریشه، کلیدهای مستقل مشتق می‌شوند', r.out === 'ALLDIFF');

  const dev = { NODE_ENV: 'development', BILITFAST_SESSION_KEY: '', BILITFAST_MASTER_KEY: '', BILITFAST_LICENSE_KEY: '' };
  const g = () => runIsolated(dev, "console.log(require('" + ROOT + "/lib/secrets.js').sessionKey().toString('hex'))").out;
  const k1 = g(), k2 = g();
  test('در توسعه، کلید هر اجرا تصادفی است (نه ثابتِ قابل حدس)', !!k1 && !!k2 && k1 !== k2);

  /* ============ یافته ۲: API انتقال کوکی بدون احراز هویت ============ */
  const cookieSync = require('../api/cookie-sync');
  function callSync(body, ip = '127.0.0.1') {
    return new Promise((resolve) => {
      const res = {
        _c: 200,
        status(c) { this._c = c; return this; },
        json(o) { resolve({ code: this._c, body: o }); return this; },
      };
      cookieSync({ method: 'POST', body, headers: { 'x-forwarded-for': ip },
        socket: { remoteAddress: ip }, connection: { remoteAddress: ip } }, res);
    });
  }

  let res1 = await callSync({ action: 'poll' }, '9.9.9.9');
  test('poll از اینترنت بدون ورود به حساب مسدود می‌شود', res1.code === 401);

  res1 = await callSync({ action: 'push', cookies: ['PHPSESSID=attacker'] });
  test('push بدون کد جفت‌سازی رد می‌شود', res1.body.ok !== true);

  const pair = await callSync({ action: 'pair' });
  test('pair کد ۶ رقمی و nonce می‌سازد',
    pair.body.ok && /^\d{6}$/.test(pair.body.code) && (pair.body.nonce || '').length > 20);

  res1 = await callSync({ action: 'push', code: '000000', cookies: ['PHPSESSID=x'] });
  test('کد جفت‌سازی اشتباه رد می‌شود', res1.body.ok !== true);

  const pushed = await callSync({ action: 'push', code: pair.body.code, cookies: ['PHPSESSID=real', 'a=1'] });
  test('push با کد درست پذیرفته می‌شود', pushed.body.ok === true);

  res1 = await callSync({ action: 'poll', nonce: 'wrong-nonce-guess' });
  test('poll با nonce اشتباه کوکی نمی‌دهد', !res1.body.cookies);

  res1 = await callSync({ action: 'poll' });
  test('poll بدون nonce (رفتار قدیمی) کوکی نمی‌دهد', !res1.body.cookies);

  res1 = await callSync({ action: 'poll', nonce: pair.body.nonce });
  test('صاحب اصلی با nonce درست کوکی می‌گیرد',
    res1.body.ok && Array.isArray(res1.body.cookies) && res1.body.cookies.includes('PHPSESSID=real'));

  res1 = await callSync({ action: 'poll', nonce: pair.body.nonce });
  test('کوکی یک‌بارمصرف است (بازپخش ممکن نیست)', !res1.body.cookies);

  /* ============ یافته ۳: داده حساس در localStorage ============ */
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const cookieFn = appSrc.slice(appSrc.indexOf('function getCookies'), appSrc.indexOf('function clearCookies'));
  test('کوکی نشست دیگر در localStorage نگهداری نمی‌شود',
    /sessionStorage/.test(cookieFn) && !/localStorage\.getItem\(COOKIES_KEY\)/.test(cookieFn));
  test('مسیرها (شامل کد ملی مسافران) از مسیر ذخیره‌سازی امن می‌گذرند',
    /function saveRoutes[\s\S]{0,200}secureSet\(ROUTES_KEY/.test(appSrc));
  test('الگوهای مسافر رمزشده ذخیره می‌شوند',
    /function savePassengerProfiles[\s\S]{0,300}secureSet\(PASSENGER_PROFILES_KEY/.test(appSrc));
  const storeSrc = fs.readFileSync(path.join(ROOT, 'public', 'secure-store.js'), 'utf8');
  test('لایه امن از AES-GCM استفاده می‌کند', /AES-GCM/.test(storeSrc));
  test('کلید رمزنگاری غیرقابل‌استخراج ساخته می‌شود',
    /generateKey\(\s*\{\s*name:\s*'AES-GCM',\s*length:\s*256\s*\},\s*false/.test(storeSrc));
  test('امکان حذف کامل داده‌های دستگاه وجود دارد', /purgeLocalData/.test(appSrc));
  test('صفحه حریم خصوصی موجود است', fs.existsSync(path.join(ROOT, 'public', 'privacy.html')));

  /* ============ یافته ۴: ذخیره‌سازی JSON برای production ============ */
  const db = require('../lib/db');
  test('وضعیت ذخیره‌سازی گزارش می‌شود', typeof db.storageStatus === 'function');
  const localSt = db.storageStatus();
  test('اجرای محلی پایدار تشخیص داده می‌شود', localSt.mode === 'local-file' && localSt.reliable === true);

  r = runIsolated({ VERCEL: '1', NODE_ENV: '', BILITFAST_ENFORCE_SECURITY: '' },
    "const s=require('" + ROOT + "/lib/db.js').storageStatus();console.log(s.mode+'|'+s.reliable+'|'+s.warnings.length)");
  test('سرورلس بدون ذخیره‌ساز مشترک ناپایدار علامت می‌خورد', /ephemeral-tmp\|false\|[1-9]/.test(r.out || ''));

  r = runIsolated({ VERCEL: '1', KV_REST_API_URL: 'https://x.upstash.io', KV_REST_API_TOKEN: 't' },
    "const s=require('" + ROOT + "/lib/db.js').storageStatus();console.log(s.mode+'|'+s.reliable)");
  test('با ذخیره‌ساز مشترک، استقرار پایدار می‌شود', (r.out || '') === 'shared-kv|true');

  r = runIsolated({ VERCEL: '1', NODE_ENV: 'production', BILITFAST_SESSION_KEY: 'a'.repeat(64),
    BILITFAST_LICENSE_KEY: 'b'.repeat(64), BILITFAST_TOKEN_KEY: 'c'.repeat(64) },
    "require('" + ROOT + "/lib/db.js').assertReliableStorage();console.log('STARTED')");
  test('تولیدِ سرورلس بدون KV بالا نمی‌آید (fail-closed)', !!r.err && /پایدار نیست/.test(r.err));

  /* ============ یافته ۵: پایش سرورلس ============ */
  const monitor = require('../lib/monitor');
  test('قابلیت پایش گزارش می‌شود', typeof monitor.capability === 'function');
  test('روی سرور دائمی، پایش تایمری پشتیبانی می‌شود',
    monitor.capability().mode === 'timer' && monitor.capability().supported === true);

  r = runIsolated({ VERCEL: '1', BILITFAST_CRON_SECRET: '' },
    "const c=require('" + ROOT + "/lib/monitor.js').capability();console.log(c.mode+'|'+c.supported)");
  test('سرورلس بدون Cron: پایش پشتیبانی‌نشده اعلام می‌شود', (r.out || '') === 'unsupported|false');

  r = runIsolated({ VERCEL: '1', BILITFAST_CRON_SECRET: 'secret123' },
    "const c=require('" + ROOT + "/lib/monitor.js').capability();console.log(c.mode+'|'+c.supported)");
  test('سرورلس با Cron: پایش پشتیبانی می‌شود', (r.out || '') === 'cron|true');

  test('تابع اجرای دوره‌ای برای Cron وجود دارد', typeof monitor.runDueMonitors === 'function');
  test('نقطه ورود Cron ساخته شده است', fs.existsSync(path.join(ROOT, 'api', 'cron.js')));

  // امنیت نقطه ورود Cron
  const cronApi = require('../api/cron');
  function callCron(headers, env) {
    const saved = process.env.BILITFAST_CRON_SECRET;
    process.env.BILITFAST_CRON_SECRET = env;
    return new Promise((resolve) => {
      const res = { _c: 200, status(c) { this._c = c; return this; },
        json(o) { process.env.BILITFAST_CRON_SECRET = saved; resolve({ code: this._c, body: o }); return this; } };
      cronApi({ method: 'POST', url: '/api/cron', headers: headers || {} }, res);
    });
  }
  let c1 = await callCron({}, 'topsecret');
  test('Cron بدون راز درست رد می‌شود', c1.code === 401);
  c1 = await callCron({ authorization: 'Bearer wrong' }, 'topsecret');
  test('Cron با راز اشتباه رد می‌شود', c1.code === 401);
  c1 = await callCron({ authorization: 'Bearer topsecret' }, 'topsecret');
  test('Cron با راز درست اجرا می‌شود', c1.code === 200 && c1.body.ok === true);

  /* ============ یافته ۶: آسیب‌پذیری jimp/file-type ============ */
  const guard = require('../lib/image-guard');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  test('تصویر PNG معتبر پذیرفته می‌شود', guard.inspectImageBuffer(png).ok === true);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]);
  test('تصویر JPEG معتبر پذیرفته می‌شود', guard.inspectImageBuffer(jpeg).ok === true);
  // ASF/WMV — همان قالبی که پارسر آسیب‌پذیر را فعال می‌کند
  const asf = Buffer.concat([
    Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]),
    Buffer.alloc(64),
  ]);
  test('ورودی ASF (مسیر آسیب‌پذیر file-type) رد می‌شود', guard.inspectImageBuffer(asf).ok === false);
  test('بافر خیلی بزرگ رد می‌شود', guard.inspectImageBuffer(Buffer.alloc(9 * 1024 * 1024)).ok === false);
  test('بافر ناقص/کوچک رد می‌شود', guard.inspectImageBuffer(Buffer.alloc(4)).ok === false);
  test('داده غیرتصویری رد می‌شود', guard.inspectImageBuffer(Buffer.from('not an image at all!!')).ok === false);
  const reserveSrc = fs.readFileSync(path.join(ROOT, 'lib', 'reserve.js'), 'utf8');
  test('مسیر دریافت کپچا از نگهبان تصویر عبور می‌کند', /assertSafeImage/.test(reserveSrc));

  /* ============ یافته ۷: ناسازگاری نسخه undici ============ */
  const pkg = require('../package.json');
  const undiciPkg = require('undici/package.json');
  test('undici نصب‌شده با Node اعلام‌شده سازگار است',
    /^\^?6\./.test(pkg.dependencies.undici) && /18/.test(undiciPkg.engines.node));
  const declared = pkg.engines.node.replace(/[^\d.]/g, '');
  const required = undiciPkg.engines.node.replace(/[^\d.]/g, '');
  function cmp(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
  }
  test('engines پروژه از نیازمندی undici کمتر نیست (بدون EBADENGINE)', cmp(declared, required) >= 0);

  console.log('\n' + (fail === 0
    ? 'همه ' + pass + ' تست امنیتی پاس شدند'
    : fail + ' تست شکست خورد از ' + (pass + fail)));
  try { fs.rmSync(process.env.BILITFAST_DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  if (fail) process.exit(1);
})();
