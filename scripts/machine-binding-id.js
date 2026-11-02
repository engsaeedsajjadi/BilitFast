#!/usr/bin/env node
// Use before migrating an old v1 install. Share only the printed IDs with seller.
'use strict';
try {
  const fs=require('node:fs');
  const {filePath}=require('../lib/selfhost-license');
  const {machineIdentity}=require('../lib/host-machine');
  const record=JSON.parse(fs.readFileSync(filePath(),'utf8'));
  if(!/^[a-f0-9]{32}$/.test(record.instanceId||'')) throw new Error('Bad installation record');
  console.log('Installation ID:',record.instanceId);
  console.log('Target host hash:',machineIdentity());
  console.log('Provide these two values to the seller for a signed BFM1 migration code.');
} catch(e){console.error('Cannot calculate migration IDs:',e.message);process.exitCode=1;}
