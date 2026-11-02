#!/usr/bin/env node
// Run ONLY on the software seller's computer. Do not distribute private keys.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createOfflineCode, createMigrationCode } = require('../lib/vendor-license');
const root = path.join(__dirname, '..');
const privatePath = process.env.BILITFAST_VENDOR_PRIVATE_KEY_PATH ||
  path.join(os.homedir(), '.bilitfast-seller', 'vendor-private.pem');
const publicPath = path.join(root, 'config', 'license-public.pem');
const [command, arg, flag, daysArg] = process.argv.slice(2);
function run() {
  if (command === 'init' || command === 'init-new') {
    const privateExists = fs.existsSync(privatePath);
    const publicExists = fs.existsSync(publicPath);
    if (publicExists && !privateExists) {
      throw new Error('The public key exists, but the seller private key is missing. Restore your private key backup.');
    }
    if (!privateExists && command === 'init') {
      throw new Error('Existing seller private key not found. Restore it; do not silently rotate signing keys. A first-ever seller may deliberately run init-new with BILITFAST_ALLOW_NEW_VENDOR_KEY=1.');
    }
    if (!privateExists && command === 'init-new' && process.env.BILITFAST_ALLOW_NEW_VENDOR_KEY !== '1') {
      throw new Error('Creating a NEW signing identity requires BILITFAST_ALLOW_NEW_VENDOR_KEY=1 and init-new. Old activation codes will not work with this key.');
    }
    fs.mkdirSync(path.dirname(privatePath), { recursive: true });
    fs.mkdirSync(path.dirname(publicPath), { recursive: true });
    if (privateExists) {
      // A new source ZIP does not contain the public key. Always restore the
      // SAME vendor public key from the seller's existing private key.
      const privatePem = fs.readFileSync(privatePath, 'utf8');
      const matchingPublic = crypto.createPublicKey(privatePem).export({ format: 'pem', type: 'spki' });
      if (publicExists) {
        if (fs.readFileSync(publicPath, 'utf8') !== matchingPublic) {
          throw new Error('Vendor public key does not match the existing private key; refusing to replace it.');
        }
        console.log('Existing vendor keys verified; nothing overwritten.');
      } else {
        fs.writeFileSync(publicPath, matchingPublic, { flag: 'wx' });
        console.log('Vendor public key restored from existing seller private key.');
      }
    } else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      fs.writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(publicPath, publicKey.export({ format: 'pem', type: 'spki' }), { flag: 'wx' });
      console.log('New vendor signing key pair created.');
    }
    console.log('Public key ready: config/license-public.pem');
    console.log('PRIVATE KEY (seller only):', privatePath);
    console.log('Never distribute this key. Back it up securely outside the project.');
    return;
  }
  if (command === 'issue-migration') {
    const hostHash = flag;
    const expiryFlag = daysArg;
    const expiry = process.argv[6];
    if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath))
      throw new Error('Restore seller key pair first (init).');
    const pem = fs.readFileSync(privatePath, 'utf8');
    const publicPem = fs.readFileSync(publicPath, 'utf8');
    const derived = crypto.createPublicKey(pem).export({format:'pem',type:'spki'});
    if (derived !== publicPem) throw new Error('Existing seller keys do not match.');
    if (expiryFlag && expiryFlag !== '--days') throw new Error('Usage: issue-migration <DEVICE_ID> <HOST_HASH> [--days 7]');
    const issued = createMigrationCode(pem, arg, hostHash, {redeemDays: expiry === undefined ? 7 : Number(expiry)});
    console.log('Seller-approved migration code for:', arg);
    console.log('Host hash:', hostHash);
    console.log('Migration code:\n' + issued.code);
    return;
  }
  if (command === 'issue') {
    if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) {
      throw new Error('Run node scripts/license-admin.js init before issuing codes.');
    }
    const privatePem = fs.readFileSync(privatePath, 'utf8');
    const publicPem = fs.readFileSync(publicPath, 'utf8');
    const derived = crypto.createPublicKey(privatePem).export({ format: 'pem', type: 'spki' });
    if (derived !== publicPem) throw new Error('Public/private keys do not match.');
    if (flag && flag !== '--days') throw new Error('Only --days N is supported');
    const { code, payload } = createOfflineCode(privatePem, arg, { redeemDays: daysArg === undefined ? 30 : Number(daysArg) });
    console.log('License ID:', payload.licenseId);
    console.log('Device ID:', payload.deviceId);
    console.log('Redeem before:', new Date(payload.redeemBy).toISOString());
    console.log('Permanent activation code:\n' + code);
    return;
  }
  console.log('Usage:\n  node scripts/license-admin.js init   # restore PUBLIC key from existing PRIVATE key\n  BILITFAST_ALLOW_NEW_VENDOR_KEY=1 node scripts/license-admin.js init-new  # first-time seller only\n  node scripts/license-admin.js issue <DEVICE_ID> [--days 30]\n  node scripts/license-admin.js issue-migration <DEVICE_ID> <HOST_HASH> [--days 7]');
  if (command) process.exitCode = 1;
}
try { run(); } catch (e) { console.error('ERROR:', e.message); process.exitCode = 1; }
