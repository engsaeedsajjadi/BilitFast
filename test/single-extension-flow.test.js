// Browser-flow regression without a real Safir account or any network access.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '../public/safir-connection.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../public/login.html'), 'utf8');
let passed = 0;
async function test(name, fn) {
  await fn(); passed++; console.log('PASS ' + name);
}
function runtime(verified, options = {}) {
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', disabled: false, hidden: id === 'pair-panel' || id === 'connect-result',
      dataset: {}, listeners: {}, addEventListener(ev, callback) { this.listeners[ev] = callback; },
    });
    return elements.get(id);
  }
  let navigated = null;
  let interval = null;
  let saved = null;
  let cleared = 0;
  let reads = [];
  let calls = [];
  let verificationPayloads = [];
  const BilitFast = {
    getCookies: () => saved || options.previousCookies || [],
    getVerificationCookies: () => options.previousVerificationCookies || [],
    hasSessionCookie: arr => arr.some(v => v.startsWith('PHPSESSID=')),
    setCookies: arr => { if (!options.storageBlocked) saved = arr; }, clearCookies: () => { cleared++; },
    async authFetch(endpoint, payload) {
      assert.strictEqual(endpoint, '/api/cookie-sync');
      calls.push(payload.action);
      if (payload.action === 'pair') return {ok:true,code:'123456',nonce:'SECRET-NONCE',expiresInMs:120000};
      if (payload.action === 'poll') return {ok:true,cookies:options.noSession?['lang=fa']:['PHPSESSID=TEST','lang=fa']};
      if (payload.action === 'verify') {
        verificationPayloads.push(payload);
        reads.push(saved); // Must not have persisted prior to verification.
        if (options.throwVerify) throw new Error('network');
        return {ok:true,valid:verified,bookingVerified:verified && !options.generalOnly,reason:verified?(options.generalOnly?(options.loginShown?'reservation_login_required':'reservation_not_yet_verified'):null):'not_logged_in'};
      }
      throw new Error('unexpected action');
    }
  };
  const ctx = {
    BilitFast, document:{getElementById:el}, window:{addEventListener(){},location:{search:options.returnUrl?('?return='+encodeURIComponent(options.returnUrl)):'',assign(url){navigated=url;}}},
    navigator:{clipboard:{writeText: async () => {}}},
    setInterval: cb => {interval=cb;return 1;},
    clearInterval: () => {interval=null;},
    console, Date, Math, URLSearchParams,
  };
  vm.runInNewContext(code,ctx,{filename:'safir-connection.js'});
  return {el,start:() => el('btn-ext-sync').listeners.click(),tick:() => interval && interval(),
    get saved(){return saved}, get cleared(){return cleared}, get navigated(){return navigated},reads,calls,verificationPayloads};
}
(async () => {
  await test('Exactly one customer-facing cookie transfer method', () => {
    assert.equal((page.match(/id="btn-ext-sync"/g)||[]).length,1);
    assert(!/id="login-form"|btn-sync-firefox|btn-sync-chrome|btn-save-cookies|btn-smart-connect|btn-pull-cookies/.test(page));
  });
  await test('Successful pairing verifies BEFORE persisting the session', async () => {
    const app=runtime(true);
    await app.start();
    assert(app.calls.includes('pair') && app.calls.includes('poll') && app.calls.includes('verify'));
    assert.equal(app.reads[0], null);
    assert(app.saved && app.saved.includes('PHPSESSID=TEST'));
    assert.equal(app.el('conn-state').dataset.state,'ok');
    assert.equal(app.el('btn-ext-sync').disabled,false);
  });
  await test('General login can be stored without claiming booking authorization', async () => {
    const app=runtime(true,{generalOnly:true});await app.start();
    assert(app.saved && app.saved.includes('PHPSESSID=TEST'));
    assert.equal(app.el('conn-state').dataset.state,'partial');
    assert(/رزرو/.test(app.el('conn-state').textContent));
  });
  await test('General login with reservation login page does not lose transferred cookies', async () => {
    const app=runtime(true,{generalOnly:true,loginShown:true});await app.start();
    assert(app.saved && app.saved.includes('PHPSESSID=TEST'));
    assert.equal(app.el('conn-state').dataset.state,'partial');
    assert(/رزرو/.test(app.el('conn-state').textContent));
    assert.equal(app.navigated,null);
  });
  await test('Provisional connection does not auto-redirect to reservation', async () => {
    const app=runtime(true,{generalOnly:true,loginShown:true,returnUrl:'route.html?id=42'});
    await app.start();
    assert(app.saved && app.navigated===null);
  });
  await test('Page reload rechecks the correct /fa cookies, not booking-path credentials', async () => {
    const app=runtime(true,{generalOnly:true,previousCookies:['PHPSESSID=BOOKING'],
      previousVerificationCookies:['PHPSESSID=FA']});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(app.verificationPayloads.length,1);
    assert.deepEqual(Array.from(app.verificationPayloads[0].cookies),['PHPSESSID=BOOKING']);
    assert.deepEqual(Array.from(app.verificationPayloads[0].verificationCookies),['PHPSESSID=FA']);
    assert.equal(app.el('conn-state').dataset.state,'partial');
  });
  await test('Rejected remote verification retains explicit handoff but never claims authenticated booking', async () => {
    const app=runtime(false);await app.start();
    assert(app.saved && app.saved.includes('PHPSESSID=TEST'));
    assert.equal(app.el('conn-state').dataset.state,'partial');
    assert(/تأیید نشده/.test(app.el('conn-state').textContent));
    assert.equal(app.cleared,0);
  });
  await test('Offline verification retains handoff but does not claim authentication', async () => {
    const app=runtime(false,{throwVerify:true});await app.start();
    assert(app.saved && app.saved.includes('PHPSESSID=TEST'));
    assert.equal(app.el('conn-state').dataset.state,'partial');
  });
  await test('No PHP session in delivery is rejected without writing local state', async () => {
    const app=runtime(false,{noSession:true});await app.start();
    assert.equal(app.saved,null);
    assert.equal(app.el('conn-state').dataset.state,'error');
  });
  await test('Blocked browser storage returns explicit error, not false transfer success', async () => {
    const app=runtime(true,{storageBlocked:true});await app.start();
    assert.equal(app.saved,null);
    assert.equal(app.el('conn-state').dataset.state,'error');
    assert(/ذخیره/.test(app.el('conn-state').textContent));
  });
  await test('Provisional imported cookies get same-tab route return button', async () => {
    const app=runtime(false,{returnUrl:'route.html?id=42'});await app.start();
    assert.equal(app.el('return-to-route').hidden,false);
    assert.equal(app.navigated,null);
    app.el('return-to-route').onclick();
    assert.equal(app.navigated,'route.html?id=42');
  });
  await test('After activation, return to the same route window when requested', async () => {
    const app=runtime(true,{returnUrl:'route.html?id=42'});await app.start();
    assert.equal(app.navigated,'route.html?id=42');
  });
  await test('External redirect after pairing is refused', async () => {
    const app=runtime(true,{returnUrl:'https://attacker.example/'});await app.start();
    assert.equal(app.navigated,null);
  });
  await test('New code is visible only after user starts pairing', async () => {
    const app=runtime(true);
    assert.equal(app.el('pair-panel').hidden,true);
    await app.start();
    assert.equal(app.el('pair-panel').hidden,true); // flow finishes in mocked happy path
    assert.equal(app.el('pair-code').textContent,'123456');
  });
  console.log('ALL '+passed+' single-extension flow tests passed');
})().catch(e => {console.error('FAIL',e);process.exit(1)});
