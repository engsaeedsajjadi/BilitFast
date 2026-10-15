// No network, no npm dependencies, no real customer data or keys.
'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bilitfast-selfhost-test-'));
const envBefore={...process.env};
process.env.BILITFAST_SELF_HOSTED='1';
process.env.BILITFAST_DATA_DIR=tmp;
process.env.BILITFAST_MASTER_KEY=crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV='production';
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
const privatePem=privateKey.export({format:'pem',type:'pkcs8'});
const pub=path.join(tmp,'license-public.pem');
fs.writeFileSync(pub,publicKey.export({format:'pem',type:'spki'}));
process.env.BILITFAST_VENDOR_PUBLIC_KEY_PATH=pub;
const license=require('../lib/selfhost-license');
const {createOfflineCode}=require('../lib/vendor-license');
const gate=require('../lib/license');
const tests=[];
function check(label,fn){fn();tests.push(label);console.log('PASS '+label);}
(async()=>{
 try {
  check('Installation has stable random ID and 72-hour trial',()=>{
    const inst=license.initial();
    assert.match(inst.instanceId,/^[0-9a-f]{32}$/);
    assert.equal(license.status().state,'active');
    assert.equal(license.status().trialDays,3);
    assert.equal(license.initial().instanceId,inst.instanceId);
    assert.equal(gate.checkAccess({user:{license_activated:false}}).allowed,true);
  });
  check('Trial survives a fresh Node process',()=>{
    const script="process.stdout.write(require('./lib/selfhost-license').initial().instanceId)";
    const out=spawnSync(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),env:process.env,encoding:'utf8'});
    assert.equal(out.status,0,out.stderr);
    assert.equal(out.stdout,license.read().instanceId);
  });
  check('Trial expiration gates search even for a locally licensed account',()=>{
    const install=license.read();
    install.installedAt=new Date(Date.now()-73*3600000).toISOString();
    fs.writeFileSync(license.filePath(),JSON.stringify(install));
    assert.equal(license.status().state,'expired');
    assert.equal(gate.checkAccess({user:{license_activated:true}}).allowed,false);
  });
  check('Wrong instance and forged signatures are rejected',()=>{
    const own=license.read().instanceId;
    const wrong=createOfflineCode(privatePem,crypto.randomBytes(16).toString('hex'));
    assert.equal(license.redeem(wrong.code).ok,false);
    const good=createOfflineCode(privatePem,own);
    assert.equal(license.redeem(good.code.slice(0,-5)+'abcde').ok,false);
  });
  check('Seller signed offline activation is permanent and installation-bound',()=>{
    const r=createOfflineCode(privatePem,license.read().instanceId,{redeemDays:1});
    assert.equal(license.redeem(r.code).ok,true);
    assert.equal(license.status().state,'activated');
    assert.equal(gate.checkAccess({user:{license_activated:false}}).allowed,true);
    assert.equal(license.redeem(r.code).ok,false);
    const record=license.read();
    assert.equal(record.license.licenseId,r.payload.licenseId);
    assert.equal(require('../lib/vendor-license').verifyOfflineCode(r.code,record.instanceId,{alreadyRedeemed:true}).ok,true);
  });
  check('Activation remains valid after backend restart',()=>{
    const r=spawnSync(process.execPath,['-e',"process.stdout.write(require('./lib/selfhost-license').status().state)"],
      {cwd:path.join(__dirname,'..'),env:process.env,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'activated');
  });
  check('Corrupted installation is not silently reset',()=>{
    const good=fs.readFileSync(license.filePath(),'utf8');
    fs.writeFileSync(license.filePath(),'not-json');
    assert.throws(()=>license.initial(),/نصب وب/);
    fs.writeFileSync(license.filePath(),good);
  });
  check('Production activation API requires administrator session',async()=>{
    const api=require('../api/activate');
    function call(body,headers={}) {return new Promise(resolve=>{
      const res={code:200,status(n){this.code=n;return this;},json(x){resolve({code:this.code,...x});return this;}};
      api({method:'POST',body:JSON.stringify(body),headers,socket:{remoteAddress:'127.0.0.1'}},res);
    });}
    const unauth=await call({code:'BF1.bad.bad'});
    assert.equal(unauth.code,401);
  });
  check('Dedicated seller setup refuses weak domains and overwrites',()=>{
    const root=path.join(tmp,'setup-test');fs.mkdirSync(path.join(root,'scripts'),{recursive:true});
    fs.copyFileSync(path.join(__dirname,'../scripts/setup-selfhost.js'),path.join(root,'scripts/setup-selfhost.js'));
    const run=(d)=>spawnSync(process.execPath,[path.join(root,'scripts/setup-selfhost.js'),d],{encoding:'utf8'});
    assert.notEqual(run('http://evil.example').status,0);
    assert.equal(run('agency.example.com').status,0);
    assert.notEqual(run('agency.example.com').status,0);
    assert.match(fs.readFileSync(path.join(root,'.env'),'utf8'),/BILITFAST_MASTER_KEY=[a-f0-9]{64}/);
    assert(!fs.readFileSync(path.join(root,'.env'),'utf8').includes('BILITFAST_VENDOR_PRIVATE_KEY'));
  });
  check('Web extension requires HTTPS for customers and restricts local preview to loopback port 3000',()=>{
    const src=fs.readFileSync(path.join(__dirname,'../extension/popup.js'),'utf8');
    const origin=require('../extension/target-origin');
    assert(!src.includes('CANDIDATES'));
    assert(src.includes('permissions.request'));
    assert.throws(()=>origin.fromTab({url:'http://agency.example.com/'}));
    assert.throws(()=>origin.fromTab({url:'http://localhost:3210/'}));
    assert.equal(origin.fromTab({url:'https://agency.example.com/login.html'}).origin,'https://agency.example.com');
    assert.equal(origin.fromTab({url:'http://127.0.0.1:3000/login.html'}).localPreview,true);
    assert(src.includes('BilitCookieReader.collect(chrome)'));
  });
  console.log(`ALL ${tests.length} self-hosted web checks passed`);
 }finally{
   for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
   for (const [k,v] of Object.entries(envBefore)) process.env[k]=v;
   fs.rmSync(tmp,{recursive:true,force:true});
 }
})().catch(e=>{console.error('FAIL selfhost-web',e);process.exitCode=1;});
