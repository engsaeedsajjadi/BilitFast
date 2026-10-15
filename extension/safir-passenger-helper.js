/* global chrome, BilitOfficialCheckout, BilitSafeSelection, BilitAutoOfficialFlow */
'use strict';
// First-party helper. ARCaptcha is exclusively human-operated on SafirRail.
// Following official human verification, the user's Start Booking action
// authorizes matching passenger and allocation confirmations via the site's
// native controls. Never submit or click any CAPTCHA or complete bank payment.
(() => {
  if (location.protocol !== 'https:' || location.hostname !== 'safirrail.ir' ||
      !location.pathname.startsWith('/etrain/')) return;

  const PANEL_ID = 'bilitfast-official-helper';
  const MAX_AGE_MS = 15 * 60 * 1000;
  const start = Date.now();
  let filled = false;
  let filling = false;
  let panel;
  let lastPhase = '';
  let lastInspect = 0;
  let lastPage = '';
  let selectionBusy = false;
  let lastFillAttempt = 0;
  let passengerSubmitting = false;
  let lastPassengerContinueAttempt = 0;
  let allocationSubmitting = false;
  let lastAllocationAttempt = 0;
  const selectionAttempted = new Set();

  const field = name => document.querySelector(`input[name="${name}"],input[id="${name}"]`);
  const hasPassengerForm = () => !!(field('pid0') && field('fn0') && field('ln0'));
  // Existence only: never read ARCaptcha response values or checkbox state.
  const hasChallenge = () => !!document.querySelector('.arcaptcha[data-site-key],input[name="arcaptcha-token"]');
  const notify = (stage, detail) => chrome.runtime.sendMessage({type:'BILIT_SET_WORKFLOW_STAGE',stage,detail}).catch(()=>{});
  function report(stage, detail='') {
    if (stage===lastPhase) return;
    lastPhase=stage;
    void notify(stage,detail);
  }
  function ensurePanel() {
    if (panel || (!hasPassengerForm() && !hasChallenge())) return;
    panel=document.createElement('aside');
    panel.id=PANEL_ID; panel.dir='rtl';
    panel.style.cssText='position:fixed;z-index:2147483600;right:12px;bottom:12px;max-width:350px;padding:14px 15px;background:#f0f7ff;border:2px solid #1d4ed8;border-radius:13px;color:#0f172a;font:13px Tahoma,Arial,sans-serif;box-shadow:0 9px 24px #0003;line-height:1.85';
    const title=document.createElement('strong'); title.textContent='🚆 BilitFast | راهنمای رزرو';
    title.style.cssText='display:block;font-size:14px;margin-bottom:7px';panel.append(title);
    const label=document.createElement('div');label.id='bilitfast-helper-text';panel.append(label);
    // The initial booking action already authorizes safe field filling; no
    // second permission prompt or passenger-fill button is needed here.
    document.body.append(panel);
  }
  function setText(message) {
    ensurePanel();const label=document.getElementById('bilitfast-helper-text');
    if(label)label.textContent=message;
  }
  function fillOne(name,value) {
    const element=field(name);
    if(!element || element.disabled || element.readOnly || value===undefined || value===null || String(value)==='')return false;
    // Never override changes a human has already made to the official form.
    if(String(element.value||'').trim() && String(element.value).trim()!==String(value))return false;
    element.value=String(value);
    element.dispatchEvent(new Event('input',{bubbles:true}));
    element.dispatchEvent(new Event('change',{bubbles:true}));
    return element.value===String(value);
  }
  async function fillFromExtension() {
    if(filling || filled || Date.now()-lastFillAttempt<1800)return;
    lastFillAttempt=Date.now();
    if(!hasPassengerForm()) {setText('ابتدا در همین صفحه رسمی ARCaptcha را شخصاً تأیید و فرم رسمی را ارسال کنید.');return;}
    filling=true;
    try {
      const data=await chrome.runtime.sendMessage({type:'BILIT_GET_PASSENGERS'});
      if(!data?.ok || !Array.isArray(data.passengers) || !data.passengers.length || data.passengers.length>6) {
        setText('اطلاعات مسافر در دسترس نیست؛ از BilitFast دوباره شروع کنید.');report('network-session-error');return;
      }
      if(!data.passengers.every((_,i)=>field('pid'+i)&&field('fn'+i)&&field('ln'+i))) {
        setText('ساختار فرم رسمی تغییر کرده است. مشخصات را دستی وارد کنید.');report('official-form-not-submitted');return;
      }
      let count=0;let complete=true;
      for(const [index,person] of data.passengers.entries()) {
        const values={pid:person.national_code,ruz:person.birth_day,mah:person.birth_month,
          sal:person.birth_year,fn:person.first_name,ln:person.last_name};
        for(const [name,value] of Object.entries(values)) {
          if(!field(name+index) || !fillOne(name+index,value))complete=false;
          else count++;
        }
      }
      if(data.phone && field('phone')) {if(fillOne('phone',data.phone))count++;else complete=false;}
      if(!count){setText('فیلدهای قابل ویرایش یافت نشدند. فرم را خودتان تکمیل کنید.');report('official-form-not-submitted');return;}
      filled=complete;
      if(!complete)report('manual-review');
      setText(complete ? 'اطلاعات مسافر درج شد؛ BilitFast ادامه فرم رسمی را به‌طور خودکار انجام می‌دهد.' :
        'اطلاعات ناقص یا مغایرند؛ ادامه خودکار متوقف شد. فرم رسمی را بررسی کنید.');
      report(complete?'official-form-not-submitted':'manual-review');
      if (complete) await autoContinuePassenger(data);
    } catch (_) {
      setText('خطای ارتباط افزونه. صفحه رسمی را حفظ و دوباره تلاش کنید.');
      report('network-session-error');
    } finally {filling=false;}
  }
  async function autoContinuePassenger(data) {
    if (passengerSubmitting || !data?.autoAdvance || typeof BilitAutoOfficialFlow === 'undefined' ||
        Date.now()-lastPassengerContinueAttempt < 1500) return;
    lastPassengerContinueAttempt = Date.now();
    const action = BilitAutoOfficialFlow.findPassengerSubmit(document, data, location);
    if (!action.ok) {
      setText('ادامه خودکار اطلاعات مسافر ممکن نیست ('+action.reason+'). لطفاً کنترل رسمی سایت را بررسی کنید.');
      report('manual-review');
      return;
    }
    passengerSubmitting = true;
    try {
      // The background claim is idempotent, bound to THIS authorized booking
      // and the same tab; clicking invokes the official chkForm() handler.
      const claim = await chrome.runtime.sendMessage({type:'BILIT_CLAIM_SELECTION',kind:'passenger'});
      if (!claim?.ok) return;
      report('auto-passenger-submitting');
      action.element.click();
      setText('تأیید اطلاعات مسافر از طریق کنترل رسمی سایت ارسال شد. منتظر پاسخ سفیر ریل...');
    } catch (_) { report('network-session-error'); }
  }
  async function autoConfirmAllocation() {
    if (allocationSubmitting || Date.now()-lastAllocationAttempt < 1600 ||
        typeof BilitAutoOfficialFlow === 'undefined' || hasChallenge()) return;
    lastAllocationAttempt = Date.now();
    try {
      const data = await chrome.runtime.sendMessage({type:'BILIT_GET_PASSENGERS'});
      if (!data?.ok || !data.passengerSubmitted) return;
      const action = BilitAutoOfficialFlow.findAllocationAcknowledgement(document, data, location);
      if (!action.ok) {
        // Only show manual review if the actual assigned-seat agreement is
        // present; other official interstitial pages are allowed to load.
        if (document.body?.innerText?.includes('واگن و کوپه اختصاص')) {
          setText('تخصیص کوپه قابل تطبیق با رزرو اولیه نیست؛ تأیید خودکار متوقف شد.');
          report('manual-review');
        }
        return;
      }
      allocationSubmitting = true;
      const claimed = await chrome.runtime.sendMessage({type:'BILIT_CLAIM_SELECTION',kind:'allocation'});
      if (!claimed?.ok) return;
      // This is the site's ordinary allocated-seat acknowledgement, NOT the
      // CAPTCHA widget or any banking/payment control.
      if (!action.checkbox.checked) action.checkbox.click();
      if (!action.checkbox.checked) { report('manual-review'); return; }
      report('auto-allocation-confirming');
      action.element.click();
      setText('تأیید شماره واگن و کوپه اختصاص‌یافته ارسال شد. منتظر مرحله بعد...');
    } catch (_) {report('network-session-error');}
  }
  async function tryConfirmSelection() {
    if(selectionBusy || hasChallenge() || typeof BilitSafeSelection === 'undefined')return;
    selectionBusy=true;
    try {
      const data=await chrome.runtime.sendMessage({type:'BILIT_GET_PASSENGERS'});
      if(!data?.ok || !data.selection)return;
      for(const kind of ['train','coupe']) {
        if(selectionAttempted.has(kind))continue;
        const result=BilitSafeSelection.findSafeAction(document, kind, data.selection, location);
        if(!result.ok)continue;
        selectionAttempted.add(kind);
        const claimed=await chrome.runtime.sendMessage({type:'BILIT_CLAIM_SELECTION',kind});
        if(!claimed?.ok)continue;
        // Only explicit type=button controls, no form-submit or final checkout.
        result.element.click();
        setText(kind==='train'?'انتخاب قطار مطابق فرم اولیه تأیید شد.':'انتخاب کوپه مطابق فرم اولیه تأیید شد.');
        return; // Navigation may begin; never click a second control on a stale page.
      }
    }catch(_){report('network-session-error');}
    finally{selectionBusy=false;}
  }
  function inspect() {
    if(Date.now()-start>MAX_AGE_MS || Date.now()-lastInspect<350)return;
    lastInspect=Date.now();
    ensurePanel();
    if(hasChallenge()) {
      if(lastPage!=='challenge') {
        lastPage='challenge';report('unverified');
        setText('در همین سایت رسمی «من ربات نیستم» را شخصاً تأیید کنید و دکمه تأیید خود سایت را بزنید. BilitFast به ویجت دست نمی‌زند.');
      }
      return;
    }
    if(hasPassengerForm()) {
      if(lastPage!=='passenger') {
        lastPage='passenger';
        // Only official navigation to the passenger form is evidence of a
        // completed CAPTCHA step. We never infer it from a token/checkbox.
        report('human-verified');
        setText('فرم رسمی مسافر باز شد؛ درج اطلاعات و ادامه مراحل عادی رزرو مطابق انتخاب اولیه، خودکار انجام می‌شود.');
      }
      if(!filled && !filling)void fillFromExtension();
      else if(filled && !passengerSubmitting && Date.now()-lastPassengerContinueAttempt>=1500) {
        void chrome.runtime.sendMessage({type:'BILIT_GET_PASSENGERS'})
          .then(data=>autoContinuePassenger(data)).catch(()=>report('network-session-error'));
      }
      return;
    }
    // A named train/coupe confirmation may be pressed automatically ONLY if
    // the actual official page proves a unique match to the original selection.
    // Unknown HTML, CAPTCHA and purchase buttons are never auto-clicked.
    const observedPhase=typeof BilitOfficialCheckout!=='undefined'? BilitOfficialCheckout.detectPage({
      hostname:location.hostname,pathname:location.pathname,visibleText:document.body?.innerText||'',
      hasPassenger:false,hasChallenge:false
    }):'unknown-official';
    if(!selectionBusy && observedPhase!=='purchase-review' && observedPhase!=='purchase-response')
      void tryConfirmSelection();
    void autoConfirmAllocation();
    if(lastPage==='other')return;
    lastPage='other';
    const phase=typeof BilitOfficialCheckout!=='undefined' ? BilitOfficialCheckout.detectPage({
      hostname:location.hostname,pathname:location.pathname,
      visibleText:document.body?.innerText || '',hasPassenger:false,hasChallenge:false
    }):'unknown-official';
    if(phase==='purchase-review'){
      report('purchase-review');
      // Preserve the authorized booking for a bounded allocation confirmation.
      // Background removes it on the bank page or after TTL expiry.
    } else if(phase==='purchase-response'||phase==='passenger-response'||phase==='unknown-official'){
      report('official-form-not-submitted');
    }
  }
  inspect();
  const observer=new MutationObserver(inspect);
  observer.observe(document.documentElement,{childList:true,subtree:true});
  const interval=setInterval(()=>{
    if(Date.now()-start>MAX_AGE_MS){clearInterval(interval);observer.disconnect();return;}
    inspect();
  },650);
})();
