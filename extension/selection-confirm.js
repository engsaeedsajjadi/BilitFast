/* Safe, strictly matched train/coupe intermediate controls; NEVER CAPTCHA/checkout. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BilitSafeSelection=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const normalize=value=>String(value||'').replace(/[يى]/g,'ی').replace(/ك/g,'ک')
    .replace(/[\u200c\s]+/g,' ').trim();
  const LABELS={train:new Set(['تایید قطار','تأیید قطار']),coupe:new Set(['تایید کوپه','تأیید کوپه'])};
  const FIELD={train:'srvc',coupe:'wagon'};
  function findSafeAction(doc,kind,selection,location){
    if(!LABELS[kind] || location?.protocol!=='https:' || location?.hostname!=='safirrail.ir' ||
       !location?.pathname?.startsWith('/etrain/'))return {ok:false,reason:'origin'};
    // On a CAPTCHA page no automation, even if unrelated buttons exist.
    if(doc.querySelector('.arcaptcha[data-site-key],input[name="arcaptcha-token"]'))
      return {ok:false,reason:'challenge'};
    const expected=String(selection?.[kind==='train'?'srvc':'wagon']||'').trim();
    if(!expected)return {ok:false,reason:'unbound-selection'};
    const markers=Array.from(doc.querySelectorAll(`input[name="${FIELD[kind]}"]`));
    if(markers.length!==1 || String(markers[0].value||'').trim()!==expected)
      return {ok:false,reason:'selection-mismatch'};
    const candidates=Array.from(doc.querySelectorAll('button[type="button"],input[type="button"]')).filter(el=>{
      const label=normalize(el.textContent||el.value);
      const onclick=el.getAttribute?.('onclick')||'';
      return el.type==='button' && !el.disabled && !el.hidden && LABELS[kind].has(label) &&
        !/submit|chkForm|arcaptcha|captcha|پرداخت|خرید|payment/i.test(onclick) &&
        String(el.getAttribute?.('formaction')||'')==='' &&
        el.getAttribute?.('aria-disabled')!=='true';
    });
    if(candidates.length!==1)return {ok:false,reason:'unknown-control'};
    return {ok:true,element:candidates[0]};
  }
  return {findSafeAction};
});
