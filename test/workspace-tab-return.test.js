'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../extension/workspace.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../extension/workspace.html'),'utf8');
let total=0;
function pass(name,condition){assert(condition,name);total++;console.log('PASS '+name)}
function setup(sourceUrl='https://agency.example/route.html?id=9'){
 const buttons={}, elements={};for(const id of ['workflow','detail','focus-site','focus-bilitfast'])elements[id]={textContent:'',addEventListener(type,fn){buttons[id]=fn}};
 const stored={bilitWorkspaceSourceTab:{tabId:14,siteTabId:100,origin:'https://agency.example'}};
 const tabs={14:{id:14,url:sourceUrl},100:{id:100,url:'https://safirrail.ir/etrain/TresV.php'}};
 const activations=[];
 const chrome={runtime:{async sendMessage(){return {stage:'awaiting-human'}}},storage:{session:{async get(key){return {[key]:stored[key]}}}},tabs:{async get(id){if(!tabs[id])throw Error('tab absent');return tabs[id]},async update(id,update){activations.push([id,update]);return tabs[id]}}};
 vm.runInNewContext(code,{document:{getElementById:id=>elements[id]},chrome,URL,Number,setInterval(){}});
 return {click:buttons,tabs,elements,activations};
}
(async()=>{
 const run=setup();
 await run.click['focus-bilitfast']();
 pass('Back button focuses the original route tab',run.activations[0][0]===14&&run.activations[0][1].active===true);
 await run.click['focus-site']();
 pass('Official button focuses only the current reservation tab',run.activations[1][0]===100&&run.activations[1][1].active===true);
 const changed=setup('https://evil.example/route.html');
 await changed.click['focus-bilitfast']();
 pass('Back button refuses navigation if original tab origin changed',changed.activations.length===0&&changed.elements.detail.textContent.includes('در دسترس نیست'));
 const gone=setup();delete gone.tabs[100];
 await gone.click['focus-site']();
 pass('Missing official tab shows clear recoverable error',gone.activations.length===0&&gone.elements.detail.textContent.includes('دوباره قطار را انتخاب'));
 pass('Both buttons are present in sidebar HTML',html.includes('id="focus-bilitfast"')&&html.includes('id="focus-site"'));
 console.log('ALL '+total+' workspace tab-return tests passed');
})().catch(err=>{console.error(err);process.exitCode=1});
