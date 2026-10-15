'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const api=require('../extension/checkout-flow');
let count=0;
function test(name,fn){fn();console.log('PASS '+name);count++;}
function form(action='/etrain/TresV.php',opts={}) {
  const calls=[];
  const button={type:opts.type||'button',disabled:!!opts.disabled,
    getAttribute:(key)=>key==='onclick'?(opts.handler||''):null,
    click(){calls.push('native-click');if(opts.handler==='chkForm()')thisForm.action='https://safirrail.ir/etrain/VerifyTck.php';}};
  const thisForm={method:opts.method||'post',action:'https://safirrail.ir'+action,
    getAttribute:()=>null,reportValidity:()=>opts.valid!==false,
    querySelectorAll:()=>opts.button===false?[]:[button],
    requestSubmit(){calls.push('request-submit');}};
  return {thisForm,button,calls};
}
test('native onclick=chkForm advances passenger form to VerifyTck.php',()=>{
 const {thisForm,calls}=form('/etrain/TresV.php',{handler:'chkForm()'});
 const r=api.submitPassenger(thisForm);
 assert.equal(r.method,'official-chkForm');assert.deepEqual(calls,['native-click']);
 assert.ok(thisForm.action.endsWith('VerifyTck.php'));
});
test('missing official handler never blindly resubmits to TresV.php',()=>{
 const {thisForm,calls}=form();assert.equal(api.submitPassenger(thisForm).ok,false);assert.equal(calls.length,0);
});
test('explicit official VerifyTck.php action uses native click',()=>{
 const {thisForm,calls}=form('/etrain/VerifyTck.php',{type:'submit'});
 assert.equal(api.submitPassenger(thisForm).ok,true);assert.deepEqual(calls,['native-click']);
});
test('invalid personal-data fields block native clicks',()=>{
 const {thisForm,calls}=form('/etrain/VerifyTck.php',{handler:'chkForm()',valid:false});
 assert.equal(api.submitPassenger(thisForm).reason,'invalid-fields');assert.deepEqual(calls,[]);
});
test('foreign origin and GET action blocked',()=>{
 const {thisForm,calls}=form();thisForm.action='https://malicious.example/etrain/VerifyTck.php';
 assert.equal(api.submitPassenger(thisForm).ok,false);thisForm.action='https://safirrail.ir/etrain/VerifyTck.php';
 thisForm.method='get';assert.equal(api.submitPassenger(thisForm).ok,false);assert.equal(calls.length,0);
});
test('unknown control requires manual confirmation and does not simulate checkout',()=>{
 const {thisForm,calls}=form('/etrain/TresV.php',{handler:'somethingElse()'});
 assert.equal(api.submitPassenger(thisForm).reason,'official-control-not-found');assert.deepEqual(calls,[]);
});
test('form onsubmit may implement official chkForm without click',()=>{
 const {thisForm,calls}=form('/etrain/TresV.php',{button:false});
 thisForm.getAttribute=k=>k==='onsubmit'?'return chkForm();':null;
 assert.equal(api.submitPassenger(thisForm).method,'official-onsubmit');assert.deepEqual(calls,['request-submit']);
});
test('passenger form and challenge outrank identical URL',()=>{
 assert.equal(api.detectPage({hostname:'safirrail.ir',pathname:'/etrain/TresV.php',hasPassenger:true}), 'passenger-form');
 assert.equal(api.detectPage({hostname:'safirrail.ir',pathname:'/etrain/TresV.php',hasChallenge:true}), 'awaiting-human');
});
test('official confirmation page requires visible confirmation evidence',()=>{
 assert.equal(api.detectPage({hostname:'safirrail.ir',pathname:'/etrain/VerifyTck.php',visibleText:'لطفا مشخصات خود را تأیید خرید نمایید'}),'purchase-review');
 assert.equal(api.detectPage({hostname:'safirrail.ir',pathname:'/etrain/VerifyTck.php'}),'purchase-response');
});
test('TresV.php alone never means purchase or payment succeeded',()=>{
 assert.equal(api.detectPage({hostname:'safirrail.ir',pathname:'/etrain/TresV.php'}),'passenger-response');
});
test('only exact official bank host/path accepted as payment page',()=>{
 assert.equal(api.detectPage({hostname:'pec.shaparak.ir',pathname:'/NewIPG/'}),'payment-page');
 assert.equal(api.detectPage({hostname:'pec.shaparak.ir.evil.example',pathname:'/NewIPG/'}),'not-official');
});
test('extension never hardcodes or extracts bank token',()=>{
 const background=fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
 const helper=fs.readFileSync(path.join(__dirname,'../extension/safir-passenger-helper.js'),'utf8');
 assert.ok(!background.includes('409589579484274'));
 assert.ok(!helper.includes('409589579484274'));
 assert.ok(!/arcaptcha-token[^\n]*\.value\s*=/.test(helper));
});
console.log('ALL '+count+' official checkout regression checks passed');
