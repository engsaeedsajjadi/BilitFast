'use strict';
// End-to-end through searchOnce with a synthetic SafirRail response (no network).
const assert = require('node:assert/strict');
const Module = require('node:module');
const dep = require('../lib/departure');
let body = '';
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename.replace(/\\/g, '/').endsWith('/lib/core.js') && request === './http') {
    return { safirFetch: async () => ({ ok: true, status: 200, url: 'https://safirrail.ir/etrain/searchWagn.php',
      headers: { get() { return null; } }, async text() { return body; } }) };
  }
  return load.call(this, request, parent, isMain);
};
let core; try { core = require('../lib/core'); } finally { Module._load = load; }

const n = dep.tehranNow();
const pad = (x) => String(x).padStart(2, '0');
const today = n.jy + '/' + pad(n.jm) + '/' + pad(n.jd);
function row(num, date, time, cap) {
  return `<tr name="srvc"><td>c</td><td><div>co</div></td><td>${num}</td><td>کوپه</td><td></td><td></td>` +
    `<td>${date}</td><td>${time}</td><td>${cap}</td><td>1,000,000</td><td><input name="srvc" value="s${num}"></td></tr>`;
}
const query = (date, train = '') => ({ fields: { from_city: 'تهران', to_city: 'مشهد', date, gender: 'عادی', train_number: train },
  passengers: [{ quota_type: 'بزرگسال' }], cookies: ['PHPSESSID=fixture'] });

(async () => {
  // 00:00 today has always passed (or is exactly now); it must never stop the search.
  body = '<html><body><table>' + row(401, today, '00:00', '7') + '</table></body></html>';
  let r = await core.searchOnce(query(today));
  assert.equal(r.ok, true); assert.equal(r.trains.length, 0, JSON.stringify(r.trains));
  assert.equal(r.availabilityStatus, 'no_match'); assert.match(r.note, /گذشته/);
  console.log('PASS today: a departed train with seats is not reported as found');

  r = await core.searchOnce(query(today, '401'));
  assert.equal(r.trains.length, 0); assert.match(r.note, /401/);
  console.log('PASS today: a selected train that already left gets a clear message');

  // A date in the future keeps the same early train.
  const f = new Date(Date.now() + 3 * 86400000);
  const fj = dep.tehranNow(f);
  const future = fj.jy + '/' + pad(fj.jm) + '/' + pad(fj.jd);
  body = '<html><body><table>' + row(401, future, '00:00', '7') + '</table></body></html>';
  r = await core.searchOnce(query(future));
  assert.equal(r.availabilityStatus, 'found'); assert.equal(r.trains.length, 1);
  console.log('PASS future date: the same early-morning train is still found');
  console.log('ALL departed-train search checks passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
