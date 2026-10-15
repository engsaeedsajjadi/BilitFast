'use strict';
const fs=require('fs');const vm=require('vm');const path=require('path');const assert=require('node:assert/strict');
const code=fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
const handoff=require('../extension/official-handoff');
let total=0;
function pass(s,condition){assert(condition,s);total++;console.log('PASS '+s)}
async function harness(job){
 let callback;const state={bilitOneTabHandoff:job};const sent=[];
 const chrome={
  runtime:{id:'bf',onInstalled:{addListener(){}},onMessage:{addListener(){}},getURL(s){return 'chrome-extension://bf/'+s}},
  action:{setTitle(){}},
  tabs:{onUpdated:{addListener(fn){callback=fn}}},
  storage:{session:{async get(k){return {[k]:state[k]}},async set(o){Object.assign(state,o)},async remove(k){delete state[k]}}},
  scripting:{async executeScript(o){
    const calls=[];const form={method:'',action:'',style:{},appendChild(el){calls.push(el)},submit(){sent.push({url:this.action,method:this.method,fields:calls.map(x=>[x.name,x.value])})}};
    const doc={createElement(tag){return tag==='form'?form:{type:'',name:'',value:''}},body:{appendChild(){}}};
    const result=vm.runInNewContext('('+o.func.toString()+')(handoff)',{
     document:doc,location:{protocol:'https:',hostname:'safirrail.ir',pathname:'/etrain/index.php'},handoff:o.args[0]});
    return [{result}];
  }}
 };
 vm.runInNewContext(code,{chrome,Date,Set,URL,BilitOfficialHandoff:handoff,importScripts(){},console});
 const complete=async (tabId,url='https://safirrail.ir/etrain/index.php')=>{
  callback(tabId,{status:'complete'},{url});
  for(let i=0;i<7;i++)await new Promise(r=>setImmediate(r));
 };
 return {complete,state,sent};
}
(async()=>{
 const base={tabId:17,origin:'https://agency.example',createdAt:Date.now(),handoff:{
  url:'https://safirrail.ir/etrain/TresV-auth.php',method:'POST',fields:{from:'1',to:'191',srvc:'ticket-value',passCnt:'1'}}};
 const valid=await harness(base);
 await valid.complete(19);
 pass('another tab cannot consume pending reservation',valid.sent.length===0&&!!valid.state.bilitOneTabHandoff);
 await valid.complete(17);
 pass('only the matching first-party page submits reservation',valid.sent.length===1&&valid.sent[0].url===handoff.OFFICIAL);
 pass('first party post sends train fields but never captcha data',valid.sent[0].fields.some(([k,v])=>k==='srvc'&&v==='ticket-value')&&!valid.sent[0].fields.some(([k])=>k.includes('captcha')));
 pass('reservation intent consumed once',!valid.state.bilitOneTabHandoff);
 await valid.complete(17);
 pass('same event cannot replay the reservation',valid.sent.length===1);
 const expired=await harness({...base,createdAt:Date.now()-61e3});
 await expired.complete(17);
 pass('expired one-tab authorization never submits',expired.sent.length===0&&expired.state.bilitWorkflowStatus?.stage==='network-session-error');
 const invalid=await harness({...base,handoff:{...base.handoff,url:'https://attacker.example/pay'}});
 await invalid.complete(17);
 pass('untrusted destination never submits',invalid.sent.length===0&&invalid.state.bilitWorkflowStatus?.stage==='network-session-error');
 console.log('ALL '+total+' worker handoff tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
