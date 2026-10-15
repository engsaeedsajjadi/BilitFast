// background.js — از نسخه ۱.۲ ارسال کوکی از طریق پنجره افزونه (popup.html)
// انجام می‌شود، چون به «کد جفت‌سازی یک‌بارمصرف» نیاز دارد.
//
// دلیل امنیتی: ارسال بی‌قید کوکی با یک کلیک، یعنی هر کسی که به endpoint
// دسترسی داشته باشد می‌تواند کوکی نشست را تحویل بگیرد. حالا کوکی فقط به
// صفحه‌ای می‌رسد که کد را ساخته است.

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.action.setTitle({ title: 'انتقال کوکی صفیر ریل — برای وارد کردن کد کلیک کنید' });
  } catch (e) { /* ignore */ }
});


// Only our content script on the REAL SafirRail reservation pages can request
// the short-lived passenger data. No cookies, ARCaptcha tokens or bank data.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const url = sender && sender.url || '';
  if (!/^https:\/\/safirrail\.ir\/etrain\//.test(url) || !sender.tab || !message ||
      !['BILIT_GET_PASSENGERS','BILIT_CLEAR_PASSENGERS'].includes(message.type)) return;
  if (message.type === 'BILIT_CLEAR_PASSENGERS') {
    chrome.storage.session.get('bilitPendingPassengerFill').then(async value=>{
      const record=value?.bilitPendingPassengerFill;
      if (!record || (record.siteTabId && record.siteTabId!==sender.tab.id)) {
        reply({ok:false});return;
      }
      await chrome.storage.session.remove('bilitPendingPassengerFill');
      reply({ok:true});
    }).catch(()=>reply({ok:false}));
    return true;
  }
  chrome.storage.session.get('bilitPendingPassengerFill').then(value => {
    const record = value && value.bilitPendingPassengerFill;
    if (!record || (record.siteTabId && record.siteTabId !== sender.tab.id)) {
      reply({ok:false,passengers:[]});return;
    }
    if (Date.now() - record.createdAt > 15*60*1000 ||
        !Array.isArray(record.passengers) || record.passengers.length > 6) {
      chrome.storage.session.remove('bilitPendingPassengerFill').catch(() => {});
      reply({ok:false,passengers:[]});return;
    }
    reply({ok:true, passengers:record.passengers, phone:record.phone || ''});
  }).catch(() => reply({ok:false,passengers:[]}));
  return true;
});

// Side-panel state consists of stage labels only. No personal data, cookies,
// ARCaptcha tokens or hidden form values are exposed in the workspace.
const WORKFLOW_STAGES = new Set([
  'idle','unverified','human-verified','official-form-not-submitted',
  'network-session-error','return-to-official-page','purchase-review',
  'payment-page','manual-review','awaiting-human','passenger-form'
]);
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if (!message || typeof message.type !== 'string') return;
  const official=/^https:\/\/safirrail\.ir\/etrain\//.test(sender.url || '');
  const panel=sender.id===chrome.runtime.id &&
    (sender.url || '').startsWith(chrome.runtime.getURL('workspace.html'));
  if(message.type==='BILIT_WORKSPACE_STATUS'&&panel){
    chrome.storage.session.get('bilitWorkflowStatus').then(obj=>{
      const value=obj?.bilitWorkflowStatus;
      reply({stage:value&&WORKFLOW_STAGES.has(value.stage)?value.stage:'idle'});
    }).catch(()=>reply({stage:'network-session-error'}));
    return true;
  }
  if(message.type==='BILIT_SET_WORKFLOW_STAGE'&&official&&sender.tab&&
     WORKFLOW_STAGES.has(message.stage)){
    chrome.storage.session.get('bilitPendingPassengerFill').then(async value=>{
      const record=value?.bilitPendingPassengerFill;
      if(!record || record.siteTabId!==sender.tab.id || Date.now()-record.createdAt>15*60*1000){
        reply({ok:false});return;
      }
      await chrome.storage.session.set({bilitWorkflowStatus:{stage:message.stage,at:Date.now()}});
      reply({ok:true});
    }).catch(()=>reply({ok:false}));
    return true;
  }
});

