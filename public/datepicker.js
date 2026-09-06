/* datepicker.js — دیت‌پیکر شمسی سبک برای فیلدهای تاریخ (بدون وابستگی خارجی)
 * استفاده:  BilitFastDatePicker.attach(inputElement)
 * نیازمند:  jalaali.min.js (که در همه صفحات بارگذاری می‌شود)
 */
const BilitFastDatePicker = (function () {
  const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
  const WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

  function faDigits(n) {
    return String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  }

  function parseInput(input) {
    const m = String(input.value || '').trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) return null;
    const jy = +m[1], jm = +m[2], jd = +m[3];
    if (!window.jalaali || !window.jalaali.isValidJalaaliDate(jy, jm, jd)) return null;
    return { jy, jm, jd };
  }

  function daysInMonth(jy, jm) {
    return window.jalaali.jalaaliMonthLength(jy, jm);
  }

  // شنبه اولین روز هفته است؛ این تابع «ایندکس ستون» اولین روز ماه را می‌دهد
  function firstWeekdayIndex(jy, jm) {
    const g = window.jalaali.toGregorian(jy, jm, 1);
    const d = new Date(g.gy, g.gm - 1, g.gd);
    return (d.getDay() + 1) % 7; // getDay: یکشنبه=0 ... شنبه=6 → تبدیل به شنبه=0
  }

  function attach(input) {
    if (!input || input.dataset.hasDatepicker) return;
    input.dataset.hasDatepicker = '1';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dp-btn';
    btn.title = 'انتخاب تاریخ';
    btn.textContent = '📅';
    input.insertAdjacentElement('afterend', btn);

    const pop = document.createElement('div');
    pop.className = 'dp-pop';
    pop.style.display = 'none';
    document.body.appendChild(pop);

    let view = null; // {jy, jm}

    function current() {
      return parseInput(input) || (function () {
        const now = new Date();
        const t = window.jalaali.toJalaali(now.getFullYear(), now.getMonth() + 1, now.getDate());
        return { jy: t.jy, jm: t.jm, jd: t.jd };
      })();
    }

    function render() {
      const sel = parseInput(input);
      const { jy, jm } = view;
      const dim = daysInMonth(jy, jm);
      const startIdx = firstWeekdayIndex(jy, jm);
      const today = (function () {
        const now = new Date();
        return window.jalaali.toJalaali(now.getFullYear(), now.getMonth() + 1, now.getDate());
      })();

      let html = '<div class="dp-head">';
      html += '<button type="button" class="dp-nav" data-nav="-12" title="سال قبل">«</button>';
      html += '<button type="button" class="dp-nav" data-nav="-1" title="ماه قبل">‹</button>';
      html += '<span class="dp-title">' + MONTHS[jm - 1] + ' ' + faDigits(jy) + '</span>';
      html += '<button type="button" class="dp-nav" data-nav="1" title="ماه بعد">›</button>';
      html += '<button type="button" class="dp-nav" data-nav="12" title="سال بعد">»</button>';
      html += '</div>';

      html += '<div class="dp-grid">';
      for (const w of WEEKDAYS) html += '<div class="dp-wd">' + w + '</div>';
      for (let i = 0; i < startIdx; i++) html += '<div></div>';
      for (let d = 1; d <= dim; d++) {
        const cls = [];
        if (sel && sel.jy === jy && sel.jm === jm && sel.jd === d) cls.push('dp-sel');
        if (today.jy === jy && today.jm === jm && today.jd === d) cls.push('dp-today');
        html += '<div class="dp-day ' + cls.join(' ') + '" data-day="' + d + '">' + faDigits(d) + '</div>';
      }
      html += '</div>';
      html += '<div class="dp-foot"><button type="button" class="dp-today-btn">امروز</button></div>';
      pop.innerHTML = html;

      pop.querySelectorAll('.dp-nav').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        const n = parseInt(b.getAttribute('data-nav'), 10);
        let m = view.jm + n;
        let y = view.jy;
        while (m < 1) { m += 12; y -= 1; }
        while (m > 12) { m -= 12; y += 1; }
        view = { jy: y, jm: m };
        render();
      }));
      pop.querySelectorAll('.dp-day').forEach((el) => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const d = el.getAttribute('data-day');
        input.value = jy + '/' + String(jm).padStart(2, '0') + '/' + String(d).padStart(2, '0');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        close();
      }));
      const tb = pop.querySelector('.dp-today-btn');
      if (tb) tb.addEventListener('click', (e) => {
        e.stopPropagation();
        const now = new Date();
        const t = window.jalaali.toJalaali(now.getFullYear(), now.getMonth() + 1, now.getDate());
        input.value = t.jy + '/' + String(t.jm).padStart(2, '0') + '/' + String(t.jd).padStart(2, '0');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        close();
      });
    }

    function position() {
      const r = input.getBoundingClientRect();
      pop.style.top = (window.scrollY + r.bottom + 6) + 'px';
      // راست‌چین: انتهای تقویم با انتهای فیلد تنظیم می‌شود
      const left = window.scrollX + r.left + r.width - pop.offsetWidth;
      pop.style.left = Math.max(8, left) + 'px';
    }

    function open() {
      const c = current();
      view = { jy: c.jy, jm: c.jm };
      pop.style.display = 'block';
      render();
      position();
      setTimeout(() => document.addEventListener('click', onDocClick), 0);
    }
    function close() {
      pop.style.display = 'none';
      document.removeEventListener('click', onDocClick);
    }
    function onDocClick(e) {
      if (!pop.contains(e.target) && e.target !== input && e.target !== btn) close();
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pop.style.display === 'none') open(); else close();
    });
    input.addEventListener('focus', () => { if (pop.style.display === 'none') open(); });

    return { open, close };
  }

  return { attach };
})();
