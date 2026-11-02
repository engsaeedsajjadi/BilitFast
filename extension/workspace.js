/* global chrome */
'use strict';
const workflow = document.getElementById('workflow');
const detail = document.getElementById('detail');
const stages = Object.freeze({
  'idle':['در انتظار رزرو','از ردیف نتایج قطار، «انتخاب و تأیید ربات» را بزنید.'],
  'awaiting-human':['در انتظار صفحه رسمی','رزرو در تب جدید safirrail.ir باز می‌شود. تب BilitFast محفوظ است.'],
  'unverified':['تأیید انسانی انجام نشده','در صفحه رسمی safirrail.ir تیک «من ربات نیستم» و سپس دکمه رسمی تأیید را شخصاً بزنید.'],
  'human-verified':['مرحله تأیید در سایت عبور شد','سامانه رسمی فرم اطلاعات مسافر را نمایش داد. این وضعیت از تغییر مرحله سایت است، نه از خواندن توکن.'],
  'passenger-form':['فرم مسافر آماده است','اطلاعات اولیه پس از تأیید انسانی، بدون سؤال دوباره درج می‌شود.'],
  'official-form-not-submitted':['اطلاعات مسافر درج شد','در حال بررسی کنترل رسمی برای ادامه خودکار رزرو؛ در صورت تغییر ساختار سایت، ادامه متوقف می‌شود.'],
  'auto-passenger-submitting':['تأیید خودکار اطلاعات مسافر','فرم از طریق دکمه رسمی سفیر ریل ارسال شد؛ منتظر پاسخ سایت هستیم.'],
  'auto-allocation-confirming':['تأیید خودکار واگن و کوپه','موافقت با تخصیص شماره واگن و کوپه از طریق کنترل رسمی ارسال شد؛ منتظر انتقال به مرحله بعد هستیم.'],
  'network-session-error':['خطای نشست یا ارتباط','ممکن است نشست منقضی شده یا اتصال برقرار نباشد. در دامنه رسمی دوباره وارد شوید؛ هیچ داده امنیتی را ارسال نکنید.'],
  'return-to-official-page':['بازگشت به صفحه رسمی لازم است','برای تکمیل تأیید انسانی، تب رسمی safirrail.ir را فعال کنید.'],
  'purchase-review':['بررسی واگن و کوپه','اگر تأیید تخصیص با رزرو اولیه مطابقت داشته باشد، BilitFast بدون پرسش دوباره ادامه می‌دهد؛ در غیر این صورت متوقف می‌شود.'],
  'manual-review':['بررسی دستی لازم است','پیام‌های سامانه رسمی را بررسی کنید و دکمه‌های رسمی را خودتان بزنید.'],
  'payment-page':['صفحه درگاه نمایش داده شد','آدرس و مبلغ درگاه رسمی را خودتان بررسی کنید. پرداخت خودکار انجام نمی‌شود.'],
});
async function update() {
  try {
    const value = await chrome.runtime.sendMessage({type:'BILIT_WORKSPACE_STATUS'});
    const key = value?.stage && Object.hasOwn(stages,value.stage) ? value.stage : 'idle';
    const [title,description] = stages[key];
    workflow.textContent = title;
    detail.textContent = description;
    if (key === 'manual-review' || key === 'network-session-error') {
      const error = await chrome.storage.session.get('bilitWorkflowError');
      if (error?.bilitWorkflowError) detail.textContent = error.bilitWorkflowError;
    }
  } catch (_) {workflow.textContent='ارتباط با افزونه برقرار نیست';detail.textContent='افزونه را دوباره بارگذاری کنید.';}
}
document.getElementById('focus-site').addEventListener('click', async () => {
  try {
    const state=await chrome.storage.session.get('bilitWorkspaceSourceTab');
    const id=state?.bilitWorkspaceSourceTab?.siteTabId;
    if (!Number.isSafeInteger(id)) throw new Error('تب رزرو ثبت نشده است.');
    const tab=await chrome.tabs.get(id);
    if (!tab?.url || !/^https:\/\/safirrail\.ir\/etrain\//.test(tab.url))
      throw new Error('تب رسمی رزرو در دسترس نیست.');
    await chrome.tabs.update(tab.id,{active:true});
  } catch (_) {detail.textContent='تب رسمی رزرو در دسترس نیست؛ از BilitFast دوباره قطار را انتخاب کنید.';}
});
document.getElementById('focus-bilitfast').addEventListener('click', async () => {
  try {
    const state=await chrome.storage.session.get('bilitWorkspaceSourceTab');
    const ref=state?.bilitWorkspaceSourceTab;
    if (!Number.isSafeInteger(ref?.tabId)) throw new Error('تب برنامه ثبت نشده است.');
    const tab=await chrome.tabs.get(ref.tabId);
    if (new URL(tab.url).origin !== ref.origin || new URL(tab.url).pathname !== '/route.html')
      throw new Error('آدرس صفحه تغییر کرده است.');
    await chrome.tabs.update(tab.id,{active:true});
  } catch (_) {detail.textContent='تب اصلی BilitFast در دسترس نیست؛ از فهرست تب‌ها آن را انتخاب کنید.';}
});
void update();setInterval(update,1200);
