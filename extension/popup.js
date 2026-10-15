/* global chrome, BilitCookieReader, BilitTargetOrigin, BilitOfficialHandoff */
'use strict';
// One customer-facing flow: open BilitFast web tab -> click extension -> enter 6-digit PIN.
// Never read a saved / manually typed target host and never upload automatically.
const msg = document.getElementById('msg');
const codeInput = document.getElementById('code');
const sendBtn = document.getElementById('send');
const endpointText = document.getElementById('endpoint');
let tabOrigin = null;
function show(s, cls = '') { msg.textContent = s; msg.className = cls; }
async function detectTabOrigin() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return BilitTargetOrigin.fromTab(tabs && tabs[0]);
}
async function readJson(url, body, label) {
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), cache: 'no-store' });
  } catch (error) {
    throw new Error('ارتباط با ' + label + ' برقرار نشد. مطمئن شوید سرور BilitFast در همین آدرس باز است و افزونه مجوز این دامنه را دارد.');
  }
  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error('آدرس انتخاب‌شده پاسخ JSON سرویس BilitFast نمی‌دهد (HTTP ' + response.status + ').'); }
  if (!response.ok || !data || !data.ok) {
    throw new Error((data && data.error) || (label + ' خطای HTTP ' + response.status + ' برگرداند.'));
  }
  return data;
}
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/[^0-9]/g, '').slice(0, 6);
});
(async () => {
  try {
    tabOrigin = await detectTabOrigin();
    endpointText.textContent = 'نصب انتخاب‌شده: ' + tabOrigin.origin + (tabOrigin.localPreview ? ' (آزمایش محلی)' : '');
  } catch (error) {
    endpointText.textContent = error.message;
    endpointText.className = 'err';
  }
})().catch(() => { endpointText.textContent = 'تشخیص تب BilitFast ممکن نیست.'; });

sendBtn.addEventListener('click', async () => {
  if (!/^[0-9]{6}$/.test(codeInput.value)) { show('کد شش‌رقمی BilitFast را وارد کنید.', 'err'); return; }
  sendBtn.disabled = true;
  try {
    // permissions.request needs a user activation: invoke synchronously in click,
    // BEFORE the first await. The popup's active tab is identified at startup;
    // navigating the tab would close this popup and invalidate that selection.
    const target = tabOrigin;
    if (!target) throw new Error('ابتدا تب BilitFast را فعال کنید، سپس افزونه را دوباره باز کنید.');
    const permissionPromise = chrome.permissions.request({
      origins: [BilitTargetOrigin.permissionPattern(target.origin)],
    });
    endpointText.textContent = 'نصب انتخاب‌شده: ' + target.origin;
    const grant = await permissionPromise;
    if (!grant) throw new Error('مجوز اتصال به همین نشانی BilitFast داده نشد.');
    const url = target.origin + '/api/cookie-sync';
    const service = await readJson(url, { action: 'ping' }, 'سرویس BilitFast');
    if (service.service !== 'bilitfast-cookie-sync' || service.version < 2) {
      throw new Error('این آدرس نسخه سازگار سرویس اتصال BilitFast را اجرا نمی‌کند.');
    }
    show('سرور پیدا شد؛ در حال بررسی نشست سفیر ریل…');
    const { cookies, verificationCookies, host } = await BilitCookieReader.collect(chrome);
    await readJson(url, { action: 'push', code: codeInput.value, cookies,
      verificationCookies, source: 'extension', site: host }, 'تحویل نشست');
    show('✓ نشست تحویل داده شد. تأیید واقعی ورود را در تب BilitFast ببینید.', 'ok');
    codeInput.value = '';
  } catch (error) { show((error && error.message) || 'اتصال انجام نشد.', 'err'); }
  finally { sendBtn.disabled = false; }
});

