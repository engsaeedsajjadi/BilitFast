// Deployment host identity for offline-license copy detection.
// This is a deterrent, not tamper-proof DRM on a buyer-controlled server.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function machineIdentity() {
  let raw = '';
  const overrideFile = process.env.BILITFAST_HOST_MACHINE_ID_FILE;
  if (overrideFile) {
    // Explicit host mapping: do not silently fall back to container identity.
    raw = fs.readFileSync(overrideFile, 'utf8').trim();
  } else if (process.platform === 'linux') {
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try { raw = fs.readFileSync(file, 'utf8').trim(); if (raw) break; } catch (_) { /* next */ }
    }
  } else if (process.platform === 'win32') {
    const stdout = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const match = stdout.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
    raw = match ? match[1].trim() : '';
  } else if (process.platform === 'darwin') {
    const stdout = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'],
      { encoding: 'utf8', timeout: 5000 });
    const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    raw = match ? match[1].trim() : '';
  }
  if (!raw || /^0+$/.test(raw) || raw.length > 256) {
    throw new Error('شناسه قابل اتکای میزبان در دسترس نیست؛ نصب یا نگاشت host machine-id را بررسی کنید.');
  }
  // Store only the fingerprint, never the raw host machine identifier.
  return crypto.createHash('sha256').update('bilitfast-machine-binding-v1\0' + os.platform() + '\0' + raw).digest('hex');
}
module.exports = { machineIdentity };
