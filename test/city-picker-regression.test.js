'use strict';
// Regression: /api/cities can fail while the origin/destination controls must
// remain populated and searchable using the authoritative bundled city list.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const cities = Object.keys(JSON.parse(read('cities.json')));
const html = read('public/route.html');
const pickerCode = read('public/city-picker.js');
function test(label, fn) { fn(); console.log('PASS  ' + label); }
function selectMarkup(id) {
  const match = html.match(new RegExp('<select id="' + id + '"[^>]*>([\\s\\S]*?)<\\/select>'));
  assert.ok(match, `Missing ${id}`);
  const names = Array.from(match[1].matchAll(/<option value="([^"]*)"/g), m => m[1]);
  return names;
}
test('Origin and destination contain all bundled Safir city names in HTML, without API calls', () => {
  assert.deepEqual(selectMarkup('bf_src'), ['', ...cities]);
  assert.deepEqual(selectMarkup('bf_dst'), ['', ...cities]);
});
test('City data is not silently replaced by invalid defaults', () => {
  assert.equal(selectMarkup('bf_src')[0], '');
  assert.equal(selectMarkup('bf_dst')[0], '');
  assert.equal(new Set(cities).size, cities.length);
  assert.ok(cities.length >= 100);
});
test('City initialization is synchronous and does not wait for network fetch', () => {
  const part = html.match(/function loadCities\(\)\s*\{([\s\S]*?)\n  \}\n  let cityPickers/);
  assert.ok(part, 'missing loadCities');
  assert.ok(!/\bfetch\s*\(/.test(part[1]));
  assert.ok(!/\bawait\b/.test(part[1]));
  assert.ok(/attachCityPickers\(\)/.test(part[1]));
  assert.match(html, /BilitCityPicker\.attach\(\['bf_src', 'bf_dst'\]/);
});
test('City picker is mounted before the asynchronous storage initializer', () => {
  assert.ok(html.indexOf('attachCityPickers();') < html.indexOf('(async function init()'));
});
test('Native select controls are retained as a functional fallback', () => {
  assert.ok(/\$\('bf_src'\)\.classList\.remove\('city-native'\)/.test(html));
  assert.ok(/\$\('bf_dst'\)\.classList\.remove\('city-native'\)/.test(html));
  assert.ok(/city-picker\.js/.test(html));
});

// Tiny DOM simulator: exercise the actual picker logic (without jsdom/npm).
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {};
    this.className = ''; this.value = ''; this.dataset = {}; this.attrs = {};
    this.parentNode = null; this.style = {}; this.textContent = '';
    this.classList = {
      add: (name) => this.className = [...new Set([...this.className.split(' ').filter(Boolean), name])].join(' '),
      remove: (name) => this.className = this.className.split(' ').filter(x => x !== name).join(' '),
      contains: (name) => this.className.split(' ').includes(name),
    };
  }
  set innerHTML(value) { if (value === '') this.children = []; }
  get innerHTML() { return ''; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  insertBefore(child) { this.appendChild(child); }
  setAttribute(k,v) { this.attrs[k] = v; }
  addEventListener(type,fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.listeners[event.type] || []) fn(event); }
  fire(type, e = {}) { this.dispatchEvent({ type, preventDefault() {}, key:'', ...e }); }
  querySelector(selector) {
    const tokens = selector.split('.').filter(Boolean);
    const walk = n => n.children.flatMap(child => [child, ...walk(child)]);
    return walk(this).find(n => tokens.every(tok => n.className.split(' ').includes(tok))) || null;
  }
  scrollIntoView() {}
  select() {}
}
const parent = new FakeNode('div');
function makeSelect(id) {
  const s = new FakeNode('select'); s.id = id;
  s.options = [{value:''}, ...cities.map(value=>({value}))];
  parent.appendChild(s); return s;
}
const source = makeSelect('bf_src');
const dest = makeSelect('bf_dst');
const sandbox = {
  document: {
    createElement: tag => new FakeNode(tag),
    getElementById: id => id === 'bf_src' ? source : id === 'bf_dst' ? dest : null,
  },
  Event: class Event { constructor(type) { this.type = type; } },
  setTimeout, clearTimeout,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(pickerCode, sandbox);
const pickers = sandbox.BilitCityPicker.attach(['bf_src','bf_dst'], { placeholder:'نام شهر را بنویسید…' });
function pickerInput(select) { return select.parentNode.children.find(c => c.tagName === 'INPUT'); }
function pickerList(select) { return select.parentNode.children.find(c => c.className === 'city-list'); }

test('Typing on origin input filters cities even without an API response', () => {
  assert.equal(pickers.length, 2);
  const inp = pickerInput(source); assert.ok(inp);
  inp.fire('focus'); inp.value = 'تهر'; inp.fire('input');
  const items = pickerList(source).children.filter(n => n.className.includes('city-item'));
  assert.deepEqual(items.map(x => x.textContent), ['تهران']);
  items[0].fire('mousedown');
  assert.equal(source.value, 'تهران');
  assert.equal(inp.value, 'تهران');
});
test('Keyboard selection works on destination without a mouse', () => {
  const inp = pickerInput(dest); inp.fire('focus'); inp.value = 'مش'; inp.fire('input');
  inp.fire('keydown', {key:'ArrowDown'});
  inp.fire('keydown', {key:'Enter'});
  assert.equal(dest.value, 'مشهد');
  assert.equal(inp.value, 'مشهد');
});
test('Reopening an existing route refreshes displayed city name', () => {
  source.value = 'اصفهان'; dest.value = 'شیراز';
  pickers.forEach(p => p.refresh());
  assert.equal(pickerInput(source).value,'اصفهان');
  assert.equal(pickerInput(dest).value,'شیراز');
});
test('Swapping origin/destination for a return trip refreshes both inputs', () => {
  assert.match(html, /\$\('bf_dst'\)\.value = src;\s*if \(cityPickers\) cityPickers\.forEach/);
});
test('Unmatched typed city cannot be committed as an invalid code', () => {
  const inp = pickerInput(dest); inp.fire('focus'); inp.value = 'شهر ساختگی نامعتبر'; inp.fire('input');
  assert.equal(pickerList(dest).children.filter(n=>n.className.includes('city-item')).length, 0);
  assert.equal(dest.value, 'شیراز');
});
console.log('ALL 10 CITY PICKER REGRESSIONS PASSED');
