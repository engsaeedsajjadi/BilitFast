'use strict';
const assert=require('node:assert/strict');
const {findSafeAction}=require('../extension/selection-confirm');
const loc={protocol:'https:',hostname:'safirrail.ir',pathname:'/etrain/TresV.php'};
let count=0;
function run(name,fn){fn();count++;console.log('PASS '+name)}
function mock({srvc='S123',wagon='W5',challenge=false,buttons=[]}={}){
 const marks={srvc:[{value:srvc}],wagon:[{value:wagon}]};
 return {querySelector(sel){return challenge&&sel.includes('arcaptcha')?{}:null;},
   querySelectorAll(sel){const n=/input\[name="(\w+)"\]/.exec(sel);return n?marks[n[1]]||[]:buttons;}};
}
function button(label,{type='button',onclick='',disabled=false,hidden=false}={}){
 return {type,disabled,hidden,textContent:label,value:'',getAttribute(n){return n==='onclick'?onclick:n==='aria-disabled'?'false':''},click(){this.clicked=true}};
}
run('Official origin and first-party path only',()=>{
 const x=mock({buttons:[button('تأیید قطار')]});
 for(const bad of [{...loc,hostname:'bilitfast.example'},{...loc,protocol:'http:'},{...loc,pathname:'/'}])
 assert.equal(findSafeAction(x,'train',{srvc:'S123'},bad).ok,false);
});
run('No interaction while challenge widget exists',()=>{
 assert.equal(findSafeAction(mock({challenge:true,buttons:[button('تأیید قطار')]}),'train',{srvc:'S123'},loc).ok,false);
});
run('Exact selected service and wagon must match',()=>{
 assert.equal(findSafeAction(mock({buttons:[button('تأیید قطار')]}),'train',{srvc:'wrong'},loc).ok,false);
 assert.equal(findSafeAction(mock({buttons:[button('تأیید کوپه')]}),'coupe',{wagon:'wrong'},loc).ok,false);
});
run('Only unique expected control can be invoked',()=>{
 let doc=mock({buttons:[button('تأیید قطار'),button('تأیید قطار')]});
 assert.equal(findSafeAction(doc,'train',{srvc:'S123'},loc).ok,false);
 doc=mock({buttons:[button('تأیید قطار')]});
 assert.equal(findSafeAction(doc,'train',{srvc:'S123'},loc).ok,true);
});
run('Unknown, checkout, and final purchase controls are never selected',()=>{
 for(const label of ['تأیید نهایی خرید','پرداخت','من ربات نیستم','تأیید فرم','تأیید'])
 assert.equal(findSafeAction(mock({buttons:[button(label)]}),'train',{srvc:'S123'},loc).ok,false);
});
run('Submit buttons and forms with submit script are never accepted',()=>{
 for(const opts of [{type:'submit'},{onclick:'chkForm()'},{onclick:'form.submit()'},{disabled:true},{hidden:true}])
 assert.equal(findSafeAction(mock({buttons:[button('تأیید قطار',opts)]}),'train',{srvc:'S123'},loc).ok,false);
});
run('Safe intermediate coupe control allowed only for selected wagon',()=>{
 assert.equal(findSafeAction(mock({buttons:[button('تأیید کوپه')]}),'coupe',{wagon:'W5'},loc).ok,true);
});
console.log('ALL '+count+' guarded selection tests passed');