// Same-tab handoff: use the ORIGINAL BilitFast tab for the official first-party
// reservation challenge, while Chrome's side panel continues to show BilitFast.
// ARCaptcha is neither copied to the customer origin nor automated here.
// Persist the intent before navigation: the popup can close on tab navigation.
if (typeof importScripts === 'function') importScripts('official-handoff.js');
const oneTabClaims = new Set();
chrome.tabs?.onUpdated?.addListener?.((tabId, changes, tab) => {
  if (changes.status !== 'complete' || !tab?.url) return;
  let page;
  try { page = new URL(tab.url); } catch (_) { return; }
  // A reservation should never silently continue if the user leaves the
  // official origin. A bank redirect is handled separately below.
  if (!(page.protocol === 'https:' && page.hostname === 'safirrail.ir') &&
      !(page.protocol === 'https:' && page.hostname === 'pec.shaparak.ir' &&
        /^\/NewIPG\//i.test(page.pathname))) {
    void chrome.storage.session.get('bilitPendingPassengerFill').then(async data=>{
      const record=data?.bilitPendingPassengerFill;
      if(record && record.siteTabId===tabId && Date.now()-record.createdAt<15*60*1000)
        await chrome.storage.session.set({bilitWorkflowStatus:{stage:'return-to-official-page',at:Date.now()}});
    }).catch(()=>{});
    return;
  }
  if (page.protocol === 'https:' && page.hostname === 'pec.shaparak.ir' &&
      /^\/NewIPG\//i.test(page.pathname)) {
    // Observe only the legitimate bank hostname/path. Never log/retain Token.
    void chrome.storage.session.get('bilitPendingPassengerFill').then(async result=>{
      const record=result?.bilitPendingPassengerFill;
      if (record?.siteTabId !== tabId || Date.now()-record.createdAt > 15*60*1000) return;
      await chrome.storage.session.set({bilitWorkflowStatus:{stage:'payment-page',at:Date.now()}});
      await chrome.storage.session.remove('bilitPendingPassengerFill');
    }).catch(()=>{});
    return;
  }
  if (
      !/^https:\/\/safirrail\.ir\/etrain\/index\.php(?:[?#]|$)/i.test(tab.url) ||
      oneTabClaims.has(tabId)) return;
  oneTabClaims.add(tabId);
  (async () => {
    const {bilitOneTabHandoff: job} = await chrome.storage.session.get('bilitOneTabHandoff');
    if (!job || job.tabId !== tabId) return;
    // Bound to a 60-second one-time handoff from the extension UI, never to
    // arbitrary web content. No CAPTCHA response values or cookies persisted.
    if (Date.now() - job.createdAt > 60000) {
      await chrome.storage.session.remove('bilitOneTabHandoff');
      throw new Error('درخواست رزرو منقضی شد؛ از BilitFast دوباره شروع کنید.');
    }
    const handoff = BilitOfficialHandoff.validate(job.handoff);
    await chrome.storage.session.remove('bilitOneTabHandoff');
    const injected = await chrome.scripting.executeScript({
      target:{tabId}, args:[handoff],
      func: data => {
        if (location.protocol !== 'https:' || location.hostname !== 'safirrail.ir' ||
            !location.pathname.startsWith('/etrain/') ||
            data.url !== 'https://safirrail.ir/etrain/TresV-auth.php' || data.method !== 'POST')
          throw new Error('مقصد رسمی رزرو معتبر نیست.');
        const form = document.createElement('form');
        form.method='POST';form.action=data.url;form.style.display='none';
        for (const [name,value] of Object.entries(data.fields)) {
          const input=document.createElement('input');
          input.type='hidden';input.name=name;input.value=String(value);
          form.appendChild(input);
        }
        document.body.appendChild(form);
        form.submit(); // start the OFFICIAL CAPTCHA page, never solve it
        return true;
      }
    });
    if (!injected?.[0] || injected[0].result !== true)
      throw new Error('فرم رزرو در تب رسمی اجرا نشد.');
  })().catch(async err => {
    await chrome.storage.session.remove('bilitOneTabHandoff').catch(()=>{});
    await chrome.storage.session.set({
      bilitWorkflowStatus:{stage:'network-session-error',at:Date.now()},
      bilitWorkflowError:String(err?.message||'خطا در شروع رزرو رسمی').slice(0,200)
    }).catch(()=>{});
  }).finally(()=>oneTabClaims.delete(tabId));
});
