'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const target = require('../extension/target-origin');
const reader = require('../extension/session-cookies');
const manifest = require('../extension/manifest.json');
function check(label, fn) { fn(); console.log('PASS: ' + label); }
function reject(label, url) { check(label, () => assert.throws(() => target.fromTab({url}))); }
check('Web HTTPS BilitFast origin is inferred from active app tab', () => {
  assert.deepEqual(target.fromTab({url:'https://tickets.example.org/login.html?return=route'}),
    {origin:'https://tickets.example.org',localPreview:false});
});
check('Customer HTTPS site custom port preserves destination', () => {
  assert.equal(target.fromTab({url:'https://tickets.example.org:8443/login.html'}).origin,'https://tickets.example.org:8443');
});
check('Local preview is detected on 127.0.0.1 port 3000 only', () => {
  assert.deepEqual(target.fromTab({url:'http://127.0.0.1:3000/login.html'}),
    {origin:'http://127.0.0.1:3000',localPreview:true});
  assert.equal(target.fromTab({url:'http://localhost:3000/'}).localPreview,true);
});
reject('Ordinary insecure HTTP remote site is rejected','http://tickets.example.org/');
reject('Non-approved localhost ports are rejected','http://localhost:3210/');
reject('Unknown HTTP loopback is rejected','http://127.0.0.1:8080/');
reject('Safir tab cannot be mistaken for BilitFast','https://safirrail.ir/etrain/index.php');
reject('Safir subdomain cannot be mistaken for BilitFast','https://demo.safirrail.ir');
reject('Chrome internal tab cannot be a destination','chrome://extensions');
reject('Missing active tab fails safely',undefined);
reject('Website with embedded credentials rejected','https://user:pass@tickets.example.org/');
check('Permission pattern removes port while actual fetch keeps it', () => {
  assert.equal(target.permissionPattern('http://127.0.0.1:3000'),'http://127.0.0.1/*');
  assert.equal(target.permissionPattern('https://tickets.example.org:8443'),'https://tickets.example.org/*');
});
check('Manifest declares local development permission explicitly', () => {
  assert.equal(manifest.version,'3.5.0');
  assert(manifest.optional_host_permissions.includes('http://127.0.0.1/*'));
  assert(manifest.optional_host_permissions.includes('http://localhost/*'));
  assert(manifest.optional_host_permissions.includes('https://*/*'));
  assert(manifest.host_permissions.includes('https://safirrail.ir/*'));
});
check('Cookie reader preserves independently scoped booking cookies', () => {
  assert.deepEqual(reader.toHeaders([
    {name:'PHPSESSID',value:'resv',path:'/etrain'},
    {name:'PHPSESSID',value:'general',path:'/'}]),
   ['PHPSESSID=resv','PHPSESSID=general']);
});
const popupHtml = fs.readFileSync(path.join(ROOT,'extension/popup.html'),'utf8');
const popupCode = fs.readFileSync(path.join(ROOT,'extension/popup.js'),'utf8');
const loginHtml = fs.readFileSync(path.join(ROOT,'public/login.html'),'utf8');
check('Customer no longer needs to type deployment URL into popup', () => {
  assert(!popupHtml.includes('id="app-origin"'));
  assert(!popupCode.includes('chrome.storage.local.set'));
  assert(!popupCode.includes('bilitfastOrigin'));
  assert(popupHtml.includes('target-origin.js'));
});
check('App instructions now describe one-tab active origin discovery', () => {
  assert(loginHtml.includes('نشانی همین تب خودکار تشخیص داده می‌شود'));
});

