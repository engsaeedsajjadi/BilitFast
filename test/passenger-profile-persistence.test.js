'use strict';
// Regression: passenger templates persist on the same browser origin and become
// selectable after reopening the app or navigating to a different route.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../public/route.html'), 'utf8');
const durable = new Map();

function makePage(storage) {
  let ready = false;
  let resolveInit;
  const readyPromise = new Promise((resolve) => { resolveInit = resolve; });
  const cache = new Map();
  const writes = [];
  const secure = {
    available: true,
    init() {
      // Simulate asynchronous IndexedDB key restoration + profile decryption.
      return readyPromise.then(() => {
        for (const [k, v] of storage) {
          cache.set(k, typeof v === 'string' && v.startsWith('enc1:')
            ? Buffer.from(v.slice(5), 'base64').toString('utf8') : v);
        }
        ready = true;
      });
    },
    whenReady() { return readyPromise.then(() => undefined); },
    getItem(k) { return cache.get(k) ?? null; },
    setItem(k, v) {
      cache.set(k, v);
      writes.push(Promise.resolve().then(() => storage.set(k, 'enc1:' + Buffer.from(v).toString('base64'))));
    },
    flush() { return Promise.all(writes).then(() => undefined); },
  };
  const localStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
  };
  const listeners = {};
  const document = {
    readyState: 'loading',
    addEventListener(name, f) { listeners[name] = f; },
    dispatchEvent() {},
  };
  const ctx = { window: null, document, localStorage, navigator: {},
    location: { protocol: 'https:' }, BilitSecureStore: secure,
    CustomEvent: class CustomEvent {}, setTimeout, clearTimeout,
    console };
  ctx.window = ctx;
  vm.runInNewContext(app + '\nthis.BilitFastForTest = BilitFast;', ctx, { filename: 'app.js' });
  return { api: ctx.BilitFastForTest, ready: () => resolveInit(), secure };
}

(async function run() {
  const passenger = { quota_type: 'بزرگسال', national_code: '0123456789',
    birth_day: '10', birth_month: '03', birth_year: '1370',
    first_name: 'Sample', last_name: 'Passenger' };
  const first = makePage(durable);
  first.ready();
  await first.api.whenStorageReady();
  first.api.savePassengerProfile('خانواده', [passenger]);
  await first.api.flushStorage();
  assert.equal(first.api.loadPassengerProfiles().length, 1);
  console.log('PASS: profile is saved and encrypted-storage flush is awaited');

  const reopened = makePage(durable);
  // The encrypted cache starts empty on every new route/page. It must not be
  // used to populate the template dropdown until whenStorageReady resolves.
  assert.equal(reopened.api.loadPassengerProfiles().length, 0);
  reopened.ready();
  await reopened.api.whenStorageReady();
  const saved = reopened.api.loadPassengerProfiles();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'خانواده');
  assert.equal(saved[0].passengers[0].first_name, 'Sample');
  console.log('PASS: reopened tab/new route recovers the persisted passenger template');

  const profilesStart = route.indexOf('  async function refreshProfileSelect() {');
  const profilesEnd = route.indexOf("  $('btn-save-profile').addEventListener", profilesStart);
  assert.ok(profilesStart >= 0 && profilesEnd > profilesStart);
  const select = { value: '', innerHTML: '', disabled: true };
  const testCtx = { BilitFast: reopened.api,
    $: (id) => id === 'profile-select' ? select : null,
    esc: (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;') };
  vm.runInNewContext(route.slice(profilesStart, profilesEnd) + '\nthis.refresh = refreshProfileSelect;', testCtx);
  await testCtx.refresh();
  assert.match(select.innerHTML, /خانواده/);
  assert.equal(select.disabled, false);
  console.log('PASS: template selector loads the saved profile after storage is ready');

  const initPos = route.indexOf('  (async function init() {');
  const awaitedPos = route.indexOf('await BilitFast.whenStorageReady();', initPos);
  const refreshedPos = route.indexOf('await refreshProfileSelect();', initPos);
  assert.ok(initPos > 0 && awaitedPos > initPos && refreshedPos > awaitedPos,
    'route initialization must wait for encrypted profile data');
  assert.ok(route.indexOf('await BilitFast.flushStorage();') > route.indexOf('BilitFast.savePassengerProfile(name.trim(), pass);'));
  assert.ok(route.indexOf('await refreshProfileSelect();', initPos) > initPos);
  assert.ok(route.includes("$('btn-save-profile').disabled = false;"));
  console.log('PASS: route init and save action prevent stale dropdown and premature success');
  console.log('PASS: 4 passenger-profile persistence checks');
})().catch((e) => { console.error(e); process.exitCode = 1; });
