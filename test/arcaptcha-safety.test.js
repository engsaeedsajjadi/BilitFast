'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
let total=0;
function test(name,fn){fn();total++;console.log('PASS '+name)}
const helper=read('extension/safir-passenger-helper.js');
const popup=read('extension/popup.js');
const ui=read('extension/popup.html');
const checkout=read('extension/checkout-flow.js');
const bg=read('extension/background.js');
const panel=read('extension/workspace.js');
const manifest=JSON.parse(read('extension/manifest.json'));
test('Widget only detected as an element, never read token value',()=>{
 assert(helper.includes('.arcaptcha[data-site-key],input[name="arcaptcha-token"]'));
 assert(!/arcaptcha-token[^\n]*\.value|#arc-checkbox|widget\.arcaptcha\.ir|bowman\.arcaptcha\.ir/i.test(helper));
});
test('No CAPTCHA bypass or direct synthetic form submission',()=>{
 for(const code of [helper,checkout])assert(!/\.requestSubmit\s*\(|\.submit\s*\(/.test(code));
 assert(!/arc-checkbox|arcaptcha-token[^\n]*\.value/.test(helper));
 assert(!popup.includes('auto-continue'));assert(!ui.includes('auto-continue'));
 assert(read('extension/auto-official-flow.js').includes('challenge(doc)'));
});
test('Passenger completion automatically starts only after official form appears',()=>{
 assert(helper.includes('if(!filled && !filling)void fillFromExtension()'));
 assert(!helper.includes("button.addEventListener('click'"));
 assert(helper.includes('if(hasChallenge())'));
});
test('Only first-party original HTTPS origin has content script',()=>{
 assert.deepEqual(manifest.content_scripts[0].matches,['https://safirrail.ir/etrain/*']);
 assert(manifest.content_scripts[0].js.includes('selection-confirm.js'));
 assert(popup.includes("chrome.tabs.update(tab.id, {url:'https://safirrail.ir/etrain/index.php'}"));
});
test('Explicit first-party start action cannot carry CAPTCHA fields',()=>{
 const {validate,OFFICIAL}=require('../extension/official-handoff');
 assert.throws(()=>validate({url:OFFICIAL,method:'POST',fields:{srvc:'x', 'arcaptcha-token':'fake'}}));
});
test('Five required statuses are rendered for users',()=>{
 for(const stage of ['unverified','human-verified','official-form-not-submitted','network-session-error','return-to-official-page']){
  assert(panel.includes("'"+stage+"':"),stage);
  assert(bg.includes("'"+stage+"'"),stage);
 }
});
test('Returning to official origin required after unexpected tab exit',()=>{
 assert(bg.includes("stage:'return-to-official-page'"));
 assert(bg.includes('record.siteTabId===tabId'));
});
test('No bank token processing in extension helper',()=>{
 assert(!/NewIPG.*Token=|\.searchParams\.get\(['"]Token/.test(helper+popup+bg));
});
console.log('ALL '+total+' additional ARCaptcha safety checks passed');
