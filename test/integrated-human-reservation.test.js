'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname,'..');
const helper=fs.readFileSync(path.join(root,'extension/safir-passenger-helper.js'),'utf8');
const BilitOfficialCheckout=require('../extension/checkout-flow');
let assertions=0;
const pass=(name,cond)=>{assert(cond,name);console.log('PASS '+name);assertions++};
const manifest=JSON.parse(fs.readFileSync(path.join(root,'extension/manifest.json'),'utf8'));
pass('Extension workspace uses Chrome sidePanel',manifest.permissions.includes('sidePanel')&&manifest.side_panel.default_path==='workspace.html');
pass('BilitFast workspace has no embedded/fake CAPTCHA',!/<iframe|arcaptcha-token|arc-checkbox/.test(fs.readFileSync(path.join(root,'extension/workspace.html'),'utf8')));
pass('Content script never generates ARCaptcha tokens',!/\.value\s*=\s*['"`]([^'"`]*)['"`].*arcaptcha|arcaptcha-token[^\n]*\.value\s*=/.test(helper));
function testContext({mode,token='',checked=false,autoContinue=false,incomplete=false}) {
  const messages=[];
  const fields={};
  const submitted=[];
  const form={method:'post',action:'https://safirrail.ir/etrain/TresV.php',
    querySelector:()=>({type:'submit'}),reportValidity:()=>true,checkValidity:()=>true,
    querySelectorAll(){return [{type:'button',disabled:false,
      getAttribute:(attr)=>attr==='onclick'?'chkForm()':null,
      click:()=>{this.action='https://safirrail.ir/etrain/VerifyTck.php';submitted.push('site-chkForm');}}]},
    requestSubmit(el){submitted.push(el||true)}};
  const makeEl=(v='')=>({value:v,disabled:false,style:{},children:[],
    append(el){this.children.push(el);},appendChild(el){this.children.push(el)},
    addEventListener(){},dispatchEvent(){},getAttribute:()=>null,form});
  if(mode==='passenger'){
    for(const k of ['pid0','fn0','ln0','ruz0','mah0','sal0'])fields[k]=makeEl('');
    fields.phone=makeEl('');
  }
  const elements={};
  const document={
    querySelector(sel){
      if(sel==='.arcaptcha[data-site-key],input[name="arcaptcha-token"]')return mode==='captcha'?makeEl(''):null;
      if(sel==='#arc-checkbox input[type="checkbox"]:checked')return checked?makeEl(''):null;
      if(sel==='#arc-checkbox')return mode==='captcha'?{getAttribute:()=>checked?'true':'false'}:null;
      if(sel==='input[name="arcaptcha-token"]')return mode==='captcha'?{value:token,form}:null;
      if(sel==='form[name="mainFrm"]')return form;
      const match=sel.match(/^input\[name="([^"]+)"\],input\[id="([^"]+)"\]$/);
      if(match)return fields[match[1]]||null;
      return null;
    },
    createElement(tag){const el=makeEl();el.tagName=tag;return el;},
    body:{append(el){elements[el.id]=el;}},getElementById(id){return elements[id]||null;},documentElement:{}
  };
  const claims=[];
  const chrome={runtime:{async sendMessage(message){messages.push(message.type + (message.stage?':'+message.stage:''));
    if(message.type==='BILIT_GET_PASSENGERS')return {ok:true,autoContinue,passengers:[{
      national_code:incomplete?'':'0499370899',first_name:'سارا',last_name:'حقی',
      birth_day:'01',birth_month:'02',birth_year:'1370'}],phone:'09120000000'};
    if(message.type==='BILIT_CLAIM_WORKFLOW_STEP'){claims.push(message.step);return {ok:true}};
    return {ok:true};}}};
  let tick;
  const context={document,chrome,URL,Date,Event:class {constructor(s){this.type=s}},
    BilitOfficialCheckout,location:{protocol:'https:',hostname:'safirrail.ir',pathname:'/etrain/TresV-auth.php',href:'https://safirrail.ir/etrain/TresV-auth.php'},
    MutationObserver:class{observe(){}disconnect(){}},setInterval(fn){tick=fn;return 1},clearInterval(){}};
  vm.runInNewContext(helper,context);
  return {messages,claims,fields,submitted,tick};
}
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
(async()=>{
  const unseen=testContext({mode:'captcha',checked:true,token:'',autoContinue:true});
  unseen.tick();await flush();
  pass('No CAPTCHA token means no automatic submission',unseen.submitted.length===0 && unseen.claims.length===0);
  const unchecked=testContext({mode:'captcha',checked:false,token:'test-solved',autoContinue:true});
  unchecked.tick();await flush();
  pass('Token without human checking does not submit',unchecked.submitted.length===0);
  const manual=testContext({mode:'captcha',checked:true,token:'test-solved',autoContinue:false});
  manual.tick();await flush();
  pass('Manual mode leaves official submit to customer',manual.submitted.length===0 && manual.claims.length===0);
  const approved=testContext({mode:'captcha',checked:true,token:'test-solved',autoContinue:true});
  approved.tick();await flush();approved.tick();await flush();
  pass('After human approval, native official submit executes once',approved.submitted.length===1&&approved.claims.join()==='captcha');
  pass('CAPTCHA token never sent through extension messaging',approved.messages.every(m=>!m.includes('test-solved')));
  const form=testContext({mode:'passenger',autoContinue:true});
  await flush();
  pass('Full passenger data is inserted before checkout',form.fields.fn0.value==='سارا' && form.fields.pid0.value==='0499370899' && form.fields.sal0.value==='1370');
  pass('With consent, validated passenger form auto-continues once',form.submitted.length===1&&form.claims.join()==='passenger');
  pass('Passenger data retained until server confirmation',!form.messages.includes('BILIT_CLEAR_PASSENGERS'));
  const missing=testContext({mode:'passenger',autoContinue:true,incomplete:true});
  await flush();
  pass('Missing passenger details STOP automatic submission',missing.submitted.length===0);
  const fallback=testContext({mode:'passenger',autoContinue:false});
  await flush();
  pass('Without consent, passenger fields filled but not submitted',fallback.fields.fn0.value==='سارا'&&fallback.submitted.length===0);
  console.log('ALL '+assertions+' integrated human reservation checks passed');
})().catch(err=>{console.error(err);process.exitCode=1});
