// Regression tests for the commercial-security hardening patch.
// All tests are isolated and require no external network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.BILITFAST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-hardening-'));
process.env.BILITFAST_ENFORCE_LICENSE = '1';
process.env.BILITFAST_ACTIVATION_CODE = 'unit-test-activation-secret-2026';
process.env.BILITFAST_ADMIN_BOOTSTRAP_SECRET = 'unit-test-bootstrap-secret-over-32-characters';
const license = require('../lib/license');
const { safePaymentUrl } = require('../lib/payment-url');
const { readOrCreateKeys } = require('../desktop/keys');
const auth = require('../lib/auth');
const adminApi = require('../api/admin-users');
const bookingApi = require('../api/bookings');
const notifyApi = require('../api/notify');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, e.message); process.exitCode = 1; }
}
function req(body, token) {
  return {
    method: 'POST',
    body,
    headers: token ? { authorization: 'Bearer ' + token } : {},
    socket: { remoteAddress: '127.0.0.1' }
  };
}
async function call(fn, body, token) {
  const response = {
    code: 200,
    status(n) { this.code = n; return this; },
    json(v) { this.data = v; return this; },
    set() { return this; },
    send(v) { this.data = v; return this; }
  };
  await fn(req(body, token), response);
  return response;
}
(async function main() {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-device-'));
  const firstKeys = readOrCreateKeys(keyDir);
  const laterKeys = readOrCreateKeys(keyDir);
  test('Desktop secrets survive process restart', () => assert.deepStrictEqual(firstKeys, laterKeys));
  test('Desktop crypto keys are purpose-specific', () => assert.strictEqual(
    new Set(Object.values(firstKeys)).size, 4));
  test('Desktop install signing key exists', () => assert.match(
    firstKeys.BILITFAST_INSTALL_KEY, /^[a-f0-9]{64}$/));
  test('Operator activation accepted', () => assert.strictEqual(
    license.isActivationCodeValid('unit-test-activation-secret-2026'), true));
  test('Shared legacy activation is rejected', () => assert.strictEqual(
    license.isActivationCodeValid('Sa0946517835'), false));
  delete process.env.BILITFAST_ACTIVATION_CODE;
  test('Unconfigured activation denied', () => assert.strictEqual(
    license.isActivationCodeValid('anything'), false));
  process.env.BILITFAST_ACTIVATION_CODE = 'unit-test-activation-secret-2026';
  test('License gate rejects unlicensed caller', () => assert.strictEqual(
    license.checkAccess({}).allowed, false));
  test('Safir HTTPS URLs permitted', () => assert.strictEqual(
    safePaymentUrl('https://safirrail.ir/pay?x=1'), 'https://safirrail.ir/pay?x=1'));
  for (const url of [
    'http://safirrail.ir/pay',
    'https://safirrail.ir.evil.example/',
    'javascript:alert(1)',
    'https://localhost/',
    'https://other-bank.example/pay'
  ]) {
    test('Unsafe payment URL denied: ' + url, () => assert.strictEqual(
      safePaymentUrl(url), null));
  }
  process.env.BILITFAST_PAYMENT_ALLOWED_HOSTS = 'pec.shaparak.ir';
  test('Explicit gateway allowlist works', () => assert.strictEqual(
    safePaymentUrl('https://pec.shaparak.ir/pay'), 'https://pec.shaparak.ir/pay'));
  let r = await call(adminApi, {
    action: 'bootstrap', username: 'newadmin', password: 'testpass123'
  });
  test('Bootstrap without secret denied', () => assert.strictEqual(r.code, 403));
  r = await call(adminApi, {
    action: 'bootstrap', bootstrap_secret: 'wrong', username: 'newadmin', password: 'testpass123'
  });
  test('Bootstrap with bad secret denied', () => assert.strictEqual(r.code, 403));
  r = await call(adminApi, {
    action: 'bootstrap', bootstrap_secret: process.env.BILITFAST_ADMIN_BOOTSTRAP_SECRET,
    username: 'newadmin', password: 'testpass123'
  });
  test('Bootstrap with strong secret works', () => assert.strictEqual(r.data.ok, true));
  r = await call(adminApi, {
    action: 'bootstrap', bootstrap_secret: process.env.BILITFAST_ADMIN_BOOTSTRAP_SECRET,
    username: 'secondadmin', password: 'testpass123'
  });
  test('Bootstrap closes after first admin', () => assert.strictEqual(r.code, 403));
  const user = auth.registerUser('ordinarycustomer', 'testpass123');
  test('Ordinary customer created', () => assert.strictEqual(user.ok, true));
  for (const action of ['setup-webhook', 'setup-bale-webhook', 'setup-eitaa-webhook']) {
    r = await call(notifyApi, { action }, user.token);
    test(action + ' is admin-only', () => assert.strictEqual(r.code, 403));
  }
  r = await call(bookingApi, {
    action: 'save', paymentUrl: 'https://phishing.example/collect'
  }, user.token);
  test('Unsafe payment link refused', () => assert.strictEqual(r.code, 400));
  r = await call(bookingApi, {
    action: 'save', paymentUrl: '', booking: { origin: 'THR', destination: 'MHD' }
  }, user.token);
  test('Pending booking stored', () => assert.strictEqual(r.data.ok, true));
  const bookingId = r.data.id;
  r = await call(bookingApi, { action: 'result', id: bookingId, result: 'paid' }, user.token);
  test('Client payment claim is not bank confirmation', () =>
    assert.strictEqual(r.data.status, 'payment_reported'));
  if (process.exitCode) process.exit(process.exitCode);
  console.log('PASSED ' + passed + ' hardening assertions.');
})().catch(error => { console.error(error); process.exit(1); });
