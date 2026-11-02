'use strict';
// Isolated production-like regression: no real customer data or network.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const vm=require('node:vm');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bf-owner-only-'));
const savedEnv={...process.env};
process.env.BILITFAST_SINGLE_USER='1';
process.env.BILITFAST_SELF_HOSTED='1';
process.env.BILITFAST_MULTIUSER='1';
process.env.BILITFAST_DATA_DIR=tmp;
process.env.BILITFAST_MASTER_KEY=crypto.randomBytes(32).toString('hex');
process.env.BILITFAST_ADMIN_BOOTSTRAP_SECRET=crypto.randomBytes(32).toString('hex');
// These tests use the same dedicated keys as a production installation.
const db=require('../lib/db');const auth=require('../lib/auth');
const gate=require('../lib/apiauth');const single=require('../lib/single-user');
const adminApi=require('../api/admin-users');const authApi=require('../api/auth');
function mockReq(action,body={},token='') {
 return {method:'POST',body:{action,...body},headers:token?{authorization:'Bearer '+token}:{},socket:{remoteAddress:'127.0.0.1'}};
}
function mockRes() {return {code:200,data:null,status(n){this.code=n;return this;},json(o){this.data=o;return this;}};}
async function call(api,req) {const res=mockRes(); await api(req,res);return res;}
(async()=>{
 try {
  assert(single.enabled());
  assert.equal(auth.registerUser('shortpass','1234567890').ok,false);
  let r=await call(authApi,mockReq('register',{username:'second',password:'longpassword'}));
  assert.equal(r.code,403);
  r=await call(adminApi,mockReq('bootstrap',{username:'owner',password:'ownerpass123',bootstrap_secret:'bad'}));
  assert.equal(r.code,403);
  r=await call(adminApi,mockReq('bootstrap',{username:'owner',password:'ownerpass123',bootstrap_secret:process.env.BILITFAST_ADMIN_BOOTSTRAP_SECRET}));
  assert.equal(r.code,200,JSON.stringify(r.data));
  assert(r.data.token);const token=r.data.token;const ownerId=r.data.user.id;
  assert.equal(db.find('users',()=>true).length,1);
  console.log('PASS only a secret-authorized first owner can be created');
  r=await call(adminApi,mockReq('bootstrap',{username:'other',password:'otherpass123',bootstrap_secret:process.env.BILITFAST_ADMIN_BOOTSTRAP_SECRET}));
  assert.equal(r.code,403);
  assert.equal(auth.registerUser('other','otherpass123').ok,false);
  r=await call(adminApi,mockReq('create',{username:'other',password:'otherpass123'},token));
  assert.equal(r.code,403);
  r=await call(adminApi,mockReq('delete',{id:ownerId},token));
  assert.equal(r.code,403);
  r=await call(adminApi,mockReq('list',{},token));
  assert.equal(r.code,200);assert.equal(r.data.users.length,1);
  console.log('PASS second accounts and user-management mutations rejected');
  r=await call(authApi,mockReq('register',{username:'third',password:'anotherlongpass'}));
  assert.equal(r.code,403);
  r=await call(authApi,mockReq('import-local',{cookies:['PHPSESSID=EXAMPLE-SESSION'],routes:[]},token));
  assert.equal(r.code,200);
  assert.equal(db.findById('users',ownerId).safir_cookies,undefined);
  r=await call(authApi,mockReq('export-local',{},token));
  assert.deepEqual(r.data.cookies,[]);
  const denied=mockRes();assert.equal(gate.requireUser(mockReq('me'),denied,{}).ok,false);
  assert.equal(denied.code,401);
  console.log('PASS owner authentication is mandatory and session cookies are not imported into plaintext user records');
  const secondLogin=auth.loginUser('owner','ownerpass123');
  assert(secondLogin.ok);
  assert.equal(auth.verifySession(token),null,'previous login must become inactive');
  assert(auth.verifySession(secondLogin.token));
  console.log('PASS only the newest owner login has an active session');
  const key='0123456789-SECRET-PII';
  db.insert('bookings',{secret:key, owner_id:ownerId});
  const disk=fs.readFileSync(path.join(tmp,'db.json'),'utf8');
  assert(!disk.includes(key));assert(!disk.includes('ownerpass123'));assert(disk.includes('bilitfast-db-gcm-v1'));
  const inspect=spawnSync(process.execPath,['-e',"const x=require('./lib/db').find('bookings',()=>true);process.stdout.write(x[0].secret)"],{cwd:path.resolve(__dirname,'..'),env:process.env,encoding:'utf8'});
  assert.equal(inspect.status,0,inspect.stderr);assert.equal(inspect.stdout,key);
  const bad=spawnSync(process.execPath,['-e',"require('./lib/db').find('users',()=>true)"],{cwd:path.resolve(__dirname,'..'),env:{...process.env,BILITFAST_MASTER_KEY:crypto.randomBytes(32).toString('hex')},encoding:'utf8'});
  assert.notEqual(bad.status,0);
  console.log('PASS encrypted DB persists across restarts and fails closed with wrong key');
  const legacyDir=fs.mkdtempSync(path.join(os.tmpdir(),'bf-legacy-upgrade-'));
  try {
    fs.writeFileSync(path.join(legacyDir,'db.json'),JSON.stringify({users:[],bookings:[{id:'legacy',reference:'LEGACY-MIGRATE-TEST'}]}));
    const upgraded=spawnSync(process.execPath,['-e',
      "const d=require('./lib/db');process.stdout.write(d.find('bookings',()=>true)[0].reference)"],
      {cwd:path.resolve(__dirname,'..'),env:{...process.env,BILITFAST_DATA_DIR:legacyDir},encoding:'utf8'});
    assert.equal(upgraded.status,0,upgraded.stderr);
    assert.equal(upgraded.stdout,'LEGACY-MIGRATE-TEST');
    const migrated=fs.readFileSync(path.join(legacyDir,'db.json'),'utf8');
    assert(migrated.includes('bilitfast-db-gcm-v1'));
    assert(!migrated.includes('LEGACY-MIGRATE-TEST'));
  }finally{fs.rmSync(legacyDir,{recursive:true,force:true});}
  console.log('PASS existing plaintext single-owner databases migrate atomically without losing records');

  // A failed filesystem rename must be surfaced; no record may appear saved.
  const original=fs.renameSync;
  fs.renameSync=()=>{throw Error('simulated disk failure')};
  try {assert.throws(()=>db.insert('bookings',{secret:'should-not-persist'}),/ذخیره داده/);} finally {fs.renameSync=original;}
  assert.equal(db.find('bookings',x=>x.secret==='should-not-persist').length,0);
  console.log('PASS database write failures never return false success');
  db.insert('users',{username:'legacy_other',role:'user',pass:auth.hashPassword('anypass')});
  assert.equal(single.state().ok,false);
  assert(!single.isOwner(db.findById('users',ownerId)));
  console.log('PASS legacy multi-account DB is not silently migrated/deleted');
  // Sensitive local data cannot fall back to plaintext storage.
  const source=fs.readFileSync(path.resolve(__dirname,'../public/secure-store.js'),'utf8');
  const writes=[];const window={crypto:null,indexedDB:null,localStorage:{setItem:(...a)=>writes.push(a)}};
  window.window=window;
  vm.runInNewContext(source,{window});
  let rejected=false;
  try {await window.BilitSecureStore.setItem('bilitfast_passenger_profiles','sensitive');}catch(e){rejected=true;}
  assert(rejected);assert.equal(writes.length,0);
  console.log('PASS browser encryption absence never writes plaintext passenger records');
  console.log('ALL 9 single-owner production safety checks passed');
 }finally{fs.rmSync(tmp,{recursive:true,force:true});Object.keys(process.env).forEach(k=>{if(!(k in savedEnv))delete process.env[k]});Object.assign(process.env,savedEnv);}
})().catch(e=>{console.error(e);process.exitCode=1;});
