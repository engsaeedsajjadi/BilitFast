// popup.js — ارسال کوکی‌های صفیر ریل با «کد جفت‌سازی یک‌بارمصرف».
//
// چرا کد؟ بدون آن، هر کسی که به آدرس برنامه دسترسی داشت می‌توانست کوکی نشست
// را بردارد (ربودن نشست). حالا کوکی فقط به همان صفحه‌ای می‌رسد که کد را ساخته.

const DEFAULT_APP_URL = 'http://localhost:3000';

const msg = document.getElementById('msg');
const codeInput = document.getElementById('code');
const sendBtn = document.getElementById('send');

function show(text, cls) {
  msg.textContent = text;
  msg.className = cls || '';
}

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
});

sendBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    show('کد ۶ رقمی را وارد کنید.', 'err');
    return;
  }
  sendBtn.disabled = true;
  show('در حال خواندن کوکی‌ها...');

  try {
    const cfg = await chrome.storage.local.get({ appUrl: DEFAULT_APP_URL });
    const appUrl = String(cfg.appUrl || DEFAULT_APP_URL).replace(/\/+$/, '');

    const cookies = await chrome.cookies.getAll({ domain: 'safirrail.ir' });
    if (!cookies.length) {
      show('کوکی‌ای یافت نشد. ابتدا در مرورگر وارد safirrail.ir شوید.', 'err');
      sendBtn.disabled = false;
      return;
    }

    const list = cookies.map((c) => c.name + '=' + c.value);
    const hasSession = list.some((c) => /^PHPSESSID=/i.test(c));

    const resp = await fetch(appUrl + '/api/cookie-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'push', code, cookies: list, source: 'extension' }),
    });
    const data = await resp.json();

    if (data && data.ok) {
      show('✓ ' + data.count + ' کوکی ارسال شد' +
        (hasSession ? ' (کوکی نشست ✓)' : ' — ⚠ کوکی نشست یافت نشد؛ ابتدا در سایت وارد شوید.'), 'ok');
      codeInput.value = '';
    } else {
      show('✗ ' + ((data && data.error) || 'خطا در ارسال کوکی‌ها'), 'err');
    }
  } catch (e) {
    show('برنامه در دسترس نیست. مطمئن شوید برنامه اجراست و آدرس در تنظیمات افزونه درست است.', 'err');
  }
  sendBtn.disabled = false;
});
