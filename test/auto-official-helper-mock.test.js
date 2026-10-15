'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const helper=fs.readFileSync(path.join(__dirname,'../extension/safir-passenger-helper.js'),'utf8');
const flow=require('../extension/auto-official-flow');
const checkout=require('../extension/checkout-flow');
const selection=require('../extension/selection-confirm');
const loc=mode=>({protocol:'https:',hostname:'safirrail.ir',
  pathname:mode==='allocation'?'/etrain/VerifyTck.php':'/etrain/TresV.php',
  href:mode==='allocation'?'https://safirrail.ir/etrain/VerifyTck.php':'https://safirrail.ir/etrain/TresV.php'});
const passenger={national_code:'0499370899',first_name:'سارا',last_name:'سجادی',birth_day:'01',birth_month:'02',birth_year:'1370'};
const booking={ok:true,passengers:[passenger],phone:'09120000000',
 selection:{srvc:'S123',wagon:'W5'},autoAdvance:true};
const flush=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r))};
function scene(mode,opts={}){
 let interval;let observer;const events=[];const nodes={};let doc;
 const makeEl=()=>({id:'',disabled:false,readOnly:false,value:'',textContent:'',style:{},children:[],
  append(...x){this.children.push(...x)},addEventListener(){},dispatchEvent(){},getAttribute(){return null}});
 const control={type:'button',value:'ادامه',textContent:mode==='allocation'?'تأیید':'ادامه',disabled:false,hidden:false,
  getAttribute(n){return n==='onclick'?'chkForm()':n==='aria-disabled'?'false':''},click(){events.push('OFFICIAL_CONTINUE')}};
 const form={method:'POST',action:'https://safirrail.ir/etrain/VerifyTck.php',checkValidity(){return true},
  getAttribute(n){return n==='action'?this.action:''},querySelectorAll(){return [control]}};
 const fields={};
 if(mode==='passenger')for(const k of ['pid0','fn0','ln0','ruz0','mah0','sal0','phone']){
  fields[k]=makeEl();fields[k].form=form;
 }
 const ack={type:'checkbox',checked:false,disabled:false,hidden:false,form,
  labels:[{textContent:'تأیید شماره واگن و کوپه اختصاص یافته مورد تأیید میباشد'}],
  click(){this.checked=true;events.push('ACK_CHECK')}};
 doc={querySelector(s){
   if(s==='.arcaptcha[data-site-key],input[name="arcaptcha-token"]')return mode==='challenge'?{}:null;
   const m=/^input\[name="([^"]+)"\],input\[id="([^"]+)"\]$/.exec(s);return m?fields[m[1]]||null:null;
  },querySelectorAll(s){
   if(s==='input[name="srvc"]')return [{value:opts.srvc||'S123'}];
   if(s==='input[name="wagon"]')return [{value:opts.wagon||'W5'}];
   if(s==='input[type="checkbox"]')return mode==='allocation'?[ack]:[];
   return [];
  },getElementById(id){if(nodes[id])return nodes[id];
   for(const n of Object.values(nodes))for(const child of n.children||[])if(child.id===id)return child;
   return null;
  },createElement(){return makeEl()},body:{innerText:mode==='allocation'?'تأیید نهایی خرید. شماره واگن و کوپه اختصاص یافته مورد تایید میباشد':'',
   append(el){nodes[el.id]=el}},documentElement:{}};
 const chrome={runtime:{sendMessage:async msg=>{
  if(msg.type==='BILIT_GET_PASSENGERS')return {...booking,passengerSubmitted:mode==='allocation'};
  if(msg.type==='BILIT_CLAIM_SELECTION'){events.push('CLAIM_'+msg.kind);return {ok:!opts.rejectClaim};}
  if(msg.type==='BILIT_SET_WORKFLOW_STAGE'){events.push('STATUS_'+msg.stage);return {ok:true};}
  return {ok:true};
 }}};
 vm.runInNewContext(helper,{chrome,document:doc,location:loc(mode),Date,URL,console,
  Event:class{constructor(type){this.type=type}},MutationObserver:class{observe(){}disconnect(){}},
  setInterval(fn){interval=fn;return 1},clearInterval(){},BilitAutoOfficialFlow:flow,
  BilitOfficialCheckout:checkout,BilitSafeSelection:selection});
 return {events,fields,doc,ack,tick(){interval?.()}};
}
(async()=>{
 const c=scene('challenge');await flush();
 assert(!c.events.includes('OFFICIAL_CONTINUE')&&!c.events.includes('ACK_CHECK'));
 console.log('PASS ARCaptcha scene never touched');
 const p=scene('passenger');await flush();
 assert.equal(p.fields.fn0.value,'سارا');
 assert.deepEqual(p.events.filter(x=>x==='OFFICIAL_CONTINUE'),['OFFICIAL_CONTINUE']);
 assert(p.events.includes('CLAIM_passenger'));
 p.tick();await flush();
 assert.equal(p.events.filter(x=>x==='OFFICIAL_CONTINUE').length,1);
 console.log('PASS passenger filled and official chkForm clicked exactly once with no extra prompt');
 const stopped=scene('passenger',{rejectClaim:true});await flush();
 assert(!stopped.events.includes('OFFICIAL_CONTINUE'));
 console.log('PASS refused idempotency claim prevents form click');
 const a=scene('allocation');await flush();
 assert.deepEqual(a.events.filter(x=>x==='ACK_CHECK'),['ACK_CHECK']);
 assert.deepEqual(a.events.filter(x=>x==='OFFICIAL_CONTINUE'),['OFFICIAL_CONTINUE']);
 assert(a.events.includes('CLAIM_allocation'));
 a.tick();await flush();
 assert.equal(a.events.filter(x=>x==='OFFICIAL_CONTINUE').length,1);
 console.log('PASS allocated wagon/coupe ordinary acknowledgement automatically confirmed once');
 const mismatch=scene('allocation',{wagon:'OTHER'});await flush();
 assert(!mismatch.events.includes('ACK_CHECK')&&!mismatch.events.includes('OFFICIAL_CONTINUE'));
 console.log('PASS wagon mismatch prevents automatic acknowledgement');
 console.log('ALL 5 auto-continuation browser simulations passed');
})().catch(err=>{console.error(err);process.exitCode=1});
