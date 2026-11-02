'use strict';
// Regression tests for the 3.13.4 security fixes. No network access: any
// SafirRail call is stubbed. Uses an isolated temporary data directory.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-sec-3134-'));
Object.assign(process.env, {
  BILITFAST_SINGLE_USER: '1', BILITFAST_SELF_HOSTED: '1', BILITFAST_MULTIUSER: '1',
  BILITFAST_DATA_DIR: tmp, BILITFAST_MASTER_KEY: crypto.randomBytes(32).toString('hex'),
  BILITFAST_ADMIN_BOOTSTRAP_SECRET: crypto.randomBytes(32).toString('hex'),
});
delete process.env.BILITFAST_TRUST_PROXY;

// Stub the upstream login so no request ever leaves this process.
const core = require('../lib/core');
let upstreamLogins = 0;
core.login = async () => { upstreamLogins++; return { ok: true, cookies: ['PHPSESSID=SYNTHETIC'] }; };
core.verifySession = async () => ({ valid: false, reason: 'expired' });

const db = require('../lib/db');
const guard = require('../lib/guard');
const notify = require('../lib/notify');
const keeper = require('../lib/session-keeper');
const reserveLib = require('../lib/reserve');
let passes = 0;
function pass(label) { passes++; console.log('PASS ' + label); }
function req({ body = {}, token = '', ip = '127.0.0.1', headers = {}, query = {} } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.authorization = 'Bearer ' + token;
  return { method: 'POST', body, headers: h, query, socket: { remoteAddress: ip } };
}
function res() { return { code: 200, data: null, status(n) { this.code = n; return this; }, json(o) { this.data = o; return this; } }; }
async function call(api, r) { const out = res(); await api(r, out); return out; }

