/* global chrome */
'use strict';
// Dynamically installed only on the customer origin the user explicitly paired.
// A row selection is the ONLY automatic-start intent. Never touches CAPTCHA.
(() => {
  if (globalThis.__bilitRouteBridge || location.pathname !== '/route.html') return;
  globalThis.__bilitRouteBridge = true;
  let armed = false;
  let panelReady = false;
  let submitting = false;
  let lastHandoff = '';
  const status = message => {
    const el = document.getElementById('arcaptcha-handoff-status');
    if (el) el.textContent = message;
  };
  function snapshot() {
    const section = document.getElementById('reserve-arcaptcha');
    const el = document.getElementById('bf-browser-handoff');
    if (!section || section.style.display === 'none' || !el?.textContent) return null;
    const handoff = JSON.parse(el.textContent);
    const passengers = Array.from(document.querySelectorAll('#passengers-table tbody tr')).map(tr => {
      const val = cls => (tr.querySelector(cls)?.value || '').trim();
      return {national_code:val('.col-national'),birth_day:val('.col-day'),
        birth_month:val('.col-month'),birth_year:val('.col-year'),
        first_name:val('.col-name'),last_name:val('.col-family')};
    });
    return {handoff,passengers,phone:(document.getElementById('bf_contact')?.value || '').trim()};
  }
  function continueWhenReady() {
    if (!armed || !panelReady || submitting) return;
    let data;
    try { data = snapshot(); } catch (_) { status('فرم انتخاب قطار معتبر نیست؛ دوباره انتخاب کنید.');armed=false;return; }
    if (!data) return;
    const key = JSON.stringify(data.handoff);
    if (lastHandoff === key) return;
    submitting=true;
    chrome.runtime.sendMessage({type:'BILIT_START_FROM_SELECTION',snapshot:data})
      .then(result=>{
        if (!result?.ok) {
          status(result?.error || 'شروع خودکار ممکن نشد؛ افزونه را بررسی کنید.');
          submitting=false;
        } else { lastHandoff=key;armed=false; }
      }).catch(()=>{status('ارتباط با افزونه برقرار نیست؛ آن را مجدداً بارگذاری کنید.');submitting=false;});
  }
  document.addEventListener('click', e => {
    const button = e.target?.closest?.('button[data-train]');
    if (!button || !document.getElementById('found-table')?.contains(button)) return;
    armed=true;
    panelReady=false;
    lastHandoff='';
    // Panel opening is tied to the user's REAL selection click. Do not
    // navigate to SafirRail when the helper panel cannot remain visible.
    chrome.runtime.sendMessage({type:'BILIT_PREPARE_PANEL'}).then(result=>{
      if(!result?.ok) {
        armed=false;
        status(result?.error||'پنل BilitFast باز نشد؛ افزونه را بررسی کنید.');
        return;
      }
      panelReady=true;
      continueWhenReady();
    }).catch(()=>{armed=false;status('افزونه BilitFast در دسترس نیست.');});
  }, true);
  new MutationObserver(continueWhenReady).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['style']});
})();
