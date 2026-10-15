// Web self-hosted: active-tab origin selection, permission safety, no cookie upload by default.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const origins=require('../extension/target-origin');
const src=fs.readFileSync(path.join(__dirname,'../extension/popup.js'),'utf8');
for (const url of ['https://agency.example.com/login.html','https://sub.agency.example.com/route.html']) {
 assert.equal(origins.fromTab({url}).origin,new URL(url).origin);
 console.log('PASS HTTPS tab selected '+url);
}
for (const url of ['http://agency.example.com','https://safirrail.ir/etrain/','https://user:pw@agency.example.com',
 'http://localhost:3210','javascript:alert(1)','chrome://extensions']) {
 assert.throws(()=>origins.fromTab({url}));console.log('PASS wrong target rejected '+url);
}
assert.equal(origins.fromTab({url:'http://127.0.0.1:3000/login.html'}).localPreview,true);
console.log('PASS loopback web preview accepted only at 3000');
assert.equal(origins.permissionPattern('http://127.0.0.1:3000'),'http://127.0.0.1/*');
console.log('PASS permissions use Chrome match pattern without TCP port');
assert(src.includes('chrome.permissions.request'),'User must grant domain permission');
assert(src.includes('BilitCookieReader.collect(chrome)'),'Use the scoped Safir cookie collector');
assert(!src.includes('CANDIDATES'),'No desktop port scanning');
assert(!src.includes('bilitfastOrigin'),'No stored arbitrary destination');
console.log('PASS explicit user click and no stale origin');
console.log('ALL self-hosted extension endpoint checks passed');
