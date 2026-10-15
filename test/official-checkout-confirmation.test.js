'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const api=require('../extension/checkout-flow');
let total=0;
function test(label,fn){fn();console.log('PASS '+label);total++}
function form(action='/etrain/TresV.php',method='post'){
 const calls=[];
 const obj={method,action:'https://safirrail.ir'+action,
  reportValidity:()=>true,
  querySelectorAll:()=>[{type:'button',disabled:false,getAttribute:()=> 'chkForm()',click:()=>calls.push('UNSAFE_CLICK')}],
  requestSubmit:()=>calls.push('UNSAFE_REQUEST'),submit:()=>calls.push('UNSAFE_SUBMIT')};
 return {obj,calls};
}
test('Official form is only inspected and never clicked',()=>{
 const {obj,calls}=form();const r=api.inspectPassengerForm(obj);
 assert.equal(r.manualSubmitRequired,true);assert.equal(r.hasOfficialControl,true);assert.deepEqual(calls,[]);
});
test('Official VerifyTck POST form stays manual',()=>{
 const {obj,calls}=form('/etrain/VerifyTck.php');
 assert.equal(api.inspectPassengerForm(obj).manualSubmitRequired,true);assert.deepEqual(calls,[]);
});
test('Unsafe origins and GET forms rejected',()=>{
 const {obj}=form();obj.action='https://example.evil/etrain/TresV.php';
 assert.equal(api.inspectPassengerForm(obj).ok,false);obj.action='https://safirrail.ir/etrain/TresV.php';obj.method='GET';
 assert.equal(api.inspectPassengerForm(obj).ok,false);
});
test('Invalid fields not auto-submitted',()=>{
 const {obj,calls}=form();obj.reportValidity=()=>false;
 assert.equal(api.inspectPassengerForm(obj).reason,'invalid-fields');assert.deepEqual(calls,[]);
});
test('Same URL can contain challenge, passenger or other step',()=>{
 assert.equal(api.detectPage({hostname:'safirrail.ir',pathname:'/etrain/TresV.php',hasChallenge:true}),'awaiting-human');
 assert.equal(api.detectPage({hostname:'safirrail.ir',pathname:'/etrain/TresV.php',hasPassenger:true}),'passenger-form');
 assert.equal(api.detectPage({hostname:'safirrail.ir',pathname:'/etrain/TresV.php'}),'passenger-response');
});
test('Purchase review requires positive page evidence',()=>{
 assert.equal(api.detectPage({hostname:'safirrail.ir',pathname:'/etrain/VerifyTck.php',visibleText:'تأیید نهایی خرید'}),'purchase-review');
 assert.equal(api.detectPage({hostname:'safirrail.ir',pathname:'/etrain/VerifyTck.php'}),'purchase-response');
});
test('Only exact official bank host/path recognized',()=>{
 assert.equal(api.detectPage({hostname:'pec.shaparak.ir',pathname:'/NewIPG/'}),'payment-page');
 assert.equal(api.detectPage({hostname:'pec.shaparak.ir.evil.example',pathname:'/NewIPG/'}),'not-official');
});
test('No submission routines exported',()=>{
 assert.equal('submitPassenger' in api,false);
 const code=fs.readFileSync(path.join(__dirname,'../extension/checkout-flow.js'),'utf8');
 assert(!/\.click\s*\(|\.requestSubmit\s*\(|\.submit\s*\(/.test(code));
});
console.log('ALL '+total+' manual-checkout tests passed');
