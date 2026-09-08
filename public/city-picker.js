/* eslint-disable */
/**
 * city-picker.js — انتخابگر شهر با جستجو.
 *
 * مشکل: فهرست شهرهای صفیر ریل بسیار بلند است و در یک <select> ساده، پیدا
 * کردن شهر یعنی اسکرول طولانی — مخصوصاً روی موبایل.
 *
 * راهکار: یک فیلد جستجو که همان <select> اصلی را پشت صحنه نگه می‌دارد (پس
 * همه کدهای موجود که `$('bf_src').value` را می‌خوانند بدون تغییر کار می‌کنند)
 * و روی آن یک رابط قابل تایپ می‌نشاند:
 *   - تایپ کنید تا فهرست فیلتر شود (بدون حساسیت به «ی/ي» و «ک/ك»)
 *   - شهرهای پرتکرار بالای فهرست، در یک بخش جدا
 *   - انتخاب فعلی به‌صورت برجسته نمایش داده می‌شود
 *   - پیمایش با کلیدهای جهت‌دار و Enter
 */
(function (global) {
  'use strict';

  // شهرهای پرتکرار — بالای فهرست نشان داده می‌شوند
  var POPULAR = ['تهران', 'مشهد', 'اصفهان', 'شیراز', 'تبریز', 'اهواز', 'یزد', 'کرمان', 'قم', 'رشت'];

  /** یکسان‌سازی نویسه‌های عربی/فارسی و حذف اعراب برای جستجوی روان. */
  function norm(s) {
    return String(s || '')
      .replace(/[يﻯﻰ]/g, 'ی')
      .replace(/[كﻙ]/g, 'ک')
      .replace(/[\u064B-\u0652\u200c]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function create(selectEl, opts) {
    if (!selectEl || selectEl.dataset.cityPicker === '1') return null;
    selectEl.dataset.cityPicker = '1';
    opts = opts || {};

    var wrap = document.createElement('div');
    wrap.className = 'city-picker';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'city-input';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.placeholder = opts.placeholder || 'نام شهر را بنویسید…';

    var caret = document.createElement('span');
    caret.className = 'city-caret';
    caret.textContent = '▾';

    var list = document.createElement('div');
    list.className = 'city-list';
    list.setAttribute('role', 'listbox');

    wrap.appendChild(input);
    wrap.appendChild(caret);
    wrap.appendChild(list);

    // select اصلی مخفی می‌شود ولی در DOM می‌ماند (سازگاری کامل با کد موجود)
    selectEl.classList.add('city-native');
    selectEl.parentNode.insertBefore(wrap, selectEl);
    wrap.appendChild(selectEl);

    var activeIdx = -1;
    var visible = [];

    function allCities() {
      return Array.prototype.map.call(selectEl.options, function (o) { return o.value; })
        .filter(function (v) { return v; });
    }

    function setValue(city, fire) {
      selectEl.value = city;
      input.value = city;
      if (fire !== false) {
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      close();
    }

    function rowFor(city, isPopular) {
      var d = document.createElement('div');
      d.className = 'city-item' + (city === selectEl.value ? ' selected' : '');
      d.setAttribute('role', 'option');
      d.textContent = city;
      if (isPopular) {
        var b = document.createElement('span');
        b.className = 'city-badge';
        b.textContent = 'پرتکرار';
        d.appendChild(b);
      }
      d.addEventListener('mousedown', function (e) {
        e.preventDefault();
        setValue(city);
      });
      return d;
    }

    function render(filter) {
      var q = norm(filter);
      var cities = allCities();
      list.innerHTML = '';
      visible = [];
      activeIdx = -1;

      var matches = cities.filter(function (c) { return !q || norm(c).indexOf(q) !== -1; });
      // تطبیق از ابتدای نام، بالاتر می‌آید
      if (q) {
        matches.sort(function (a, b) {
          var sa = norm(a).indexOf(q) === 0 ? 0 : 1;
          var sb = norm(b).indexOf(q) === 0 ? 0 : 1;
          return sa - sb;
        });
      }

      if (!matches.length) {
        var none = document.createElement('div');
        none.className = 'city-empty';
        none.textContent = 'شهری با این نام پیدا نشد.';
        list.appendChild(none);
        return;
      }

      // بدون جستجو: بخش «پرتکرار» بالای فهرست
      if (!q) {
        var pops = POPULAR.filter(function (p) { return cities.indexOf(p) !== -1; });
        if (pops.length) {
          var h1 = document.createElement('div');
          h1.className = 'city-group';
          h1.textContent = 'پرتکرار';
          list.appendChild(h1);
          pops.forEach(function (c) { var r = rowFor(c, true); list.appendChild(r); visible.push({ el: r, city: c }); });
          var h2 = document.createElement('div');
          h2.className = 'city-group';
          h2.textContent = 'همه شهرها';
          list.appendChild(h2);
          matches = matches.filter(function (c) { return pops.indexOf(c) === -1; });
        }
      }

      matches.forEach(function (c) {
        var r = rowFor(c, false);
        list.appendChild(r);
        visible.push({ el: r, city: c });
      });
    }

    function open() {
      render(input.value === selectEl.value ? '' : input.value);
      wrap.classList.add('open');
      input.setAttribute('aria-expanded', 'true');
      var sel = list.querySelector('.city-item.selected');
      if (sel) sel.scrollIntoView({ block: 'center' });
    }
    function close() {
      wrap.classList.remove('open');
      input.setAttribute('aria-expanded', 'false');
      // اگر متن ناقص ماند، به مقدار معتبر برگرد
      if (input.value !== selectEl.value) input.value = selectEl.value || '';
    }

    function highlight(i) {
      if (!visible.length) return;
      if (activeIdx >= 0 && visible[activeIdx]) visible[activeIdx].el.classList.remove('active');
      activeIdx = Math.max(0, Math.min(visible.length - 1, i));
      visible[activeIdx].el.classList.add('active');
      visible[activeIdx].el.scrollIntoView({ block: 'nearest' });
    }

    input.addEventListener('focus', function () { input.select(); open(); });
    caret.addEventListener('mousedown', function (e) {
      e.preventDefault();
      if (wrap.classList.contains('open')) close(); else { input.focus(); }
    });
    input.addEventListener('input', function () {
      wrap.classList.add('open');
      render(input.value);
    });
    input.addEventListener('blur', function () { setTimeout(close, 120); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!wrap.classList.contains('open')) open(); else highlight(activeIdx + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(activeIdx - 1); }
      else if (e.key === 'Enter') {
        if (wrap.classList.contains('open') && activeIdx >= 0 && visible[activeIdx]) {
          e.preventDefault();
          setValue(visible[activeIdx].city);
        }
      } else if (e.key === 'Escape') { close(); }
    });

    // اگر کد برنامه مقدار select را عوض کرد، ورودی هم به‌روز شود
    selectEl.addEventListener('change', function () {
      if (input.value !== selectEl.value) input.value = selectEl.value || '';
    });

    return {
      refresh: function () { input.value = selectEl.value || ''; },
    };
  }

  /** فعال‌سازی روی چند select با شناسه. */
  function attach(ids, opts) {
    var out = [];
    (ids || []).forEach(function (id) {
      var el = typeof id === 'string' ? document.getElementById(id) : id;
      if (el) out.push(create(el, opts));
    });
    return out;
  }

  global.BilitCityPicker = { attach: attach, create: create, POPULAR: POPULAR, norm: norm };
})(window);
