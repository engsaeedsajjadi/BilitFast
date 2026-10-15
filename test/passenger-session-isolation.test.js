'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const content=fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
const actions=[];const sessions={bilitPendingPassengerFill:{siteTabId:77,createdAt:Date.now(),
  passengers:[{first_name:'test'}],selection:{srvc:'S123',wagon:'W5'},autoAdvance:true}};
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
  result=await send('BILIT_CLAIM_SELECTION',88,undefined,{kind:'train'});
  pass('Another tab cannot claim train selection',result.ok===false);
  result=await send('BILIT_CLAIM_SELECTION',77,undefined,{kind:'payment'});
  pass('Unknown confirmation type is rejected',result.ok===false);
  result=await send('BILIT_CLAIM_SELECTION',77,undefined,{kind:'train'});
  pass('Selected tab can claim its preselected train once',result.ok===true);
  result=await send('BILIT_CLAIM_SELECTION',77,undefined,{kind:'train'});
  pass('Duplicate train click claim is rejected',result.ok===false);
  result=await send('BILIT_CLAIM_SELECTION',77,undefined,{kind:'coupe'});
  pass('Selected tab can claim its preselected coupe once',result.ok===true);
  result=await send('BILIT_CLAIM_SELECTION',77,undefined,{kind:'allocation'});
  pass('Cannot acknowledge an allocation before passenger form submission',result.ok===false);
  result=await send('BILIT_CLAIM_SELECTION',88,undefined,{kind:'passenger'});
  pass('Another tab cannot claim passenger continuation',result.ok===false);
  result=await send('BILIT_CLAIM_SELECTION',77,undefined,{kind:'passenger'});
  pass('Official tab claims automatic passenger step exactly once',result.ok===true);
  result=await send('BILIT_CLAIM_SELECTION',77,undefined,{kind:'passenger'});
  pass('Duplicate automatic passenger submission blocked',result.ok===false);
  result=await send('BILIT_CLAIM_SELECTION',77,undefined,{kind:'allocation'});
  pass('Exact same booking may claim allocated coupe only after passenger step',result.ok===true);
  result=await send('BILIT_CLAIM_SELECTION',77,undefined,{kind:'allocation'});
  pass('Duplicate assigned coupe acknowledgement blocked',result.ok===false);
  result=await send('BILIT_SET_WORKFLOW_STAGE',88,undefined,{stage:'human-verified'});
  pass('Another tab cannot forge human-verified status',result.ok===false);
  result=await send('BILIT_SET_WORKFLOW_STAGE',77,undefined,{stage:'human-verified'});
  pass('Selected official tab can report official passenger page',result.ok===true);
  result=await send('BILIT_SET_WORKFLOW_STAGE',77,undefined,{stage:'arbitrary-invalid-stage'});
  pass('Unknown status is not accepted',result===null);
  result=await send('BILIT_WORKSPACE_STATUS',0,extensionOrigin+'workspace.html');
  pass('Workspace receives only status, no session or passenger PII',result.stage==='human-verified'&&!result.passengers&&!result.cookies);
  result=await send('BILIT_CLEAR_PASSENGERS',77);
  pass('Only selected official tab clears passenger data',result.ok===true&&!sessions.bilitPendingPassengerFill);
  console.log('ALL '+count+' passenger session isolation checks passed');
})().catch(err=>{console.error(err);process.exitCode=1});
