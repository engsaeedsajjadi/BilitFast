#!/usr/bin/env node
// End-to-end HTTP smoke with a disposable directory and port; NO live bookings.
'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bf-selfhost-smoke-'));
const port=30000+crypto.randomInt(18000);
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
const publicKeyPath=path.join(dir,'vendor-public.pem');
fs.writeFileSync(publicKeyPath,publicKey.export({format:'pem',type:'spki'}));
const env={...process.env,PORT:String(port),BILITFAST_DATA_DIR:dir,
 BILITFAST_SELF_HOSTED:'1',BILITFAST_MULTIUSER:'1',BILITFAST_BIND_HOST:'127.0.0.1',
 BILITFAST_ADMIN_BOOTSTRAP_SECRET:crypto.randomBytes(32).toString('hex'),
 BILITFAST_VENDOR_PUBLIC_KEY_PATH:publicKeyPath,
 BILITFAST_MASTER_KEY:crypto.randomBytes(32).toString('hex'),NODE_ENV:'production'};
const child=spawn(process.execPath,['selfhost-server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
let output=''; child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
const base='http://127.0.0.1:'+port;
async function post(endpoint,payload,token){const response=await fetch(base+endpoint,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(payload)});return {status:response.status,data:await response.json()};}
async function go(){
 let healthy=false;
 for(let i=0;i<55;i++){
  if(child.exitCode!==null) throw Error('Server exited '+child.exitCode+' '+output.slice(-1400));
  try{const r=await fetch(base+'/healthz',{signal:AbortSignal.timeout(900)});if(r.ok){healthy=true;break;}}
  catch(_){}
  await new Promise(r=>setTimeout(r,120));
 }
 assert(healthy,'Production server did not become healthy: '+output.slice(-1600));
 console.log('PASS independent Node web server started');
 const trial=await post('/api/trial',{action:'status'});
 assert.equal(trial.status,200);assert.equal(trial.data.state,'active');
 assert.match(trial.data.deviceId,/^[0-9a-f]{32}$/);
 console.log('PASS 72-hour trial and installation ID from real HTTP API');
 const noAdmin=await post('/api/activate',{code:'invalid'}); assert.equal(noAdmin.status,401);
 console.log('PASS anonymous license redemption refused');
 const boot=await post('/api/admin-users',{action:'bootstrap',username:'owner',password:crypto.randomBytes(12).toString('hex'),bootstrap_secret:env.BILITFAST_ADMIN_BOOTSTRAP_SECRET});
 assert.equal(boot.status,200,JSON.stringify(boot.data));assert(boot.data.token);
 console.log('PASS first admin provisioned securely');
 const non=await post('/api/admin-users',{action:'list'});
 assert.equal(non.status,401);
 console.log('PASS unauthenticated administration API is protected');
 const wrong=await post('/api/activate',{code:'BF1.fake.fake'},boot.data.token);
 assert.equal(wrong.status,400);
 console.log('PASS forged offline deployment code refused');
 const {createOfflineCode}=require('../lib/vendor-license');
 const signed=createOfflineCode(privateKey.export({format:'pem',type:'pkcs8'}),trial.data.deviceId);
 const activated=await post('/api/activate',{code:signed.code},boot.data.token);
 assert.equal(activated.status,200,JSON.stringify(activated.data));
 const after=await post('/api/trial',{action:'status'});
 assert.equal(after.data.state,'activated');
 console.log('PASS administrator redeemed seller-signed code via real HTTP API');
 console.log('PASS no live booking, captcha or merchant payment attempted');
 console.log('ALL 8 selfhost HTTP smoke checks passed');
}
go().catch(e=>{console.error('FAIL smoke',e);process.exitCode=1;}).finally(async()=>{
 child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)resolve();else {child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},1500).unref();}});
 fs.rmSync(dir,{recursive:true,force:true});
});
