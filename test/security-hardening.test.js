// Dependency-free release security regression and CI checks.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root=path.resolve(__dirname,'..');
const pkg=require('../package.json');
const manifest=require('../extension/manifest.json');
const ci=fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8');
assert.equal(pkg.version, manifest.version);
for (const m of ci.matchAll(/npm run ([a-z][a-z:-]+)/g))
  assert(pkg.scripts[m[1]],'CI script is undefined: '+m[1]);
const route=fs.readFileSync(path.join(root,'public/route.html'),'utf8');
assert(!/data\.trains\.find\([^\n]*\)\s*\|\|\s*data\.trains\[0\]/.test(route),'unsafe alternative-train fallback');
assert.match(route,/matchingTrains\.length !== 1/);
assert.match(route,/!matchingTrains\[0\]\.srvc/);
const core=fs.readFileSync(path.join(root,'lib/core.js'),'utf8');
assert.match(core,/inspectSearchPage\(htmlText, resp\.url, \$doc\)/);
assert.match(core,/inspection\.reason !== 'search_results'/);
const compose=fs.readFileSync(path.join(root,'compose.selfhost.yml'),'utf8');
assert.match(compose,/BILITFAST_HOST_MACHINE_ID_FILE/);
assert.match(compose,/\/etc\/machine-id:\/host\/etc\/machine-id:ro/);
assert(!fs.existsSync(path.join(root,'config','license-private.pem')));
console.log('PASS: CI jobs, version, strict train selection, HTML response gate, and host ID mapping');
