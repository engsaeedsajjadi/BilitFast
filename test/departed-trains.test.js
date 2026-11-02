'use strict';
// 3.13.5: trains whose departure time has passed TODAY (Tehran time) must not
// be reported as found; future dates are never filtered by the current clock.
const assert = require('node:assert/strict');
const dep = require('../lib/departure');
const core = require('../lib/core');
let passes = 0;
function pass(l) { passes++; console.log('PASS ' + l); }

// 1405/08/11 12:00 Tehran == 2026-11-02 08:30 UTC (Iran is UTC+3:30, no DST)
const NOON = new Date('2026-11-02T08:30:00Z');
const t = dep.tehranNow(NOON);
assert.deepEqual([t.jy, t.jm, t.jd, t.minutes], [1405, 8, 11, 720]);
// 23:50 Tehran is already "tomorrow" in Tehran but still "today" in UTC.
const late = dep.tehranNow(new Date('2026-11-02T20:20:00Z'));
assert.deepEqual([late.jy, late.jm, late.jd, late.minutes], [1405, 8, 11, 23 * 60 + 50]);
const afterMidnight = dep.tehranNow(new Date('2026-11-02T21:00:00Z'));
assert.deepEqual([afterMidnight.jd, afterMidnight.minutes], [12, 30]);
pass('Tehran date/time is computed independently of the server time zone');

const today = '1405/08/11', tomorrow = '1405/08/12';
assert.equal(dep.hasDeparted({ timeText: '08:15', searchDate: today, now: NOON }), true);
assert.equal(dep.hasDeparted({ timeText: '12:00', searchDate: today, now: NOON }), true);
assert.equal(dep.hasDeparted({ timeText: '12:01', searchDate: today, now: NOON }), false);
assert.equal(dep.hasDeparted({ timeText: '۰۸:۱۵', searchDate: '۱۴۰۵/۰۸/۱۱', now: NOON }), true);
pass('today: trains at or before the current time are departed, later ones are not (Persian digits too)');

assert.equal(dep.hasDeparted({ timeText: '06:00', searchDate: tomorrow, now: NOON }), false);
assert.equal(dep.hasDeparted({ timeText: '00:30', searchDate: '1405/09/01', now: NOON }), false);
pass('future dates are never filtered by the current clock');

assert.equal(dep.hasDeparted({ timeText: 'نامشخص', searchDate: today, now: NOON }), false);
assert.equal(dep.hasDeparted({ timeText: '08:00', searchDate: 'bad', now: NOON }), false);
pass('unreadable time or date never hides a train');

// Row date wins over the search date when it is readable.
assert.equal(dep.hasDeparted({ timeText: '08:00', rowDate: tomorrow, searchDate: today, now: NOON }), false);
assert.equal(dep.hasDeparted({ timeText: '08:00', rowDate: '۱۴۰۵/۸/۱۱', searchDate: tomorrow, now: NOON }), true);
pass('the train row\'s own date takes precedence over the search date');

// Real extractor with rows matching config.json column selectors.
function row(num, date, time, cap) {
  return `<tr name="srvc"><td>c</td><td><div>co</div></td><td>${num}</td><td>کوپه</td><td></td><td></td>` +
    `<td>${date}</td><td>${time}</td><td>${cap}</td><td>1,000,000</td>` +
    `<td><input name="srvc" value="s${num}"></td></tr>`;
}
const html = '<table>' + row(301, today, '08:15', '5') + row(302, today, '11:59', '3') +
  row(303, today, '18:40', '4') + '</table>';
const opts = { searchDate: today, now: NOON };
let trains = core.extractTrains(html, 1, null, opts);
assert.deepEqual(trains.map((x) => x['شماره قطار']), ['303']);
let diag = core.extractDiagnostics(html, null, 1, opts);
assert.equal(diag.departedRows, 2); assert.equal(diag.matchingRows, 1);
pass('today\'s departed trains with free seats are excluded; the later train is still found');

const htmlTomorrow = '<table>' + row(301, tomorrow, '08:15', '5') + row(303, tomorrow, '18:40', '4') + '</table>';
trains = core.extractTrains(htmlTomorrow, 1, null, { searchDate: tomorrow, now: NOON });
assert.deepEqual(trains.map((x) => x['شماره قطار']), ['301', '303']);
pass('searching a future date keeps early-morning trains');

const onlyDeparted = '<table>' + row(301, today, '08:15', '5') + '</table>';
assert.equal(core.extractTrains(onlyDeparted, 1, '301', opts).length, 0);
diag = core.extractDiagnostics(onlyDeparted, '301', 1, opts);
assert.equal(diag.departedRows, 1); assert.equal(diag.matchingRows, 0);
pass('a specifically selected train that already left is not reported as found');

assert.equal(core.extractTrains(html, 1, null).length, 3);
pass('callers that pass no search date keep the previous behaviour');

console.log('ALL ' + passes + ' departed-train checks passed');
