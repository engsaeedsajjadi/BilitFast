'use strict';
// End-to-end browser storage/start race regression. No Safir network or customer data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const disk = new Map();
const keys = new Map();
const delays = [];
const indexedDB = {
  open() {
    const op = {};
    queueMicrotask(() => {
      op.result = {
        objectStoreNames: {contains: () => true},
        createObjectStore() {},
        transaction() {return {objectStore() {return {
          get(k) { const r={}; queueMicrotask(()=>{r.result=keys.get(k);r.onsuccess();});return r; },
          put(v,k) { const r={}; queueMicrotask(()=>{keys.set(k,v);r.onsuccess();});return r; },
        };}};},
      };
      op.onsuccess();
    });
    return op;
  },
};
const localStorage = {
  getItem(k) {return disk.get(k) ?? null;},
  setItem(k, v) {disk.set(k, v);},
  removeItem(k) {disk.delete(k);},
};
const crypto = {
  getRandomValues: (...a) => webcrypto.getRandomValues(...a),
  subtle: {
    generateKey: (...a) => webcrypto.subtle.generateKey(...a),
    encrypt: async (...a) => {
      const delay = delays.shift() || 0;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return webcrypto.subtle.encrypt(...a);
    },
    decrypt: (...a) => webcrypto.subtle.decrypt(...a),
  },
};
const events = {};
const document = {readyState:'loading', addEventListener(k,fn) {events[k]=fn;}, dispatchEvent() {}};
const ctx = {window:null, document, crypto, indexedDB, localStorage,
  sessionStorage:{getItem:()=>null,removeItem:()=>{}},
  navigator:{}, location:{protocol:'https:'}, setTimeout,clearTimeout,
  TextEncoder, TextDecoder, Uint8Array, btoa, atob, console, CustomEvent:class CustomEvent{}};
ctx.window=ctx;
const root=path.resolve(__dirname,'..');
vm.runInNewContext(fs.readFileSync(path.join(root,'public/secure-store.js'),'utf8'),ctx);
vm.runInNewContext(fs.readFileSync(path.join(root,'public/app.js'),'utf8')+'\nthis.bf = BilitFast;',ctx);

(async function main(){
  await ctx.bf.whenStorageReady();
  ctx.bf.upsertRoute({id:42,fields:{from_city:'Sample'},running:false,passengers:[]});
  await ctx.bf.flushStorage();
  assert.equal(ctx.bf.getRoute(42).running,false);
  // Simulate a slow encryption taking longer than the immediate first attempt.
  delays.push(80, 1);
  ctx.bf.upsertRoute({...ctx.bf.getRoute(42),running:true});
  assert.equal(ctx.bf.getRoute(42).running,true,
    'First search attempt must read running=true immediately, not the old encrypted cache');
  ctx.bf.upsertRoute({...ctx.bf.getRoute(42),status:'first attempt sent'});
  assert.equal(ctx.bf.getRoute(42).status,'first attempt sent');
  await ctx.bf.flushStorage();
  const ciphertext=disk.get('bilitfast_routes');
  assert.match(ciphertext,/^enc1:/);
  assert(!ciphertext.includes('first attempt sent'));
  const plaintext=await ctx.BilitSecureStore.decrypt(ciphertext);
  const stored=JSON.parse(plaintext);
  assert.equal(stored[0].running,true);
  assert.equal(stored[0].status,'first attempt sent',
    'Concurrent writes must never let an older encrypted route overwrite a newer one');
  console.log('PASS: start-search running=true visible to the first immediate poll');
  console.log('PASS: concurrent writes persist the latest encrypted route in order');
  console.log('PASS: no plaintext route data written to localStorage');
  // Guard route UI contract; no deceptive status-only patch in lieu of actual fix.
  const route=fs.readFileSync(path.join(root,'public/route.html'),'utf8');
  assert.match(route,/saveRouteState\(\{ fields: f, passengers, running: true,/);
  assert.match(route,/function startPolling\(\)/);
  assert.match(route,/function doOneAttempt\(\)/);
  console.log('PASS: original start/search functions remain wired');
})().catch(err=>{console.error(err);process.exitCode=1;});