// Separate explicit user gesture, after BilitFast has reported a real
// ARCaptcha step. Submit the real first-party POST from the SafirRail tab;
// cross-site POST from the BilitFast page may omit SameSite session cookies.
document.getElementById('start-booking').addEventListener('click', async () => {
  const button = document.getElementById('start-booking');
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const target = BilitTargetOrigin.fromTab(tab);
    // Open a persistent BilitFast workspace alongside the real first-party page.
    // The actual ARCaptcha cannot be embedded in the cross-origin BilitFast page.
    if (!chrome.sidePanel?.open || tab.windowId == null)
      throw new Error('پنل کناری BilitFast در این مرورگر پشتیبانی نمی‌شود. Chrome/Edge را به‌روزرسانی کنید؛ رزرو شروع نشد.');
    try { await chrome.sidePanel.open({windowId:tab.windowId}); }
    catch (_) { throw new Error('پنل کنار صفحه باز نشد. رزرو برای جلوگیری از خروج از BilitFast آغاز نشد.'); }
    if (!tab || !/\/route\.html$/.test(new URL(tab.url).pathname)) {
      throw new Error('ابتدا در تب BilitFast قطار را انتخاب کنید و به مرحله ARCaptcha برسید؛ سپس افزونه را باز کنید.');
    }
    // Chrome's activeTab grant is user-scoped to this popup interaction.
    // Read only the currently visible booking snapshot; never execute code
    // supplied by the site or persist any session/captcha tokens.
    const snapshots = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = document.getElementById('bf-browser-handoff');
        const section = document.getElementById('reserve-arcaptcha');
        if (!el || !section || section.style.display === 'none' || !el.textContent)
          throw new Error('مرحله تأیید رزرو هنوز در صفحه نمایش داده نشده است.');
        const rows = Array.from(document.querySelectorAll('#passengers-table tbody tr'));
        const passengers = rows.map(tr => {
          const val = cls => (tr.querySelector(cls)?.value || '').trim();
          return {national_code:val('.col-national'), birth_day:val('.col-day'),
            birth_month:val('.col-month'), birth_year:val('.col-year'),
            first_name:val('.col-name'), last_name:val('.col-family')};
        });
        return { handoff: JSON.parse(el.textContent), passengers,
          phone: (document.getElementById('bf_contact')?.value || '').trim() };
      }
    });
    const snapshot = snapshots && snapshots[0] && snapshots[0].result;
    if (!snapshot || !Array.isArray(snapshot.passengers) || !snapshot.passengers.length || snapshot.passengers.length > 6) {
      throw new Error('فهرست مسافران مسیر کامل نیست.');
    }
    const handoff = BilitOfficialHandoff.validate(snapshot.handoff);
    const siteTab = await BilitCookieReader.discoverTab(chrome);
    const stores = await chrome.cookies.getAllCookieStores();
    const sourceStore = stores.find(s => s.tabIds?.includes(tab.id));
    const destinationStore = stores.find(s => s.tabIds?.includes(siteTab.id));
    if (!sourceStore || !destinationStore || sourceStore.id !== destinationStore.id)
      throw new Error('تب BilitFast و سفیر ریل باید در یک پروفایل مرورگر باشند.');
    // User stays in the SAME browser tab and keeps BilitFast visible in Chrome's
    // side panel. Navigating to the official first-party origin is unavoidable
    // for a legitimate ARCaptcha; NO second tab or separate window is opened.
    // The service worker performs the POST after safirrail.ir finishes loading:
    // the popup itself may close as soon as this tab navigates.
    await chrome.storage.session.set({ bilitPendingPassengerFill: {
      passengers: snapshot.passengers, phone: snapshot.phone,
      selection:{srvc:handoff.fields.srvc||'',wagon:handoff.fields.wagon||''},
      autoAdvance:true, // The initial Start Booking click authorizes normal intermediate progression.
      createdAt: Date.now(), origin: target.origin,
      siteTabId: tab.id
    }});
    await chrome.storage.session.set({
      bilitWorkflowStatus:{stage:'awaiting-human',at:Date.now()},
      bilitOneTabHandoff:{tabId:tab.id,origin:target.origin,createdAt:Date.now(),handoff}
    });
    show('BilitFast در پنل کناری باقی می‌ماند؛ در همین تب، صفحه رسمی برای تأیید انسانی آماده می‌شود.', 'ok');
    // No new Chrome tab or window. The browser automatically supplies its
    // own first-party SafirRail session cookies after this navigation.
    await chrome.tabs.update(tab.id, {url:'https://safirrail.ir/etrain/index.php'});

  } catch (error) {
    show((error && error.message) || 'شروع رزرو رسمی انجام نشد.', 'err');
  } finally { button.disabled = false; }
});
