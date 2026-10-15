/* global chrome, BilitOfficialCheckout */
'use strict';
// First-party helper. ARCaptcha and all official form submissions are solely
// owned by SafirRail and the human. Never inspect widget tokens, checkboxes,
// anti-bot internals or trigger submit/click on official controls.
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
    const button=document.createElement('button');button.type='button';button.id='bilitfast-fill-passengers';
    button.textContent='درج اطلاعات مسافر (با تأیید من)';
    button.style.cssText='margin:7px 0 0;padding:8px 11px;border:0;border-radius:8px;background:#1d4ed8;color:white;cursor:pointer;font:12px Tahoma';
    button.addEventListener('click',()=>{void fillFromExtension();});
    button.hidden=!hasPassengerForm();panel.append(button);
    document.body.append(panel);
  }
  function setText(message) {
    ensurePanel();const label=document.getElementById('bilitfast-helper-text');
    if(label)label.textContent=message;
  }
  function fillOne(name,value) {
    const element=field(name);
    if(!element || element.disabled || element.readOnly || value===undefined || value===null || String(value)==='')return false;
    element.value=String(value);
    element.dispatchEvent(new Event('input',{bubbles:true}));
    element.dispatchEvent(new Event('change',{bubbles:true}));
    return element.value===String(value);
  }
  async function fillFromExtension() {
    if(filling || filled)return;
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
      filled=true;
      const button=document.getElementById('bilitfast-fill-passengers');if(button)button.disabled=true;
      setText((complete?'اطلاعات در فرم درج شد. ':'بعضی فیلدها ناقص‌اند. ')+
        'نام، کد ملی، قطار و مبلغ را بررسی کنید؛ برای ادامه فقط دکمه رسمی سایت را خودتان بزنید.');
      report('official-form-not-submitted');
      // Intentionally NO requestSubmit(), submit(), click() or checkout auto-continue.
    } catch (_) {
      setText('خطای ارتباط افزونه. صفحه رسمی را حفظ و دوباره تلاش کنید.');
      report('network-session-error');
    } finally {filling=false;}
  }
  function inspect() {
    if(Date.now()-start>MAX_AGE_MS || Date.now()-lastInspect<350)return;
    lastInspect=Date.now();
    ensurePanel();
    if(hasChallenge()) {
      const btn=document.getElementById('bilitfast-fill-passengers');if(btn)btn.hidden=true;
      if(lastPage!=='challenge') {
        lastPage='challenge';report('unverified');
        setText('در همین سایت رسمی «من ربات نیستم» را شخصاً تأیید کنید و دکمه تأیید خود سایت را بزنید. BilitFast به ویجت دست نمی‌زند.');
      }
      return;
    }
    if(hasPassengerForm()) {
      const btn=document.getElementById('bilitfast-fill-passengers');if(btn)btn.hidden=filled;
      if(lastPage!=='passenger') {
        lastPage='passenger';
        // Only official navigation to the passenger form is evidence of a
        // completed CAPTCHA step. We never infer it from a token/checkbox.
        report('human-verified');
        setText('سامانه رسمی فرم مسافر را نمایش داد. اطلاعات را با دکمه BilitFast درج کنید؛ سپس تأیید نهایی فرم فقط با شماست.');
      }
      return;
    }
    if(lastPage==='other')return;
    lastPage='other';
    const phase=typeof BilitOfficialCheckout!=='undefined' ? BilitOfficialCheckout.detectPage({
      hostname:location.hostname,pathname:location.pathname,
      visibleText:document.body?.innerText || '',hasPassenger:false,hasChallenge:false
    }):'unknown-official';
    if(phase==='purchase-review'){
      report('purchase-review');
      void chrome.runtime.sendMessage({type:'BILIT_CLEAR_PASSENGERS'}).catch(()=>{});
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
