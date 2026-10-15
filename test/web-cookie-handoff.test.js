// Regression for the self-hosted web flow. Uses synthetic cookies only; no Safir calls.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bilitfast-cookie-handoff-'));
process.env.BILITFAST_DATA_DIR = temp;
process.env.BILITFAST_MASTER_KEY = crypto.randomBytes(32).toString('hex');
process.env.BILITFAST_ENFORCE_SECURITY = '0';
const api = require('../api/cookie-sync');
let passed = 0;
function check(label, fn) {
  fn(); passed++;
  console.log('PASS ' + label);
}
function call(action, fields = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const res = {
      code: 200,
      status(code) { this.code = code; return this; },
      json(body) { settled = true; resolve({status: this.code, ...body}); return this; },
    };
    const req = {
      method: 'POST', body: JSON.stringify({action, ...fields}), headers: {},
      socket: {remoteAddress: '127.0.0.1'},
    };
    Promise.resolve(api(req, res)).catch(reject).then(() => {
      if (!settled) reject(new Error('No response from cookie-sync'));
    });
  });
}
(async () => {
  try {
    const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    const route = fs.readFileSync(path.join(root, 'public/route.html'), 'utf8');
    const login = fs.readFileSync(path.join(root, 'public/login.html'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'public/safir-connection.js'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
    check('Web route navigation keeps the same browser tab', () => {
      assert.match(index, /window\.location\.assign\('route\.html\?id=' \+ numericId\)/);
      assert.doesNotMatch(index, /window\.open\('route\.html/);
    });
    check('Connection returns to route via same-window navigation', () => {
      assert.match(route, /window\.location\.href = 'login\.html\?return='/);
      assert.match(client, /window\.location\.assign\(returning\)/);
      assert.match(login, /id="return-to-route"/);
    });
    check('Route requires a real PHP session cookie rather than just an array item', () => {
      assert.match(route, /BilitFast\.hasSessionCookie\(BilitFast\.getCookies\(\)\)/);
      assert.match(route, /if \(!updateSafirCookieStatus\(\)\)/);
      assert.match(route, /id="safir-cookie-status"/);
    });
    check('Cookie handoff stays in tab-scoped storage, not durable localStorage', () => {
      assert.match(app, /sessionStorage\.setItem\(COOKIES_KEY/);
      assert.doesNotMatch(client, /localStorage\.setItem\(/);
    });
    const pair = await call('pair');
    assert.equal(pair.status, 200);
    assert.match(pair.code, /^\d{6}$/);
    const guest = await call('push', {code: pair.code, cookies: ['ui_lang=fa']});
    check('Guest or empty transfer cannot populate pairing record', () => {
      assert.equal(guest.status, 422);
      assert.equal(guest.ok, false);
    });
    const waiting = await call('poll', {nonce: pair.nonce});
    check('Pair remains pending until valid session is delivered', () => {
      assert.equal(waiting.waiting, true);
    });
    const synthetic = 'PHPSESSID=FAKE_FOR_INTEGRATION_TEST_ONLY';
    const pushed = await call('push', {code:pair.code,
      cookies:[synthetic, 'ui_lang=fa'], verificationCookies:['PHPSESSID=FAKE_GENERAL_TEST'], source:'test'});
    check('One-time extension-like handoff is accepted by local API', () => {
      assert.equal(pushed.ok, true);
      assert.equal(pushed.has_session, true);
    });
    const received = await call('poll', {nonce: pair.nonce});
    check('Same browser-session nonce retrieves the complete handoff exactly once', () => {
      assert.equal(received.ok, true);
      assert.deepEqual(received.cookies, [synthetic, 'ui_lang=fa']);
      assert.deepEqual(received.verificationCookies, ['PHPSESSID=FAKE_GENERAL_TEST']);
    });
    const replay = await call('poll', {nonce:pair.nonce});
    check('A consumed transfer cannot be replayed', () => {
      assert.equal(replay.expired, true);
      assert.equal(replay.ok, false);
    });
    const wrong = await call('push', {code:'000000', cookies:[synthetic]});
    check('Unpaired code is rejected', () => assert.equal(wrong.ok, false));
    console.log(`ALL ${passed} web-cookie-handoff tests passed (synthetic data)`);
  } finally {
    fs.rmSync(temp, {force:true, recursive:true});
  }
})().catch(err => { console.error('FAIL web-cookie-handoff', err); process.exitCode = 1; });
