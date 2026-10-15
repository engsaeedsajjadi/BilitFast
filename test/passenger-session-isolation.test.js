'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const content=fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
const actions=[];const sessions={bilitPendingPassengerFill:{siteTabId:77,createdAt:Date.now(),
  passengers:[{first_name:'test'}],autoContinue:true}};
const extensionOrigin='chrome-extension://bilitfast-id/';
const chrome={
  runtime:{id:'bilitfast-id',getURL(name){return extensionOrigin+name;},
    onInstalled:{addListener(){}},onMessage:{addListener(fn){actions.push(fn)}}},
  action:{setTitle(){}},
  storage:{session:{
    async get(key){if(typeof key==='string')return {[key]:sessions[key]};return {...sessions}},
    async set(entries){Object.assign(sessions,entries)},
    async remove(key){delete sessions[key]}
  }}
};
vm.runInNewContext(content,{chrome,Date,Set});
async function send(type,tabId=77,url='https://safirrail.ir/etrain/TresV.php',extra={}){
  const sender={url,tab:{id:tabId},id:'bilitfast-id'};
  const msg={type,...extra};
  return await new Promise(resolve=>{
    let responded=false;for(const listener of actions){listener(msg,sender,data=>{
      if(!responded){responded=true;resolve(data)}
    });}
    setTimeout(()=>{if(!responded)resolve(null)},35);
  });
}
let count=0;function pass(msg,result){assert(result,msg);count++;console.log('PASS '+msg)}
(async()=>{
  let result=await send('BILIT_GET_PASSENGERS',88);
  pass('Another Safir tab cannot read passenger details',result.ok===false);
  pass('Unauthorized attempt never destroys rightful booking',!!sessions.bilitPendingPassengerFill);
  result=await send('BILIT_CLEAR_PASSENGERS',88);
  pass('Another Safir tab cannot clear passenger workflow',result.ok===false&&!!sessions.bilitPendingPassengerFill);
  result=await send('BILIT_GET_PASSENGERS',77);
  pass('Selected official tab receives passenger details',result.ok===true&&result.passengers.length===1);
  result=await send('BILIT_CLAIM_WORKFLOW_STEP',88,undefined,{step:'captcha'});
  pass('Another tab cannot claim CAPTCHA submission',result.ok===false);
  result=await send('BILIT_CLAIM_WORKFLOW_STEP',77,undefined,{step:'captcha'});
  pass('Selected tab can claim CAPTCHA submission',result.ok===true);
  result=await send('BILIT_CLAIM_WORKFLOW_STEP',77,undefined,{step:'captcha'});
  pass('CAPTCHA submission cannot be replayed',result.ok===false);
  result=await send('BILIT_SET_WORKFLOW_STAGE',77,undefined,{stage:'captcha-confirmed'});
  pass('Only whitelisted workspace stages accepted',result.ok===true);
  result=await send('BILIT_WORKSPACE_STATUS',0,extensionOrigin+'workspace.html');
  pass('Workspace receives only status, no session or passenger PII',result.stage==='captcha-confirmed'&&!result.passengers&&!result.cookies);
  result=await send('BILIT_CLEAR_PASSENGERS',77);
  pass('Only selected official tab clears passenger data',result.ok===true&&!sessions.bilitPendingPassengerFill);
  console.log('ALL '+count+' passenger session isolation checks passed');
})().catch(err=>{console.error(err);process.exitCode=1});
