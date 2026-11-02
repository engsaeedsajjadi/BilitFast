#!/usr/bin/env node
'use strict';
if (process.env.BILITFAST_MIGRATE_LEGACY_INSTALLATION !== '1') {
  console.error('Requires seller authorization, backup and BILITFAST_MIGRATE_LEGACY_INSTALLATION=1');
  process.exit(1);
}
try {
  const approvalCode = process.argv[2];
  if (!approvalCode) throw new Error('Usage: node scripts/migrate-machine-binding.js <SELLER_SIGNED_BFM1_CODE>');
  const result = require('../lib/selfhost-license').migrateLegacy(approvalCode);
  console.log('Legacy installation bound to this host; original backed up to:', result.backup);
  console.log('Preserve the backup securely. Seller-signed host binding was verified.');
} catch (e) { console.error('Migration failed:', e.message); process.exitCode = 1; }
