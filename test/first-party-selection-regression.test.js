'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const backgroundCode = fs.readFileSync(path.join(ROOT,'extension/background.js'),'utf8');
const routeCode = fs.readFileSync(path.join(ROOT,'public/route.html'),'utf8');
const apiCode = fs.readFileSync(path.join(ROOT,'api/reserve.js'),'utf8');
const bridgeControl = require('../extension/route-bridge-control');
const handoff = require('../extension/official-handoff');
let checks = 0;
function check(label, fn) { fn();checks++;console.log('PASS',label); }

async function apiPrepare() {
  const reserveCalls = [];
  const fakePrepare = {
    fields: {from_city:'Tehran',to_city:'Mashhad',date:'1405/08/12'},
    passengers:[{national_code:'0012345678'}],
    train:{'شماره قطار':'123',srvc:'valid-service'}
  };
  const fakeBody = {from:'1',to:'2',passCnt:'1',srvc:'valid-service'};
  const deps = {
    '../lib/reserve': {
      buildReserveInitBody:(data)=>{reserveCalls.push('init');return {...data};},
      startReservation:()=>{throw new Error('MUST NOT perform upstream reservation')},
      submitReservation:()=>{throw new Error('MUST NOT submit CAPTCHA')},
    },
    '../lib/core': {buildReserveForm:({fields,passengers,train})=> {
      assert.equal(train.srvc,'valid-service');
      assert.equal(fields.from_city,'Tehran');
      assert.equal(passengers.length,1);
      reserveCalls.push('build');
      return {ok:true,reserveData:fakeBody};
    }},
    '../lib/guard':{guardApi:()=>true},
    '../lib/auth':{getSessionUser:()=>null},
    '../lib/apiauth':{requireUser:()=>({ok:true,user:null})},
    '../lib/accounts':{consumeQuota:()=>{throw Error('quota not consumed by mere preparation')}},
    '../lib/license':{checkAccess:()=>({allowed:true})},
    '../lib/session-fallback':{ensureCookies:()=>{throw Error('cookie fallback must not run')}},
    '../config.json':{base_url:'https://safirrail.ir',reserve_init_url:'/etrain/TresV-auth.php',trial_period_days:3}
  };
  const module = {exports:{}};
  vm.runInNewContext(apiCode,{module,require:s=>{
    if(!Object.hasOwn(deps,s)) throw Error('Unexpected require '+s);
    return deps[s];
  },URL,console}, {filename:'api/reserve.js'});
  let result;
  const res={status(code){this.code=code;return this},json(data){result=data;return this}};
  await module.exports({method:'POST',body:{action:'prepare-official-handoff',...fakePrepare}},res);
  check('Server prepares a safe handoff without a SafirRail request or cookies',()=>{
    assert.equal(result?.ok,true);
    assert.equal(result.step,'arcaptcha_required');
    assert.equal(result.browserHandoff.url,handoff.OFFICIAL);
    assert.equal(result.browserHandoff.fields.srvc,'valid-service');
    assert.deepEqual(reserveCalls,['build','init']);
    assert.equal(result.cookies,undefined);
    assert.equal(result.browserHandoff.fields['arcaptcha-token'],undefined);
  });
  check('Untrusted official origin cannot be returned',()=>{
    assert(handoff.validate(result.browserHandoff));
    assert.throws(()=>handoff.validate({...result.browserHandoff,url:'https://fake.example/'}));
  });
}

async function panelFailureMustNotBlockBooking() {
  const listeners=[];const state={};const navigation=[],created=[];
  const chrome={
    runtime:{id:'bf',onInstalled:{addListener(){}},onMessage:{addListener(fn){listeners.push(fn)}},getURL(s){return 'chrome-extension://bf/'+s}},
    action:{setTitle(){}},sidePanel:{async open(){throw Error('No user gesture for side panel')}},
    tabs:{async create(options){created.push(options);return {id:70,...options}},async update(id,change){navigation.push([id,change.url]);return {id,url:change.url};},async remove(){},onUpdated:{addListener(){}}},
    storage:{local:{async get(){return {bilitTrustedOrigin:'https://agency.example'}}},session:{async get(k){return {[k]:state[k]}},async set(v){Object.assign(state,v)},async remove(k){delete state[k]}}}
  };
  vm.runInNewContext(backgroundCode,{chrome,console,Date,Set,URL,importScripts(){},
    BilitRouteBridgeControl:bridgeControl,BilitOfficialHandoff:handoff});
  function send(message) {
    return new Promise((resolve,reject)=>{
      const tab={id:7,windowId:3,index:1,url:'https://agency.example/route.html?id=7'};
      const sender={url:tab.url,tab};
      const listener=listeners.find(fn=>fn(message,sender,resolve)===true);
      if(!listener) reject(Error('Missing response listener'));
    });
  }
  const prep=await send({type:'BILIT_PREPARE_PANEL'});
  check('A blocked side panel is non-fatal',()=>{
    assert.equal(prep.ok,true);assert.equal(prep.panelOpened,false);
    assert.match(prep.panelError,/پنل/);
  });
  const result=await send({type:'BILIT_START_FROM_SELECTION',snapshot:{
    handoff:{url:handoff.OFFICIAL,method:'POST',fields:{srvc:'valid-service',from:'1',to:'2',passCnt:'1'}},
    passengers:[{national_code:'0012345678',first_name:'Ali',last_name:'Rezaei'}],phone:'09120000000'
  }});
  check('Reservation opens separate tab despite side-panel failure; BilitFast remains intact',()=>{
    assert.equal(result.ok,true);
    assert.equal(navigation.length,1);
    assert.deepEqual(navigation[0],[70,'https://safirrail.ir/etrain/index.php']);
    assert.equal(created.length,1);
    assert.equal(created[0].windowId,3);
    assert.equal(state.bilitPendingPassengerFill.sourceTabId,7);
  });
}

(async()=>{
  check('Selected-train action uses local handoff preparation',()=>{
    assert.match(routeCode,/action:\s*'prepare-official-handoff'/);
    assert(!/async function reserveStart\(\)\s*\{[^}]*action:\s*'start'/.test(routeCode));
  });
  await apiPrepare();
  await panelFailureMustNotBlockBooking();
  console.log('ALL',checks,'first-party selection regression tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
