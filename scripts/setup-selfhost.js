#!/usr/bin/env node
// Prepare customer-owned deployment configuration. Never reissue keys on restart.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.join(__dirname,'..'),target=path.join(root,'.env');
if(fs.existsSync(target)) { console.error('.env already exists: refusing to overwrite customer secrets.');process.exit(1); }
const domain=(process.argv[2]||'').trim().toLowerCase();
if(!/^(?=.{3,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) || domain.endsWith('.local')) {
 console.error('Usage: node scripts/setup-selfhost.js agency.example.com');process.exit(1);
}
const hex=()=>crypto.randomBytes(32).toString('hex');
const content=[
 'NODE_ENV=production','PORT=3000','BILITFAST_DOMAIN='+domain,
 'BILITFAST_SELF_HOSTED=1','BILITFAST_DATA_DIR=/data',
 'BILITFAST_MASTER_KEY='+hex(),
 'BILITFAST_ADMIN_BOOTSTRAP_SECRET='+hex(),
 'BILITFAST_MULTIUSER=1','BILITFAST_ENFORCE_SECURITY=1',
 'BILITFAST_ENFORCE_LICENSE=1',
 'BILITFAST_ALLOWED_ORIGINS=',
].join('\n')+'\n';
fs.writeFileSync(target,content,{flag:'wx',mode:0o600});
console.log('Created .env for '+domain+'. Keep it secret and back it up with customer data.');
console.log('Open https://'+domain+' after DNS and HTTPS are configured; bootstrap admin at /admin.html.');
