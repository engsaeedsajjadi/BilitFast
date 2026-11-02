'use strict';
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
try {
  require('./portable-init').initialize(root);
} catch (e) {
  console.error('BilitFast: '+e.message);
  process.exit(1);
}
// This local-only Windows package must not expose the server on LAN/internet.
process.env.PORT = '3000';
process.env.BILITFAST_BIND_HOST = '127.0.0.1';
// Do not allow inherited machine-id mapping to supersede the Windows OS ID.
delete process.env.BILITFAST_HOST_MACHINE_ID_FILE;
let count = 0;
const poll = setInterval(() => {
  if (++count > 80) { clearInterval(poll); return; }
  const req = http.get('http://127.0.0.1:3000/healthz', {timeout:1000}, res => {
    const good = res.statusCode === 200;
    res.resume();
    if (!good) return;
    clearInterval(poll);
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/d','/s','/c','start "" "http://127.0.0.1:3000/admin.html"'], {
        windowsHide:true, detached:true, stdio:'ignore', shell:false,
      });
      child.on('error', e => console.error('مرورگر خودکار باز نشد؛ نشانی http://127.0.0.1:3000/admin.html را باز کنید.'));
      child.unref();
    } else console.log('Admin URL: http://127.0.0.1:3000/admin.html');
  });
  req.on('error',()=>{});
  req.on('timeout',()=>req.destroy());
}, 500);
poll.unref();
console.log('BilitFast local production: http://127.0.0.1:3000');
console.log('برای توقف سرور Ctrl+C را بزنید.');
require('../selfhost-server.js');
