// End-to-end searchOnce outcomes against synthetic HTTP responses. The small
// Cheerio substitute isolates the response gate from dependency installation.
'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
let response = null;
let mockCalls = 0;
const original = Module._load;
function makeCheerio(html) {
  const rowPresent = /<tr\s+name=["']srvc["']/i.test(html);
  const row = {kind:'row'};
  function collection(items, selector='') {
    return {
      length:items.length,
      toArray(){return items;},
      first(){return collection(items.slice(0,1),selector);},
      each(fn){items.forEach((x,i)=>fn(i,x));return this;},
      closest(type){return type==='tr'&&rowPresent?collection([row]):collection([]);},
      find(next){return select(next);},
      text(){
        if(selector==='td:nth-child(3)')return '123';
        if(selector==='td:nth-child(8)')return '08:30';
        if(selector==='td:nth-child(9)')return html.includes('zero-seat')?'0':'4';
        if(selector==='td:nth-child(10)')return '100';
        if(selector==='td:nth-child(4)')return '4 نفره';
        return '';
      },
      attr(key){
        if(key==='action')return /<form[^>]+action=["']([^"']+)/i.exec(html)?.[1];
        if(key==='value'&&selector==="input[name='srvc']")return 'SRVC123';
        return null;
      },
    };
  }
  function select(sel) {
    if (sel === row || (sel && sel.kind==='row'))return collection([row]);
    if (sel && sel.kind==='form')return collection([sel],'form');
    if (typeof sel !== 'string')return collection([]);
    if (sel === 'form')return collection(/<form/i.test(html)?[{kind:'form'}]:[],'form');
    if (sel === 'input[type="password"]')return collection(/<input[^>]+type=["']?password/i.test(html)?[{}]:[]);
    if (sel.startsWith('input[name="pass"'))return collection(/<input[^>]+name=["']?(?:pass|password)/i.test(html)?[{}]:[]);
    if (sel.startsWith('tr[name='))return collection(rowPresent?[row]:[],sel);
    if (sel==="input[name='srvc']")return collection(rowPresent?[row]:[],sel);
    if (sel.includes('arcaptcha') || sel.includes('captcha_code'))
      return collection(/data-sitekey|arcaptcha|g-recaptcha|captcha_code/.test(html)?[{}]:[]);
    if(sel.startsWith('td:nth-child(')||sel.startsWith('input[name='))return collection(rowPresent?[{}]:[],sel);
    return collection([]);
  }
  return select;
}
Module._load=function(request, parent, isMain){
  if (parent && parent.filename && parent.filename.replace(/\\/g, '/').endsWith('/lib/core.js')) {
    mockCalls++;
    if (request==='cheerio')return {load:makeCheerio};
    if (request==='jalaali-js')return {isValidJalaaliDate:()=>true};
    if (request==='./http')return {safirFetch:async()=>response};
  }
  return original.call(this,request,parent,isMain);
};
let core;
try {core=require('../lib/core');} finally {Module._load=original;}
assert.ok(mockCalls >= 3, 'Critical: synthetic tests must intercept ALL core dependencies on Windows and Linux; never make live Safir requests');
const outcome = require('../public/search-outcome');
const query = { fields:{from_city:'تهران',to_city:'مشهد',date:'1405/08/04',gender:'عادی',train_number:'123'},
  passengers:[{quota_type:'بزرگسال'}],cookies:['PHPSESSID=fixture']};
function setResponse(html,opts={}) {
  response={ok:opts.status?opts.status>=200&&opts.status<300:true,status:opts.status||200,
    url:opts.url||'https://safirrail.ir/etrain/searchWagn.php',
    headers:{get:()=>null},async text(){return html;}};
}
async function check(label,html,expected,opts={}) {
  setResponse(html,opts);
  const result=await core.searchOnce(query);
  assert.equal(outcome.classify(result),expected,`${label}: ${JSON.stringify(result)}`);
  console.log('PASS '+label+' -> '+expected);
  return result;
}
(async()=>{
  await check('200 login form',`<html><form action="/fa/Login/process.php"><input type="password"></form></html>`,'session_required');
  await check('200 login redirect URL','<html>متن نامعلوم</html>','session_required',{url:'https://safirrail.ir/fa/UserAut.php'});
  await check('200 human CAPTCHA','<html><div class="arcaptcha-widget" data-sitekey="TEST"></div></html>','captcha_required');
  await check('200 CAPTCHA textual block','<html>لطفاً تأیید انسانی کنید</html>','captcha_required');
  await check('200 unknown/WAF response','<html>unknown upstream HTML</html>','unexpected');
  await check('200 foreign domain response','<html>اطلاعاتی وجود ندارد</html>','unexpected',{url:'https://other.example/'});
  await check('valid empty inventory','<html><body>اطلاعاتی وجود ندارد</body></html>','no_match');
  await check('valid zero-seat train row','<tr name="srvc">zero-seat</tr>','no_capacity');
  const found=await check('valid matching train row','<tr name="srvc">four-seats</tr>','found');
  assert.equal(found.trains[0]['شماره قطار'],'123');
  setResponse('<tr name="srvc">four-seats</tr>');
  const digits=await core.searchOnce({...query,fields:{...query.fields,train_number:'۱۲۳'}});
  assert.equal(outcome.classify(digits),'found','Persian-number filter must match ASCII-number row');
  console.log('PASS Persian-digit train-number search remains exact');
  await check('HTTP 429 throttling','rate limited','transport_error',{status:429});
  await check('HTTP 503 outage','temporary outage','transport_error',{status:503});
  console.log('PASS: searchOnce never misclassifies 200 login/challenge/unknown as no capacity');
})().catch(e=>{console.error(e);process.exitCode=1});
