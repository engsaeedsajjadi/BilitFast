'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const target=require('../extension/target-origin');
const direct=require('../extension/direct-session');
const script=fs.readFileSync(path.join(__dirname,'../extension/popup.js'),'utf8');
let passes=0;
function check(label,cond){assert(cond,label);passes++;console.log('PASS '+label);}
const source={id:5,windowId:8,url:'https://safirrail.ir/etrain/index.php'};
const destination={id:7,windowId:8,url:'http://127.0.0.1:3000/login.html'};
async function simulate({active=source,tabs=[source,destination],permitted=true,marker=true,
  hasCookies=true,storageWorks=true,changedDestination=false}={}){
  const events=[];
  const el=Object.fromEntries(['send','msg','endpoint'].map(k=>[k,{textContent:'',className:'',disabled:false,
    listeners:{},addEventListener(name,cb){this.listeners[name]=cb}}]));
  const storage=new Map(),dispatched=[];
  const appDocument={querySelector:()=>marker?{content:'first-party-web-v1'}:null};
  const appLocation={origin:'http://127.0.0.1:3000',pathname:'/login.html'};
  const chrome={
    tabs:{async query(opt){return opt.active?[active]:tabs},async get(){return {...destination,url:changedDestination?'https://evil.example/login.html':destination.url}}},
    storage:{local:{async get(){return {bilitTrustedOrigin:null}}}},
    permissions:{async request(x){events.push(['permission',x]);return permitted}},
    scripting:{async executeScript(opts){events.push(['injection',opts.world||'ISOLATED']);
      if(opts.world!=='MAIN')return [{result:marker}];
      if(!storageWorks)return [{result:{ok:false,reason:'storage-unavailable'}}];
      const response=vm.runInNewContext('('+opts.func.toString()+')(...args)',{
        args:opts.args,location:appLocation,document:appDocument,
        sessionStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)},
        window:{dispatchEvent:e=>dispatched.push(e.type)},Event:class{constructor(s){this.type=s}},
        JSON,Date,String});
      return [{result:response}];
    }}
  };
  const reader={async collect(){events.push(['collect']);
    if(!hasCookies)throw new Error('No session');
    return {host:'safirrail.ir',cookies:['PHPSESSID=SYNTHETIC_NOT_REAL'],verificationCookies:['lang=fa']};
  }};
  vm.runInNewContext(script,{document:{getElementById:k=>el[k]},chrome,
    BilitCookieReader:reader,BilitTargetOrigin:target,BilitDirectSession:direct,
    BilitRouteBridgeControl:{async install(api,origin,tabId){events.push(['bridge',origin,tabId])}},
    URL,Date,console},{filename:'popup.js'});
  for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));
  await el.send.listeners.click();
  return {events,storage,el,dispatched};
}
(async()=>{
  check('Official apex /etrain tab is accepted',direct.official(source.url));
  check('Lookalike subdomains are rejected',!direct.official('https://safirrail.ir.evil.example/etrain/')&&!direct.official('http://safirrail.ir/etrain/'));
  check('Destination is determined from a separately opened BilitFast tab',direct.select([source,destination],source,target.fromTab).tab.id===7);
  const ok=await simulate();
  check('One click directly writes booking cookie to the matching app tab',JSON.parse(ok.storage.get('bilitfast_cookies'))[0]==='PHPSESSID=SYNTHETIC_NOT_REAL');
  check('Verification-path cookies are kept separately',JSON.parse(ok.storage.get('bilitfast_verification_cookies'))[0]==='lang=fa');
  check('App receives status without session credentials in event',ok.dispatched.includes('bilitfast-direct-session-ready'));
  check('Route-selection bridge is installed only after tab storage ACK',ok.events.findIndex(x=>x[0]==='bridge')>ok.events.findIndex(x=>x[0]==='injection'&&x[1]==='MAIN'));
  check('No credentials traverse a cookie-sync HTTP endpoint',!script.includes('fetch(')&&!script.includes('action:\'push\'')&&!script.includes('api/cookie-sync'));
  check('A wrong destination is rejected without collecting cookies',!(await simulate({marker:false})).events.some(x=>x[0]==='collect'));
  check('Site tab not active: no cookie access',!(await simulate({active:destination})).events.some(x=>x[0]==='collect'));
  check('A changed app URL aborts before cookie access',!(await simulate({changedDestination:true})).events.some(x=>x[0]==='collect'));
  check('Permission denial blocks cookie access',!(await simulate({permitted:false})).events.some(x=>x[0]==='collect'));
  check('No false success without a session',!(await simulate({hasCookies:false})).events.some(x=>x[0]==='bridge'));
  check('Blocked storage prevents success and bridge installation',!(await simulate({storageWorks:false})).events.some(x=>x[0]==='bridge'));
  check('Multiple candidate app tabs require a unique destination',(()=>{try{direct.select([source,destination,{...destination,id:8}],source,target.fromTab);return false}catch{return true}})());
  check('If login and route tabs both exist, unique route tab takes priority',direct.select([source,destination,{...destination,id:8,url:'http://127.0.0.1:3000/route.html?id=4'}],source,target.fromTab).tab.id===8);
  check('No transfer if app is not in the same window',(()=>{try{direct.select([source,{...destination,windowId:99}],source,target.fromTab);return false}catch{return true}})());
  console.log('ALL '+passes+' direct-connection tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
