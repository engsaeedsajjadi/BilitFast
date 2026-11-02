'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { initialize } = require('../scripts/portable-init');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bilit-portable-test-'));
try {
  fs.mkdirSync(path.join(temp, 'config'));
  const kp = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(temp,'config/license-public.pem'), kp.publicKey.export({format:'pem',type:'spki'}));
  let seen = [];
  const r1 = initialize(temp, x=>seen.push(x));
  assert.equal(r1.firstRun, true);
  const envBefore = fs.readFileSync(r1.envPath,'utf8');
  assert.match(envBefore,/^BILITFAST_MASTER_KEY=[a-f0-9]{64}$/m);
  assert.match(envBefore,/^BILITFAST_BIND_HOST=127\.0\.0\.1$/m);
  assert.ok(seen.some(x=>/^[a-f0-9]{64}$/.test(x)));
  seen=[];
  const r2 = initialize(temp,x=>seen.push(x));
  assert.equal(r2.firstRun,false);
  assert.equal(fs.readFileSync(r1.envPath,'utf8'),envBefore);
  fs.rmSync(r1.envPath);
  fs.writeFileSync(path.join(temp,'data','installation.json'),'{}');
  assert.throws(()=>initialize(temp,()=>{}),/نسخه پشتیبان/);
  console.log('PASS portable: first-run keys, restart persistence, localhost binding and no silent reinit after lost .env');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
