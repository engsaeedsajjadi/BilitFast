'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/safir-connection.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/login.html'),'utf8');
assert(!html.includes('id="pair-panel"')&&!html.includes('id="pair-code"'));
assert(!source.includes('/api/cookie-sync')&&!source.includes('setInterval('));
const els={};for(const id of ['conn-state','btn-ext-sync','return-to-route']) els[id]={textContent:'',hidden:id==='return-to-route',dataset:{},addEventListener(k,f){this[k]=f}};
const events={};let stored=[];let navigation='';
const window={addEventListener(k,f){events[k]=f}};
vm.runInNewContext(source,{document:{getElementById:id=>els[id]},window,location:{search:'?return=route.html%3Fid%3D9',assign:x=>navigation=x},URLSearchParams,
 BilitFast:{getCookies:()=>stored,hasSessionCookie:a=>a.some(s=>s.startsWith('PHPSESSID='))}});
assert.equal(els['conn-state'].dataset.state,'idle');
stored=['PHPSESSID=SIMULATED'];events['bilitfast-direct-session-ready']();
assert.equal(els['conn-state'].dataset.state,'ok');
assert.equal(els['return-to-route'].hidden,false);els['return-to-route'].onclick();assert.equal(navigation,'route.html?id=9');
console.log('ALL direct browser-tab state tests passed');
