/* global chrome, BilitOfficialCheckout */
'use strict';
// This trusted extension script runs ONLY on the official SafirRail origin.
// It never clicks ARCaptcha, reads its response value, moves its token to
// BilitFast, or changes site cookies. Browser cookies are sent naturally to
// the first-party website by Chrome/Edge.
(() => {
  if (location.protocol !== 'https:' || location.hostname !== 'safirrail.ir' ||
      !location.pathname.startsWith('/etrain/')) return;

  const PANEL_ID = 'bilitfast-official-helper';
  const MAX_AGE_MS = 15 * 60 * 1000;
  let completed = false;
  let filling = false;
  let challengeRequested = false;
  let reviewReported = false;
  let panel;
  let lastPhase = '';
  let lastCheckAt = 0;
  const start = Date.now();

  const field = name => document.querySelector(`input[name="${name}"],input[id="${name}"]`);
  const hasPassengerForm = () => !!(field('pid0') && (field('fn0') || field('ln0')));
  const hasChallenge = () => !!document.querySelector('.arcaptcha[data-site-key],input[name="arcaptcha-token"]');
  function humanVerified() {
    // Do not extract/consume/upload the secret token; only check whether the
    // first-party widget reports a non-empty response AFTER user verification.
    const tokenPresent = !!(document.querySelector('input[name="arcaptcha-token"]')?.value || '').trim();
    const checked = !!document.querySelector('#arc-checkbox input[type="checkbox"]:checked') ||
      document.querySelector('#arc-checkbox')?.getAttribute('aria-checked') === 'true';
    return tokenPresent && checked;
  }
  const setStage = stage => chrome.runtime.sendMessage({type:'BILIT_SET_WORKFLOW_STAGE',stage}).catch(()=>{});
  function ensurePanel() {
    if (panel || (!hasPassengerForm() && !hasChallenge())) return;
    panel = document.createElement('aside');
    panel.id = PANEL_ID;panel.dir = 'rtl';
    panel.style.cssText='position:fixed;z-index:2147483600;right:12px;bottom:12px;max-width:350px;padding:14px 15px;background:#f0f7ff;border:2px solid #1d4ed8;border-radius:13px;color:#0f172a;font:13px Tahoma,Arial,sans-serif;box-shadow:0 9px 24px #0003;line-height:1.85';
    const title=document.createElement('strong');title.textContent='🚆 BilitFast | تأیید و رزرو';
    title.style.cssText='display:block;font-size:14px;margin-bottom:7px';panel.append(title);
    const label=document.createElement('div');label.id='bilitfast-helper-text';
    label.textContent=hasPassengerForm()?'اطلاعات مسافر در حال آماده‌سازی است.':'تیک واقعی «من ربات نیستم» را خودتان در همین صفحه بزنید.';
    panel.append(label);
    const btn=document.createElement('button');btn.type='button';btn.id='bilitfast-fill-passengers';
    btn.textContent='تکمیل اطلاعات مسافر';
    btn.style.cssText='margin:7px 0 0;padding:8px 11px;border:0;border-radius:8px;background:#1d4ed8;color:white;cursor:pointer;font:12px Tahoma';
    btn.addEventListener('click',()=>{void fillFromExtension();});
    panel.append(btn);document.body.append(panel);
  }
  function setText(message) {
    ensurePanel();const el=document.getElementById('bilitfast-helper-text');
    if(el)el.textContent=message;
  }
  function reportPhase(stage) {
    if(lastPhase===stage)return;lastPhase=stage;void setStage(stage);
  }
  function officialFormFor(element, captcha=false) {
    const form=element?.form || element?.closest?.('form') || document.querySelector('form[name="mainFrm"]');
    if(!form || form.method.toUpperCase()!=='POST')return null;
    let action;
    try {action=new URL(form.action,location.href);}catch(_){return null;}
    if(action.origin!=='https://safirrail.ir' || !action.pathname.startsWith('/etrain/') ||
      (captcha && !/\/TresV\.php$/i.test(action.pathname)))return null;
    return form;
  }
  function safeSubmit(form) {
    if(!form || typeof form.requestSubmit!=='function')return false;
    if(typeof form.reportValidity==='function' && !form.reportValidity())return false;
    const submitter=form.querySelector('input[type="submit"],button[type="submit"]');
    try {form.requestSubmit(submitter || undefined);return true;}catch(_){return false;}
  }
  function fillOne(name,value) {
    const el=field(name);
    if(!el || el.disabled || value===undefined || value===null || value==='')return false;
    el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));return el.value===String(value);
  }
  async function claim(step) {
    try {const result=await chrome.runtime.sendMessage({type:'BILIT_CLAIM_WORKFLOW_STEP',step});
      return !!result?.ok;}catch(_){return false;}
  }
  async function fillFromExtension() {
    if(filling || completed)return;
    if(!hasPassengerForm()) {setText('ابتدا ARCaptcha را خودتان تأیید کنید تا فرم مسافر نمایش داده شود.');return;}
    filling=true;
    let record;
    try {record=await chrome.runtime.sendMessage({type:'BILIT_GET_PASSENGERS'});}catch(_){
      filling=false;setText('دریافت اطلاعات مسافر ممکن نشد.');reportPhase('manual-review');return;
    }
    if(!record?.ok || !Array.isArray(record.passengers) || !record.passengers.length){
      filling=false;setText('اطلاعات مسافر منقضی شده یا در دسترس نیست. به BilitFast برگردید و دوباره شروع کنید.');return;
    }
    reportPhase('passenger-form');
    const count=record.passengers.length;
    if(count>6 || !record.passengers.every((_p,i)=>field('pid'+i)&&field('fn'+i)&&field('ln'+i))){
      filling=false;setText('ساختار فرم مسافر تغییر کرده است. چیزی به‌صورت خودکار ارسال نمی‌شود.');reportPhase('manual-review');return;
    }
    let filled=0;
    let complete=true;
    for(const [index,p] of record.passengers.entries()){
      const vals={pid:p.national_code,ruz:p.birth_day,mah:p.birth_month,
        sal:p.birth_year,fn:p.first_name,ln:p.last_name};
      for(const [name,value] of Object.entries(vals)){
        const existing=field(name+index);
        if(!existing) {if(['pid','fn','ln'].includes(name))complete=false;continue;}
        if(value===undefined||value===null||value==='') {complete=false;continue;}
        const ok=fillOne(name+index,value);
        if(ok)filled++;else complete=false;
      }
    }
    if(record.phone && field('phone')) {if(fillOne('phone',record.phone))filled++;else complete=false;}
    if(!filled){filling=false;setText('فیلدهای فرم شناسایی نشدند؛ اطلاعات را دستی پر کنید.');reportPhase('manual-review');return;}
    completed=true;filling=false;
    reportPhase('passengers-filled');
    const button=document.getElementById('bilitfast-fill-passengers');if(button)button.disabled=true;
    const form=officialFormFor(field('pid0'));
    // The official page may use onclick=chkForm() to move from TresV.php
    // to VerifyTck.php. requestSubmit() skips that click and can loop.
    if(record.autoContinue && complete && form &&
        (typeof form.checkValidity!=='function'||form.checkValidity()) &&
        typeof BilitOfficialCheckout !== 'undefined') {
      // Claim BEFORE clicking so a synchronous navigation cannot lose the
      // at-most-once gate. A failed decision never submits a guessed form.
      if (await claim('passenger')) {
        const result=BilitOfficialCheckout.submitPassenger(form);
        if(result.ok) {
          setText('کنترل رسمی مسافر اجرا شد؛ منتظر صفحه تأیید خرید بمانید. پرداخت خودکار انجام نمی‌شود.');
          reportPhase('passenger-submitted');
        } else {
          setText('کنترل رسمی تأیید خرید شناسایی نشد. دکمه تأیید سایت را خودتان بزنید.');
          reportPhase('manual-review');
        }
      } else {
        setText('ارسال تکراری خودکار متوقف شد. وضعیت فرم را بررسی کنید.');
        reportPhase('manual-review');
      }
    } else {
      setText('تعداد '+filled+' فیلد تکمیل شد. نام، کد ملی، مبلغ و قطار را بررسی و دکمه تأیید سایت را بزنید.');
      reportPhase('manual-review');
    }
    // Preserve the temporary data until the official confirmation is visible.
    // A failed server-side validation may return to the same passenger page.
  }
  async function continueAfterHumanApproval() {
    if(challengeRequested || !hasChallenge() || !humanVerified())return;
    challengeRequested=true;
    const record=await chrome.runtime.sendMessage({type:'BILIT_GET_PASSENGERS'}).catch(()=>null);
    if(!record?.ok){setText('تأیید انجام شده، ولی اطلاعات رزرو یافت نشد. از دکمه تأیید رسمی استفاده کنید.');return;}
    reportPhase('captcha-confirmed');
    if(!record.autoContinue){setText('تأیید انجام شد. برای ادامه، دکمه تأیید رسمی همین صفحه را بزنید.');return;}
    const form=officialFormFor(document.querySelector('input[name="arcaptcha-token"]'),true);
    if(!form || !await claim('captcha') || !safeSubmit(form)){
      setText('تأیید انسانی ثبت شد، ولی ارسال خودکار ممکن نیست؛ دکمه تأیید رسمی را بزنید.');
      reportPhase('manual-review');return;
    }
    setText('تأیید انسانی انجام شد؛ درخواست به‌صورت رسمی در حال ارسال است.');
  }
  function inspect() {
    if(Date.now()-start>MAX_AGE_MS)return;
    if(Date.now()-lastCheckAt<350)return;
    lastCheckAt=Date.now();
    ensurePanel();
    if(hasPassengerForm() && !hasChallenge() && !completed && !filling){void fillFromExtension();return;}
    if(hasChallenge() && !challengeRequested)void continueAfterHumanApproval();
    if (!reviewReported && !hasPassengerForm() && !hasChallenge() &&
        typeof BilitOfficialCheckout !== 'undefined') {
      const stage=BilitOfficialCheckout.detectPage({
        hostname:location.hostname,pathname:location.pathname,
        visibleText:document.body?.innerText || '',hasPassenger:false,hasChallenge:false
      });
      if(stage==='purchase-review') {
        reviewReported=true;
        setText('صفحه تأیید خرید نمایش داده شد. مشخصات و مبلغ را بررسی و تأیید رسمی را خودتان بزنید.');
        reportPhase('purchase-review');
        void chrome.runtime.sendMessage({type:'BILIT_CLEAR_PASSENGERS'}).catch(()=>{});
      } else if(stage==='purchase-response' || stage==='passenger-response') {
        reviewReported=true;
        setText('پاسخ سامانه دریافت شد اما تأیید خرید قطعی نیست. پیام‌های رسمی صفحه را بررسی کنید؛ درگاه بانکی خودکار باز نمی‌شود.');
        reportPhase('manual-review');
      }
    }
  }
  inspect();
  // Native widgets may update input.value without mutating an HTML attribute.
  // Periodic observation is needed, but never clicks/checks the widget.
  const interval=setInterval(()=>{
    if(Date.now()-start>MAX_AGE_MS){clearInterval(interval);observer.disconnect();return;}
    inspect();
  },650);
  const observer=new MutationObserver(inspect);
  observer.observe(document.documentElement,{childList:true,subtree:true});
})();
