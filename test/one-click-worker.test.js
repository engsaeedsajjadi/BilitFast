'use strict';
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const control=require('../extension/route-bridge-control');
const handoff=require('../extension/official-handoff');
const code=fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
let checks=0;function check(label,cond){assert(cond,label);checks++;console.log('PASS '+label)}
(async()=>{
 const listeners=[],state={},navigation=[],panelCalls=[];
 const chrome={
  runtime:{id:'bf',onInstalled:{addListener(){}},onMessage:{addListener(fn){listeners.push(fn)}},getURL(s){return 'chrome-extension://bf/'+s}},
  action:{setTitle(){}},sidePanel:{async open(o){panelCalls.push(o)}},
  tabs:{async update(id,change){navigation.push([id,change.url])},onUpdated:{addListener(){}}},
  storage:{local:{async get(){return {bilitTrustedOrigin:'https://agency.example'}}},session:{
   async get(k){return {[k]:state[k]}},async set(o){Object.assign(state,o)},async remove(k){delete state[k]}
  }}
 };
 vm.runInNewContext(code,{chrome,console,Date,Set,URL,BilitRouteBridgeControl:control,
  BilitOfficialHandoff:handoff,importScripts(){}});
 function send(message,url='https://agency.example/route.html?id=7',id=7){
  return new Promise((resolve,reject)=>{
   const sender={url,tab:{id,windowId:3,url}};
   const listener=listeners.find(fn=>fn(message,sender,resolve)===true);
   if(!listener)reject(Error('missing message listener'));
  });
 }
 const payload={url:handoff.OFFICIAL,method:'POST',fields:{srvc:'ticket-42',from:'1',to:'2',passCnt:'1'}};
 const snapshot={handoff:payload,phone:'09120000000',passengers:[{national_code:'0012345678',first_name:'Ali',last_name:'Rezaei'}]};
 let result=await send({type:'BILIT_START_FROM_SELECTION',snapshot});
 check('No official navigation without row-click panel authorization',result.ok===false&&navigation.length===0);
 result=await send({type:'BILIT_PREPARE_PANEL'},'https://evil.example/route.html');
 check('Unpaired origin cannot open BilitFast panel',result.ok===false&&panelCalls.length===0);
 result=await send({type:'BILIT_PREPARE_PANEL'});
 check('Explicit selection authorizes a side panel for matching tab',result.ok===true&&panelCalls.length===1);
 result=await send({type:'BILIT_START_FROM_SELECTION',snapshot});
 check('One selected train navigates same tab to SafirRail first party',result.ok===true&&navigation.length===1&&navigation[0][0]===7);
 check('No captcha token transferred into worker intent',!JSON.stringify(state.bilitPendingPassengerFill).includes('arcaptcha-token'));
 check('Official POST uses selected service without forging CAPTCHA',state.bilitOneTabHandoff?.handoff?.fields?.srvc==='ticket-42');
 result=await send({type:'BILIT_START_FROM_SELECTION',snapshot});
 check('Replaying start without new selection authorization is refused',result.ok===false&&navigation.length===1);
 await send({type:'BILIT_PREPARE_PANEL'});
 result=await send({type:'BILIT_START_FROM_SELECTION',snapshot:{...snapshot,handoff:{...payload,url:'https://evil.example/'}}});
 check('Untrusted destination rejected even with valid panel authorization',result.ok===false&&navigation.length===1);
 console.log('ALL '+checks+' one-click worker tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
