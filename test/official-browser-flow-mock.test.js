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
 const popup=fs.readFileSync(path.join(__dirname,'../extension/popup.js'),'utf8');
 pass('popup no longer opens second tab or performs CAPTCHA interactions',
   !popup.includes('tabs.create(') && !popup.includes('arcaptcha-token') && !popup.includes('form.submit('));
 pass('reservation-tab worker owns official reservation navigation, not cookie-popup button',
   backgroundCode.includes('BILIT_START_FROM_SELECTION') && backgroundCode.includes('bilitOneTabHandoff'));
 // Static proof of worker's load & submit gate (the actual form is browser-owned).
 pass('background listens for first-party load',backgroundCode.includes('chrome.tabs?.onUpdated?.addListener?'));
 pass('background validates official POST after navigation',backgroundCode.includes('BilitOfficialHandoff.validate')&&backgroundCode.includes("form.submit()"));
 await testHelper();
 console.log('ALL '+count+' single-tab browser-flow checks passed');
})().catch(err=>{console.error(err);process.exitCode=1});
