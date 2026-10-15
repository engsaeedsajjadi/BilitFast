// Customer-facing interface must expose only the extension flow.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'public/login.html'), 'utf8');
const account = fs.readFileSync(path.join(root, 'public/account.html'), 'utf8');
let count = 0;
function test(name,fn) {try {fn();count++;console.log('PASS '+name)}catch(e){console.error('FAIL '+name,e.message);process.exitCode=1;}}
test('Exactly one extension connect button',()=>assert.equal((page.match(/id="btn-ext-sync"/g)||[]).length,1));
test('No direct credentials or manual cookie input',()=>assert(!/id="login-form"|id="cookie-input"|btn-save-cookies/.test(page)));
test('No profile-reading or smart-connect alternatives',()=>assert(!/btn-sync-firefox|btn-sync-chrome|btn-smart-connect|advanced-block/.test(page)));
test('Session state and expiry guidance are visible',()=>assert(/id="conn-state"/.test(page)&&/id="pair-timer"/.test(page)));
test('Installation guide is available from the single flow',()=>assert(/href="extension-help.html"/.test(page)));
test('Account page does not advertise cross-device cookie transfers',()=>assert(!/btn-push-cookies|btn-pull-cookies/.test(account)));
if(!process.exitCode)console.log('ALL '+count+' single-extension UI checks passed');
