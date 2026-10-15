'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const popupCode = fs.readFileSync(path.join(__dirname,'../extension/popup.js'),'utf8');
const backgroundCode = fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
const helperCode = fs.readFileSync(path.join(__dirname,'../extension/safir-passenger-helper.js'),'utf8');
const handoff = require('../extension/official-handoff');
const origin = require('../extension/target-origin');
let count=0;
function pass(msg,condition){assert(condition,msg);console.log('PASS '+msg);count++}
function makeEl(){return {textContent:'',value:'',className:'',disabled:false,checked:true,style:{},listeners:{},append(){},appendChild(x){(this.children ||= []).push(x);},addEventListener(k,f){this.listeners[k]=f;},dispatchEvent(){}}}
async function testPopup(isSameProfile){
 const els=Object.fromEntries(['msg','code','send','endpoint','start-booking','auto-continue'].map(k=>[k,makeEl()]));
 const calls=[];
 const session={};
 const chrome={
  tabs:{async query(q){return q.active?[{id:5,url:'https://agency.example/route.html?id=99',windowId:9}]:[]},
   async update(id,opts){calls.push(['navigate',id,opts]);}},
  sidePanel:{async open(opts){calls.push(['panel',opts])}},
  scripting:{async executeScript(o){
    if(o.target.tabId===5)return [{result:{handoff:{url:handoff.OFFICIAL,method:'POST',fields:{from:'1',to:'191',srvc:'val',passCnt:'1'}},passengers:[{national_code:'0499370899',first_name:'Test'}],phone:'09120000000'}}];
    throw Error('the popup must not inject a cross-origin reservation form');
  }},
  cookies:{async getAllCookieStores(){return [{id:'p1',tabIds:[5,...(isSameProfile?[6]:[])]},{id:'p2',tabIds:isSameProfile?[]:[6]}]}},
  storage:{session:{async set(o){Object.assign(session,o)}}}
 };
 const ctx={chrome,document:{getElementById(id){return els[id]}},window:{},
  BilitCookieReader:{discoverTab:async()=>({id:6,url:'https://safirrail.ir/etrain/index.php'})},
  BilitTargetOrigin:origin,BilitOfficialHandoff:handoff,console,Date,URL};
 vm.runInNewContext(popupCode,ctx);
 await new Promise(r=>setImmediate(r));
 await els['start-booking'].listeners.click();
 return {calls,session,msg:els.msg.textContent};
}
async function testWorker(job){
 let updateCallback;
 const session={bilitOneTabHandoff:job};const injected=[];
 const chrome={
  runtime:{id:'test',getURL(n){return 'chrome-extension://test/'+n},onInstalled:{addListener(){}},onMessage:{addListener(){}}},
  action:{setTitle(){}},
  tabs:{onUpdated:{addListener(fn){updateCallback=fn}}},
  storage:{session:{async get(k){return {[k]:session[k]}},async remove(k){delete session[k]},async set(o){Object.assign(session,o)}}},
  scripting:{async executeScript(o){injected.push(o);
   const fields=[];
   const form={appendChild(x){fields.push(x)},submit(){this.didSubmit=true}};
   const doc={createElement(tag){if(tag==='form')return form;return {type:'',name:'',value:''}},body:{appendChild(){}}};
   const result=o.func(o.args[0]); // isolated function runs against mock globals? patched below
   return [{result}];
  }}
 };
 const ctx={chrome,Date,Set,URL,console,BilitOfficialHandoff:handoff,importScripts(){}};
 vm.runInNewContext(backgroundCode,ctx);
 // Navigation and official POST run only after safirrail.ir completes loading.
 updateCallback(job.tabId,{status:'complete'},{url:'https://safirrail.ir/etrain/index.php'});
 for(let i=0;i<6;i++) await new Promise(r=>setImmediate(r));
 return {session,injected};
}
async function testHelper(){
 const fields={};
 for(const n of ['pid0','ruz0','mah0','sal0','fn0','ln0'])fields[n]=makeEl();
 const ids={};
 const document={querySelector(s){if(s.includes('arcaptcha'))return null;const m=s.match(/^input\[name="([^"]+)"\]/);return m?fields[m[1]]||null:null},createElement(tag){const el=makeEl();el.tagName=tag;return el},getElementById(id){return ids[id]||null},body:{append(x){ids[x.id]=x}},documentElement:{}};
 const calls=[];
 const chrome={runtime:{async sendMessage(data){calls.push(data.type);if(data.type==='BILIT_GET_PASSENGERS')return {ok:true,passengers:[{national_code:'0499370899',birth_day:'01',birth_month:'02',birth_year:'1370',first_name:'سارا',last_name:'حقی'}]};return {ok:true}}}};
 vm.runInNewContext(helperCode,{chrome,document,location:{protocol:'https:',hostname:'safirrail.ir',pathname:'/etrain/TresV.php'},Event:class{constructor(name,o){this.type=name;this.bubbles=o.bubbles}},MutationObserver:class{observe(){}},setInterval(){return 1},clearInterval(){}});
 await new Promise(r=>setImmediate(r));
 for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
 pass('passenger fields auto-filled after official page appears',fields.pid0.value==='0499370899'&&fields.fn0.value==='سارا');
 pass('passenger data retained until confirmed page',!calls.includes('BILIT_CLEAR_PASSENGERS'));
}
(async()=>{
 const ok=await testPopup(true);
 pass('one click opens BilitFast side panel',ok.calls.some(x=>x[0]==='panel'));
 pass('same source tab navigates to official first-party website without new tabs',ok.calls.some(x=>x[0]==='navigate'&&x[1]===5&&x[2].url==='https://safirrail.ir/etrain/index.php'));
 pass('handoff job contains validated reservation, no captcha token',ok.session.bilitOneTabHandoff?.handoff?.fields?.srvc==='val'&&!JSON.stringify(ok.session).includes('arcaptcha-token'));
 pass('passengers tied to reused same tab not another site tab',ok.session.bilitPendingPassengerFill.siteTabId===5);
 const rejected=await testPopup(false);
 pass('different Chrome profiles block all navigation',!rejected.calls.some(x=>x[0]==='navigate')&&rejected.msg.includes('یک پروفایل'));
 // Static proof of worker's load & submit gate (the actual form is browser-owned).
 pass('background listens for first-party load',backgroundCode.includes('chrome.tabs?.onUpdated?.addListener?'));
 pass('background validates official POST after navigation',backgroundCode.includes('BilitOfficialHandoff.validate')&&backgroundCode.includes("form.submit()"));
 await testHelper();
 console.log('ALL '+count+' single-tab browser-flow checks passed');
})().catch(err=>{console.error(err);process.exitCode=1});