async function exercisePopup({activeUrl, responseMode, cookieMode}) {
  const elements = new Map();
  for (const id of ['msg','code','send','endpoint','start-booking']) elements.set(id, {value:'', textContent:'', className:'', disabled:false,
    listeners:{}, addEventListener(event,fn){this.listeners[event]=fn;}});
  elements.get('code').value='123456';
  const calls = [];
  const endpoint = 'http://127.0.0.1:3000';
  const chrome = {
    tabs: { async query(){ return [{url:activeUrl}]; } },
    permissions: { async request(obj){ calls.push(['permission',obj]); return true; } },
  };
  const mockFetch = async (url,options) => {
    calls.push(['fetch',url,JSON.parse(options.body)]);
    if (responseMode==='network') throw new Error('connection refused');
    if (responseMode==='html') return {ok:true,status:200,json:async()=>{throw new Error('HTML');}};
    const action=JSON.parse(options.body).action;
    if(action==='ping') return {ok:true,status:200,json:async()=>({ok:true,service:'bilitfast-cookie-sync',version:2})};
    return {ok:true,status:200,json:async()=>({ok:true})};
  };
  const chromeReader = {collect:async()=>{calls.push(['readCookies']);if(cookieMode==='missing')throw new Error('No Safir session');
    return {cookies:['PHPSESSID=test-in-memory'],verificationCookies:[],host:'safirrail.ir'}; }};
  vm.runInNewContext(popupCode, {chrome,fetch:mockFetch,document:{getElementById(id){return elements.get(id)}},
    BilitCookieReader:chromeReader,BilitTargetOrigin:target, BilitOfficialHandoff:require('../extension/official-handoff'), console}, {filename:'popup.js'});
  await new Promise(r=>setImmediate(r));
  await elements.get('send').listeners.click();
  return {calls, elements, endpoint};
}
(async()=>{
  const found = await reader.discoverTab({ tabs: { async query(q) {
    if(q.active) return [{id:1,url:'https://agency.example.com/login.html'}];
    if(q.currentWindow) return [{id:2,url:'https://safirrail.ir/etrain/index.php'}];
    return [];
  }}});
  assert.equal(found.id,2);
  console.log('PASS: SafirRail cookies located with active BilitFast tab');
  const ok=await exercisePopup({activeUrl:'http://127.0.0.1:3000/login.html'});
  assert.equal(ok.calls[0][0],'permission');
  assert.equal(ok.calls[0][1].origins[0],'http://127.0.0.1/*');
  assert.equal(ok.calls[1][1],ok.endpoint+'/api/cookie-sync');
  assert.equal(ok.calls[1][2].action,'ping');
  assert.equal(ok.calls[2][0],'readCookies');
  assert.equal(ok.calls[3][2].action,'push');
  assert.equal(ok.elements.get('code').value,'');
  console.log('PASS: Explicit click pings chosen app, reads cookies, then sends to same origin');
  const wrong=await exercisePopup({activeUrl:'https://safirrail.ir/etrain/index.php'});
  assert.equal(wrong.calls.length,0);
  assert(wrong.elements.get('msg').textContent.includes('تب BilitFast'));
  console.log('PASS: On Safir active tab popup cannot send to wrong destination');
  const net=await exercisePopup({activeUrl:'http://127.0.0.1:3000/',responseMode:'network'});
  assert.equal(net.calls.some(x=>x[0]==='readCookies'),false);
  assert(net.elements.get('msg').textContent.includes('ارتباط'));
  console.log('PASS: Unreachable server produces actionable error before accessing Safir cookies');
  const html=await exercisePopup({activeUrl:'http://127.0.0.1:3000/',responseMode:'html'});
  assert.equal(html.calls.some(x=>x[0]==='readCookies'),false);
  console.log('PASS: Non-JSON endpoint rejected before reading cookies');
  const missing=await exercisePopup({activeUrl:'http://127.0.0.1:3000/',cookieMode:'missing'});
  assert.equal(missing.calls.some(x=>x[0]==='fetch' && x[2].action==='push'),false);
  console.log('PASS: Missing session does not generate any outgoing cookie upload');
})().catch(e=>{console.error(e);process.exitCode=1;});
