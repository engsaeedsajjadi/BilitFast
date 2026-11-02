'use strict';
// Regression: never infer zero seats or expired login from 24 returned rows.
// All upstream responses are synthetic and no external request is issued.
const assert = require('node:assert/strict');
const Module = require('node:module');
let activeResponse = '';
let intercepted = 0;
function cheerioStub(html) {
  const rows = [...html.matchAll(/<tr\s+name="srvc"\s+data-num="([^"]*)"\s+data-cap="([^"]*)"\s*>/g)]
    .map(m => ({ type: 'row', number: m[1], cap: m[2] }));
  function selection(items, selector) {
    const list = items || [];
    return {
      length: list.length,
      toArray(){ return list.slice(); },
      first(){ return selection(list.slice(0,1), selector); },
      each(fn){ list.forEach((item,index)=>fn(index,item));return this; },
      closest(name){ return selection(name === 'tr' ? rows : [], 'tr'); },
      find(s){ return select(s, list[0]); },
      text(){
        const item = list[0];
        if (!item) return '';
        if (selector === 'td:nth-child(3)') return item.number;
        if (selector === 'td:nth-child(9)') return item.cap;
        if (selector === 'td:nth-child(8)') return '08:30';
        if (selector === 'td:nth-child(10)') return '10000';
        if (selector === 'td:nth-child(4)') return '4 نفره';
        return '';
      },
      attr(key){
        if (key === 'value' && selector === "input[name='srvc']") return 'SERVICE123';
        return null;
      },
    };
  }
  function select(selector, scope) {
    if (selector && typeof selector === 'object') return selection([selector], 'row');
    if (selector === "tr[name='srvc']") return selection(rows, selector);
    if (selector === "input[name='srvc']") return selection(scope ? [scope] : rows, selector);
    if (String(selector).startsWith('td:nth-child(')) return selection(scope ? [scope] : [], selector);
    return selection([], selector);
  }
  return select;
}
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && parent.filename.replace(/\\/g,'/').endsWith('/lib/core.js')) {
    if (request==='cheerio') {intercepted++;return {load:cheerioStub};}
    if (request==='jalaali-js') {intercepted++;return {isValidJalaaliDate:()=>true};}
    if (request==='./http') {intercepted++;return {safirFetch:async()=>({
      ok:true, status:200, url:'https://safirrail.ir/etrain/searchWagn.php',
      headers:{get(){return null;}}, async text(){return activeResponse;},
    })};}
  }
  return load.call(this,request,parent,isMain);
};
let core;
try {core = require('../lib/core');} finally {Module._load=load;}
assert.equal(intercepted, 3, 'Synthetic dependencies MUST be intercepted; no live Safir calls');
const outcome = require('../public/search-outcome.js');
const defaultQuery = {fields:{from_city:'تهران',to_city:'مشهد',date:'1405/08/04',gender:'عادی',train_number:''},
  passengers:[{quota_type:'بزرگسال'}],cookies:['PHPSESSID=fake-local-fixture']};
function page(caps,numbers) {
  return '<html><body>'+caps.map((cap,i)=>`<tr name="srvc" data-num="${numbers?numbers[i]:100+i}" data-cap="${cap}"></tr>`).join('')+'</body></html>';
}
async function check(label,html, expected, number) {
  activeResponse=html;
  const query = {...defaultQuery, fields:{...defaultQuery.fields,train_number:number||''}};
  const res=await core.searchOnce(query);
  assert.equal(outcome.classify(res),expected,`${label}: ${JSON.stringify(res)}`);
  console.log('PASS '+label+' -> '+expected);
  return res;
}
(async()=>{
  const manyZero = await check('24 explicitly zero rows',page(Array(24).fill('۰')),'no_capacity');
  assert.match(manyZero.note,/24 ردیف/);
  assert.doesNotMatch(manyZero.note,/نشست ورود منقضی/);
  assert.equal(manyZero.diag.zeroRows,24);

  const persianPositive = await check('24 rows with Persian nonzero capacity',page(['۱۶',...Array(23).fill('۰')]),'found');
  assert.equal(persianPositive.trains[0]['ظرفیت'],16);
  assert.equal(persianPositive.diag.nonzeroRows,1);

  const unknown = await check('24 empty availability cells',page(Array(24).fill('')),'availability_unverified');
  assert.equal(unknown.diag.unknownRows,24);
  assert.doesNotMatch(unknown.note,/موجودی همه صفر|منقضی شده/);

  const mixed = await check('mixed zero and unreadable cells',page(['۰', 'نامشخص', ...Array(22).fill('تکمیل')]),'availability_unverified');
  assert.equal(mixed.diag.unknownRows,1);
  assert.equal(mixed.diag.zeroRows,23);

  const other = await check('other trains available, requested train absent',page(['۴', ...Array(23).fill('۰')]),'no_match','9999');
  assert.match(other.note,/9999/);
  assert.doesNotMatch(other.note,/همه صفر|نشست ورود منقضی/);

  const targeted = await check('requested train zero while others available',page(['۴', '۰'], ['777','123']),'no_capacity','123');
  assert.equal(targeted.diag.totalRows,2);
  assert.equal(targeted.diag.matchingRows,1);
  assert.equal(targeted.diag.zeroRows,1);

  const ambiguousNumber = await check('unreadable train number',page(['۴'], ['']),'availability_unverified','123');
  assert.equal(ambiguousNumber.diag.unknownTrainNumberRows,1);

  activeResponse=page(Array(24).fill('۰'));
  const noLoginCookie = await core.searchOnce({...defaultQuery,cookies:[]});
  assert.notEqual(outcome.classify(noLoginCookie),'session_required');
  assert.doesNotMatch(noLoginCookie.note,/نشست ورود منقضی شده/);

  assert.deepEqual(core.parseCapacityInfo('ظرفیت: ۲'),{known:true,capacity:2});
  assert.deepEqual(core.parseCapacityInfo('۰'),{known:true,capacity:0});
  assert.deepEqual(core.parseCapacityInfo('تکمیل'),{known:true,capacity:0});
  assert.deepEqual(core.parseCapacityInfo('—'),{known:false,capacity:null});
  assert.deepEqual(core.parseCapacityInfo(''),{known:false,capacity:null});
  console.log('PASS: inventory text is evidence-based; session uncertainty is not reported as expiration');
})().catch(err=>{console.error(err);process.exitCode=1;});
