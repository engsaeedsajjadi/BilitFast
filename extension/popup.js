/* global chrome, BilitCookieReader, BilitTargetOrigin, BilitDirectSession, BilitRouteBridgeControl */
'use strict';
// No pairing PIN, server-side cookie transport, or polling.
// A user click in the official SafirRail tab delivers only to one verified
// BilitFast tab in the same browser window/profile.
const button = document.getElementById('send');
const status = document.getElementById('msg');
const endpoint = document.getElementById('endpoint');
let chosen = null;
function show(message, cls='') { status.textContent=message;status.className=cls; }
async function detect() {
  const [active] = await chrome.tabs.query({active:true,currentWindow:true});
  const tabs = await chrome.tabs.query({currentWindow:true});
  const trusted = (await chrome.storage.local.get('bilitTrustedOrigin'))?.bilitTrustedOrigin || null;
  chosen = BilitDirectSession.select(tabs,active,BilitTargetOrigin.fromTab,trusted);
  endpoint.textContent = 'مقصد: ' + chosen.target.origin + (chosen.target.localPreview?' (نسخه آزمایشی)':'');
  return chosen;
}
// Chrome requires the optional-host permission request to originate in a
// direct popup click. Resolve tabs before the click where possible.
void detect().catch(e=>{endpoint.textContent=e.message;endpoint.className='err';});

button.addEventListener('click',async()=>{
  button.disabled=true;
  try {
    const item=chosen || await detect();
    const pattern=BilitTargetOrigin.permissionPattern(item.target.origin);
    const allowed=await chrome.permissions.request({origins:[pattern]});
    if(!allowed) throw new Error('مجوز همین نصب BilitFast داده نشد؛ نشست ارسال نگردید.');
    // Detect stale/switching tabs. Never select a different recipient silently.
    const [officialTab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!BilitDirectSession.official(officialTab?.url))
      throw new Error('تب فعال دیگر سفیر ریل نیست؛ افزونه را در تب رسمی دوباره باز کنید.');
    const app=await chrome.tabs.get(item.tab.id);
    if(app.url!==item.tab.url || app.windowId!==officialTab.windowId)
      throw new Error('تب BilitFast تغییر کرده است؛ اتصال انجام نشد.');
    const content=await chrome.scripting.executeScript({target:{tabId:app.id},func:()=>
      document.querySelector('meta[name="bilitfast-installation"]')?.content==='first-party-web-v1' &&
      ['/','/login.html','/route.html','/index.html'].includes(location.pathname)
    });
    if(content?.[0]?.result!==true)
      throw new Error('این تب نسخه شناخته‌شده BilitFast نیست؛ هیچ نشست حساسی منتقل نشد.');
    show('در حال ذخیره مستقیم نشست در تب BilitFast…');
    // collect() binds the cookie store to the actual first-party tab.
    const collected=await BilitCookieReader.collect(chrome);
    if(collected.host!=='safirrail.ir'||!collected.cookies.some(c=>/^PHPSESSID=.+/i.test(c)))
      throw new Error('کوکی نشست رزرو در همین پروفایل سفیر ریل پیدا نشد.');
    const receipt=await chrome.scripting.executeScript({target:{tabId:app.id},world:'MAIN',
      args:[collected.cookies,collected.verificationCookies,item.target.origin],
      func:(cookies,verificationCookies,expectedOrigin)=>{
        try {
          if(location.origin!==expectedOrigin ||
             !['/','/login.html','/route.html','/index.html'].includes(location.pathname) ||
             document.querySelector('meta[name="bilitfast-installation"]')?.content!=='first-party-web-v1')
            return {ok:false,reason:'unexpected-destination'};
          const booking=JSON.stringify(cookies);
          const verification=JSON.stringify(verificationCookies);
          sessionStorage.setItem('bilitfast_cookies',booking);
          sessionStorage.setItem('bilitfast_verification_cookies',verification);
          if(sessionStorage.getItem('bilitfast_cookies')!==booking ||
             sessionStorage.getItem('bilitfast_verification_cookies')!==verification)
            return {ok:false,reason:'storage-mismatch'};
          sessionStorage.setItem('bilitfast_direct_session_at',String(Date.now()));
          window.dispatchEvent(new Event('bilitfast-direct-session-ready'));
          return {ok:true}; // No credential values in the return path.
        } catch (_) { return {ok:false,reason:'storage-unavailable'}; }
      }
    });
    if(receipt?.[0]?.result?.ok!==true)
      throw new Error('ذخیره نشست در تب BilitFast موفق نبود. تب و تنظیمات ذخیره‌سازی مرورگر را بررسی کنید.');
    try { await BilitRouteBridgeControl.install(chrome,item.target.origin,app.id); }
    catch (error) {
      show('✓ نشست در تب BilitFast ذخیره شد، اما آماده‌سازی انتخاب یک‌کلیکی قطار ناموفق بود: '+(error?.message||'خطای افزونه'),'err');return;
    }
    show('✓ نشست در همان تب BilitFast ذخیره شد؛ بدون کد و بدون ارسال به سرویس واسط. اعتبار واقعی در سفیر ریل بررسی می‌شود.','ok');
  } catch(error) { show(error?.message||'اتصال انجام نشد.','err'); }
  finally{button.disabled=false;}
});
