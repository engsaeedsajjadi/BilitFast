'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const background=fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
const bridge=require('../extension/route-bridge-control');
const handoff=require('../extension/official-handoff');
let passed=0;
function check(label,condition){assert(condition,label);passed++;console.log('PASS '+label)}
async function harness({failCreate=false,failNavigate=false,failStorage=false}={}) {
  const listeners=[],tabs={14:{id:14,windowId:2,index:3,url:'https://agency.example/route.html?id=9'}};
  const session={},events=[],newIds=[],removals=[];
  const chrome={
    runtime:{id:'bf',onInstalled:{addListener(){}},onMessage:{addListener(fn){listeners.push(fn)}},getURL(f){return 'chrome-extension://bf/'+f}},
    action:{setTitle(){}}, sidePanel:{async open(){return true}},
    storage:{local:{async get(){return {bilitTrustedOrigin:'https://agency.example'}}},session:{
      async get(k){return {[k]:session[k]}},
      async set(data){if(failStorage)throw Error('storage unavailable');Object.assign(session,data);events.push('stored')},
      async remove(k){for(const key of Array.isArray(k)?k:[k])delete session[key]}
    }},
    tabs:{
      async create(options){if(failCreate)throw Error('create blocked');const id=100+newIds.length;
        tabs[id]={id,...options};newIds.push(id);events.push('created:'+id);return tabs[id]},
      async update(id,data){events.push('updated:'+id);
        if(failNavigate)throw Error('navigation blocked');
        assert(tabs[id],'Tab must exist');Object.assign(tabs[id],data);return tabs[id]},
      async remove(id){removals.push(id);delete tabs[id]},
      onUpdated:{addListener(fn){chrome._onUpdated=fn}}
    }
  };
  const injected=[];
  chrome.scripting={async executeScript(o){injected.push(o);return [{result:true}]}};
  vm.runInNewContext(background,{chrome,Date,Set,URL,console,importScripts(){},
    BilitRouteBridgeControl:bridge,BilitOfficialHandoff:handoff});
  function send(message,url='https://agency.example/route.html?id=9',tabId=14){
    return new Promise((resolve,reject)=>{
      const sender={url,tab:tabs[tabId]||{id:tabId,url,windowId:2,index:3}};
      const listener=listeners.find(fn=>fn(message,sender,resolve)===true);
      if(!listener)reject(Error('message listener missing'));
    });
  }
  const snapshot={handoff:{url:handoff.OFFICIAL,method:'POST',fields:{from:'1',to:'2',srvc:'train-99',passCnt:'1'}},
    phone:'09120000000',passengers:[{national_code:'0012345678',first_name:'Ali',last_name:'Rezaei'}]};
  return {send,snapshot,tabs,newIds,session,events,removals,injected,chrome};
}
(async()=>{
 const h=await harness();
 await h.send({type:'BILIT_PREPARE_PANEL'});
 const result=await h.send({type:'BILIT_START_FROM_SELECTION',snapshot:h.snapshot});
 check('A new reservation tab opens',result.ok===true&&result.siteTabId===100&&h.newIds.length===1);
 check('Original BilitFast route tab is never navigated or closed',h.tabs[14].url==='https://agency.example/route.html?id=9'&&h.events.every(x=>x!=='updated:14'));
 check('New tab opens adjacent in same window, becoming active',h.tabs[100].windowId===2&&h.tabs[100].index===4&&h.tabs[100].active===true);
 check('Handoff is persisted BEFORE navigating official tab',h.events.indexOf('stored')<h.events.indexOf('updated:100'));
 check('Passenger data and form handoff only work in created site tab',h.session.bilitPendingPassengerFill.siteTabId===100 && h.session.bilitOneTabHandoff.tabId===100);
 check('No cookie, ARCaptcha token or bank URL is shared by handoff',!JSON.stringify(h.session).includes('arcaptcha-token')&&!JSON.stringify(h.session).includes('NewIPG')&&!JSON.stringify(h.session).includes('PHPSESSID'));
 const wrong=await h.send({type:'BILIT_GET_PASSENGERS'},'https://safirrail.ir/etrain/TresV.php',200);
 const right=await h.send({type:'BILIT_GET_PASSENGERS'},'https://safirrail.ir/etrain/TresV.php',100);
 check('Other tabs cannot claim passenger data',wrong.ok===false&&right.ok===true&&right.passengers.length===1);
 // The existing first-party load listener is still responsible for the official POST.
 h.chrome._onUpdated(100,{status:'complete'},{url:'https://safirrail.ir/etrain/index.php'});
 for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
 check('Only new tab consumes reservation handoff',h.injected.length===1&&h.injected[0].target.tabId===100&&!h.session.bilitOneTabHandoff);
 const c=await harness({failCreate:true});await c.send({type:'BILIT_PREPARE_PANEL'});
 const blocked=await c.send({type:'BILIT_START_FROM_SELECTION',snapshot:c.snapshot});
 check('Blocked tab creation reports error without moving BilitFast',blocked.ok===false&&c.newIds.length===0&&c.tabs[14].url.includes('/route.html'));
 const f=await harness({failNavigate:true});await f.send({type:'BILIT_PREPARE_PANEL'});
 const broken=await f.send({type:'BILIT_START_FROM_SELECTION',snapshot:f.snapshot});
 check('Navigation errors clean up orphan tab and stale passenger handoff',broken.ok===false&&f.removals.length===1&&!f.session.bilitPendingPassengerFill&&!f.session.bilitOneTabHandoff&&f.tabs[14].url.includes('/route.html'));
 const code=fs.readFileSync(path.join(__dirname,'../extension/workspace.js'),'utf8');
 check('Side panel has explicit focus back to the original route tab',code.includes('focus-bilitfast')&&code.includes('bilitWorkspaceSourceTab'));
 console.log('ALL '+passed+' new-tab reservation regression checks passed');
})().catch(e=>{console.error(e);process.exitCode=1});