(async () => {
  try {
    // Owner bootstrap
    const adminApi = require('../api/admin-users');
    let r = await call(adminApi, req({ body: { action: 'bootstrap', username: 'owner', password: 'ownerpass123', bootstrap_secret: process.env.BILITFAST_ADMIN_BOOTSTRAP_SECRET } }));
    assert.equal(r.code, 200, JSON.stringify(r.data));
    const token = r.data.token; const ownerId = r.data.user.id;

    // 1. /api/login and /api/connect require the owner session
    const loginApi = require('../api/login');
    const connectApi = require('../api/connect');
    r = await call(loginApi, req({ body: { username: 'victim', password: 'x' } }));
    assert.equal(r.code, 401); assert.equal(upstreamLogins, 0);
    pass('anonymous /api/login is rejected before any upstream login');
    r = await call(loginApi, req({ body: { username: 'u', password: 'p' }, token }));
    assert.equal(r.code, 200); assert.equal(r.data.autoRelogin, undefined);
    assert.equal(keeper.hasLocalCredentials(), false);
    pass('self-hosted /api/login never stores account-less local credentials');
    // Even if old local credentials exist on disk, anonymous callers get nothing.
    keeper.saveLocalCredentials('old', 'secret');
    r = await call(connectApi, req({ body: {} }));
    assert.equal(r.code, 401); assert.equal(r.data.cookies, undefined);
    r = await call(connectApi, req({ body: {}, ip: '203.0.113.9', headers: { 'x-forwarded-for': '127.0.0.1' } }));
    assert.equal(r.code, 401); assert.equal(r.data.cookies, undefined);
    pass('anonymous /api/connect is rejected and never returns cookies');
    assert.equal(keeper.isLocalMode(), false);
    pass('session-keeper local mode is disabled on self-hosted installs');
    r = await call(loginApi, req({ body: '{bad json', token }));
    assert.equal(r.code, 400);
    pass('/api/login rejects malformed JSON with 400 instead of throwing');

    // 2. Proxy headers
    assert.equal(guard.getClientIp(req({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '127.0.0.1' } })), '172.18.0.2');
    process.env.BILITFAST_TRUST_PROXY = '1';
    assert.equal(guard.getClientIp(req({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '127.0.0.1, 198.51.100.7' } })), '198.51.100.7');
    delete process.env.BILITFAST_TRUST_PROXY;
    pass('X-Forwarded-For is ignored unless BILITFAST_TRUST_PROXY=1, then the proxy-appended value is used');
    assert.equal(guard.isLoopbackSocket(req({ ip: '127.0.0.1' })), true);
    assert.equal(guard.isLoopbackSocket(req({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4' } })), false);
    assert.equal(guard.isLoopbackSocket(req({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '127.0.0.1' } })), false);
    const sync = await call(require('../api/sync-cookies'), req({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '127.0.0.1' }, token }));
    assert.equal(sync.code, 403);
    pass('local-only endpoints cannot be reached by spoofing 127.0.0.1');

    // 3. Login lockout no longer lets a stranger lock the owner out
    for (let i = 0; i < guard.LOCK_THRESHOLD + 2; i++) guard.recordLoginFailure('owner', Date.now(), '198.51.100.1');
    assert.equal(guard.isLockedOut('owner', Date.now(), '198.51.100.1').locked, true);
    assert.equal(guard.isLockedOut('owner', Date.now(), '192.0.2.50').locked, false);
    pass('failed logins from one IP lock that IP only, not the owner everywhere');

    // 4. Webhooks
    const tg = require('../api/telegram-webhook');
    const bale = require('../api/bale-webhook');
    const forged = { message: { chat: { id: 999 }, text: '/stop' } };
    for (const [api, ch] of [[tg, 'telegram'], [bale, 'bale'], [require('../api/eitaa-webhook'), 'eitaa']]) {
      r = await call(api, req({ body: forged }));
      assert.equal(r.code, 401, ch + ' accepted a forged update');
      assert(notify.webhookUrl('https://agency.example', ch).includes('?k=' + notify.webhookSecret(ch)));
    }
    pass('forged webhook updates without the registered secret are rejected');
    assert.notEqual(notify.webhookSecret('telegram'), notify.webhookSecret('bale'));
    const owner = db.findById('users', ownerId);
    const code = notify.makeConnectCode(owner, 'bale');
    assert.match(code, /^BF-[0-9A-F]{16}$/);
    assert.equal(notify.consumeConnectCode(code, 'telegram').ok, false, 'code must be channel-bound');
    assert.equal(notify.consumeConnectCode(code, 'bale').ok, false, 'a failed attempt must burn the code');
    const code2 = notify.makeConnectCode(owner, 'bale');
    db.update('users', ownerId, { connect_code_exp: Date.now() - 1 });
    assert.equal(notify.consumeConnectCode(code2, 'bale').ok, false, 'expired code accepted');
    const code3 = notify.makeConnectCode(owner, 'bale');
    assert.equal(notify.consumeConnectCode(code3, 'bale').ok, true);
    assert.equal(notify.consumeConnectCode(code3, 'bale').ok, false, 'code reused');
    pass('connect codes are 64-bit, channel-bound, single-use and expire');
    // Bale reply sends the reply text, not the user's own message back.
    const sent = [];
    const origBale = notify.baleApi; notify.baleApi = async (m, p) => { sent.push(p); return { ok: true }; };
    await call(bale, req({ body: { message: { chat: { id: 5 }, text: 'hello' } }, query: { k: notify.webhookSecret('bale') } }));
    notify.baleApi = origBale;
    assert.equal(sent.length, 1); assert.notEqual(sent[0].text, 'hello'); assert.match(sent[0].text, /BF-/);
    pass('bale webhook replies with its own message (echo bug fixed)');

    // 5. SSRF guard
    for (const bad of ['//evil.example/x', 'https://safirrail.ir:8443/x', 'https://evil.example/', 'http://safirrail.ir/x', 'https://u:p@safirrail.ir/'])
      assert.equal(reserveLib.isSafirUrl(bad), false, bad);
    assert.equal(reserveLib.resolveSafirUrl('/etrain/c.php'), 'https://safirrail.ir/etrain/c.php');
    pass('SafirRail URL guard checks the full origin and resolves relative paths');

    // 6. Automatic CAPTCHA solving is gone
    for (const f of ['lib/captcha.js', 'lib/captures.js', 'lib/charlearn.js', 'lib/ocr', 'models', 'api/learn.js', 'public/learn.html'])
      assert(!fs.existsSync(path.join(root, f)), f + ' must not ship');
    const pkg = require('../package.json');
    for (const d of ['tesseract.js', '@tensorflow/tfjs', 'jimp']) assert(!pkg.dependencies[d], d);
    r = await call(require('../api/reserve'), req({ body: { action: 'solve-captcha' }, token }));
    assert.notEqual(r.code, 200); assert.notEqual(r.data && r.data.ok, true);
    const route = fs.readFileSync(path.join(root, 'public/route.html'), 'utf8');
    assert(!route.includes("action: 'solve-captcha'") && !route.includes('/api/learn'));
    pass('no OCR/ML CAPTCHA solver, training loop or solve endpoint remains');

    // 7. Cron secret only via headers
    const cron = fs.readFileSync(path.join(root, 'api/cron.js'), 'utf8');
    assert(!/searchParams\.get\('secret'\)/.test(cron));
    pass('cron secret is accepted only from headers');

    console.log('ALL ' + passes + ' security 3.13.4 checks passed');
  } catch (e) {
    console.error(e); process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
