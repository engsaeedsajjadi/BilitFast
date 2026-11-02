#!/usr/bin/env node
// Run on the seller's release staging copy; never ship the private key.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname,'..');
const problems = [];
const pkg = require('../package.json');
const extension = require('../extension/manifest.json');
if (pkg.version !== extension.version) problems.push('Extension version differs from package version.');
const pub = require('../lib/vendor-license').publicKeyPath();
if (!fs.existsSync(pub)) problems.push('Vendor PUBLIC key is absent: restore config/license-public.pem from the existing seller private key.');
else {
  try {
    const key = crypto.createPublicKey(fs.readFileSync(pub));
    if (key.asymmetricKeyType !== 'ed25519') problems.push('Vendor public key must be Ed25519.');
  } catch (e) { problems.push('Vendor public key is unreadable/invalid.'); }
}
const forbidden = [
  'config/license-private.pem','config/vendor-private.pem','vendor-private.pem',
  '.env','data/installation.json','data/db.json',
];
for (const rel of forbidden) if (fs.existsSync(path.join(root, rel)))
  problems.push('Sensitive/local deployment file found inside source folder: ' + rel + ' (do not package it).');
if (problems.length) {
  for (const message of problems) console.error('FAIL:',message);
  console.error('Delivery preflight failed. No release approval.');
  process.exit(1);
}
console.log('PASS: public signing key available, version aligned, no known sensitive files in source root.');
console.log('Still required: real customer browser, actual SafirRail session, and payment-stage UAT.');
