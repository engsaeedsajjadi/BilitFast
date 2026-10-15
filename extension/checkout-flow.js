/* Read-only page/form inspector: the official SafirRail UI owns every submit. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BilitOfficialCheckout=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const SITE='https://safirrail.ir';
  const VERIFY='/etrain/VerifyTck.php';
  const PASSENGER='/etrain/TresV.php';
  function officialAction(form){
    if(!form||String(form.method||'').toUpperCase()!=='POST')return null;
    try{
      const u=new URL(form.action,SITE+'/etrain/');
      return u.origin===SITE&&[VERIFY,PASSENGER].includes(u.pathname)?u.pathname:null;
    }catch(_){return null;}
  }
  function inspectPassengerForm(form){
    const action=officialAction(form);
    if(!action)return {ok:false,reason:'invalid-form'};
    if(typeof form.reportValidity==='function'&&!form.reportValidity())return {ok:false,reason:'invalid-fields'};
    const controls=Array.from(form.querySelectorAll?.('input[type="button"],button[type="button"],input[type="submit"],button[type="submit"]')||[]);
    const hasOfficialControl=controls.some(el=>!el.disabled&&(/\bchkForm\s*\(/i.test(el.getAttribute?.('onclick')||'')||/submit/i.test(el.type||'')));
    return {ok:true,manualSubmitRequired:true,hasOfficialControl,action};
  }
  function detectPage({hostname,pathname,visibleText='',hasPassenger=false,hasChallenge=false}){
    if(hostname==='pec.shaparak.ir'&&/^\/NewIPG\//i.test(pathname))return 'payment-page';
    if(hostname!=='safirrail.ir'||!pathname.startsWith('/etrain/'))return 'not-official';
    if(hasChallenge)return 'awaiting-human';
    if(hasPassenger)return 'passenger-form';
    const text=String(visibleText).slice(0,15000);
    if(/ت[أا]یید\s*(?:نهایی\s*)?(?:خرید|رزرو|بلیت)|ثبت\s*نهایی\s*خرید/.test(text))return 'purchase-review';
    if(pathname===VERIFY)return 'purchase-response';
    if(pathname===PASSENGER)return 'passenger-response';
    return 'unknown-official';
  }
  return {officialAction,inspectPassengerForm,detectPage,VERIFY,PASSENGER};
});
