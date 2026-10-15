/* global chrome */
'use strict';
const workflow = document.getElementById('workflow');
const detail = document.getElementById('detail');
const stages = Object.freeze({
  'awaiting-human': ['در انتظار تأیید شما', 'در همین تب با مبدأ رسمی safirrail.ir، چک‌باکس «من ربات نیستم» را شخصاً تأیید کنید.'],
  'captcha-confirmed': ['تأیید انسانی ثبت شد', 'در حال ادامه فرم رسمی سفیر ریل…'],
  'passenger-form': ['فرم اطلاعات مسافر باز است', 'اطلاعات ذخیره‌شده در BilitFast در فرم درج می‌شود.'],
  'passengers-filled': ['اطلاعات مسافر تکمیل شد', 'در صورت انتخاب ادامه خودکار، فرم معتبر ارسال می‌شود؛ در غیر این صورت خودتان تأیید کنید.'],
  'passenger-submitted': ['در انتظار تأیید خرید', 'کنترل رسمی ارسال شد؛ منتظر صفحه بررسی اطلاعات و تأیید خرید باشید.'],
  'purchase-review': ['صفحه تأیید خرید', 'اطلاعات قطار، مسافران و مبلغ را بررسی کنید؛ تأیید نهایی و انتقال به درگاه فقط توسط سایت رسمی انجام می‌شود.'],
  'manual-review': ['بررسی دستی لازم است', 'فیلدهای فرم را بررسی کنید و دکمه تأیید رسمی سایت را بزنید.'],
  'payment-page': ['صفحه پرداخت نمایش داده شد', 'مبلغ، مشخصات و آدرس درگاه را خودتان بررسی کنید. پرداخت خودکار انجام نمی‌شود.'],
  'idle': ['در انتظار شروع رزرو', 'در تب BilitFast قطار را انتخاب و از افزونه «شروع رزرو» را بزنید.'],
});
async function update() {
  try {
    const value = await chrome.runtime.sendMessage({type:'BILIT_WORKSPACE_STATUS'});
    const key = value?.stage && Object.hasOwn(stages,value.stage) ? value.stage : 'idle';
    const [title,description] = stages[key];
    workflow.textContent = title;
    detail.textContent = description;
    if (key === 'manual-review') {
      const error = await chrome.storage.session.get('bilitWorkflowError');
      if (error?.bilitWorkflowError) detail.textContent = error.bilitWorkflowError;
    }
  } catch (_) {workflow.textContent='ارتباط با افزونه برقرار نیست';detail.textContent='افزونه را دوباره بارگذاری کنید.';}
}
document.getElementById('focus-site').addEventListener('click', async () => {
  try {
    const tabs = await chrome.tabs.query({url:'https://safirrail.ir/etrain/*',currentWindow:true});
    if (tabs.length) await chrome.tabs.update(tabs[0].id,{active:true});
    else detail.textContent='تب رزرو سفیر ریل پیدا نشد. ابتدا از افزونه شروع رزرو را بزنید.';
  } catch (_) {detail.textContent='امکان نمایش تب رسمی وجود ندارد.';}
});
void update();setInterval(update,1200);
