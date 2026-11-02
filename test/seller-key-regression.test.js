// Seller signing keys must never be recreated silently or shipped to clients.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bf-vendor-keys-'));
const originalPub=process.env.BILITFAST_VENDOR_PUBLIC_KEY_PATH;
try {
  const privatePath=path.join(tmp,'seller-private.pem');
  const pub=path.join(tmp,'seller-public.pem');
  const env={...process.env,BILITFAST_VENDOR_PRIVATE_KEY_PATH:privatePath,
    BILITFAST_VENDOR_PUBLIC_KEY_PATH:pub};
  const run=(...args)=>spawnSync(process.execPath,['scripts/license-admin.js',...args],{cwd:root,env,encoding:'utf8'});
  // If first-party public is absent, seller admin still must NOT silently regenerate keys.
  let r=run('init');
  assert.notEqual(r.status,0,'silent new signing key would invalidate existing codes');
  assert(!fs.existsSync(privatePath));
  const {privateKey}=crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(privatePath,privateKey.export({format:'pem',type:'pkcs8'}));
  // This script's public path is fixed by design: run inside throwaway copy so
  // a local test never writes into the source project's release config.
  process.env.BILITFAST_VENDOR_PUBLIC_KEY_PATH=pub;
  const vendor=require('../lib/vendor-license');
  const {createOfflineCode,verifyOfflineCode}=vendor;
  fs.writeFileSync(pub,crypto.createPublicKey(fs.readFileSync(privatePath)).export({format:'pem',type:'spki'}));
  const identity='a'.repeat(32);
  const {code}=createOfflineCode(fs.readFileSync(privatePath,'utf8'),identity);
  assert.equal(verifyOfflineCode(code,identity).ok,true);
  assert.equal(verifyOfflineCode(code,'b'.repeat(32)).ok,false);
  // With the right public key present, a release preflight passes, but without
  // shipping the private key. The default project preflight remains NO-GO.
  r=spawnSync(process.execPath,['scripts/delivery-preflight.js'],{cwd:root,env,encoding:'utf8'});
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
  console.log('PASS: seller identity is never silently regenerated and signed codes are device-bound');
  console.log('PASS: delivery preflight succeeds with existing Ed25519 public key in seller staging');
} finally {
  if (originalPub === undefined) delete process.env.BILITFAST_VENDOR_PUBLIC_KEY_PATH;
  else process.env.BILITFAST_VENDOR_PUBLIC_KEY_PATH=originalPub;
  fs.rmSync(tmp,{recursive:true,force:true});
}
