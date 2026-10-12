// Local Electron key store: create separate persistent keys for the server
// and desktop process, rather than unrelated ephemeral keys on each launch.
// File permissions restrict casual access; this is NOT a tamper-proof DRM key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FIELDS = [
  'BILITFAST_SESSION_KEY',
  'BILITFAST_LICENSE_KEY',
  'BILITFAST_TOKEN_KEY',
  'BILITFAST_INSTALL_KEY',
];
function readOrCreateKeys(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const filePath = path.join(userDataDir, 'local-keys.json');
  if (!fs.existsSync(filePath)) {
    const values = Object.fromEntries(FIELDS.map(name => [name, crypto.randomBytes(32).toString('hex')]));
    try {
      fs.writeFileSync(filePath, JSON.stringify(values), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }
  }
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  for (const name of FIELDS) {
    if (!/^[a-f0-9]{64}$/.test(doc[name] || '')) {
      throw new Error('Invalid local key store. Restore a valid backup before starting BilitFast.');
    }
  }
  return doc;
}
module.exports = { readOrCreateKeys };
