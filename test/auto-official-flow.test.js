'use strict';
const assert=require('node:assert/strict');
const api=require('../extension/auto-official-flow');
let passed=0;
const test=(name, fn)=>{fn();passed++;console.log('PASS '+name)};
const loc={protocol:'https:',hostname:'safirrail.ir',pathname:'/etrain/TresV.php',href:'https://safirrail.ir/etrain/TresV.php'};
const verify={...loc,pathname:'/etrain/VerifyTck.php',href:'https://safirrail.ir/etrain/VerifyTck.php'};
const person={national_code:'0499370899',first_name:'سارا',last_name:'سجادی',birth_day:'01',birth_month:'02',birth_year:'1370'};
const booking={autoAdvance:true,selection:{srvc:'S123',wagon:'W5'},passengers:[person],phone:'09120000000',passengerSubmitted:true};
const meta=(type,label,onclick='')=>({type,textContent:label,value:label,disabled:false,hidden:false,
 getAttribute(n){return n==='onclick'?onclick:n==='aria-disabled'?'false':''},click(){this.clicks=(this.clicks||0)+1}});
function scene(kind='passenger',opts={}){
 const control=meta('button',kind==='passenger'?'ادامه':'تأیید','chkForm()');
 const checked=meta('checkbox','','');checked.checked=false;
 const label={textContent:'تأیید شماره واگن و کوپه اختصاص یافته مورد تأیید میباشد'};
 checked.labels=[label];
 const form={method:opts.method||'POST',action:opts.action||'https://safirrail.ir/etrain/VerifyTck.php',
  getAttribute(n){return n==='action'?this.action:null},checkValidity(){return opts.validity!==false},
  querySelectorAll(){return opts.controls||[control]}};
 checked.form=form;
 const fields={pid0:person.national_code,fn0:person.first_name,ln0:person.last_name,
  ruz0:person.birth_day,mah0:person.birth_month,sal0:person.birth_year,phone:booking.phone};
 const fieldNodes=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,{value:v,form}]));
 const doc={querySelector(s){if(s==='.arcaptcha[data-site-key],input[name="arcaptcha-token"]')return opts.challenge?{}:null;
  const m=/^input\[name="([^"]+)"\],input\[id="([^"]+)"\]$/.exec(s);return m?fieldNodes[m[1]]||null:null;},
  querySelectorAll(s){if(s==='input[name="srvc"]')return opts.srvc===null?[]:[{value:opts.srvc||'S123'}];
   if(s==='input[name="wagon"]')return opts.wagon===null?[]:[{value:opts.wagon||'W5'}];
   if(s==='input[type="checkbox"]')return opts.checkboxes||[checked];
   return [];}};
 return {doc,form,checked,control,fieldNodes};
}
test('Automatic official passenger continuation uses original chkForm control',()=>{
 const s=scene();const r=api.findPassengerSubmit(s.doc,booking,loc);
 assert.equal(r.ok,true);assert.equal(r.element,s.control);
});
test('No passenger continuation while official challenge is present',()=>{
 assert.equal(api.findPassengerSubmit(scene('passenger',{challenge:true}).doc,booking,loc).ok,false);
});
test('No passenger submit on wrong origin, protocol or unrelated path',()=>{
 for(const l of [{...loc,hostname:'bilitfast.example'},{...loc,protocol:'http:'},{...loc,pathname:'/etrain/TresV-auth.php'}])
 assert.equal(api.findPassengerSubmit(scene().doc,booking,l).ok,false);
});
test('Wrong train or wagon identity blocks passenger continuation',()=>{
 for(const opts of [{srvc:'OTHER'},{wagon:'OTHER'}])assert.equal(api.findPassengerSubmit(scene('passenger',opts).doc,booking,loc).ok,false);
});
test('Human-edited or incomplete passenger blocks continuation',()=>{
 const s=scene();s.fieldNodes.fn0.value='دیگر';assert.equal(api.findPassengerSubmit(s.doc,booking,loc).ok,false);
});
test('Wrong form action, GET or invalid browser form blocks continuation',()=>{
 for(const opt of [{action:'https://pec.shaparak.ir/NewIPG/'},{method:'GET'},{validity:false}])
 assert.equal(api.findPassengerSubmit(scene('passenger',opt).doc,booking,loc).ok,false);
});
test('Missing or ambiguous chkForm control blocks auto continuation',()=>{
 assert.equal(api.findPassengerSubmit(scene('passenger',{controls:[]}).doc,booking,loc).ok,false);
 const s=scene('passenger',{controls:[meta('button','ادامه','chkForm()'),meta('button','ادامه','chkForm()')]});
 assert.equal(api.findPassengerSubmit(s.doc,booking,loc).ok,false);
});
test('No synthetic, arbitrary JS, captcha or payment control as passenger submit',()=>{
 for(const handler of ['form.submit()','solveCaptcha()','chkForm();pay()','arcaptcha.execute()','']){
  assert.equal(api.findPassengerSubmit(scene('passenger',{controls:[meta('button','ادامه',handler)]}).doc,booking,loc).ok,false);
 }
});
test('Single official allocated seat acknowledgement recognized',()=>{
 const s=scene('allocation');const r=api.findAllocationAcknowledgement(s.doc,booking,verify);
 assert.equal(r.ok,true);assert.equal(r.checkbox,s.checked);assert.equal(r.element,s.control);
});
test('Allocation never accepted before same-tab passenger confirmation',()=>{
 assert.equal(api.findAllocationAcknowledgement(scene('allocation').doc,{...booking,passengerSubmitted:false},verify).ok,false);
});
test('Allocation never auto-handled during CAPTCHA',()=>{
 assert.equal(api.findAllocationAcknowledgement(scene('allocation',{challenge:true}).doc,booking,verify).ok,false);
});
test('Wrong wagon/service and wrong origin blocks assigned seat acknowledgement',()=>{
 assert.equal(api.findAllocationAcknowledgement(scene('allocation',{srvc:'ANOTHER'}).doc,booking,verify).ok,false);
 assert.equal(api.findAllocationAcknowledgement(scene('allocation',{wagon:'ANOTHER'}).doc,booking,verify).ok,false);
 assert.equal(api.findAllocationAcknowledgement(scene('allocation').doc,booking,{...verify,hostname:'evil.example'}).ok,false);
});
test('Unknown, duplicate or marketing checkbox cannot be mistaken for seat agreement',()=>{
 const s=scene('allocation');s.checked.labels=[{textContent:'قبول قوانین تبلیغات'}];
 assert.equal(api.findAllocationAcknowledgement(s.doc,booking,verify).ok,false);
 const t=scene('allocation');const other={...t.checked};
 assert.equal(api.findAllocationAcknowledgement(scene('allocation',{checkboxes:[t.checked,other]}).doc,booking,verify).ok,false);
});
test('Bank/payment control or externally targeted form never auto-clicked',()=>{
 for(const opt of [
  {controls:[meta('submit','پرداخت')]},
  {controls:[meta('submit','تکمیل پرداخت')]},
  {controls:[meta('button','تأیید','payNow()')]},
  {action:'https://pec.shaparak.ir/NewIPG/?Token=test'}])
  assert.equal(api.findAllocationAcknowledgement(scene('allocation',opt).doc,booking,verify).ok,false);
});
test('Allocation must have at least one matching official booking marker',()=>{
 assert.equal(api.findAllocationAcknowledgement(scene('allocation',{srvc:null,wagon:null}).doc,booking,verify).ok,false);
});
test('Same tab and explicit first booking authorization required',()=>{
 assert.equal(api.findAllocationAcknowledgement(scene('allocation').doc,{...booking,autoAdvance:false},verify).ok,false);
 assert.equal(api.findPassengerSubmit(scene().doc,{...booking,autoAdvance:false},loc).ok,false);
});
console.log('ALL '+passed+' first-party automatic continuation tests passed');
