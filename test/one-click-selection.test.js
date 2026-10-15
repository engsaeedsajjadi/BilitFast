'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const control=require('../extension/route-bridge-control');
const handoff=require('../extension/official-handoff');
let count=0;
function check(message,fn){fn();count++;console.log('PASS '+message)}
(async()=>{
  check('Only paired BilitFast route origin is allowed',()=>{
    assert(control.matches('https://agency.example','https://agency.example/route.html?id=2'));
    assert(!control.matches('https://agency.example','https://evil.example/route.html?id=2'));
    assert(!control.matches('https://agency.example','https://agency.example/login.html'));
    assert(!control.matches('https://agency.example','https://agency.example:8443/route.html'));
    assert(!control.matches('http://127.0.0.1:3000','http://localhost:3000/route.html'));
  });
  check('Unsafe local/remote and Safir origins rejected',()=>{
    for(const origin of ['http://remote.example','http://127.0.0.1:3210','https://safirrail.ir',
      'https://sub.safirrail.ir','https://agency.example:443/path'])
      assert.throws(()=>control.validateOrigin(origin));
  });
  const events={};let change;
  let handoffText='';let visible=false;
  const row={querySelector(sel){return {value:({'.col-national':'0012345678','.col-day':'1','.col-month':'1',
    '.col-year':'1375','.col-name':'Ali','.col-family':'Rezaei'})[sel]||''};}};
  const button={getAttribute:()=> '123'};
  const elements={
    'found-table':{contains(x){return x===button}},
    'reserve-arcaptcha':{get style(){return {display:visible?'block':'none'}}},
    'bf-browser-handoff':{get textContent(){return handoffText}},
    'passengers-table':{querySelectorAll:()=>[row]},
    'bf_contact':{value:'09120000000'},
    'arcaptcha-handoff-status':{textContent:''}
  };
  const messages=[];
  const chrome={runtime:{async sendMessage(msg){messages.push(msg);return {ok:true};}}};
  const document={
    documentElement:{},getElementById:k=>elements[k],
    querySelectorAll:sel=>sel==='#passengers-table tbody tr'?[row]:[],
    addEventListener:(k,fn)=>events[k]=fn
  };
  class MutationObserverMock {constructor(fn){change=fn;}observe(){}}
  vm.runInNewContext(fs.readFileSync(path.join(ROOT,'extension/route-bridge.js'),'utf8'),{
    chrome,document,location:{pathname:'/route.html'},MutationObserver:MutationObserverMock,
    queueMicrotask,JSON
  });
  check('No auto-handoff before an actual row selection',()=>{
    assert.equal(messages.length,0);
  });
  events.click({target:{closest:()=>button}});
  await new Promise(r=>setImmediate(r));
  check('One user click prepares workspace immediately',()=>{
    assert.equal(messages.length,1);assert.equal(messages[0].type,'BILIT_PREPARE_PANEL');
  });
  visible=true;
  handoffText=JSON.stringify({url:handoff.OFFICIAL,method:'POST',fields:{srvc:'123',from:'1',to:'2',passCnt:'1'}});
  change();await new Promise(r=>setImmediate(r));
  check('Challenge-ready state starts same-tab official reservation automatically',()=>{
    assert.equal(messages.length,2);
    assert.equal(messages[1].type,'BILIT_START_FROM_SELECTION');
    assert.equal(messages[1].snapshot.passengers[0].national_code,'0012345678');
    assert(!JSON.stringify(messages[1]).toLowerCase().includes('arcaptcha-token'));
  });
  change();await new Promise(r=>setImmediate(r));
  check('Repeated UI updates never re-submit the same selection',()=>assert.equal(messages.length,2));
  const registered=[];const stored=[];
  const api={
    permissions:{async contains(){return true}},
    scripting:{async unregisterContentScripts(){},async registerContentScripts(xs){registered.push(...xs)},async executeScript(x){stored.push(x)}},
    storage:{local:{async set(x){stored.push(x)}}},tabs:{async get(id){return {id,url:'https://agency.example/route.html?id=7'}}}
  };
  await control.install(api,'https://agency.example',7);
  check('Bridge is restricted to explicit origin permission and script match',()=>{
    assert.deepEqual(registered[0].matches,['https://agency.example/*']);
    assert.equal(registered[0].js[0],'route-bridge.js');
    assert.equal(stored[0].bilitTrustedOrigin,'https://agency.example');
  });
  check('No captcha automation or forged token APIs in bridge',()=>{
    const code=fs.readFileSync(path.join(ROOT,'extension/route-bridge.js'),'utf8');
    assert(!/\.click\(\)|requestSubmit\(|\.submit\(|arcaptcha-token|captchaResponse|checkbox\.checked/i.test(code));
  });
  console.log('ALL '+count+' one-click selection tests passed');
})().catch(err=>{console.error(err);process.exitCode=1});
